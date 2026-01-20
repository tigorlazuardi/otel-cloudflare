import { AsyncLocalStorage } from "node:async_hooks";
import { trace, context } from "@opentelemetry/api";
import { CallerInfo } from "./caller.js";

/** Storage for logger instance */
const loggerStorage = new AsyncLocalStorage<Logger>();

/** Storage for contextual attributes */
const attrsStorage = new AsyncLocalStorage<Record<string, unknown>>();

/** Default shared logger instance */
let defaultLogger: Logger | undefined;

/**
 * Get the current logger from context, or default logger if none
 */
export function getLogger(): Logger {
  return loggerStorage.getStore() ?? (defaultLogger ??= new Logger());
}

/**
 * Run a function with a logger in context
 */
export function runWithLogger<T>(logger: Logger, fn: (logger: Logger) => T): T {
  return loggerStorage.run(logger, () => fn(logger));
}

/**
 * Get current contextual attributes
 */
export function getAttrs(): Record<string, unknown> {
  return attrsStorage.getStore() ?? {};
}

/**
 * Run a function with additional contextual attributes
 * Attributes are merged with any existing context attributes
 */
export function withAttrs<T>(
  attrs: Record<string, unknown>,
  fn: (attrs: Record<string, unknown>) => T,
): T {
  const current = getAttrs();
  const merged = { ...current, ...attrs };
  return attrsStorage.run(merged, () => fn(merged));
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogOptions {
  /** Override caller info */
  caller?: CallerInfo;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  attributes: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  caller?: CallerInfo;
}

export interface LogHandler {
  handle(entry: LogEntry): void;
}

/**
 * Console log handler - outputs structured JSON to console
 * Prefixes message with trace ID for easy searching in Cloudflare dashboard
 */
export class ConsoleLogHandler implements LogHandler {
  handle(entry: LogEntry): void {
    // Prefix message with trace ID for searchability in Cloudflare Events
    const msgWithTrace = entry.traceId
      ? `[${entry.traceId}] ${entry.message}`
      : entry.message;

    const output: Record<string, unknown> = {
      level: entry.level,
      msg: msgWithTrace,
      time: entry.timestamp.toISOString(),
      ...entry.attributes,
    };

    if (entry.traceId) {
      output.trace_id = entry.traceId;
    }
    if (entry.spanId) {
      output.span_id = entry.spanId;
    }
    if (entry.caller && !entry.caller.isEmpty()) {
      output.caller = entry.caller.toString();
    }

    const json = JSON.stringify(output);

    switch (entry.level) {
      case "trace":
      case "debug":
        console.debug(json);
        break;
      case "info":
        console.info(json);
        break;
      case "warn":
        console.warn(json);
        break;
      case "error":
      case "fatal":
        console.error(json);
        break;
    }
  }
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m", // gray
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  fatal: "\x1b[35m", // magenta
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * OTLP log handler - collects logs for batch export to OTLP endpoint
 */
export class OTLPLogHandler implements LogHandler {
  private logs: LogEntry[] = [];

  handle(entry: LogEntry): void {
    this.logs.push(entry);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }
}

/**
 * Composite log handler - sends logs to multiple handlers
 * Useful for both console output and OTLP collection
 */
export class CompositeLogHandler implements LogHandler {
  constructor(private handlers: LogHandler[]) {}

  handle(entry: LogEntry): void {
    for (const h of this.handlers) {
      h.handle(entry);
    }
  }
}

/** Active OTLP log handler for collecting logs */
let activeLogHandler: OTLPLogHandler | null = null;

/**
 * Set the active OTLP log handler
 * Called internally by instrument() or can be set manually for custom setups
 */
export function setOTLPLogHandler(handler: OTLPLogHandler | null): void {
  activeLogHandler = handler;
}

/**
 * Get the active OTLP log handler
 */
export function getOTLPLogHandler(): OTLPLogHandler | null {
  return activeLogHandler;
}

/**
 * Pretty log handler - outputs human-readable colored logs for local development
 */
export class PrettyLogHandler implements LogHandler {
  handle(entry: LogEntry): void {
    const color = LEVEL_COLORS[entry.level];
    const level = entry.level.toUpperCase().padEnd(5);
    const time = entry.timestamp.toISOString().slice(11, 23); // HH:mm:ss.SSS

    let line = `${DIM}${time}${RESET} ${color}${level}${RESET} ${entry.message}`;

    // Add trace context if present
    if (entry.traceId || entry.spanId) {
      const traceShort = entry.traceId?.slice(0, 8) ?? "--------";
      const spanShort = entry.spanId?.slice(0, 8) ?? "--------";
      line += ` ${DIM}[${traceShort}:${spanShort}]${RESET}`;
    }

    // Add caller if present
    if (entry.caller && !entry.caller.isEmpty()) {
      line += ` ${DIM}@ ${entry.caller.toString()}${RESET}`;
    }

    // Add attributes if any
    const attrKeys = Object.keys(entry.attributes);
    if (attrKeys.length > 0) {
      line += ` ${DIM}${JSON.stringify(entry.attributes)}${RESET}`;
    }

    switch (entry.level) {
      case "trace":
      case "debug":
        console.debug(line);
        break;
      case "info":
        console.info(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
      case "fatal":
        console.error(line);
        break;
    }
  }
}

/**
 * Structured logger with OpenTelemetry trace context integration
 */
export class Logger {
  private handler: LogHandler;
  private baseAttrs: Record<string, unknown>;

  constructor(
    opts: { handler?: LogHandler; attrs?: Record<string, unknown> } = {},
  ) {
    this.handler = opts.handler ?? new ConsoleLogHandler();
    this.baseAttrs = opts.attrs ?? {};
  }

  /**
   * Create a child logger with additional base attributes
   */
  child(attrs: Record<string, unknown>): Logger {
    return new Logger({
      handler: this.handler,
      attrs: { ...this.baseAttrs, ...attrs },
    });
  }

  /**
   * Run a function with this logger in context
   */
  run<T>(fn: () => T): T {
    return runWithLogger(this, fn);
  }

  private log(
    level: LogLevel,
    msg: string,
    attrs?: Record<string, unknown>,
    opts?: LogOptions,
  ): void {
    // Capture caller info (skip: log -> info/warn/etc -> user code)
    const caller = opts?.caller ?? CallerInfo.from(4);

    // Get trace context from OpenTelemetry standard API
    const span = trace.getSpan(context.active());
    const spanContext = span?.spanContext();

    // Merge attributes: base -> context -> call-site
    const contextAttrs = getAttrs();
    const mergedAttrs = {
      ...this.baseAttrs,
      ...contextAttrs,
      ...attrs,
    };

    const entry: LogEntry = {
      level,
      message: msg,
      timestamp: new Date(),
      attributes: mergedAttrs,
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
      caller,
    };

    // Always log to console handler
    this.handler.handle(entry);

    // Also send to OTLP handler if one is active (for export)
    if (activeLogHandler) {
      activeLogHandler.handle(entry);
    }
  }

  trace(msg: string, attrs?: Record<string, unknown>, opts?: LogOptions): void {
    this.log("trace", msg, attrs, opts);
  }

  debug(msg: string, attrs?: Record<string, unknown>, opts?: LogOptions): void {
    this.log("debug", msg, attrs, opts);
  }

  info(msg: string, attrs?: Record<string, unknown>, opts?: LogOptions): void {
    this.log("info", msg, attrs, opts);
  }

  warn(msg: string, attrs?: Record<string, unknown>, opts?: LogOptions): void {
    this.log("warn", msg, attrs, opts);
  }

  error(msg: string, attrs?: Record<string, unknown>, opts?: LogOptions): void {
    this.log("error", msg, attrs, opts);
  }

  fatal(msg: string, attrs?: Record<string, unknown>, opts?: LogOptions): void {
    this.log("fatal", msg, attrs, opts);
  }
}
