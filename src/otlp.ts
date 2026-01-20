/**
 * OTLP/HTTP JSON Exporter for Cloudflare Workers
 *
 * Implements OTLP protocol using native fetch() for exporting
 * traces and logs to Grafana Cloud or any OTLP-compatible backend.
 */

import { SpanKind, SpanStatusCode, type Attributes, type Link } from "@opentelemetry/api";
import type { LogEntry, LogLevel } from "./logger.js";
import { getOriginalFetch } from "./fetch.js";

// ============================================
// Types
// ============================================

export interface OTLPExporterConfig {
  /** Base OTLP endpoint (e.g., https://otlp-gateway.grafana.net/otlp) */
  endpoint: string;
  /** Headers to send with requests (e.g., Authorization) */
  headers: Record<string, string>;
  /** Service name from OTEL_SERVICE_NAME */
  serviceName?: string;
  /** Resource attributes from OTEL_RESOURCE_ATTRIBUTES */
  resourceAttributes?: Record<string, string>;
}

/** Span data needed for OTLP export */
export interface ExportableSpan {
  spanContext(): { traceId: string; spanId: string };
  name: string;
  kind: SpanKind;
  parentSpanId?: string;
  startTime: number;
  endTime?: number;
  attributes: Attributes;
  status: { code: number; message?: string };
  events: Array<{ name: string; timestamp: number; attributes?: Attributes }>;
  links: Link[];
}

// OTLP JSON types
interface OTLPKeyValue {
  key: string;
  value: OTLPAnyValue;
}

interface OTLPAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OTLPAnyValue[] };
  kvlistValue?: { values: OTLPKeyValue[] };
}

interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OTLPKeyValue[];
  droppedAttributesCount: number;
  events: OTLPEvent[];
  droppedEventsCount: number;
  links: OTLPLink[];
  droppedLinksCount: number;
  status: OTLPStatus;
}

interface OTLPEvent {
  timeUnixNano: string;
  name: string;
  attributes: OTLPKeyValue[];
  droppedAttributesCount: number;
}

interface OTLPLink {
  traceId: string;
  spanId: string;
  attributes: OTLPKeyValue[];
  droppedAttributesCount: number;
}

interface OTLPStatus {
  code: number;
  message?: string;
}

interface OTLPLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: OTLPAnyValue;
  attributes: OTLPKeyValue[];
  droppedAttributesCount: number;
  traceId?: string;
  spanId?: string;
}

interface ExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: { attributes: OTLPKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OTLPSpan[];
    }>;
  }>;
}

interface ExportLogsServiceRequest {
  resourceLogs: Array<{
    resource: { attributes: OTLPKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string; version?: string };
      logRecords: OTLPLogRecord[];
    }>;
  }>;
}

// ============================================
// Conversion Utilities
// ============================================

/** Convert milliseconds to nanoseconds as string */
function msToNanoString(ms: number): string {
  return (BigInt(Math.floor(ms)) * BigInt(1_000_000)).toString();
}

/** Map SpanKind to OTLP enum value */
function spanKindToOTLP(kind: SpanKind): number {
  switch (kind) {
    case SpanKind.INTERNAL:
      return 1;
    case SpanKind.SERVER:
      return 2;
    case SpanKind.CLIENT:
      return 3;
    case SpanKind.PRODUCER:
      return 4;
    case SpanKind.CONSUMER:
      return 5;
    default:
      return 0; // UNSPECIFIED
  }
}

/** Map SpanStatusCode to OTLP enum value */
function statusCodeToOTLP(code: number): number {
  switch (code) {
    case SpanStatusCode.OK:
      return 1;
    case SpanStatusCode.ERROR:
      return 2;
    default:
      return 0; // UNSET
  }
}

/** Map log level to OTLP severity number */
function logLevelToSeverity(level: LogLevel): number {
  switch (level) {
    case "trace":
      return 1;
    case "debug":
      return 5;
    case "info":
      return 9;
    case "warn":
      return 13;
    case "error":
      return 17;
    case "fatal":
      return 21;
    default:
      return 0;
  }
}

/**
 * Flatten nested objects to dot-notation keys
 * { request: { body: "..." } } -> { "request.body": "..." }
 * This is needed because many OTLP backends don't support kvlistValue well
 */
