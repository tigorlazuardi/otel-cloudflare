/**
 * Instrumentation wrapper for Cloudflare Workers handlers
 *
 * Automatically sets up trace context for fetch, queue, and scheduled handlers.
 */

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type SpanContext,
  type Span,
} from "@opentelemetry/api";
import { spanContextFromTraceparent, getTraceparent } from "./provider.js";
import { getLogger } from "./logger.js";
import { getOTLPConfigFromEnv, type OTLPExporterConfig } from "./otlp.js";
import { initOTLP } from "./flush.js";

// ============================================
// Helper Functions
// ============================================

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Format duration to human readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

const MAX_BODY_LOG_SIZE = 8192;

/** Content types that are safe to log */
const LOGGABLE_CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "text/plain",
  "text/xml",
  "application/xml",
];

/**
 * Check if content type is loggable (text-based, excluding HTML)
 */
function isLoggableContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return LOGGABLE_CONTENT_TYPES.includes(base);
}

/**
 * Read body from stream with truncation (max 2048 bytes)
 * Only reads if content type is text-based (json, form, text)
 * Returns [truncatedBody, originalOrTeedStream]
 */
async function readBodyWithTruncate(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
): Promise<[string, ReadableStream<Uint8Array> | null]> {
  if (!body) return ["", null];

  // Skip binary content (images, files, etc.)
  if (!isLoggableContentType(contentType)) {
    return ["", body];
  }

  const [stream1, stream2] = body.tee();
  const reader = stream1.getReader();
  const decoder = new TextDecoder();
  let result = "";

  try {
    while (result.length < MAX_BODY_LOG_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    if (result.length > MAX_BODY_LOG_SIZE) {
      result = result.slice(0, MAX_BODY_LOG_SIZE) + "...[truncated]";
    }
  } finally {
    reader.cancel();
  }

  return [result, stream2];
}

// ============================================
// Types
// ============================================

/**
 * Message with optional trace context for propagation
 */
export interface TracedMessage<T = unknown> {
  body: T & { _traceparent?: string };
  id: string;
  timestamp: Date;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// Re-export OTLPExporterConfig from otlp.ts
export type { OTLPExporterConfig };

/**
 * Options for the instrument wrapper
 * Can be a static object or a function that receives env and returns options
 */
export type InstrumentOptions<Env = unknown> =
  | InstrumentOptionsObject
  | ((env: Env) => InstrumentOptionsObject);

/**
 * Options object for instrumentation
 */
export interface InstrumentOptionsObject {
  /**
   * Service name for tracing
   * Used as resource attribute
   */
  serviceName?: string;

  /**
   * OTLP exporter configuration
   *
   * - If not provided (default), auto-detects from env vars:
   *   - OTEL_EXPORTER_OTLP_ENDPOINT: Base OTLP endpoint
   *   - OTEL_EXPORTER_OTLP_HEADERS: Headers in "Authorization=Basic xxx" format
   *   - Or: GRAFANA_INSTANCE_ID + GRAFANA_OTLP_TOKEN for Grafana Cloud
   *
   * - If explicitly provided, uses the given config
   *
   * - If env vars not set and no explicit config, spans/logs are not exported
   */
  exporter?: OTLPExporterConfig;

  /**
   * Disable OTLP export entirely (even if env vars are set)
   * Useful for local development without export
   */
  disableExport?: boolean;

  /**
   * URL patterns to ignore from tracing (fetch handler only)
   * Useful for health check endpoints that don't need tracing
   *
   * Can be:
   * - string: exact match on pathname (e.g., "/health", "/ready")
   * - RegExp: pattern match on pathname (e.g., /^\/health/)
   *
   * When a request matches, the original handler is called without creating spans
   *
   * Default: ["/health", "/healthz", "/ready", "/readyz", "/live", "/livez", "/ping"]
   *
   * Pass an empty array to disable default ignoring.
   *
   * @example
   * // Use custom patterns
   * instrument(handler, {
   *   ignoreUrls: ["/health", "/healthz", /^\/internal\//]
   * })
   *
   * @example
   * // Disable default ignoring (trace all URLs)
   * instrument(handler, {
   *   ignoreUrls: []
   * })
   */
  ignoreUrls?: (string | RegExp)[];
}

/**
 * Cloudflare Workers ExportedHandler interface with generic queue message type
 */
export interface ExportedHandler<Env = unknown, QueueMessage = unknown> {
  fetch?: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>;
  queue?: (
    batch: MessageBatch<QueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ) => void | Promise<void>;
  scheduled?: (
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) => void | Promise<void>;
}

/**
 * Cloudflare MessageBatch interface
 */
interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

/**
 * Cloudflare Message interface
 */
interface Message<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/**
 * Cloudflare ScheduledController interface
 */
interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

/**
 * Cloudflare ExecutionContext interface
 * Using generic Props to match @cloudflare/workers-types
 */
interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: Props;
}

/**
 * Key for trace context in queue message body
 */
export const TRACE_CONTEXT_KEY = "_traceparent";

/**
 * Helper to inject trace context into a message body for queue propagation
 *
 * @example
 * await env.QUEUE.send(withTraceContext({ orderId: 123 }));
 */
export function withTraceContext<T extends Record<string, unknown>>(
  body: T,
): T & { _traceparent?: string } {
  const traceparent = getTraceparent();
  if (traceparent) {
    return { ...body, [TRACE_CONTEXT_KEY]: traceparent };
  }
  return body;
}

/**
 * Cloudflare Queue interface for type safety
 */
interface Queue<T = unknown> {
  send(message: T, options?: { contentType?: string }): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: T; contentType?: string }>,
  ): Promise<void>;
}

