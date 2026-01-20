// Caller utilities
export {
  CallerInfo,
  parseStackFrame,
  getCallerFromStack,
  withCaller,
  getCurrentCaller,
  runWithCaller,
} from "./caller.js";

// Logger
export {
  Logger,
  ConsoleLogHandler,
  PrettyLogHandler,
  OTLPLogHandler,
  CompositeLogHandler,
  getLogger,
  runWithLogger,
  getAttrs,
  withAttrs,
  setOTLPLogHandler,
  getOTLPLogHandler,
  type LogLevel,
  type LogOptions,
  type LogEntry,
  type LogHandler,
} from "./logger.js";

// Tracing utilities
export { withTrace, type WithTraceOptions } from "./trace.js";

// Provider and trace context utilities
export {
  initTracing,
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  toSpanContext,
  toTraceparent,
  getTraceparent,
  spanContextFromTraceparent,
  withParentTrace,
  SimpleSpanProcessor,
  setSpanProcessor,
  getSpanProcessor,
  type TraceContext,
  type SpanProcessor,
} from "./provider.js";

// Instrumentation
export {
  instrument,
  traceHandler,
  traceRequest,
  withTraceContext,
  wrapQueue,
  TRACE_CONTEXT_KEY,
  DEFAULT_IGNORE_URLS,
  type InstrumentOptions,
  type InstrumentOptionsObject,
  type TraceHandlerOptions,
  type OTLPExporterConfig,
  type ExportedHandler,
  type TracedMessage,
} from "./instrument.js";

// OTLP export utilities
export {
  exportTraces,
  exportLogs,
  getOTLPConfigFromEnv,
  spanToOTLP,
  logToOTLP,
  buildTraceExportRequest,
  buildLogExportRequest,
  type ExportableSpan,
} from "./otlp.js";

// Force flush API (for SvelteKit and other non-standard contexts)
export {
  initOTLP,
  getFlushContext,
  flushTraces,
  flushLogs,
  flushAll,
  flushToEnv,
  type FlushContext,
} from "./flush.js";

// Instrumented fetch for outgoing HTTP requests
export {
  tracedFetch,
  instrumentedFetch,
  patchGlobalFetch,
  unpatchGlobalFetch,
  getOriginalFetch,
  type TracedFetchOptions,
} from "./fetch.js";

// Workflow tracing (Cloudflare Workflows)
export {
  traceWorkflow,
  withWorkflowTrace,
  generateDeterministicKey,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowEntrypoint,
  type WorkflowEntrypointConstructor,
  type TracedParams,
  type TracedWorkflow,
  type WorkflowInstance,
  type WorkflowInstanceStatus,
  type WorkflowInstanceCreateOptions,
  type WorkflowBinding,
  type TracedWorkflowBinding,
} from "./workflow.js";

// Custom error class
export { TracedError, ErrorStatus, type TracedErrorOptions } from "./error.js";