function flattenAttributes(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      // Recursively flatten nested objects
      Object.assign(result, flattenAttributes(value as Record<string, unknown>, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/** Convert a value to OTLP AnyValue */
function toOTLPValue(value: unknown): OTLPAnyValue {
  if (value === null || value === undefined) {
    return { stringValue: "" };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: value.toString() };
    }
    return { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    // Convert arrays to JSON string for better compatibility
    return { stringValue: JSON.stringify(value) };
  }
  if (value instanceof Date) {
    return { stringValue: value.toISOString() };
  }
  // Objects should already be flattened, but handle edge cases
  if (typeof value === "object") {
    return { stringValue: JSON.stringify(value) };
  }
  return { stringValue: String(value) };
}

/** Convert attributes to OTLP KeyValue array with flattening */
function attributesToOTLP(attrs: Attributes | Record<string, unknown>): OTLPKeyValue[] {
  // Flatten nested objects to dot-notation
  const flattened = flattenAttributes(attrs as Record<string, unknown>);

  return Object.entries(flattened).map(([key, value]) => ({
    key,
    value: toOTLPValue(value),
  }));
}

// ============================================
// Span Conversion
// ============================================

/** Convert a span to OTLP format */
export function spanToOTLP(span: ExportableSpan): OTLPSpan {
  const ctx = span.spanContext();

  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: spanKindToOTLP(span.kind),
    startTimeUnixNano: msToNanoString(span.startTime),
    endTimeUnixNano: msToNanoString(span.endTime ?? Date.now()),
    attributes: attributesToOTLP(span.attributes),
    droppedAttributesCount: 0,
    events: span.events.map((e) => ({
      timeUnixNano: msToNanoString(e.timestamp),
      name: e.name,
      attributes: attributesToOTLP(e.attributes ?? {}),
      droppedAttributesCount: 0,
    })),
    droppedEventsCount: 0,
    links: span.links.map((l) => ({
      traceId: l.context.traceId,
      spanId: l.context.spanId,
      attributes: attributesToOTLP(l.attributes ?? {}),
      droppedAttributesCount: 0,
    })),
    droppedLinksCount: 0,
    status: {
      code: statusCodeToOTLP(span.status.code),
      message: span.status.message,
    },
  };
}

/** Build ExportTraceServiceRequest */
export function buildTraceExportRequest(
  spans: ExportableSpan[],
  serviceName: string,
  resourceAttributes?: Record<string, string>,
  version = "5.3.0",
): ExportTraceServiceRequest {
  const attrs: OTLPKeyValue[] = [
    { key: "service.name", value: { stringValue: serviceName } },
  ];

  // Add resource attributes from OTEL_RESOURCE_ATTRIBUTES
  if (resourceAttributes) {
    for (const [key, value] of Object.entries(resourceAttributes)) {
      attrs.push({ key, value: { stringValue: value } });
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: attrs },
        scopeSpans: [
          {
            scope: { name: "otel-cloudflare", version },
            spans: spans.map(spanToOTLP),
          },
        ],
      },
    ],
  };
}

// ============================================
// Log Conversion
// ============================================

/**
 * Convert milliseconds to nanoseconds as string, with optional microsecond offset
 * The offset is used to preserve log ordering when multiple logs have the same ms timestamp
 */
function msToNanoStringWithOffset(ms: number, offsetMicros: number = 0): string {
  const nanos = BigInt(Math.floor(ms)) * BigInt(1_000_000) + BigInt(offsetMicros) * BigInt(1_000);
  return nanos.toString();
}

/** Convert a log entry to OTLP format */
export function logToOTLP(entry: LogEntry, offsetMicros: number = 0): OTLPLogRecord {
  const attrs = attributesToOTLP(entry.attributes);

  // Add caller info as attribute if present
  if (entry.caller && !entry.caller.isEmpty()) {
    attrs.push({
      key: "code.filepath",
      value: { stringValue: entry.caller.file ?? "" },
    });
    if (entry.caller.line) {
      attrs.push({
        key: "code.lineno",
        value: { intValue: entry.caller.line.toString() },
      });
    }
    if (entry.caller.function) {
      attrs.push({
        key: "code.function",
        value: { stringValue: entry.caller.function },
      });
    }
  }

  return {
    // Add microsecond offset to preserve log ordering
    timeUnixNano: msToNanoStringWithOffset(entry.timestamp.getTime(), offsetMicros),
    severityNumber: logLevelToSeverity(entry.level),
    severityText: entry.level.toUpperCase(),
    body: { stringValue: entry.message },
    attributes: attrs,
    droppedAttributesCount: 0,
    traceId: entry.traceId,
    spanId: entry.spanId,
  };
}

