import { describe, it, expect } from "vitest";
import { TracedError, ErrorStatus } from "./error.js";

describe("ErrorStatus", () => {
  it("toString() returns the name", () => {
    expect(ErrorStatus.NotFound.toString()).toBe("Not Found");
    expect(ErrorStatus.InternalServerError.toString()).toBe("Internal Server Error");
  });

  it("httpStatusCode() returns the code", () => {
    expect(ErrorStatus.NotFound.httpStatusCode()).toBe(404);
    expect(ErrorStatus.InternalServerError.httpStatusCode()).toBe(500);
  });

  it("has correct 4xx status codes", () => {
    expect(ErrorStatus.BadRequest.httpStatusCode()).toBe(400);
    expect(ErrorStatus.Unauthorized.httpStatusCode()).toBe(401);
    expect(ErrorStatus.PaymentRequired.httpStatusCode()).toBe(402);
    expect(ErrorStatus.Forbidden.httpStatusCode()).toBe(403);
    expect(ErrorStatus.NotFound.httpStatusCode()).toBe(404);
    expect(ErrorStatus.MethodNotAllowed.httpStatusCode()).toBe(405);
    expect(ErrorStatus.NotAcceptable.httpStatusCode()).toBe(406);
    expect(ErrorStatus.RequestTimeout.httpStatusCode()).toBe(408);
    expect(ErrorStatus.Conflict.httpStatusCode()).toBe(409);
    expect(ErrorStatus.Gone.httpStatusCode()).toBe(410);
    expect(ErrorStatus.PreconditionFailed.httpStatusCode()).toBe(412);
    expect(ErrorStatus.PayloadTooLarge.httpStatusCode()).toBe(413);
    expect(ErrorStatus.UnsupportedMediaType.httpStatusCode()).toBe(415);
    expect(ErrorStatus.UnprocessableEntity.httpStatusCode()).toBe(422);
    expect(ErrorStatus.TooManyRequests.httpStatusCode()).toBe(429);
  });

  it("has correct 5xx status codes", () => {
    expect(ErrorStatus.InternalServerError.httpStatusCode()).toBe(500);
    expect(ErrorStatus.NotImplemented.httpStatusCode()).toBe(501);
    expect(ErrorStatus.BadGateway.httpStatusCode()).toBe(502);
    expect(ErrorStatus.ServiceUnavailable.httpStatusCode()).toBe(503);
    expect(ErrorStatus.GatewayTimeout.httpStatusCode()).toBe(504);
  });

  it("can create custom status", () => {
    const custom = new ErrorStatus(418, "I'm a teapot");
    expect(custom.httpStatusCode()).toBe(418);
    expect(custom.toString()).toBe("I'm a teapot");
  });
});

