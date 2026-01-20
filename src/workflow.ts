/**
 * Traced Workflow decorator for Cloudflare Workflows
 *
 * Automatically instruments Workflow classes with OpenTelemetry tracing.
 * Traceparent is stored using a deterministic step so it persists across
 * workflow pause/resume cycles. Each step.do() call creates a child span.
 */

import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  spanContextFromTraceparent,
  generateTraceId,
  generateSpanId,
} from "./provider.js";
import { getLogger } from "./logger.js";
import { initOTLP, type FlushContext } from "./flush.js";

// ============================================
// Types
// ============================================

/**
 * Cloudflare WorkflowEvent type
 */
export interface WorkflowEvent<T = unknown> {
  payload: Readonly<T & { _traceparent?: string }>;
  timestamp: Date;
  instanceId: string;
}

/**
 * Cloudflare WorkflowStep type
 */
export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<T>;
}

/**
 * Cloudflare WorkflowStepConfig type
 */
export interface WorkflowStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

/**
 * Base WorkflowEntrypoint interface (matches Cloudflare's)
 */
export interface WorkflowEntrypoint<Env = unknown, Params = unknown> {
  run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  env?: Env;
  ctx?: ExecutionContext;
}

/**
 * Constructor type for WorkflowEntrypoint (lenient - any constructor)
 */
export type WorkflowEntrypointConstructor<
  Env = unknown,
  Params = unknown,
> = new (...args: unknown[]) => WorkflowEntrypoint<Env, Params>;

/**
 * Params type with _traceparent included
 */
export type TracedParams<T = unknown> = T & { _traceparent?: string };

/**
 * TracedWorkflow type - WorkflowEntrypoint with _traceparent in params
 */
export type TracedWorkflow<Env = unknown, Params = unknown> = WorkflowEntrypoint<
  Env,
  TracedParams<Params>
>;

// ============================================
// Workflow Binding Types (for env)
// ============================================

/**
 * Workflow instance returned by create() or get()
 */
export interface WorkflowInstance<Params = unknown> {
  id: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<WorkflowInstanceStatus>;
}

/**
 * Workflow instance status
 */
export interface WorkflowInstanceStatus {
  status: "queued" | "running" | "paused" | "complete" | "errored" | "terminated" | "waiting";
  error?: string;
  output?: unknown;
}

/**
 * Options for creating a workflow instance
 */
export interface WorkflowInstanceCreateOptions<Params = unknown> {
  id?: string;
  params?: Params;
}

/**
 * Workflow binding type (matches Cloudflare's Workflow)
 * Use this in env interface for workflow bindings
 */
export interface WorkflowBinding<Params = unknown> {
  create(options?: WorkflowInstanceCreateOptions<Params>): Promise<WorkflowInstance<Params>>;
  get(id: string): Promise<WorkflowInstance<Params>>;
}

/**
 * Traced workflow binding - automatically includes _traceparent in params
 * Use this instead of Workflow from cloudflare:workers
 *
 * @example
 * interface Env {
 *   MY_WORKFLOW: TracedWorkflowBinding<MyParams>;
 * }
 */
export type TracedWorkflowBinding<Params = unknown> = WorkflowBinding<TracedParams<Params>>;


// ============================================
// Deterministic Key Serialization
// ============================================

/**
 * Sort object keys recursively for deterministic serialization
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Generate deterministic key from value
 * - Non-array values are wrapped in array
 * - Object keys are sorted recursively
 * - Result is JSON stringified
 */
export function generateDeterministicKey(value: unknown): string {
  const normalized = Array.isArray(value) ? value : [value];
  const sorted = sortObjectKeys(normalized);
  return JSON.stringify(sorted);
}

// ============================================
// Constants
// ============================================

const TRACE_INIT_STEP = "__trace_init";

// ============================================
// Step Proxy
// ============================================

/**
 * Create a span with parent context from traceparent string
 */
function withTraceparentContext<T>(
  traceparent: string,
  spanName: string,
  attributes: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("otel-cloudflare");
  const parentSpanContext = spanContextFromTraceparent(traceparent);

  let parentContext = context.active();
  if (parentSpanContext) {
    const parentSpan = trace.wrapSpanContext(parentSpanContext);
    parentContext = trace.setSpan(context.active(), parentSpan);
  }

  return context.with(parentContext, () => {
    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.INTERNAL,
        attributes,
      },
      async (span) => {
        try {
          const result = await fn();
          span.end();
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
          });
          span.end();
          throw error;
        }
      },
    );
  });
}

