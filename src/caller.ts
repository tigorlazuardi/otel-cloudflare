import { AsyncLocalStorage } from "node:async_hooks";

const callerStorage = new AsyncLocalStorage<CallerInfo>();

/**
 * Run a function with caller context
 */
export function runWithCaller<T>(
  caller: CallerInfo,
  fn: (caller: CallerInfo) => T,
): T {
  return callerStorage.run(caller, () => fn(caller));
}

/**
 * Run a function with auto-captured caller context
 * Automatically captures the caller info from the current stack
 */
export function withCaller<T>(fn: (caller: CallerInfo) => T): T;
export function withCaller<T>(
  fn: (caller: CallerInfo) => Promise<T>,
): Promise<T>;
export function withCaller<T>(
  fn: (caller: CallerInfo) => T | Promise<T>,
): T | Promise<T> {
  const caller = CallerInfo.from(3);
  return callerStorage.run(caller, () => fn(caller));
}

/**
 * Get the current caller from AsyncLocalStorage
 */
export function getCurrentCaller(): CallerInfo | undefined {
  return callerStorage.getStore();
}

/**
 * Information about the caller location
 */
export class CallerInfo {
  readonly file?: string;
  private readonly _function?: string;
  readonly line?: number;
  readonly column?: number;
  readonly parent?: CallerInfo;

  constructor(
    opts: {
      file?: string;
      function?: string;
      line?: number;
      column?: number;
      parent?: CallerInfo;
    } = {},
  ) {
    this.file = opts.file;
    this._function = opts.function;
    this.line = opts.line;
    this.column = opts.column;
    this.parent = opts.parent ?? getCurrentCaller();
  }

  /**
   * Get the function name, looking up parent chain if anonymous
   */
  get function(): string {
    // If we have a real function name, use it
    if (this._function && this._function !== "<anonymous>") {
      return this._function;
    }

    // Look up parent chain for a named function
    if (this.parent) {
      return this.parent.function;
    }

    // Give up, return empty string
    return "";
  }

  /**
   * Get caller info from current stack trace
   * Skips internal frames to find the actual caller
   */
  static from(skipFrames = 2, parent?: CallerInfo): CallerInfo {
    parent = parent ?? getCurrentCaller();
    if (skipFrames <= 0) return new CallerInfo({ parent });
    const stack = new Error().stack;
    // Split with limit skipFrames + 1 to include the target frame
    const frames = stack?.split("\n", skipFrames + 1);
    if (!frames || frames.length <= skipFrames) {
      return new CallerInfo({ parent });
    }
    const frame = frames[skipFrames];
    return CallerInfo.fromStackFrame(frame, parent);
  }

  /**
   * Parse a single stack frame line
   * Returns empty CallerInfo if the line cannot be parsed
   */
  static fromStackFrame(frame: string, parent?: CallerInfo): CallerInfo {
    parent = parent ?? getCurrentCaller();

    // Check if this is a valid stack frame line
    const atIndex = frame.indexOf("at ");
    if (atIndex === -1) {
      return new CallerInfo({ parent });
    }

    const fnIdxStart = atIndex + 3;
    const fnIdxEnd = frame.indexOf(" (", fnIdxStart);

    // Handle two stack frame formats:
    // 1. With function name: "at functionName (/path/to/file.ts:10:5)"
    // 2. Without function name: "at /path/to/file.ts:10:5"
    let fnName: string;
    let filePathStart: number;
    let filePathEnd: number;

    if (fnIdxEnd !== -1) {
      // Format with function name: "at functionName (/path/to/file.ts:10:5)"
      fnName = frame.slice(fnIdxStart, fnIdxEnd);
      // Strip "async " prefix from function names
      if (fnName.startsWith("async ")) {
        fnName = fnName.slice(6);
      }
      filePathStart = fnIdxEnd + 2; // Skip " ("
      filePathEnd = frame.lastIndexOf(")");
    } else {
      // Format without function name: "at /path/to/file.ts:10:5"
      fnName = "";
      filePathStart = fnIdxStart;
      filePathEnd = frame.length;
    }

    const filePath = frame.slice(filePathStart, filePathEnd);

    // Parse file:line:column from the path portion
    // Find the last two colons for line:column (handle Windows paths with drive letters like C:\)
    const lastColonIdx = filePath.lastIndexOf(":");
    if (lastColonIdx === -1) return new CallerInfo({ parent });

    const secondLastColonIdx = filePath.lastIndexOf(":", lastColonIdx - 1);
    if (secondLastColonIdx === -1) return new CallerInfo({ parent });

    const fileName = filePath.slice(0, secondLastColonIdx);
    const lineNumber = parseInt(
      filePath.slice(secondLastColonIdx + 1, lastColonIdx),
      10,
    );
    const columnNumber = parseInt(filePath.slice(lastColonIdx + 1), 10);

    return new CallerInfo({
      file: CallerInfo.cleanPath(fileName),
      function: fnName,
      line: isNaN(lineNumber) ? undefined : lineNumber,
      column: isNaN(columnNumber) ? undefined : columnNumber,
      parent,
    });
  }

  /**
   * Clean file path by removing file:// protocol
   */
  private static cleanPath(filePath: string): string {
    return filePath.replace(/^file:\/\//, "");
  }

  /**
   * Check if caller info is empty
   */
  isEmpty(): boolean {
    return !this.file && !this._function && !this.line;
  }

  /**
   * Format as string for display
   */
  toString(): string {
    if (this.isEmpty()) return "";

    const loc = this.line ? `${this.file}:${this.line}` : (this.file ?? "");
    const func = this.function;
    return func ? `${loc} ${func}` : loc;
  }

  /**
   * Convert to plain object (excludes parent to avoid circular refs)
   */
  toJSON(): {
    file?: string;
    function?: string;
    line?: number;
    column?: number;
  } {
    return {
      file: this.file,
      function: this.function || undefined,
      line: this.line,
      column: this.column,
    };
  }

  /**
   * Returns OpenTelemetry semantic convention attributes for code location.
   */
  toAttributes(): Record<string, string | number> {
    const attrs: Record<string, string | number> = {};

    if (this.file) {
      attrs["code.filepath"] = this.file;
    }
    if (this.line) {
      attrs["code.lineno"] = this.line;
    }
    if (this.column) {
      attrs["code.column"] = this.column;
    }
    if (this.function) {
      attrs["code.function"] = this.function;
    }

    return attrs;
  }
}

// Legacy function exports for backwards compatibility
export function parseStackFrame(line: string): CallerInfo | null {
  const caller = CallerInfo.fromStackFrame(line);
  // Return null if the line couldn't be parsed (no valid location info)
  if (caller.isEmpty()) {
    return null;
  }
  return caller;
}

export function getCallerFromStack(skipFrames = 4): CallerInfo {
  return CallerInfo.from(skipFrames + 1);
}