/** Build ExportLogsServiceRequest */
export function buildLogExportRequest(
  logs: LogEntry[],
  serviceName: string,
  resourceAttributes?: Record<string, string>,
  version = "5.3.0",
): ExportLogsServiceRequest {
  const attrs: OTLPKeyValue[] = [
    { key: "service.name", value: { stringValue: serviceName } },
  ];

  // Add resource attributes from OTEL_RESOURCE_ATTRIBUTES
  if (resourceAttributes) {
    for (const [key, value] of Object.entries(resourceAttributes)) {
      attrs.push({ key, value: { stringValue: value } });
    }
  }

  return {
    resourceLogs: [
      {
        resource: { attributes: attrs },
        scopeLogs: [
          {
            scope: { name: "otel-cloudflare", version },
            // Add 1 microsecond offset per log entry to preserve ordering
            logRecords: logs.map((log, index) => logToOTLP(log, index)),
          },
        ],
      },
    ],
  };
}

// ============================================
// Export Functions
// ============================================

/**
 * Export traces to OTLP endpoint
 * Uses originalFetch if available to avoid tracing the export request itself
 */
export async function exportTraces(
  config: OTLPExporterConfig,
  spans: ExportableSpan[],
  serviceName: string,
): Promise<void> {
  if (spans.length === 0) return;

  const url = `${config.endpoint}/v1/traces`;
  const body = buildTraceExportRequest(
    spans,
    config.serviceName ?? serviceName,
    config.resourceAttributes,
  );

  // Use original fetch to avoid infinite recursion when global fetch is patched
  const fetchFn = getOriginalFetch() ?? globalThis.fetch;

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error(
        `OTLP trace export failed: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    console.error("OTLP trace export error:", error);
  }
}

/**
 * Export logs to OTLP endpoint
 * Uses originalFetch if available to avoid tracing the export request itself
 */
export async function exportLogs(
  config: OTLPExporterConfig,
  logs: LogEntry[],
  serviceName: string,
): Promise<void> {
  if (logs.length === 0) return;

  const url = `${config.endpoint}/v1/logs`;
  const effectiveServiceName = config.serviceName ?? serviceName;
  const body = buildLogExportRequest(logs, effectiveServiceName, config.resourceAttributes);

  // Use original fetch to avoid infinite recursion when global fetch is patched
  const fetchFn = getOriginalFetch() ?? globalThis.fetch;

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(
        `[otel-cloudflare] OTLP log export failed: ${response.status} ${response.statusText}`,
        text,
      );
    }
  } catch (error) {
    console.error("[otel-cloudflare] OTLP log export error:", error);
  }
}

// ============================================
// Environment Detection
// ============================================

/**
 * Parse OTEL_RESOURCE_ATTRIBUTES env var
 * Format: "key1=value1,key2=value2"
 */
function parseResourceAttributes(
  attrString: string | undefined,
): Record<string, string> {
  if (!attrString) return {};

  const result: Record<string, string> = {};
  for (const pair of attrString.split(",")) {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      result[key.trim()] = valueParts.join("=").trim();
    }
  }
  return result;
}

/**
 * Get OTLP config from environment variables
 * Returns null if OTLP is not configured
 */
export function getOTLPConfigFromEnv(
  env: Record<string, unknown>,
): OTLPExporterConfig | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT as string | undefined;
  if (!endpoint) {
    return null;
  }

  // Try to get auth header from various sources
  let authHeader: string | undefined;

  // Option 1: Direct headers env var (format: "Authorization=Basic xxx")
  const headersEnv = env.OTEL_EXPORTER_OTLP_HEADERS as string | undefined;
  if (headersEnv) {
    const match = headersEnv.match(/Authorization=(.+)/i);
    if (match) {
      authHeader = match[1];
    }
  }

  // Option 2: Grafana-specific env vars
  if (!authHeader) {
    const instanceId = env.GRAFANA_INSTANCE_ID as string | undefined;
    const token = env.GRAFANA_OTLP_TOKEN as string | undefined;
    if (instanceId && token) {
      authHeader = `Basic ${btoa(`${instanceId}:${token}`)}`;
    }
  }

  // No auth configured - can't export
  if (!authHeader) {
    return null;
  }

  // Parse service name and resource attributes
  const serviceName = env.OTEL_SERVICE_NAME as string | undefined;
  const resourceAttributes = parseResourceAttributes(
    env.OTEL_RESOURCE_ATTRIBUTES as string | undefined,
  );

  return {
    endpoint: endpoint.replace(/\/$/, ""), // Remove trailing slash
    headers: {
      Authorization: authHeader,
    },
    serviceName,
    resourceAttributes,
  };
}
