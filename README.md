# otel-cloudflare

Lightweight OpenTelemetry helpers for Cloudflare Workers runtime.

**[API Documentation](https://otel-cloudflare.pages.dev)**

This library provides:
- **Trace context propagation** across services (fetch → queue → consumer)
- **Structured logging** with trace ID for log correlation
- **Custom TracerProvider** that works in Workers runtime (without dependency on `@opentelemetry/sdk-trace-base`)

## Installation

1. Add `.npmrc` to your project root:
```
@tigorlazuardi:registry=https://npm.pkg.github.com
```

2. Install the package:
```bash
pnpm add @tigorlazuardi/otel-cloudflare @opentelemetry/api
```

## Quick Start

### Vanilla Workers (Queue, Scheduled)

Use `instrument()` for auto-setup trace context:

```typescript
import { instrument, getLogger, withTraceContext } from "@tigorlazuardi/otel-cloudflare";

export default instrument({
  async fetch(request, env, ctx) {
    const logger = getLogger();
    logger.info("handling request"); // [trace_id] handling request

    // Propagate trace to queue
    await env.QUEUE.send(withTraceContext({ orderId: 123 }));

    return new Response("OK");
  },

  async queue(batch, env, ctx) {
    const logger = getLogger();
    // Trace ID is automatically extracted from message
    logger.info("processing batch"); // [same_trace_id] processing batch

    for (const msg of batch.messages) {
      logger.info("processing message", { id: msg.id });
      msg.ack();
    }
  },

  async scheduled(controller, env, ctx) {
    const logger = getLogger();
    // Scheduled always gets a new trace ID
    logger.info("running cron", { cron: controller.cron }); // [new_trace_id] running cron
  },
});
```

### SvelteKit / Custom Handlers

Use `withTrace()` with `parent` option:

```typescript
// hooks.server.ts
import { 
  Logger, 
  withTrace, 
  getTraceparent,
  initTracing,
} from "@tigorlazuardi/otel-cloudflare";

// Initialize once
initTracing();

export const handle: Handle = async ({ event, resolve }) => {
  const traceparent = event.request.headers.get("traceparent");

  return withTrace(
    async () => {
      const logger = new Logger();
      logger.info("handling request"); // [trace_id] handling request

      // Get current traceparent for propagation
      const currentTrace = getTraceparent();
      
      // Send to queue with trace context
      await env.QUEUE.send({ 
        data: payload,
        _traceparent: currentTrace 
      });

      return resolve(event);
    },
    { parent: traceparent, name: "handleRequest" }
  );
};
```

## Features

### Trace Context Propagation

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   producer  │ ──► │   Queue     │ ──► │  consumer   │
│  [abc123]   │     │ _traceparent│     │  [abc123]   │
└─────────────┘     └─────────────┘     └─────────────┘

Query: trace_id = "abc123" → Get all logs
```

- **fetch**: Extract `traceparent` from request headers
- **queue**: Extract `_traceparent` from message body
- **scheduled**: Generate new trace ID

### Structured Logging

```typescript
import { Logger, getLogger, runWithLogger, withAttrs } from "@tigorlazuardi/otel-cloudflare";

const logger = new Logger({
  attrs: { service: "my-service", environment: "production" }
});

// Basic logging - automatically includes trace_id
logger.info("user logged in", { userId: 42 });
// Output: {"level":"info","msg":"[abc123] user logged in","time":"...","userId":42,"trace_id":"abc123"}

// Child logger
const requestLogger = logger.child({ requestId: "req-456" });
requestLogger.info("processing"); // includes requestId in all logs

// Contextual attributes
withAttrs({ userId: 42 }, () => {
  logger.info("user action"); // includes userId
});

// Logger in context
runWithLogger(logger, () => {
  const log = getLogger();
  log.info("from context");
});
```

### CallerInfo

Capture source code location for debugging:

```typescript
import { CallerInfo, withCaller, getCurrentCaller } from "@tigorlazuardi/otel-cloudflare";

const caller = CallerInfo.from();
console.log(caller.toString()); // "src/handler.ts:42 handleRequest"
console.log(caller.toAttributes()); 
// { "code.filepath": "src/handler.ts", "code.lineno": 42, "code.function": "handleRequest" }
```

## Workflow Tracing

`@traceWorkflow()` decorator for auto-instrumenting [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) with OpenTelemetry tracing.

### Basic Usage

```typescript
import { traceWorkflow, WorkflowEvent, WorkflowStep } from "@tigorlazuardi/otel-cloudflare";
import { WorkflowEntrypoint } from "cloudflare:workers";

interface Env {
  MY_QUEUE: Queue;
}

interface OrderPayload {
  orderId: string;
  items: string[];
}

@traceWorkflow<Env, OrderPayload>()
export class OrderWorkflow extends WorkflowEntrypoint<Env, OrderPayload> {
  async run(event: WorkflowEvent<OrderPayload>, step: WorkflowStep) {
    // Each step.do() is automatically traced as a child span
    const validated = await step.do("validate-order", async () => {
      return this.validateOrder(event.payload);
    });

    await step.do("process-payment", async () => {
      return this.processPayment(validated);
    });

    // step.sleep, sleepUntil, waitForEvent are also traced
    await step.sleep("wait-for-inventory", "5 minutes");

    await step.do("ship-order", async () => {
      return this.shipOrder(validated);
    });

    return { success: true, orderId: event.payload.orderId };
  }
}
```

### Trace Propagation from Parent

To connect trace from caller (e.g., fetch handler) to workflow:

```typescript
import { instrument, withWorkflowTrace } from "@tigorlazuardi/otel-cloudflare";

interface Env {
  ORDER_WORKFLOW: Workflow;
}

export default instrument<Env>({
  async fetch(request, env, ctx) {
    const payload = await request.json();

    // withWorkflowTrace() injects _traceparent into payload
    const instance = await env.ORDER_WORKFLOW.create({
      params: withWorkflowTrace({
        orderId: payload.orderId,
        items: payload.items,
      }),
    });

    return Response.json({ instanceId: instance.id });
  },
});
```

As a result, the workflow becomes a child span of the fetch handler:

```
┌─────────────────────────────────────────────────────────────────┐
│ fetch handler [trace_id: abc123]                                │
│   └─► workflow:OrderWorkflow [trace_id: abc123]                 │
│         ├─► step:validate-order                                 │
│         ├─► step:process-payment                                │
│         ├─► step:wait-for-inventory:sleep                       │
│         └─► step:ship-order                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Step Configurations

Retry and timeout config work as normal:

```typescript
@traceWorkflow<Env, Payload>()
export class MyWorkflow extends WorkflowEntrypoint<Env, Payload> {
  async run(event: WorkflowEvent<Payload>, step: WorkflowStep) {
    // With retry config
    await step.do(
      "fetch-external-api",
      {
        retries: { limit: 3, delay: "1s", backoff: "exponential" },
        timeout: "30s",
      },
      async () => {
        return fetch("https://api.example.com/data");
      }
    );

    // Wait for external event
    const approval = await step.waitForEvent<{ approved: boolean }>(
      "wait-approval",
      { type: "approval-response", timeout: "24 hours" }
    );

    if (!approval.approved) {
      throw new Error("Order rejected");
    }
  }
}
```

### Span Attributes

Each created span has the following attributes:

| Attribute | Description |
|-----------|-------------|
| `workflow.name` | Workflow class name |
| `workflow.instance_id` | Cloudflare workflow instance ID |
| `workflow.step.name` | Step name |
| `workflow.step.type` | Step type: `sleep`, `sleepUntil`, `waitForEvent` |
| `workflow.step.duration` | Duration for sleep |
| `workflow.step.timestamp` | Target timestamp for sleepUntil |
| `workflow.step.event_type` | Event type for waitForEvent |
| `workflow.step.timeout` | Timeout for waitForEvent |

## API Reference

### Instrumentation

| Function | Description |
|----------|-------------|
| `instrument(handler, opts?)` | Wrap ExportedHandler with auto trace context |
| `withTraceContext(body)` | Inject `_traceparent` into message body for queue propagation |
| `initTracing()` | Initialize TracerProvider (called automatically by `instrument`) |

### Tracing

| Function | Description |
|----------|-------------|
| `withTrace(fn, opts?)` | Wrap function with span, supports `parent` option |
| `getTraceparent()` | Get current trace as W3C traceparent string |
| `parseTraceparent(str)` | Parse traceparent string to TraceContext |
| `withParentTrace(parent, fn)` | Run function with specific parent context |

### Logger

| Method | Description |
|--------|-------------|
| `logger.trace/debug/info/warn/error/fatal(msg, attrs?, opts?)` | Log with level |
| `logger.child(attrs)` | Create child logger with additional attributes |
| `logger.run(fn)` | Run function with logger in context |

| Function | Description |
|----------|-------------|
| `getLogger()` | Get logger from context (AsyncLocalStorage) |
| `runWithLogger(logger, fn)` | Run with logger in context |
| `withAttrs(attrs, fn)` | Run with contextual attributes |
| `getAttrs()` | Get current contextual attributes |

### CallerInfo

| Method | Description |
|--------|-------------|
| `CallerInfo.from(skipFrames?)` | Capture caller from stack trace |
| `caller.toAttributes()` | Return OpenTelemetry attributes |
| `caller.toString()` | Format: "file:line function" |
| `caller.isEmpty()` | Check if empty |

### Workflow

| Function/Decorator | Description |
|----------|-------------|
| `@traceWorkflow<Env, Payload>()` | Decorator for auto-tracing workflow class |
| `withWorkflowTrace(payload)` | Inject `_traceparent` into workflow payload |

## How It Works

### Why Custom TracerProvider?

`@opentelemetry/sdk-trace-base` is not compatible with Cloudflare Workers due to dependencies on Node.js APIs (`perf_hooks`, etc). This library provides a lightweight TracerProvider that:

- Works in Workers runtime
- Generates valid W3C trace ID & span ID
- Maintains OpenTelemetry context (for logger integration)
- Does not export spans (no-op exporter)

### Future: Export to Grafana

Since we use `@opentelemetry/api` interfaces, in the future you can add an OTLP exporter via `fetch()` + `waitUntil()` to send traces to Grafana or other backends.

### Cloudflare Native Traces

This library is **not compatible** with Cloudflare's native tracing (`[observability.traces]`). They operate as completely separate pipelines:

- **Native traces**: Cloudflare's internal tracing system, visible only in Cloudflare Dashboard
- **This library**: Custom OpenTelemetry implementation for log correlation & trace propagation

The trace IDs generated by this library will not appear in Cloudflare's native trace view, and vice versa. If you need both, you'll have two independent tracing systems running in parallel.

## Limitations

| Feature | Status |
|---------|--------|
| Log correlation across services | Works |
| Trace propagation (fetch → queue → consumer) | Works |
| Single trace view in Cloudflare Dashboard | Not supported by Cloudflare |
| Match trace ID with Cloudflare native traces | No API exposed |
| Microsecond precision timing | Workers uses Date.now() |

## License

Apache-2.0