/**
 * Wrapped Queue that automatically creates PRODUCER spans and injects trace context
 */
interface TracedQueue<T extends Record<string, unknown>> {
  send(message: T, options?: { contentType?: string }): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: T; contentType?: string }>,
  ): Promise<void>;
}

/**
 * Wrap a Cloudflare Queue with automatic PRODUCER span creation
 *
 * Creates a PRODUCER span for each send/sendBatch operation and
 * automatically injects trace context into the message body.
 *
 * @example
 * const tracedQueue = wrapQueue(env.MY_QUEUE, 'my-queue');
 * await tracedQueue.send({ orderId: 123 });
 * // Creates PRODUCER span and injects _traceparent automatically
 */
export function wrapQueue<T extends Record<string, unknown>>(
  queue: Queue<T & { _traceparent?: string }>,
  queueName: string,
): TracedQueue<T> {
  const tracer = trace.getTracer("otel-cloudflare");

  return {
    send(message: T, options?: { contentType?: string }): Promise<void> {
      return tracer.startActiveSpan(
        `queue:${queueName}:send`,
        { kind: SpanKind.PRODUCER },
        async (span) => {
          try {
            const tracedMessage = withTraceContext(message);
            await queue.send(tracedMessage, options);
            span.end();
          } catch (error) {
            // Log the error
            getLogger().error("Error sending to queue", {
              queue: queueName,
              error: (error as Error).message,
              stack: (error as Error).stack,
            });

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
    },

    sendBatch(
      messages: Iterable<{ body: T; contentType?: string }>,
    ): Promise<void> {
      return tracer.startActiveSpan(
        `queue:${queueName}:sendBatch`,
        { kind: SpanKind.PRODUCER },
        async (span) => {
          try {
            const tracedMessages = Array.from(messages).map((msg) => ({
              ...msg,
              body: withTraceContext(msg.body),
            }));
            await queue.sendBatch(tracedMessages);
            span.end();
          } catch (error) {
            // Log the error
            getLogger().error("Error sending batch to queue", {
              queue: queueName,
              error: (error as Error).message,
              stack: (error as Error).stack,
            });

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
    },
  };
}

/**
 * Extract SpanContext from queue message body
 */
function extractSpanContextFromMessage(body: unknown): SpanContext | null {
  if (
    typeof body === "object" &&
    body !== null &&
    TRACE_CONTEXT_KEY in body &&
    typeof (body as Record<string, unknown>)[TRACE_CONTEXT_KEY] === "string"
  ) {
    return spanContextFromTraceparent(
      (body as Record<string, string>)[TRACE_CONTEXT_KEY],
    );
  }
  return null;
}

/**
 * Resolve options from static object or function
 */
function resolveOptions<Env>(
  options: InstrumentOptions<Env> | undefined,
  env: Env,
): InstrumentOptionsObject {
  if (!options) {
    return {};
  }
  if (typeof options === "function") {
    return options(env);
  }
  return options;
}

// ============================================
// Standalone Request Tracing
// ============================================

/**
 * Options for traceHandler
 */
export interface TraceHandlerOptions {
  /**
   * Environment variables for OTLP configuration
   */
  env?: Record<string, unknown>;

  /**
   * Service name for telemetry
   * @default "unknown"
   */
  serviceName?: string;

  /**
   * URL patterns to ignore from tracing
   * Same format as InstrumentOptionsObject.ignoreUrls
   */
  ignoreUrls?: (string | RegExp)[];
}

/**
 * Trace an incoming HTTP request with full instrumentation
 *
 * This is a standalone function for use in non-standard environments like SvelteKit.
 * It provides the same functionality as the instrumented fetch handler:
 * - Creates SERVER span with HTTP semantic convention attributes
 * - Extracts traceparent from request headers for distributed tracing
 * - Captures request/response body (truncated to 8KB, text-based content only)
 * - Logs request summary with method, path, status, size, and duration
 * - Adds traceparent header to response for downstream correlation
 * - Automatically initializes OTLP and flushes telemetry via ctx.waitUntil
 *
 * @param ctx - Cloudflare ExecutionContext (provides waitUntil for non-blocking flush)
 * @param request - The incoming HTTP request
 * @param handler - The request handler function that receives the span
 * @param options - Optional configuration
 *
 * @example
 * // SvelteKit hooks.server.ts
 * import { traceHandler } from '@tigorlazuardi/otel-cloudflare';
 *
 * export const handle: Handle = async ({ event, resolve }) => {
 *   return traceHandler(
 *     event.platform!.context,
 *     event.request,
 *     (span) => resolve(event),
 *     { env: event.platform?.env, serviceName: 'my-service' }
 *   );
 * };
 *
 * @example
 * // Next.js with OpenNext Cloudflare
 * import { traceHandler } from '@tigorlazuardi/otel-cloudflare';
 * import { getCloudflareContext } from '@opennextjs/cloudflare';
 *
 * export async function middleware(request: NextRequest) {
 *   const { env, ctx } = await getCloudflareContext();
 *   return traceHandler(ctx, request, () => NextResponse.next(), { env, serviceName: 'my-app' });
 * }
 */
export async function traceHandler(
  ctx: ExecutionContext,
  request: Request,
  handler: (span: Span) => Promise<Response>,
  options?: TraceHandlerOptions,
): Promise<Response> {
  // Initialize OTLP
  const flushCtx = initOTLP(options?.env, options?.serviceName ?? "unknown");

  try {
    // Skip tracing for ignored URLs - pass a no-op span
    if (shouldIgnoreUrl(request, options?.ignoreUrls)) {
      const noopSpan = trace.getTracer("otel-cloudflare").startSpan("noop");
      noopSpan.end();
      return await handler(noopSpan);
    }

    // Extract traceparent from request headers
    const incomingTraceparent = request.headers.get("traceparent");
    const parentSpanContext = incomingTraceparent
      ? spanContextFromTraceparent(incomingTraceparent)
      : null;

    const tracer = trace.getTracer("otel-cloudflare");
    const url = new URL(request.url);
    const spanName = `${request.method} ${url.pathname}`;

    // Set up parent context
    let parentContext = context.active();
    if (parentSpanContext) {
      const parentSpan = trace.wrapSpanContext(parentSpanContext);
      parentContext = trace.setSpan(context.active(), parentSpan);
    }

    return await context.with(parentContext, () => {
      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": request.method,
            "url.full": request.url,
            "url.scheme": url.protocol.replace(":", ""),
            "url.path": url.pathname,
            "url.query": url.search ? url.search.slice(1) : undefined,
            "server.address": url.hostname,
            "server.port": url.port
              ? parseInt(url.port, 10)
              : url.protocol === "https:"
                ? 443
                : 80,
          },
        },
        async (span) => {
          // Get traceparent for response header
          const traceparent = getTraceparent();
          const startTime = Date.now();
          const userAgent = request.headers.get("user-agent");

          // Capture request body (truncated, only for text-based content)
          // Note: We only capture for logging, the handler receives the original request
          // For SvelteKit, the body is usually not consumed before resolve()
          const requestContentType = request.headers.get("content-type");
          const [requestBody, _requestBodyStream] = await readBodyWithTruncate(
            request.body,
            requestContentType,
          );

          try {
            const response = await handler(span);
            const duration = Date.now() - startTime;

            // Capture response body (truncated, only for text-based content)
            const responseContentType = response.headers.get("content-type");
            const [responseBody, responseBodyStream] =
              await readBodyWithTruncate(response.body, responseContentType);

            // Get response size from Content-Length header or actual body length
            const contentLength = response.headers.get("content-length");
            const bytes = contentLength
              ? parseInt(contentLength, 10)
              : responseBody.length;

            // Record status code and set error status if >= 400
            span.setAttribute("http.response.status_code", response.status);
            if (response.status >= 400) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: `HTTP ${response.status}`,
              });
            }

            span.end();

            // Log request summary with bodies
            const logMessage = `${request.method} ${url.pathname} - ${response.status} - ${formatBytes(bytes)} - ${formatDuration(duration)}`;
            const logAttrs: Record<string, unknown> = {};
            if (userAgent) {
              logAttrs.userAgent = userAgent;
            }
            if (requestBody) {
              logAttrs.requestBody = requestBody;
            }
            if (responseBody) {
              logAttrs.responseBody = responseBody;
            }

            if (response.status >= 400) {
              getLogger().error(logMessage, logAttrs);
            } else {
              getLogger().info(logMessage, logAttrs);
            }

            // Build response with traceparent header
            const headers = new Headers(response.headers);
            if (traceparent) {
              headers.set("traceparent", traceparent);
            }

            return new Response(responseBodyStream, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          } catch (error) {
            const traceId = span.spanContext().traceId;
            const duration = Date.now() - startTime;

            // Log the error
            getLogger().error(
              `${request.method} ${url.pathname} - 500 - ${formatDuration(duration)}`,
              {
                error: (error as Error).message,
                stack: (error as Error).stack,
                userAgent,
              },
            );

            span.recordException(error as Error);
            span.setAttribute("http.response.status_code", 500);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: (error as Error).message,
            });
            span.end();

            // Return error response with Request ID (trace ID)
            const errorHeaders: Record<string, string> = {
              "Content-Type": "text/plain",
            };
            if (traceparent) {
              errorHeaders["traceparent"] = traceparent;
            }

            return new Response(
              `Internal Server Error\nRequest ID: ${traceId}`,
              {
                status: 500,
                headers: errorHeaders,
              },
            );
          }
        },
      );
    });
  } finally {
    // Always flush telemetry via waitUntil (non-blocking)
    ctx.waitUntil(flushCtx.flush());
  }
}

