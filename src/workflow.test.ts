import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateDeterministicKey,
  traceWorkflow,
  withWorkflowTrace,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "./workflow.js";
import { initTracing } from "./provider.js";

// Initialize tracing for tests
beforeEach(() => {
  initTracing();
});

// ============================================
// generateDeterministicKey tests
// ============================================

describe("generateDeterministicKey", () => {
  it("wraps non-array values in array", () => {
    expect(generateDeterministicKey("hello")).toBe('["hello"]');
    expect(generateDeterministicKey(123)).toBe("[123]");
    expect(generateDeterministicKey(true)).toBe("[true]");
    expect(generateDeterministicKey(null)).toBe("[null]");
  });

  it("keeps arrays as-is", () => {
    expect(generateDeterministicKey(["a", "b"])).toBe('["a","b"]');
    expect(generateDeterministicKey([1, 2, 3])).toBe("[1,2,3]");
  });

  it("sorts object keys alphabetically", () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(generateDeterministicKey(obj)).toBe('[{"a":2,"m":3,"z":1}]');
  });

  it("sorts nested object keys recursively", () => {
    const obj = {
      z: { b: 1, a: 2 },
      a: { y: 3, x: 4 },
    };
    expect(generateDeterministicKey(obj)).toBe(
      '[{"a":{"x":4,"y":3},"z":{"a":2,"b":1}}]'
    );
  });

  it("handles arrays with objects", () => {
    const arr = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
    expect(generateDeterministicKey(arr)).toBe(
      '[{"a":2,"b":1},{"c":4,"d":3}]'
    );
  });

  it("converts Date to ISO string", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    expect(generateDeterministicKey(date)).toBe('["2024-01-15T10:30:00.000Z"]');
  });

  it("handles mixed nested structures", () => {
    const obj = {
      items: [{ id: 2 }, { id: 1 }],
      meta: { count: 2, type: "list" },
    };
    expect(generateDeterministicKey(obj)).toBe(
      '[{"items":[{"id":2},{"id":1}],"meta":{"count":2,"type":"list"}}]'
    );
  });

  it("produces same key regardless of object key order", () => {
    const obj1 = { a: 1, b: 2, c: 3 };
    const obj2 = { c: 3, a: 1, b: 2 };
    const obj3 = { b: 2, c: 3, a: 1 };

    const key1 = generateDeterministicKey(obj1);
    const key2 = generateDeterministicKey(obj2);
    const key3 = generateDeterministicKey(obj3);

    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });
});

// ============================================
// withWorkflowTrace tests
// ============================================

describe("withWorkflowTrace", () => {
  it("returns payload unchanged when no active span", () => {
    const payload = { orderId: "123", amount: 100 };
    const result = withWorkflowTrace(payload);

    expect(result).toEqual(payload);
    expect(result._traceparent).toBeUndefined();
  });

  it("preserves existing payload properties", () => {
    const payload = { orderId: "123", nested: { value: 42 } };
    const result = withWorkflowTrace(payload);

    expect(result.orderId).toBe("123");
    expect(result.nested).toEqual({ value: 42 });
  });
});

// ============================================
// traceWorkflow decorator tests
// ============================================

