/**
 * Custom Error class with tracing support
 */

import { getCallerFromStack, type CallerInfo } from "./caller.js";

/**
 * Error status class - can be extended by library users
 */
export class ErrorStatus {
  constructor(
    private readonly code: number,
    private readonly name: string,
  ) {}

  toString(): string {
    return this.name;
  }

  httpStatusCode(): number {
    return this.code;
  }

  // 4xx Client Errors
  static readonly BadRequest = new ErrorStatus(400, "Bad Request");
  static readonly Unauthorized = new ErrorStatus(401, "Unauthorized");
  static readonly PaymentRequired = new ErrorStatus(402, "Payment Required");
  static readonly Forbidden = new ErrorStatus(403, "Forbidden");
  static readonly NotFound = new ErrorStatus(404, "Not Found");
  static readonly MethodNotAllowed = new ErrorStatus(405, "Method Not Allowed");
  static readonly NotAcceptable = new ErrorStatus(406, "Not Acceptable");
  static readonly RequestTimeout = new ErrorStatus(408, "Request Timeout");
  static readonly Conflict = new ErrorStatus(409, "Conflict");
  static readonly Gone = new ErrorStatus(410, "Gone");
  static readonly PreconditionFailed = new ErrorStatus(412, "Precondition Failed");
  static readonly PayloadTooLarge = new ErrorStatus(413, "Payload Too Large");
  static readonly UnsupportedMediaType = new ErrorStatus(415, "Unsupported Media Type");
  static readonly UnprocessableEntity = new ErrorStatus(422, "Unprocessable Entity");
  static readonly TooManyRequests = new ErrorStatus(429, "Too Many Requests");

  // 5xx Server Errors
  static readonly InternalServerError = new ErrorStatus(500, "Internal Server Error");
  static readonly NotImplemented = new ErrorStatus(501, "Not Implemented");
  static readonly BadGateway = new ErrorStatus(502, "Bad Gateway");
  static readonly ServiceUnavailable = new ErrorStatus(503, "Service Unavailable");
  static readonly GatewayTimeout = new ErrorStatus(504, "Gateway Timeout");
}

/**
 * Options for creating a TracedError
 */
export interface TracedErrorOptions {
  status?: ErrorStatus;
  fields?: Record<string, unknown>;
  caller?: CallerInfo;
}

/**
 * Custom error class with tracing support and HTTP status codes.
 *
 * Features:
 * - Captures caller info automatically
 * - Supports HTTP status codes via ErrorStatus interface
 * - Can wrap other errors while preserving the cause chain
 * - Custom instanceof behavior that checks the cause chain
 * - JSON serialization via toJSON()
 *
 * @example
 * // Create a new error
 * throw TracedError.fail("User not found", {
 *   status: ErrorStatus.NotFound,
 *   fields: { userId: 123 }
 * });
 *
 * @example
 * // Wrap an existing error
 * try {
 *   await fetchUser(id);
 * } catch (err) {
 *   throw TracedError.wrap(err, "Failed to fetch user", {
 *     status: ErrorStatus.InternalServerError,
 *     fields: { userId: id }
 *   });
 * }
 */
export class TracedError extends Error {
  readonly status: ErrorStatus;
  readonly fields: Record<string, unknown>;
  readonly caller: CallerInfo;
  override readonly cause?: unknown;

  private constructor(message: string, cause: unknown, options: TracedErrorOptions, callerDepth: number) {
    super(message);
    this.name = "TracedError";
    this.status = options.status ?? ErrorStatus.InternalServerError;
    this.fields = options.fields ?? {};
    this.caller = options.caller ?? getCallerFromStack(callerDepth);
    this.cause = cause;

    // Maintain proper prototype chain for instanceof
    Object.setPrototypeOf(this, TracedError.prototype);
  }

  /**
   * Create a new error
   *
   * @param message - Error message
   * @param options - Optional status, fields, and caller info
   */
  static fail(message: string, options?: TracedErrorOptions): TracedError {
    return new TracedError(message, undefined, options ?? {}, 4);
  }

  /**
   * Wrap an existing error with additional context
   *
   * @param cause - The cause to wrap (can be any value)
   * @param message - New message describing the context
   * @param options - Optional status, fields, and caller info
   */
  static wrap(cause: unknown, message: string, options?: TracedErrorOptions): TracedError {
    return new TracedError(message, cause, options ?? {}, 4);
  }

  /**
   * Custom instanceof behavior - also matches wrapped errors in the cause chain.
   *
   * This allows:
   * ```ts
   * const wrapped = TracedError.wrap(new TypeError("bad"), "context");
   * wrapped instanceof TracedError // true
   * ```
   *
   * And when checking the cause chain with `is()`:
   * ```ts
   * wrapped.is(TypeError) // true
   * ```
   */
  static [Symbol.hasInstance](instance: unknown): boolean {
    if (!instance || typeof instance !== "object") {
      return false;
    }

    // Walk the prototype chain and cause chain
    let current: unknown = instance;
    while (current instanceof Error) {
      if (Object.getPrototypeOf(current) === TracedError.prototype) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }

  /**
   * Check if this error or any error in the cause chain is an instance of the given class.
   *
   * @param ErrorClass - The error class to check against
   * @returns true if this error or any wrapped error is an instance of ErrorClass
   *
   * @example
   * const wrapped = TracedError.wrap(new TypeError("bad"), "context");
   * wrapped.is(TypeError) // true
   * wrapped.is(RangeError) // false
   */
  is<T extends Error>(ErrorClass: new (...args: unknown[]) => T): this is TracedError & { cause: T } {
    let current: unknown = this;
    while (current instanceof Error) {
      if (current instanceof ErrorClass) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }

  /**
   * Get the root cause (the innermost wrapped value)
   */
  rootCause(): unknown {
    let current: unknown = this;
    while (current instanceof Error && (current as { cause?: unknown }).cause !== undefined) {
      current = (current as { cause: unknown }).cause;
    }
    return current;
  }

  /**
   * Serialize error to JSON
   *
   * When cause is a TracedError, it calls toJSON() recursively to avoid
   * double printing stack traces.
   */
  toJSON(): Record<string, unknown> {
    let causeJson: unknown;
    if (this.cause instanceof TracedError) {
      // Recursively serialize TracedError cause (avoids double stack printing)
      causeJson = this.cause.toJSON();
    } else if (this.cause instanceof Error) {
      causeJson = {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack,
      };
    } else if (this.cause !== undefined) {
      causeJson = this.cause;
    }

    return {
      name: this.name,
      message: this.message,
      status: this.status.toString(),
      statusCode: this.status.httpStatusCode(),
      fields: this.fields,
      caller: this.caller,
      cause: causeJson,
      stack: this.stack,
    };
  }
}
