/**
 * Instrumented fetch for outgoing HTTP requests
 *
 * Automatically creates CLIENT spans and injects traceparent header
 * for trace context propagation to downstream services.
 */

import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTraceparent } from "./provider.js";
import { getLogger } from "./logger.js";

// ============================================
// Body Capture Utilities
// ============================================

/** Maximum body size to capture (8KB) */
const MAX_BODY_SIZE = 8192;

/** Content types that should have their body captured */
const LOGGABLE_CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "text/plain",
];

/**
 * Check if a content type should have its body captured
 */
function isLoggableContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return LOGGABLE_CONTENT_TYPES.includes(base);
}

/**
 * Read body from a string or ReadableStream with truncation
 * Returns [bodyText, newBody] where newBody is a replacement stream if needed
 */
async function captureBody(
  body: BodyInit | null | undefined,
  contentType: string | null,
): Promise<[string, BodyInit | null | undefined]> {
  if (!body) return ["", body];
  if (!isLoggableContentType(contentType)) return ["", body];

  // Handle string body directly
  if (typeof body === "string") {
    const text =
      body.length > MAX_BODY_SIZE
        ? body.slice(0, MAX_BODY_SIZE) + "...[truncated]"
        : body;
    return [text, body];
  }

  // Handle URLSearchParams
  if (body instanceof URLSearchParams) {
    const text = body.toString();
    const truncated =
      text.length > MAX_BODY_SIZE
        ? text.slice(0, MAX_BODY_SIZE) + "...[truncated]"
        : text;
    return [truncated, body];
  }

  // Handle ArrayBuffer
  if (body instanceof ArrayBuffer) {
    try {
      const decoder = new TextDecoder();
      const text = decoder.decode(body);
      const truncated =
        text.length > MAX_BODY_SIZE
          ? text.slice(0, MAX_BODY_SIZE) + "...[truncated]"
          : text;
      return [truncated, body];
    } catch {
      return ["", body];
    }
  }

  // Handle ReadableStream with tee()
  if (body instanceof ReadableStream) {
    const [stream1, stream2] = body.tee();
    const reader = stream1.getReader();
    const decoder = new TextDecoder();
    let result = "";

    try {
      while (result.length < MAX_BODY_SIZE) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      if (result.length > MAX_BODY_SIZE) {
        result = result.slice(0, MAX_BODY_SIZE) + "...[truncated]";
      }
    } finally {
      reader.cancel();
    }

    return [result, stream2];
  }

  // For Blob, FormData, etc. - don't capture
  return ["", body];
}

/**
 * Capture response body using tee() without consuming the original
 */