describe("traceWorkflow decorator", () => {
  // Type for step.do callback
  type StepCallback<T> = () => Promise<T>;

  // Mock WorkflowStep
  function createMockStep(): WorkflowStep {
    return {
      do: vi.fn(async <T>(
        _name: string,
        configOrCallback: WorkflowStepConfig | StepCallback<T>,
        maybeCallback?: StepCallback<T>
      ) => {
        const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback!;
        return callback();
      }),
      sleep: vi.fn(async () => {}),
      sleepUntil: vi.fn(async () => {}),
      waitForEvent: vi.fn(async () => ({ type: "test", data: {} })),
    };
  }

  // Mock WorkflowEvent
  function createMockEvent<T>(payload: T): WorkflowEvent<T> {
    return {
      payload: payload as Readonly<T & { _traceparent?: string }>,
      timestamp: new Date(),
      instanceId: "test-instance-123",
    };
  }

  it("decorates a workflow class", () => {
    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<{ data: string }>, _step: WorkflowStep) {
        return { success: true };
      }
    }

    expect(TestWorkflow).toBeDefined();
    expect(TestWorkflow.name).toBe("TestWorkflow");
  });

  it("calls the original run method", async () => {
    const runSpy = vi.fn().mockResolvedValue({ result: "done" });

    @traceWorkflow()
    class TestWorkflow {
      async run(event: WorkflowEvent<{ data: string }>, step: WorkflowStep) {
        return runSpy(event, step);
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({ data: "test" });
    const step = createMockStep();

    const result = await workflow.run(event, step);

    expect(runSpy).toHaveBeenCalled();
    expect(result).toEqual({ result: "done" });
  });

  it("proxies step.do calls", async () => {
    const stepDoResult = { fetched: true };

    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        const result = await step.do("fetch-data", async () => {
          return stepDoResult;
        });
        return result;
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    const result = await workflow.run(event, step);

    expect(step.do).toHaveBeenCalledWith(
      "fetch-data",
      expect.any(Function)
    );
    expect(result).toEqual(stepDoResult);
  });

  it("proxies step.do calls with config", async () => {
    const stepDoResult = { processed: true };
    const config: WorkflowStepConfig = {
      retries: { limit: 3, delay: "1s" },
      timeout: "30s",
    };

    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        const result = await step.do("process", config, async () => {
          return stepDoResult;
        });
        return result;
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    const result = await workflow.run(event, step);

    expect(step.do).toHaveBeenCalledWith(
      "process",
      config,
      expect.any(Function)
    );
    expect(result).toEqual(stepDoResult);
  });

  it("proxies step.sleep calls", async () => {
    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        await step.sleep("wait-period", "1 hour");
        return { done: true };
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    await workflow.run(event, step);

    expect(step.sleep).toHaveBeenCalledWith("wait-period", "1 hour");
  });

  it("proxies step.sleepUntil calls", async () => {
    const targetDate = new Date("2025-01-20T10:00:00Z");

    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        await step.sleepUntil("wait-until", targetDate);
        return { done: true };
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    await workflow.run(event, step);

    expect(step.sleepUntil).toHaveBeenCalledWith("wait-until", targetDate);
  });

  it("proxies step.waitForEvent calls", async () => {
    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        const result = await step.waitForEvent("approval", {
          type: "user-approval",
          timeout: "24 hours",
        });
        return result;
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    await workflow.run(event, step);

    expect(step.waitForEvent).toHaveBeenCalledWith("approval", {
      type: "user-approval",
      timeout: "24 hours",
    });
  });

  it("handles errors in step.do", async () => {
    const error = new Error("Step failed");

    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        await step.do("failing-step", async () => {
          throw error;
        });
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();
    vi.mocked(step.do).mockImplementation(async <T>(_name: string, callback: StepCallback<T>) => {
      return callback();
    });

    await expect(workflow.run(event, step)).rejects.toThrow("Step failed");
  });

  it("handles errors in workflow run", async () => {
    const error = new Error("Workflow failed");

    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, _step: WorkflowStep) {
        throw error;
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    await expect(workflow.run(event, step)).rejects.toThrow("Workflow failed");
  });

  it("extracts traceparent from payload", async () => {
    @traceWorkflow()
    class TestWorkflow {
      async run(_event: WorkflowEvent<{ data: string }>, _step: WorkflowStep) {
        return { received: true };
      }
    }

    const workflow = new (TestWorkflow as unknown as new (...args: unknown[]) => { run: typeof TestWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({
      data: "test",
      _traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    const step = createMockStep();

    const result = await workflow.run(event, step);

    expect(result).toEqual({ received: true });
  });

  it("handles multiple steps in sequence", async () => {
    const stepResults: string[] = [];

    @traceWorkflow()
    class MultiStepWorkflow {
      async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
        await step.do("step-1", async () => {
          stepResults.push("step-1");
          return "result-1";
        });

        await step.sleep("pause", "1s");

        await step.do("step-2", async () => {
          stepResults.push("step-2");
          return "result-2";
        });

        return { steps: stepResults };
      }
    }

    const workflow = new (MultiStepWorkflow as unknown as new (...args: unknown[]) => { run: typeof MultiStepWorkflow.prototype.run })(undefined, undefined);
    const event = createMockEvent({});
    const step = createMockStep();

    await workflow.run(event, step);

    expect(stepResults).toEqual(["step-1", "step-2"]);
    // 3 calls: 1 for __trace_init + 2 for actual steps
    expect(step.do).toHaveBeenCalledTimes(3);
    expect(step.sleep).toHaveBeenCalledTimes(1);
  });
});
