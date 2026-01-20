/**
 * Force Flush API for OTLP Export
 *
 * Provides manual flush capability for non-standard contexts like SvelteKit
 * where the instrument() pattern doesn't apply.
 */

import {
  getSpanProcessor,
  SimpleSpanProcessor,
  setSpanProcessor,
  initTracing,
} from "./provider.js";
import {
  getOTLPLogHandler,
  setOTLPLogHandler,
  OTLPLogHandler,
} from "./logger.js";
import {
  exportTraces,
  exportLogs,
  getOTLPConfigFromEnv,
  type OTLPExporterConfig,
  type ExportableSpan,
} from "./otlp.js";
import { patchGlobalFetch } from "./fetch.js";

export type { OTLPExporterConfig };

// ============================================
// Flush Context
// ============================================

/**
 * Flush context for managing collectors in a request lifecycle
 */
export interface FlushContext {
  /** Collected spans (for manual access if needed) */
  readonly spans: ExportableSpan[];
  /** Collected log count (for diagnostics) */
  readonly logCount: number;
  /** Flush all collected data to OTLP endpoint (does not remove global collectors) */
  flush(): Promise<void>;
  /** Clear all collected data without exporting (does not remove global collectors) */
  clear(): void;
  /** Flush and then remove global collectors - call at end of request lifecycle */
  shutdown(): Promise<void>;
}

/**
 * Initialize OTLP collectors for a request
 *
 * Call this at the beginning of your request handler.
 * Returns a FlushContext that you should call flush() on at the end.
 *
 * @param env - Environment variables (used to auto-detect OTLP config if configOverride not provided)
 * @param serviceName - Service name for telemetry
 * @param configOverride - Optional explicit OTLP config (skips env detection if provided)
 *
 * @example
 * // SvelteKit hooks.server.ts
 * import { initOTLP, type FlushContext } from '@tigorlazuardi/otel-cloudflare';
 *
 * export async function handle({ event, resolve }) {
 *   const ctx = initOTLP(event.platform?.env, 'my-service');
 *
 *   try {
 *     return await resolve(event);
 *   } finally {
 *     // Use waitUntil if available, otherwise await
 *     if (event.platform?.context?.waitUntil) {
 *       event.platform.context.waitUntil(ctx.flush());
 *     } else {
 *       await ctx.flush();
 *     }
 *   }
 * }
 */
export function initOTLP(
  env: Record<string, unknown> | undefined,
  serviceName: string,
  configOverride?: OTLPExporterConfig | null,
): FlushContext {
  // Initialize tracing provider (idempotent)
  initTracing();

  // Patch global fetch to auto-trace outgoing requests (idempotent)
  patchGlobalFetch();

  // Use override if provided, otherwise auto-detect from env
  const config =
    configOverride !== undefined
      ? configOverride
      : env
        ? getOTLPConfigFromEnv(env)
        : null;

  // Reuse existing collectors if already set (idempotent)
  let spanProcessor = getSpanProcessor() as SimpleSpanProcessor | null;
  let logHandler = getOTLPLogHandler();

  if (!spanProcessor) {
    spanProcessor = new SimpleSpanProcessor();
    setSpanProcessor(spanProcessor);
  }

  if (!logHandler) {
    logHandler = new OTLPLogHandler();
    setOTLPLogHandler(logHandler);
  }

  return {
    get spans() {
      return spanProcessor.getSpans() as ExportableSpan[];
    },
    get logCount() {
      return logHandler.getLogs().length;
    },
    async flush() {
      if (!config) {
        // No OTLP config, just clear collectors
        spanProcessor.clear();
        logHandler.clear();
        return;
      }

      const spans = spanProcessor.getSpans();
      const logs = logHandler.getLogs();

      // Export in parallel, catch errors to prevent throwing
      try {
        await Promise.all([
          spans.length > 0
            ? exportTraces(config, spans as ExportableSpan[], serviceName)
            : Promise.resolve(),
          logs.length > 0
            ? exportLogs(config, logs, serviceName)
            : Promise.resolve(),
        ]);
      } catch (error) {
        console.error("[otel-cloudflare] flush error:", error);
      }

      // Clear after export (always, even on error)
      spanProcessor.clear();
      logHandler.clear();
    },
    clear() {
      spanProcessor.clear();
      logHandler.clear();
    },
    async shutdown() {
      await this.flush();
      setSpanProcessor(null);
      setOTLPLogHandler(null);
    },
  };
}

// ============================================
// Standalone Flush Functions
// ============================================

/**
 * Flush all collected traces to OTLP endpoint
 *
 * Uses the currently active span processor. If no processor is active,
 * this is a no-op. Never throws - errors are logged to console.
 */
export async function flushTraces(
  config: OTLPExporterConfig,
  serviceName: string,
): Promise<void> {
  const processor = getSpanProcessor();
  if (!processor) return;

  const spans = processor.getSpans();
  if (spans.length === 0) return;

  try {
    await exportTraces(config, spans as ExportableSpan[], serviceName);
  } catch (error) {
    console.error("[otel-cloudflare] flushTraces error:", error);
  }
  processor.clear();
}

/**
 * Flush all collected logs to OTLP endpoint
 *
 * Uses the currently active OTLP log handler. If no handler is active,
 * this is a no-op. Never throws - errors are logged to console.
 */
export async function flushLogs(
  config: OTLPExporterConfig,
  serviceName: string,
): Promise<void> {
  const handler = getOTLPLogHandler();
  if (!handler) return;

  const logs = handler.getLogs();
  if (logs.length === 0) return;

  try {
    await exportLogs(config, logs, serviceName);
  } catch (error) {
    console.error("[otel-cloudflare] flushLogs error:", error);
  }
  handler.clear();
}

/**
 * Flush all collected traces and logs to OTLP endpoint
 *
 * Convenience function that calls both flushTraces and flushLogs.
 * Never throws - errors are logged to console.
 */
export async function flushAll(
  config: OTLPExporterConfig,
  serviceName: string,
): Promise<void> {
  await Promise.all([
    flushTraces(config, serviceName),
    flushLogs(config, serviceName),
  ]);
}

/**
 * Get OTLP config from environment and flush all collected data
 *
 * Convenience function that reads config from env and flushes.
 * If OTLP is not configured, this is a no-op. Never throws.
 *
 * @example
 * // At end of SvelteKit handle()
 * await flushToEnv(event.platform?.env, 'my-service');
 */
export async function flushToEnv(
  env: Record<string, unknown> | undefined,
  serviceName: string,
): Promise<void> {
  if (!env) return;

  const config = getOTLPConfigFromEnv(env);
  if (!config) return;

  await flushAll(config, serviceName);
}