/**
 * Alias for traceHandler - trace an incoming HTTP request
 *
 * @see traceHandler for full documentation
 */
export const traceRequest = traceHandler;

/**
 * Default URLs to ignore from tracing (health check endpoints)
 */
export const DEFAULT_IGNORE_URLS: (string | RegExp)[] = [
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/live",
  "/livez",
  "/ping",
];

/**
 * Check if a request URL should be ignored from tracing
 */
function shouldIgnoreUrl(
  request: Request,
  ignoreUrls: (string | RegExp)[] | undefined,
): boolean {
  const patterns = ignoreUrls ?? DEFAULT_IGNORE_URLS;

  if (patterns.length === 0) {
    return false;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  return patterns.some((pattern) => {
    if (typeof pattern === "string") {
      return pathname === pattern;
    }
    return pattern.test(pathname);
  });
}

/**
 * Get OTLP config from options or auto-detect from env
 */
function getExporterConfig(
  opts: InstrumentOptionsObject,
  env: Record<string, unknown>,
): OTLPExporterConfig | null {
  // Explicit disable
  if (opts.disableExport) {
    return null;
  }

  // Explicit config takes priority
  if (opts.exporter) {
    // Merge serviceName from options if not in exporter config
    return {
      ...opts.exporter,
      serviceName: opts.exporter.serviceName ?? opts.serviceName,
    };
  }

  // Auto-detect from env
  const config = getOTLPConfigFromEnv(env);
  if (config && opts.serviceName) {
    // Options serviceName overrides env-detected one
    config.serviceName = opts.serviceName;
  }
  return config;
}

/**
 * Run handler with a new span, using standard OpenTelemetry context API
 */
function runWithSpan<T>(
  name: string,
  kind: SpanKind,
  parentSpanContext: SpanContext | null,
  fn: () => T,
): T {
  const tracer = trace.getTracer("otel-cloudflare");

  // Determine parent context
  let parentContext = context.active();
  if (parentSpanContext) {
    const parentSpan = trace.wrapSpanContext(parentSpanContext);
    parentContext = trace.setSpan(context.active(), parentSpan);
  }

  // Use standard OpenTelemetry API
  return context.with(parentContext, () => {
    return tracer.startActiveSpan(name, { kind }, (span) => {
      try {
        const result = fn();

        if (result instanceof Promise) {
          return (result as Promise<unknown>)
            .then((value) => {
              span.end();
              return value;
            })
            .catch((error) => {
              // Log the error
              getLogger().error("Unhandled error in handler", {
                error: (error as Error).message,
                stack: (error as Error).stack,
              });

              span.recordException(error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
              });
              span.end();
              throw error;
            }) as T;
        }

        span.end();
        return result;
      } catch (error) {
        // Log the error
        getLogger().error("Unhandled error in handler", {
          error: (error as Error).message,
          stack: (error as Error).stack,
        });

        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        span.end();
        throw error;
      }
    });
  });
}

