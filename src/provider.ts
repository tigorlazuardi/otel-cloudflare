/**
 * Lightweight OpenTelemetry TracerProvider for Cloudflare Workers
 *
 * This provider generates valid trace IDs and span IDs without requiring
 * the full @opentelemetry/sdk-trace-base which has Node.js dependencies
 * that don't work in Workers runtime.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  trace,
  context,
  SpanKind,
  type Tracer,
  type TracerProvider,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Context,
  type TimeInput,
  type Link,
  type SpanStatus,
  type AttributeValue,
  type Attributes,
  type Exception,
  SpanStatusCode,
  TraceFlags,
  ROOT_CONTEXT,
} from "@opentelemetry/api";

/**
 * Generate a random trace ID (32 hex characters)
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random span ID (16 hex characters)
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * W3C Trace Context format: 00-{traceId}-{spanId}-{flags}
 */
export interface TraceContext {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

/**
 * Parse a W3C traceparent header
 * Format: 00-{traceId}-{spanId}-{flags}
 */
export function parseTraceparent(traceparent: string): TraceContext | null {
  const parts = traceparent.split("-");
  if (parts.length !== 4) {
    return null;
  }

  const [version, traceId, spanId, flags] = parts;

  if (version !== "00") {
    return null;
  }
  if (traceId.length !== 32 || !/^[0-9a-f]+$/i.test(traceId)) {
    return null;
  }
  if (spanId.length !== 16 || !/^[0-9a-f]+$/i.test(spanId)) {
    return null;
  }
  if (flags.length !== 2 || !/^[0-9a-f]+$/i.test(flags)) {
    return null;
  }

  return { version, traceId, spanId, flags };
}

/**
 * Convert TraceContext to SpanContext
 */
export function toSpanContext(ctx: TraceContext): SpanContext {
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: parseInt(ctx.flags, 16) as TraceFlags,
    isRemote: true,
  };
}

/**
 * Format trace context as W3C traceparent header
 */
export function toTraceparent(ctx: {
  traceId: string;
  spanId: string;
}): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

/**
 * Get the current traceparent from active context
 * Returns null if no active span
 */
export function getTraceparent(): string | null {
  const span = trace.getSpan(context.active());
  if (!span) {
    return null;
  }
  return toTraceparent(span.spanContext());
}

/**
 * Span event for recording timestamped events
 */
interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Attributes;
}

/**
 * Span implementation for Cloudflare Workers
 * Uses Date.now() instead of performance.now() for timing
 * Full OTLP-compliant with SpanKind and parent reference
 */
class CloudflareSpan implements Span {
  private readonly _spanContext: SpanContext;
  private readonly _parentSpanId?: string;
  private readonly _kind: SpanKind;
  private _name: string;
  private readonly _startTime: number;
  private _endTime?: number;
  private _ended = false;
  private _status: SpanStatus = { code: SpanStatusCode.UNSET };
  private _attributes: Attributes = {};
  private _events: SpanEvent[] = [];
  private _links: Link[] = [];

  constructor(
    name: string,
    spanContext: SpanContext,
    kind: SpanKind = SpanKind.INTERNAL,
    parentSpanId?: string,
    startTime?: TimeInput,
    attributes?: Attributes,
    links?: Link[],
  ) {
    this._name = name;
    this._spanContext = spanContext;
    this._kind = kind;
    this._parentSpanId = parentSpanId;
    this._startTime = this._timeInputToMs(startTime) ?? Date.now();
    if (attributes) {
      this._attributes = { ...attributes };
    }
    if (links) {
      this._links = [...links];
    }
  }

  /**
   * Convert TimeInput to milliseconds
   */
  private _timeInputToMs(time?: TimeInput): number | undefined {
    if (time === undefined) return undefined;
    if (typeof time === "number") return time;
    if (time instanceof Date) return time.getTime();
    if (Array.isArray(time)) {
      // HrTime format [seconds, nanoseconds]
      return time[0] * 1000 + time[1] / 1e6;
    }
    return undefined;
  }

  spanContext(): SpanContext {
    return this._spanContext;
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (this._ended) return this;
    this._attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    if (this._ended) return this;
    Object.assign(this._attributes, attributes);
    return this;
  }