/**
 * Create a proxy around WorkflowStep that traces each step.do() call
 */
function createTracedStep(
  step: WorkflowStep,
  workflowName: string,
  traceparent: string,
): WorkflowStep {
  const logger = getLogger();

  return new Proxy(step, {
    get(target, prop, receiver) {
      if (prop === "do") {
        return function tracedDo<T>(
          name: string,
          configOrCallback: WorkflowStepConfig | (() => Promise<T>),
          maybeCallback?: () => Promise<T>,
        ): Promise<T> {
          // Skip tracing for internal trace init step
          if (name === TRACE_INIT_STEP) {
            const callback =
              typeof configOrCallback === "function"
                ? configOrCallback
                : maybeCallback!;
            return target.do(name, callback);
          }

          // Parse overloaded arguments
          const config =
            typeof configOrCallback === "function"
              ? undefined
              : configOrCallback;
          const callback =
            typeof configOrCallback === "function"
              ? configOrCallback
              : maybeCallback!;

          return withTraceparentContext(
            traceparent,
            `step:${name}`,
            {
              "workflow.name": workflowName,
              "workflow.step.name": name,
            },
            async () => {
              logger.info(`Step started: ${name}`, {
                workflow: workflowName,
                step: name,
              });

              try {
                const result = config
                  ? await target.do(name, config, callback)
                  : await target.do(name, callback);

                logger.info(`Step completed: ${name}`, {
                  workflow: workflowName,
                  step: name,
                });

                return result;
              } catch (error) {
                logger.error(`Step failed: ${name}`, {
                  workflow: workflowName,
                  step: name,
                  error: (error as Error).message,
                  stack: (error as Error).stack,
                });
                throw error;
              }
            },
          );
        };
      }

      if (prop === "sleep") {
        return function tracedSleep(
          name: string,
          duration: string | number,
        ): Promise<void> {
          return withTraceparentContext(
            traceparent,
            `step:${name}:sleep`,
            {
              "workflow.name": workflowName,
              "workflow.step.name": name,
              "workflow.step.type": "sleep",
              "workflow.step.duration": String(duration),
            },
            async () => {
              logger.info(`Step started: ${name} (sleep ${duration})`, {
                workflow: workflowName,
                step: name,
                type: "sleep",
                duration: String(duration),
              });

              try {
                await target.sleep(name, duration);

                logger.info(`Step completed: ${name} (sleep)`, {
                  workflow: workflowName,
                  step: name,
                  type: "sleep",
                });
              } catch (error) {
                logger.error(`Step failed: ${name} (sleep)`, {
                  workflow: workflowName,
                  step: name,
                  type: "sleep",
                  error: (error as Error).message,
                  stack: (error as Error).stack,
                });
                throw error;
              }
            },
          );
        };
      }

      if (prop === "sleepUntil") {
        return function tracedSleepUntil(
          name: string,
          timestamp: Date | number,
        ): Promise<void> {
          const ts =
            timestamp instanceof Date
              ? timestamp.toISOString()
              : new Date(timestamp).toISOString();

          return withTraceparentContext(
            traceparent,
            `step:${name}:sleepUntil`,
            {
              "workflow.name": workflowName,
              "workflow.step.name": name,
              "workflow.step.type": "sleepUntil",
              "workflow.step.timestamp": ts,
            },
            async () => {
              logger.info(`Step started: ${name} (sleepUntil ${ts})`, {
                workflow: workflowName,
                step: name,
                type: "sleepUntil",
                timestamp: ts,
              });

              try {
                await target.sleepUntil(name, timestamp);

                logger.info(`Step completed: ${name} (sleepUntil)`, {
                  workflow: workflowName,
                  step: name,
                  type: "sleepUntil",
                });
              } catch (error) {
                logger.error(`Step failed: ${name} (sleepUntil)`, {
                  workflow: workflowName,
                  step: name,
                  type: "sleepUntil",
                  error: (error as Error).message,
                  stack: (error as Error).stack,
                });
                throw error;
              }
            },
          );
        };
      }

      if (prop === "waitForEvent") {
        return function tracedWaitForEvent<T>(
          name: string,
          options: { type: string; timeout?: string },
        ): Promise<T> {
          return withTraceparentContext(
            traceparent,
            `step:${name}:waitForEvent`,
            {
              "workflow.name": workflowName,
              "workflow.step.name": name,
              "workflow.step.type": "waitForEvent",
              "workflow.step.event_type": options.type,
              "workflow.step.timeout": options.timeout,
            },
            async () => {
              logger.info(`Step started: ${name} (waitForEvent ${options.type})`, {
                workflow: workflowName,
                step: name,
                type: "waitForEvent",
                eventType: options.type,
                timeout: options.timeout,
              });

              try {
                const result = await target.waitForEvent<T>(name, options);

                logger.info(`Step completed: ${name} (waitForEvent)`, {
                  workflow: workflowName,
                  step: name,
                  type: "waitForEvent",
                });

                return result;
              } catch (error) {
                logger.error(`Step failed: ${name} (waitForEvent)`, {
                  workflow: workflowName,
                  step: name,
                  type: "waitForEvent",
                  error: (error as Error).message,
                  stack: (error as Error).stack,
                });
                throw error;
              }
            },
          );
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

// ============================================
// Decorator
// ============================================

/**
 * Decorator to add tracing to Cloudflare Workflow classes
 *
 * Automatically:
 * - Initializes OTLP collectors and flushes on completion
 * - Stores traceparent in deterministic step (persists across pause/resume)
 * - Extracts traceparent from payload._traceparent or generates new one
 * - Proxies step methods to create child spans for each step
 *
 * @example
 * @traceWorkflow()
 * export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
 *   async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
 *     await step.do("fetch-data", async () => {
 *       // This step is automatically traced
 *     });
 *   }
 * }
 */
export function traceWorkflow<Env = unknown, Params = unknown>(): <
  T extends WorkflowEntrypointConstructor<Env, Params>,
>(
  target: T,
  context: ClassDecoratorContext,
) => T {
  return function decorator<
    T extends WorkflowEntrypointConstructor<Env, Params>,
  >(target: T, _context: ClassDecoratorContext): T {
    const workflowName = target.name;

    // Create a new class that extends the target
    const TracedClass = class extends (target as WorkflowEntrypointConstructor) {
      async run(
        event: WorkflowEvent<Params>,
        step: WorkflowStep,
      ): Promise<unknown> {
        // Initialize OTLP collectors for this workflow run
        // Workflows have separate lifecycle from request handlers
        const flushCtx: FlushContext = initOTLP(
          this.env as Record<string, unknown> | undefined,
          workflowName,
        );

        try {
          // Store traceparent in deterministic step (persists across pause/resume)
          const traceparent = await step.do(TRACE_INIT_STEP, async () => {
            // Return existing traceparent from payload, or generate new one
            if (event.payload._traceparent) {
              return event.payload._traceparent;
            }
            // Generate new traceparent
            const traceId = generateTraceId();
            const spanId = generateSpanId();
            return `00-${traceId}-${spanId}-01`;
          });

          // Create traced step proxy
          const tracedStep = createTracedStep(step, workflowName, traceparent);

          // Log workflow start with trace context
          const parentSpanContext = spanContextFromTraceparent(traceparent);
          let parentContext = context.active();
          if (parentSpanContext) {
            const parentSpan = trace.wrapSpanContext(parentSpanContext);
            parentContext = trace.setSpan(context.active(), parentSpan);
          }

          return await context.with(parentContext, async () => {
            getLogger().info(`Workflow started: ${workflowName}`, {
              instanceId: event.instanceId,
            });

            try {
              // Call original run with traced step
              const result = await super.run(event, tracedStep);

              getLogger().info(`Workflow completed: ${workflowName}`, {
                instanceId: event.instanceId,
              });

              return result;
            } catch (error) {
              getLogger().error(`Workflow failed: ${workflowName}`, {
                instanceId: event.instanceId,
                error: (error as Error).message,
                stack: (error as Error).stack,
              });
              throw error;
            }
          });
        } finally {
          // Flush all collected traces and logs
          await flushCtx.flush();
        }
      }
    };

    // Preserve the original class name
    Object.defineProperty(TracedClass, "name", { value: target.name });

    return TracedClass as T;
  };
}

/**
 * Helper to inject traceparent into workflow payload
 *
 * @example
 * const result = await env.MY_WORKFLOW.create({
 *   params: withWorkflowTrace({ orderId: "123" })
 * });
 */
export function withWorkflowTrace<T extends Record<string, unknown>>(
  payload: T,
): T & { _traceparent?: string } {
  const span = trace.getSpan(context.active());
  if (!span) {
    return payload;
  }

  const spanContext = span.spanContext();
  const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-01`;

  return {
    ...payload,
    _traceparent: traceparent,
  };
}