/**
 * Wrap a Cloudflare Workers handler with automatic tracing
 *
 * - fetch: extracts traceparent from request headers, or creates root span
 * - queue: extracts traceparent from message body (_traceparent field), or creates root span
 * - scheduled: generates new root span for each invocation
 *
 * @example
 * // Basic usage (no export, just context propagation)
 * export default instrument({
 *   async fetch(request, env, ctx) {
 *     const logger = getLogger();
 *     logger.info('handling request'); // includes trace_id, span_id
 *     return new Response('OK');
 *   },
 * });
 *
 * @example
 * // With typed queue messages
 * interface MyMessage {
 *   orderId: string;
 *   _traceparent?: string;
 * }
 *
 * export default instrument<Env, MyMessage>({
 *   async queue(batch, env, ctx) {
 *     for (const msg of batch.messages) {
 *       console.log(msg.body.orderId); // typed!
 *     }
 *   },
 * });
 */
export function instrument<Env, QueueMessage = unknown>(
  handler: ExportedHandler<Env, QueueMessage>,
  options?: InstrumentOptions<Env>,
): ExportedHandler<Env, QueueMessage> {
  const instrumented: ExportedHandler<Env, QueueMessage> = {};

  if (handler.fetch) {
    const originalFetch = handler.fetch;

    instrumented.fetch = async (
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> => {
      const opts = resolveOptions(options, env);

      // Skip tracing for ignored URLs (e.g., health checks)
      if (shouldIgnoreUrl(request, opts.ignoreUrls)) {
        return originalFetch(request, env, ctx);
      }

      const serviceName = opts.serviceName ?? "cloudflare-worker";
      const exporterConfig = getExporterConfig(
        opts,
        env as Record<string, unknown>,
      );

      // Initialize OTLP (sets up tracing provider and collectors, idempotent)
      const flushCtx = initOTLP(
        env as Record<string, unknown>,
        serviceName,
        exporterConfig,
      );

      // Extract traceparent from request headers
      const traceparent = request.headers.get("traceparent");
      const parentSpanContext = traceparent
        ? spanContextFromTraceparent(traceparent)
        : null;

      const tracer = trace.getTracer("otel-cloudflare");
      const url = new URL(request.url);
      const spanName = `${request.method} ${url.pathname}`;

      // Set up parent context
      let parentContext = context.active();
      if (parentSpanContext) {
        const parentSpan = trace.wrapSpanContext(parentSpanContext);
        parentContext = trace.setSpan(context.active(), parentSpan);
      }

      const result = await context.with(parentContext, () => {
        return tracer.startActiveSpan(
          spanName,
          {
            kind: SpanKind.SERVER,
            attributes: {
              "http.request.method": request.method,
              "url.full": request.url,
              "url.scheme": url.protocol.replace(":", ""),
              "url.path": url.pathname,
              "url.query": url.search ? url.search.slice(1) : undefined,
              "server.address": url.hostname,
              "server.port": url.port
                ? parseInt(url.port, 10)
                : url.protocol === "https:"
                  ? 443
                  : 80,
            },
          },
          async (span) => {
            // Get traceparent for response header
            const traceparent = getTraceparent();
            const startTime = Date.now();
            const userAgent = request.headers.get("user-agent");

            // Capture request body (truncated, only for text-based content)
            const requestContentType = request.headers.get("content-type");
            const [requestBody, requestBodyStream] = await readBodyWithTruncate(
              request.body,
              requestContentType,
            );
            const tracedRequest = requestBodyStream
              ? new Request(request, { body: requestBodyStream })
              : request;

            try {
              const response = await originalFetch(tracedRequest, env, ctx);
              const duration = Date.now() - startTime;

              // Capture response body (truncated, only for text-based content)
              const responseContentType = response.headers.get("content-type");
              const [responseBody, responseBodyStream] =
                await readBodyWithTruncate(response.body, responseContentType);

              // Get response size from Content-Length header or actual body length
              const contentLength = response.headers.get("content-length");
              const bytes = contentLength
                ? parseInt(contentLength, 10)
                : responseBody.length;

              // Record status code and set error status if >= 400
              span.setAttribute("http.response.status_code", response.status);
              if (response.status >= 400) {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: `HTTP ${response.status}`,
                });
              }

              span.end();

              // Log request summary with bodies
              const logMessage = `${request.method} ${url.pathname} - ${response.status} - ${formatBytes(bytes)} - ${formatDuration(duration)}`;
              const logAttrs: Record<string, unknown> = {};
              if (userAgent) {
                logAttrs.userAgent = userAgent;
              }
              if (requestBody) {
                logAttrs.requestBody = requestBody;
              }
              if (responseBody) {
                logAttrs.responseBody = responseBody;
              }

              if (response.status >= 400) {
                getLogger().error(logMessage, logAttrs);
              } else {
                getLogger().info(logMessage, logAttrs);
              }

              // Build response with traceparent header
              const headers = new Headers(response.headers);
              if (traceparent) {
                headers.set("traceparent", traceparent);
              }

              return new Response(responseBodyStream, {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
            } catch (error) {
              const traceId = span.spanContext().traceId;

              // Log the error
              getLogger().error("Unhandled error in fetch handler", {
                error: (error as Error).message,
                stack: (error as Error).stack,
              });

              span.recordException(error as Error);
              span.setAttribute("http.response.status_code", 500);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (error as Error).message,
              });
              span.end();

              // Return error response with Request ID (trace ID)
              const errorHeaders: Record<string, string> = {
                "Content-Type": "text/plain",
              };
              if (traceparent) {
                errorHeaders["traceparent"] = traceparent;
              }
              return new Response(
                `Internal Server Error\nRequest ID: ${traceId}`,
                {
                  status: 500,
                  headers: errorHeaders,
                },
              );
            }
          },
        );
      });

      // Export via waitUntil (flush handles cleanup)
      ctx.waitUntil(flushCtx.flush());

      return result;
    };
  }

  if (handler.queue) {
    const originalQueue = handler.queue;

    instrumented.queue = async (
      batch: MessageBatch<QueueMessage>,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<void> => {
      const opts = resolveOptions(options, env);
      const serviceName = opts.serviceName ?? "cloudflare-worker";
      const exporterConfig = getExporterConfig(
        opts,
        env as Record<string, unknown>,
      );

      // Initialize OTLP (sets up tracing provider and collectors, idempotent)
      const flushCtx = initOTLP(
        env as Record<string, unknown>,
        serviceName,
        exporterConfig,
      );

      // Extract trace from first message
      const firstMessage = batch.messages[0];
      const parentSpanContext = firstMessage
        ? extractSpanContextFromMessage(firstMessage.body)
        : null;

      await runWithSpan(
        `queue:${batch.queue}`,
        SpanKind.CONSUMER,
        parentSpanContext,
        () => originalQueue(batch, env, ctx),
      );

      // Export via waitUntil (flush handles cleanup)
      ctx.waitUntil(flushCtx.flush());
    };
  }

  if (handler.scheduled) {
    const originalScheduled = handler.scheduled;

    instrumented.scheduled = async (
      controller: ScheduledController,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<void> => {
      const opts = resolveOptions(options, env);
      const serviceName = opts.serviceName ?? "cloudflare-worker";
      const exporterConfig = getExporterConfig(
        opts,
        env as Record<string, unknown>,
      );

      // Initialize OTLP (sets up tracing provider and collectors, idempotent)
      const flushCtx = initOTLP(
        env as Record<string, unknown>,
        serviceName,
        exporterConfig,
      );

      // Scheduled always gets a new root span (no parent)
      await runWithSpan(
        `scheduled:${controller.cron}`,
        SpanKind.INTERNAL,
        null,
        () => originalScheduled(controller, env, ctx),
      );

      // Export via waitUntil (flush handles cleanup)
      ctx.waitUntil(flushCtx.flush());
    };
  }

  return instrumented;
}