describe("TracedError", () => {
  describe("fail()", () => {
    it("creates error with message", () => {
      const err = TracedError.fail("Something went wrong");
      expect(err.message).toBe("Something went wrong");
      expect(err.name).toBe("TracedError");
    });

    it("defaults to InternalServerError status", () => {
      const err = TracedError.fail("Something went wrong");
      expect(err.status).toBe(ErrorStatus.InternalServerError);
      expect(err.status.httpStatusCode()).toBe(500);
    });

    it("accepts custom status", () => {
      const err = TracedError.fail("Not found", {
        status: ErrorStatus.NotFound,
      });
      expect(err.status).toBe(ErrorStatus.NotFound);
      expect(err.status.httpStatusCode()).toBe(404);
    });

    it("accepts fields", () => {
      const err = TracedError.fail("User not found", {
        fields: { userId: 123, action: "fetch" },
      });
      expect(err.fields).toEqual({ userId: 123, action: "fetch" });
    });

    it("defaults to empty fields", () => {
      const err = TracedError.fail("Error");
      expect(err.fields).toEqual({});
    });

    it("captures caller automatically", () => {
      const err = TracedError.fail("Error");
      expect(err.caller).toBeDefined();
      expect(err.caller.file).toContain("error.test.ts");
    });

    it("has no cause", () => {
      const err = TracedError.fail("Error");
      expect(err.cause).toBeUndefined();
    });
  });

  describe("wrap()", () => {
    it("wraps an existing error", () => {
      const original = new Error("Original error");
      const wrapped = TracedError.wrap(original, "Wrapped context");
      expect(wrapped.message).toBe("Wrapped context");
      expect(wrapped.cause).toBe(original);
    });

    it("preserves the original error as cause", () => {
      const original = new TypeError("Type mismatch");
      const wrapped = TracedError.wrap(original, "Failed to process");
      expect(wrapped.cause).toBeInstanceOf(TypeError);
      expect((wrapped.cause as Error).message).toBe("Type mismatch");
    });

    it("accepts non-Error cause", () => {
      const wrapped = TracedError.wrap("string cause", "Wrapped string");
      expect(wrapped.cause).toBe("string cause");
    });

    it("accepts object cause", () => {
      const cause = { code: "ERR_001", detail: "Something failed" };
      const wrapped = TracedError.wrap(cause, "Wrapped object");
      expect(wrapped.cause).toEqual(cause);
    });

    it("accepts custom status", () => {
      const original = new Error("DB error");
      const wrapped = TracedError.wrap(original, "Database failed", {
        status: ErrorStatus.ServiceUnavailable,
      });
      expect(wrapped.status.httpStatusCode()).toBe(503);
    });

    it("accepts fields", () => {
      const original = new Error("Query failed");
      const wrapped = TracedError.wrap(original, "Database error", {
        fields: { query: "SELECT *", table: "users" },
      });
      expect(wrapped.fields).toEqual({ query: "SELECT *", table: "users" });
    });

    it("captures caller automatically", () => {
      const original = new Error("Original");
      const wrapped = TracedError.wrap(original, "Wrapped");
      expect(wrapped.caller).toBeDefined();
      expect(wrapped.caller.file).toContain("error.test.ts");
    });
  });

  describe("instanceof", () => {
    it("works with TracedError.fail()", () => {
      const err = TracedError.fail("Error");
      expect(err instanceof TracedError).toBe(true);
      expect(err instanceof Error).toBe(true);
    });

    it("works with TracedError.wrap()", () => {
      const wrapped = TracedError.wrap(new Error("Original"), "Wrapped");
      expect(wrapped instanceof TracedError).toBe(true);
      expect(wrapped instanceof Error).toBe(true);
    });

    it("returns false for regular Error", () => {
      const err = new Error("Regular error");
      expect(err instanceof TracedError).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(null instanceof TracedError).toBe(false);
      expect(undefined instanceof TracedError).toBe(false);
    });
  });

  describe("is()", () => {
    it("returns true for TracedError itself", () => {
      const err = TracedError.fail("Error");
      expect(err.is(TracedError)).toBe(true);
      expect(err.is(Error)).toBe(true);
    });

    it("checks wrapped error type", () => {
      const wrapped = TracedError.wrap(new TypeError("Bad type"), "Context");
      expect(wrapped.is(TypeError)).toBe(true);
      expect(wrapped.is(RangeError)).toBe(false);
    });

    it("checks nested cause chain", () => {
      const inner = new RangeError("Out of range");
      const middle = TracedError.wrap(inner, "Middle layer");
      const outer = TracedError.wrap(middle, "Outer layer");

      expect(outer.is(RangeError)).toBe(true);
      expect(outer.is(TracedError)).toBe(true);
      expect(outer.is(TypeError)).toBe(false);
    });
  });

  describe("rootCause()", () => {
    it("returns itself when no cause", () => {
      const err = TracedError.fail("Error");
      expect(err.rootCause()).toBe(err);
    });

    it("returns the wrapped error", () => {
      const original = new TypeError("Original");
      const wrapped = TracedError.wrap(original, "Wrapped");
      expect(wrapped.rootCause()).toBe(original);
    });

    it("returns the innermost error in a chain", () => {
      const innermost = new RangeError("Innermost");
      const middle = TracedError.wrap(innermost, "Middle");
      const outer = TracedError.wrap(middle, "Outer");

      expect(outer.rootCause()).toBe(innermost);
    });

    it("returns non-Error cause", () => {
      const wrapped = TracedError.wrap("string cause", "Wrapped");
      expect(wrapped.rootCause()).toBe("string cause");
    });

    it("returns object cause", () => {
      const cause = { code: "ERR" };
      const wrapped = TracedError.wrap(cause, "Wrapped");
      expect(wrapped.rootCause()).toBe(cause);
    });
  });

  describe("toJSON()", () => {
    it("serializes error without cause", () => {
      const err = TracedError.fail("Test error", {
        status: ErrorStatus.BadRequest,
        fields: { foo: "bar" },
      });
      const json = err.toJSON();

      expect(json.name).toBe("TracedError");
      expect(json.message).toBe("Test error");
      expect(json.status).toBe("Bad Request");
      expect(json.statusCode).toBe(400);
      expect(json.fields).toEqual({ foo: "bar" });
      expect(json.caller).toBeDefined();
      expect(json.cause).toBeUndefined();
      expect(json.stack).toBeDefined();
    });

    it("serializes error with Error cause (includes stack)", () => {
      const original = new TypeError("Type error");
      const wrapped = TracedError.wrap(original, "Wrapped error");
      const json = wrapped.toJSON();

      expect(json.name).toBe("TracedError");
      expect(json.message).toBe("Wrapped error");
      expect(json.cause).toBeDefined();
      expect((json.cause as Record<string, unknown>).name).toBe("TypeError");
      expect((json.cause as Record<string, unknown>).message).toBe("Type error");
      expect((json.cause as Record<string, unknown>).stack).toBeDefined();
    });

    it("serializes error with non-Error cause", () => {
      const wrapped = TracedError.wrap("string cause", "Wrapped");
      const json = wrapped.toJSON();
      expect(json.cause).toBe("string cause");
    });

    it("serializes error with object cause", () => {
      const cause = { code: "ERR", detail: "info" };
      const wrapped = TracedError.wrap(cause, "Wrapped");
      const json = wrapped.toJSON();
      expect(json.cause).toEqual(cause);
    });

    it("serializes nested TracedError without double stack", () => {
      const inner = TracedError.fail("Inner error", {
        status: ErrorStatus.NotFound,
        fields: { inner: true },
      });
      const outer = TracedError.wrap(inner, "Outer error", {
        status: ErrorStatus.InternalServerError,
        fields: { outer: true },
      });
      const json = outer.toJSON();

      // Outer error fields
      expect(json.message).toBe("Outer error");
      expect(json.statusCode).toBe(500);
      expect(json.fields).toEqual({ outer: true });

      // Inner error is fully serialized via toJSON()
      const causeJson = json.cause as Record<string, unknown>;
      expect(causeJson.name).toBe("TracedError");
      expect(causeJson.message).toBe("Inner error");
      expect(causeJson.statusCode).toBe(404);
      expect(causeJson.fields).toEqual({ inner: true });
      expect(causeJson.caller).toBeDefined();
    });

    it("can be serialized with JSON.stringify", () => {
      const err = TracedError.fail("Test", {
        status: ErrorStatus.NotFound,
        fields: { id: 123 },
      });
      const str = JSON.stringify(err);
      const parsed = JSON.parse(str);

      expect(parsed.message).toBe("Test");
      expect(parsed.statusCode).toBe(404);
      expect(parsed.fields.id).toBe(123);
    });
  });

  describe("extends Error properly", () => {
    it("has stack trace", () => {
      const err = TracedError.fail("Error");
      expect(err.stack).toBeDefined();
      expect(err.stack).toContain("TracedError");
    });

    it("can be thrown and caught", () => {
      expect(() => {
        throw TracedError.fail("Thrown error");
      }).toThrow("Thrown error");
    });

    it("can be caught as Error", () => {
      try {
        throw TracedError.fail("Test");
      } catch (e) {
        expect(e instanceof Error).toBe(true);
        expect(e instanceof TracedError).toBe(true);
      }
    });
  });
});