  addEvent(
    name: string,
    attributesOrStartTime?: Attributes | TimeInput,
    startTime?: TimeInput,
  ): this {
    if (this._ended) return this;

    let timestamp: number;
    let attributes: Attributes | undefined;

    if (typeof attributesOrStartTime === "number") {
      timestamp = attributesOrStartTime;
    } else if (attributesOrStartTime instanceof Date) {
      timestamp = attributesOrStartTime.getTime();
    } else if (Array.isArray(attributesOrStartTime)) {
      // HrTime format [seconds, nanoseconds]
      timestamp =
        attributesOrStartTime[0] * 1000 + attributesOrStartTime[1] / 1e6;
    } else {
      attributes = attributesOrStartTime as Attributes | undefined;
      if (typeof startTime === "number") {
        timestamp = startTime;
      } else if (startTime instanceof Date) {
        timestamp = startTime.getTime();
      } else if (Array.isArray(startTime)) {
        timestamp = startTime[0] * 1000 + startTime[1] / 1e6;
      } else {
        timestamp = Date.now();
      }
    }

    this._events.push({ name, timestamp, attributes });
    return this;
  }

  addLink(link: Link): this {
    if (this._ended) return this;
    this._links.push(link);
    return this;
  }

  addLinks(links: Link[]): this {
    if (this._ended) return this;
    this._links.push(...links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (this._ended) return this;
    this._status = status;
    return this;
  }

  updateName(name: string): this {
    if (this._ended) return this;
    this._name = name;
    return this;
  }

  end(endTime?: TimeInput): void {
    if (this._ended) return;
    this._ended = true;

    if (typeof endTime === "number") {
      this._endTime = endTime;
    } else if (endTime instanceof Date) {
      this._endTime = endTime.getTime();
    } else {
      this._endTime = Date.now();
    }

    // Notify processor if registered
    if (activeSpanProcessor) {
      activeSpanProcessor.onEnd(this);
    }
  }

  isRecording(): boolean {
    return !this._ended;
  }

  recordException(exception: Exception, time?: TimeInput): void {
    if (this._ended) return;

    const attributes: Attributes = {};
    if (typeof exception === "string") {
      attributes["exception.message"] = exception;
    } else if (exception instanceof Error) {
      attributes["exception.type"] = exception.name;
      attributes["exception.message"] = exception.message;
      if (exception.stack) {
        attributes["exception.stacktrace"] = exception.stack;
      }
    }

    this.addEvent("exception", attributes, time);
  }

  // Getters for OTLP export
  get name(): string {
    return this._name;
  }
  get kind(): SpanKind {
    return this._kind;
  }
  get parentSpanId(): string | undefined {
    return this._parentSpanId;
  }
  get startTime(): number {
    return this._startTime;
  }
  get endTime(): number | undefined {
    return this._endTime;
  }
  get attributes(): Attributes {
    return this._attributes;
  }
  get status(): SpanStatus {
    return this._status;
  }
  get events(): SpanEvent[] {
    return this._events;
  }
  get links(): Link[] {
    return this._links;
  }
}

/**
 * Tracer implementation for Cloudflare Workers
 */
class CloudflareTracer implements Tracer {
  startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
    const parentContext = ctx ?? context.active();
    const parentSpan = trace.getSpan(parentContext);
    const parentSpanContext = parentSpan?.spanContext();

    // Inherit traceId from parent or generate new
    const traceId = parentSpanContext?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const parentSpanId = parentSpanContext?.spanId;

    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    const kind = options?.kind ?? SpanKind.INTERNAL;

    return new CloudflareSpan(
      name,
      spanContext,
      kind,
      parentSpanId,
      options?.startTime,
      options?.attributes,
      options?.links,
    );
  }

  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    ctx: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    optionsOrFn: SpanOptions | F,
    ctxOrFn?: Context | F,
    maybeFn?: F,
  ): ReturnType<F> {
    // Parse overloaded arguments
    let options: SpanOptions | undefined;
    let ctx: Context | undefined;
    let fn: F;

    if (typeof optionsOrFn === "function") {
      fn = optionsOrFn;
    } else if (typeof ctxOrFn === "function") {
      options = optionsOrFn;
      fn = ctxOrFn;
    } else {
      options = optionsOrFn;
      ctx = ctxOrFn;
      fn = maybeFn!;
    }

    const parentContext = ctx ?? context.active();
    const span = this.startSpan(name, options, parentContext);
    const newContext = trace.setSpan(parentContext, span);

    return context.with(newContext, () => {
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
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.end();
              throw error;
            }) as ReturnType<F>;
        }

        span.end();
        return result as ReturnType<F>;
      } catch (error) {
        span.recordException(error as Exception);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      }
    });
  }
}