async function captureResponseBody(
  response: Response,
): Promise<[string, Response]> {
  const contentType = response.headers.get("content-type");
  if (!isLoggableContentType(contentType)) {
    return ["", response];
  }

  if (!response.body) {
    return ["", response];
  }

  const [stream1, stream2] = response.body.tee();
  const reader = stream1.getReader();
  const decoder = new TextDecoder();
  let result = "";

  try {
    while (result.length < MAX_BODY_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    if (result.length > MAX_BODY_SIZE) {
      result = result.slice(0, MAX_BODY_SIZE) + "...[truncated]";
    }
  } finally {
    reader.cancel();
  }

  // Create new response with the second stream
  const newResponse = new Response(stream2, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  return [result, newResponse];
}

/**
 * Options for traced fetch
 */
export interface TracedFetchOptions {
  /**
   * Custom span name. Defaults to "HTTP {method}"
   */
  spanName?: string;

  /**
   * Whether to skip tracing for this request
   * Useful for conditional tracing
   */
  skipTracing?: boolean;
}

/**
 * Create an instrumented fetch function that automatically:
 * - Creates a CLIENT span for each outgoing request
 * - Injects traceparent header for distributed tracing
 * - Records HTTP attributes (method, URL, status code)
 *
 * @example
 * const fetch = tracedFetch();
 *
 * // Use like regular fetch - tracing happens automatically
 * const response = await fetch('https://api.example.com/users');
 *
 * @example
 * // Skip tracing for specific requests
 * const fetch = tracedFetch();
 * const response = await fetch('https://api.example.com/health', {}, { skipTracing: true });
 */
export function tracedFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): (
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: TracedFetchOptions,
) => Promise<Response> {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
    options?: TracedFetchOptions,
  ): Promise<Response> => {
    // Skip tracing if requested
    if (options?.skipTracing) {
      return baseFetch(input, init);
    }

    // Parse URL for span attributes
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsedUrl = new URL(url);
    const method = init?.method ?? "GET";

    // Create span name
    const spanName = options?.spanName ?? `HTTP ${method}`;

    const tracer = trace.getTracer("otel-cloudflare");

    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "http.request.method": method,
          "url.full": url,
          "url.scheme": parsedUrl.protocol.replace(":", ""),
          "server.address": parsedUrl.hostname,
          "server.port": parsedUrl.port
            ? parseInt(parsedUrl.port, 10)
            : parsedUrl.protocol === "https:"
              ? 443
              : 80,
          "url.path": parsedUrl.pathname,
          "url.query": parsedUrl.search ? parsedUrl.search.slice(1) : undefined,
        },
      },
      async (span) => {
        const logAttrs: Record<string, unknown> = {};
        const startTime = Date.now();
        logAttrs.start = new Date(startTime).toISOString();
        try {
          // Inject traceparent header
          const headers = new Headers(init?.headers);
          headers.set("traceparent", getTraceparent()!);
          const requestLog: Record<string, unknown> = {
            headers: Object.fromEntries(headers.entries()),
            url,
          };
          if (headers.get("authorization")) {
            (requestLog.headers as Record<string, string>).authorization = "[redacted]";
          }

          // Capture request body (uses tee for streams, only reads up to 8KB)
          const requestContentType = headers.get("content-type");
          const [requestBody, newBody] = await captureBody(
            init?.body,
            requestContentType,
          );
          if (requestBody) {
            requestLog.body = requestBody;
          }
          logAttrs.request = requestLog;

          const response = await baseFetch(input, {
            ...init,
            headers,
            body: newBody,
          });
          const end = Date.now();
          logAttrs.end = new Date(end).toISOString();
          logAttrs.duration_ms = end - startTime;
          logAttrs.response = {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          };

          // Record response attributes
          span.setAttribute("http.response.status_code", response.status);

          // Capture response body (uses tee, only reads up to 8KB)
          const [responseBody, newResponse] =
            await captureResponseBody(response);
          if (responseBody) {
            logAttrs.response_body = responseBody;
          }

          // Set error status for 4xx/5xx responses
          if (response.status >= 400) {
            getLogger().error(`http client: ${method} ${url}`, logAttrs);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `HTTP ${response.status}`,
            });
          } else {
            getLogger().info(`http client: ${method} ${url}`, logAttrs);
          }

          span.end();
          return newResponse;
        } catch (error) {
          getLogger().error(`http client error: ${method} ${url} - ${error}`, {
            ...logAttrs,
            error: (error as Error).message,
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
  };
}

/**
 * Instrumented fetch that can be used as a drop-in replacement
 *
 * Uses the global fetch and automatically adds tracing.
 * The third parameter allows passing TracedFetchOptions.
 *
 * @example
 * import { instrumentedFetch } from '@tigorlazuardi/otel-cloudflare';
 *
 * // Use like regular fetch
 * const response = await instrumentedFetch('https://api.example.com/data');
 *
 * // With options
 * const response = await instrumentedFetch('https://api.example.com/data', {
 *   method: 'POST',
 *   body: JSON.stringify({ foo: 'bar' }),
 * });
 */
export const instrumentedFetch = tracedFetch();

// Store original fetch for restoration
let originalFetch: typeof globalThis.fetch | null = null;

/**
 * Get the original unpatched fetch function.
 * Returns null if global fetch has not been patched.
 * Use this for internal operations that should not be traced (e.g., OTLP export).
 */
export function getOriginalFetch(): typeof globalThis.fetch | null {
  return originalFetch;
}

/**
 * Patch globalThis.fetch to automatically trace all outgoing requests.
 * This is called by initOTLP() and instrument().
 *
 * Idempotent - calling multiple times has no effect.
 */
export function patchGlobalFetch(): void {
  // Already patched
  if (originalFetch !== null) {
    return;
  }

  originalFetch = globalThis.fetch;
  const traced = tracedFetch(originalFetch);

  // Patch global fetch - wrap to match standard fetch signature
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return traced(input, init);
  }) as typeof globalThis.fetch;
}

/**
 * Restore original globalThis.fetch.
 * Useful for testing or cleanup.
 */
export function unpatchGlobalFetch(): void {
  if (originalFetch !== null) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}
