import {
  trace,
  context,
  type Span,
  type SpanContext,
  type SpanOptions,
} from "@opentelemetry/api";
import { CallerInfo } from "./caller.js";
import { spanContextFromTraceparent } from "./provider.js";

export interface WithTraceOptions extends SpanOptions {
  /**
   * Override the caller info for this span.
   * If not provided, will be captured automatically.
   */
  caller?: CallerInfo;

  /**
   * Name of the span. If not provided, uses the function name from caller info.
   */
  name?: string;

  /**
   * Tracer name to use. Defaults to "otel-cloudflare".
   */
  tracerName?: string;

  /**
   * Parent trace context. Can be:
   * - W3C traceparent string (e.g., "00-traceId-spanId-01")
   * - SpanContext object
   *
   * If provided, the new span will be a child of this parent.
   * If not provided, uses the current active context.
   */
  parent?: string | SpanContext;
}

/**
 * Wraps a function with OpenTelemetry tracing.
 * Automatically captures caller info and sets code.* attributes.
 *
 * If the callback returns a Promise, the span ends after the promise resolves/rejects.
 * If the callback is synchronous, the span ends immediately after execution.
 *
 * @example
 * // Basic usage
 * withTrace((span) => {
 *   logger.info('doing something');
 *   return result;
 * });
 *
 * @example
 * // With parent from traceparent header
 * const traceparent = request.headers.get('traceparent');
 * withTrace((span) => {
 *   logger.info('handling request');
 * }, { parent: traceparent, name: 'handleRequest' });
 */
export function withTrace<T>(
  fn: (span: Span) => T,
  opts?: WithTraceOptions,
): T {
  const caller = opts?.caller ?? CallerInfo.from(3);
  const tracerName = opts?.tracerName ?? "otel-cloudflare";
  const spanName = opts?.name ?? caller.function ?? "<anonymous>";

  const tracer = trace.getTracer(tracerName);

  const spanOptions: SpanOptions = {
    ...opts,
    attributes: {
      ...caller.toAttributes(),
      ...opts?.attributes,
    },
  };

  // Determine parent context
  let parentContext = context.active();

  if (opts?.parent) {
    const parentSpanContext =
      typeof opts.parent === "string"
        ? spanContextFromTraceparent(opts.parent)
        : opts.parent;

    if (parentSpanContext) {
      // Create a non-recording span to hold the parent context
      const parentSpan = trace.wrapSpanContext(parentSpanContext);
      parentContext = trace.setSpan(context.active(), parentSpan);
    }
  }

  // Start span with the determined parent context
  // Using standard OpenTelemetry API - context.with() for propagation
  return context.with(parentContext, () => {
    return tracer.startActiveSpan(spanName, spanOptions, (span: Span) => {
      try {
        const result = fn(span);

        if (result instanceof Promise) {
          return result
            .then((value) => {
              span.end();
              return value;
            })
            .catch((error) => {
              span.recordException(error);
              span.end();
              throw error;
            }) as T;
        }

        span.end();
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
  });
}