/**
 * Lightweight TracerProvider for Cloudflare Workers
 *
 * This provider creates tracers that generate valid trace/span IDs
 * and maintain context, but don't export anywhere.
 */
class CloudflareTracerProvider implements TracerProvider {
  private readonly _tracers = new Map<string, Tracer>();

  getTracer(name: string, _version?: string): Tracer {
    let tracer = this._tracers.get(name);
    if (!tracer) {
      tracer = new CloudflareTracer();
      this._tracers.set(name, tracer);
    }
    return tracer;
  }

  /**
   * Force flush all pending spans
   * Currently a no-op since we don't buffer spans
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Shutdown the provider and cleanup resources
   * Currently clears the tracer cache
   */
  shutdown(): Promise<void> {
    this._tracers.clear();
    return Promise.resolve();
  }
}

// ============================================
// Span Processor
// ============================================

/**
 * Interface for processing spans when they end
 */
export interface SpanProcessor {
  onEnd(span: CloudflareSpan): void;
  getSpans(): CloudflareSpan[];
  clear(): void;
}

/**
 * Simple span processor that collects ended spans for batch export
 */
export class SimpleSpanProcessor implements SpanProcessor {
  private spans: CloudflareSpan[] = [];

  onEnd(span: CloudflareSpan): void {
    this.spans.push(span);
  }

  getSpans(): CloudflareSpan[] {
    return [...this.spans];
  }

  clear(): void {
    this.spans = [];
  }
}

/** Active span processor for collecting spans */
let activeSpanProcessor: SpanProcessor | null = null;

/**
 * Set the active span processor
 * Called internally by instrument() or can be set manually for custom setups
 */
export function setSpanProcessor(processor: SpanProcessor | null): void {
  activeSpanProcessor = processor;
}

/**
 * Get the active span processor
 */
export function getSpanProcessor(): SpanProcessor | null {
  return activeSpanProcessor;
}

/** Singleton provider instance */
let providerInstance: CloudflareTracerProvider | null = null;

/** AsyncLocalStorage-based context manager for Cloudflare Workers */
const contextStorage = new AsyncLocalStorage<Context>();

/**
 * Context manager using AsyncLocalStorage
 * Works with Cloudflare Workers when node_compat is enabled
 */
class AsyncLocalStorageContextManager {
  active(): Context {
    return contextStorage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return contextStorage.run(ctx, () => fn.apply(thisArg, args));
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target === "function") {
      return ((...args: unknown[]) =>
        contextStorage.run(ctx, () => (target as (...a: unknown[]) => unknown)(...args))) as T;
    }
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

/**
 * Initialize the Cloudflare TracerProvider
 * Call this once at application startup
 */
export function initTracing(): void {
  if (providerInstance) {
    return; // Already initialized
  }

  // Disable any existing context manager first
  context.disable();

  // Register AsyncLocalStorage-based context manager
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager);

  providerInstance = new CloudflareTracerProvider();
  trace.setGlobalTracerProvider(providerInstance);
}

/**
 * Create a span context from a traceparent string
 * Useful for setting up parent context from incoming requests
 */
export function spanContextFromTraceparent(
  traceparent: string,
): SpanContext | null {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) {
    return null;
  }
  return toSpanContext(parsed);
}

/**
 * Run a function with a specific parent trace context
 * The parent can be a traceparent string or SpanContext
 */
export function withParentTrace<T>(
  parent: string | SpanContext,
  fn: () => T,
): T {
  const spanContext =
    typeof parent === "string" ? spanContextFromTraceparent(parent) : parent;

  if (!spanContext) {
    // Invalid parent, run without trace context
    return fn();
  }

  // Create a non-recording span just to hold the context
  const parentSpan = trace.wrapSpanContext(spanContext);
  const parentContext = trace.setSpan(context.active(), parentSpan);

  return context.with(parentContext, fn);
}
