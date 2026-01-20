import { describe, it, expect } from "vitest";
import {
  CallerInfo,
  parseStackFrame,
  getCallerFromStack,
  withCaller,
  getCurrentCaller,
} from "./index.js";

describe("parseStackFrame", () => {
  it("parses named function with file path", () => {
    const line = "    at myFunction (/home/user/project/src/index.ts:42:15)";
    const result = parseStackFrame(line);
    expect(result?.toJSON()).toEqual({
      function: "myFunction",
      file: "/home/user/project/src/index.ts",
      line: 42,
      column: 15,
    });
  });

  it("parses method call", () => {
    const line = "    at Logger.info (/home/user/project/src/logger.ts:100:5)";
    const result = parseStackFrame(line);
    expect(result?.toJSON()).toEqual({
      function: "Logger.info",
      file: "/home/user/project/src/logger.ts",
      line: 100,
      column: 5,
    });
  });

  it("parses anonymous function", () => {
    const line = "    at /home/user/project/src/handler.ts:25:10";
    const result = parseStackFrame(line);
    // Anonymous functions return empty string for function via getter
    expect(result?.file).toBe("/home/user/project/src/handler.ts");
    expect(result?.line).toBe(25);
    expect(result?.function).toBe(""); // getter returns empty for anonymous without parent
  });

  it("parses async function", () => {
    const line = "    at async handleRequest (/app/src/server.ts:15:3)";
    const result = parseStackFrame(line);
    expect(result?.toJSON()).toEqual({
      function: "handleRequest",
      file: "/app/src/server.ts",
      line: 15,
      column: 3,
    });
  });

  it("returns null for Error line", () => {
    const line = "Error: something went wrong";
    const result = parseStackFrame(line);
    expect(result).toBeNull();
  });

  it("returns null for empty line", () => {
    expect(parseStackFrame("")).toBeNull();
    expect(parseStackFrame("   ")).toBeNull();
  });

  it("returns null for unparseable line", () => {
    const line = "some random text";
    const result = parseStackFrame(line);
    expect(result).toBeNull();
  });

  it("handles Windows-style paths", () => {
    const line = "    at myFunc (C:\\Users\\dev\\project\\src\\index.ts:10:5)";
    const result = parseStackFrame(line);
    expect(result?.toJSON()).toEqual({
      function: "myFunc",
      file: "C:\\Users\\dev\\project\\src\\index.ts",
      line: 10,
      column: 5,
    });
  });

  it("handles nested paths", () => {
    const line = "    at handler (/very/long/nested/path/to/file.ts:1:1)";
    const result = parseStackFrame(line);
    expect(result?.toJSON()).toEqual({
      function: "handler",
      file: "/very/long/nested/path/to/file.ts",
      line: 1,
      column: 1,
    });
  });
});

describe("getCallerFromStack", () => {
  it("returns caller info with file and line", () => {
    const result = getCallerFromStack(1);
    expect(result.file).toBeDefined();
    expect(result.line).toBeGreaterThan(0);
  });

  it("returns empty CallerInfo when stack is exhausted", () => {
    const result = getCallerFromStack(1000);
    expect(result.isEmpty()).toBe(true);
  });

  it("finds first named function in stack", () => {
    function namedParentFunction() {
      // skipFrames=2: skip getCallerFromStack wrapper + CallerInfo.from
      return getCallerFromStack(2);
    }

    const result = namedParentFunction();
    expect(result.file).toContain("caller.test");
    expect(result.function).toBe("namedParentFunction");
  });

  it("handles Array.forEach callback with withCaller", () => {
    function processItems() {
      let result: CallerInfo | undefined;
      withCaller(() => {
        [1].forEach(() => {
          result = getCurrentCaller();
        });
      });
      return result;
    }

    const result = processItems();
    // With withCaller, parent chain lookup finds processItems
    expect(result?.function).toBe("processItems");
  });
});

describe("CallerInfo", () => {
  it("creates with options", () => {
    const caller = new CallerInfo({
      file: "test.ts",
      function: "myFunc",
      line: 10,
      column: 5,
    });
    expect(caller.file).toBe("test.ts");
    expect(caller.function).toBe("myFunc");
    expect(caller.line).toBe(10);
    expect(caller.column).toBe(5);
  });

  it("function getter returns parent function for anonymous", () => {
    const parent = new CallerInfo({ function: "parentFunc" });
    const child = new CallerInfo({ function: "<anonymous>", parent });
    expect(child.function).toBe("parentFunc");
  });

  it("function getter returns empty string for anonymous without parent", () => {
    const caller = new CallerInfo({ function: "<anonymous>" });
    expect(caller.function).toBe("");
  });

  it("isEmpty returns true for empty CallerInfo", () => {
    const caller = new CallerInfo();
    expect(caller.isEmpty()).toBe(true);
  });

  it("isEmpty returns false when has data", () => {
    const caller = new CallerInfo({ file: "test.ts" });
    expect(caller.isEmpty()).toBe(false);
  });

  it("toString formats correctly", () => {
    const caller = new CallerInfo({
      file: "test.ts",
      function: "myFunc",
      line: 10,
    });
    expect(caller.toString()).toBe("test.ts:10 myFunc");
  });

  it("toJSON excludes parent", () => {
    const parent = new CallerInfo({ function: "parent" });
    const child = new CallerInfo({
      file: "test.ts",
      function: "child",
      line: 5,
      column: 3,
      parent,
    });
    const json = child.toJSON();
    expect(json).toEqual({
      file: "test.ts",
      function: "child",
      line: 5,
      column: 3,
    });
    expect("parent" in json).toBe(false);
  });
});

describe("withCaller", () => {
  it("captures caller at withCaller call site", () => {
    function outerFunction() {
      return withCaller(() => {
        return getCurrentCaller();
      });
    }

    const caller = outerFunction();
    expect(caller?.function).toBe("outerFunction");
    expect(caller?.file).toContain("caller.test");
  });

  it("captures caller with anonymous callback getting outer function name", () => {
    function namedHandler() {
      return withCaller(() => {
        // Anonymous callback, should get namedHandler as function name
        const caller = getCurrentCaller();
        return caller;
      });
    }

    const caller = namedHandler();
    expect(caller?.function).toBe("namedHandler");
  });

  it("captures caller in nested anonymous callbacks", () => {
    function topLevelFunction() {
      return withCaller(() => {
        // Level 1 anonymous
        const nested = () => {
          // Level 2 anonymous
          return getCurrentCaller();
        };
        return nested();
      });
    }

    const caller = topLevelFunction();
    // Should get topLevelFunction from the withCaller call site
    expect(caller?.function).toBe("topLevelFunction");
  });

  it("works with async callbacks", async () => {
    async function asyncHandler() {
      return withCaller(async () => {
        await Promise.resolve();
        return getCurrentCaller();
      });
    }

    const caller = await asyncHandler();
    expect(caller?.function).toBe("asyncHandler");
  });

  it("preserves line number from withCaller call site", () => {
    function testLineNumber() {
      return withCaller(() => {
        return getCurrentCaller();
      });
    }

    const caller = testLineNumber();
    expect(caller?.line).toBeGreaterThan(0);
    expect(caller?.file).toContain("caller.test");
  });

  it("nested withCaller uses innermost context", () => {
    function outer() {
      return withCaller(() => {
        function inner() {
          return withCaller(() => {
            return getCurrentCaller();
          });
        }
        return inner();
      });
    }

    const caller = outer();
    // Inner withCaller should capture 'inner' as the function
    expect(caller?.function).toBe("inner");
  });
});
