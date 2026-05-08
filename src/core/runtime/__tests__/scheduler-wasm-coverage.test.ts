import { afterEach, describe, expect, it, vi } from "vitest";

const waitMicro = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const waitMacro = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.doUnmock("../wasmModule");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("WASM scheduler edges", () => {
  it("requires the wasm scheduler state machine when explicitly requested", async () => {
    vi.doMock("../wasmModule", () => ({ resolveWasmModule: () => ({}) }));

    const { Scheduler } = await import("../scheduler");

    expect(() => new Scheduler({ engine: "wasm" })).toThrow(/wasm scheduler is not available/);
  });

  it("drives single and batch wasm scheduling policies, flushes, stats, and task failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctorArgs: unknown[][] = [];

    class FakeMachine {
      readonly refs: number[] = [];
      readonly tags = new Map<number, string>();
      scheduled = false;
      flushing = false;
      completed = 0;

      constructor(...args: unknown[]) {
        ctorArgs.push(args);
      }

      len() { return this.refs.length; }
      capacity() { return 32; }
      is_flushing() { return this.flushing; }
      is_scheduled() { return this.scheduled; }

      enqueue(ref: number, tag: string) {
        if (tag.includes("drop")) return 3;
        this.refs.push(ref);
        this.tags.set(ref, tag);
        this.scheduled = true;
        if (tag.includes("macro")) return 1;
        if (tag.includes("noop")) return 2;
        return 0;
      }

      enqueue_batch(refs: Uint32Array, tags: string[]) {
        return Uint32Array.from(tags.map((tag, index) => {
          const ref = refs[index]!;
          if (tag.includes("drop")) return 3;
          this.refs.push(ref);
          this.tags.set(ref, tag);
          this.scheduled = true;
          if (tag.includes("macro")) return 1;
          if (tag.includes("noop")) return 2;
          return 0;
        }));
      }

      begin_flush() {
        this.flushing = true;
        this.scheduled = false;
        return this.refs.length + 1;
      }

      shift() {
        return this.refs.shift() ?? 0;
      }

      end_flush() {
        this.flushing = false;
        this.completed++;
        return this.refs.length > 0 ? 0 : 2;
      }

      clear() {
        this.refs.length = 0;
        this.tags.clear();
      }

      stats_json() {
        return JSON.stringify({
          len: this.refs.length,
          capacity: this.capacity(),
          completedFlushes: this.completed,
          scheduledFlushes: this.scheduled ? 1 : 0,
        });
      }
    }

    vi.doMock("../wasmModule", () => ({
      resolveWasmModule: () => ({ BrassWasmSchedulerStateMachine: FakeMachine }),
    }));

    const { Scheduler } = await import("../scheduler");
    const scheduler = new Scheduler({
      engine: "wasm",
      initialCapacity: 4,
      maxCapacity: 32,
      flushBudget: 4,
      microThreshold: 2,
      laneCapacity: 8,
      laneBudget: 3,
      maxLanes: 7,
    });
    const ran: string[] = [];

    expect(ctorArgs[0]).toEqual([4, 32, 4, 2, 8, 3, 7]);
    expect(scheduler.schedule(() => ran.push("micro"), "lane:a|micro")).toBe("accepted");
    await waitMicro();
    expect(ran).toEqual(["micro"]);

    expect(scheduler.schedule(() => ran.push("macro"), "lane:a|macro")).toBe("accepted");
    await waitMacro();
    expect(ran).toContain("macro");

    expect(scheduler.schedule(() => ran.push("dropped"), "lane:a|drop")).toBe("dropped");
    expect(scheduler.schedule(() => ran.push("deferred"), "lane:a|noop")).toBe("accepted");

    expect(scheduler.scheduleBatch([
      { fn: () => ran.push("batch-micro"), tag: "lane:a|micro" },
      { fn: "bad" as any, tag: "lane:a|invalid" },
      { fn: () => { throw new Error("boom"); }, tag: "lane:a|macro" },
      { fn: () => ran.push("batch-drop"), tag: "lane:a|drop" },
      { fn: () => ran.push("batch-noop"), tag: "lane:a|noop" },
    ])).toEqual(["accepted", "dropped", "accepted", "dropped", "accepted"]);

    await waitMicro();
    await waitMicro();

    expect(ran).toEqual(expect.arrayContaining(["deferred", "batch-micro", "batch-noop"]));
    expect(ran).not.toContain("dropped");
    expect(ran).not.toContain("batch-drop");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[Scheduler] task threw"), expect.any(Error));
    expect(scheduler.stats()).toEqual({
      engine: "wasm",
      fallbackUsed: false,
      data: {
        len: 0,
        capacity: 32,
        completedFlushes: expect.any(Number),
        scheduledFlushes: 0,
      },
    });
  });

  it("returns batch drops without touching wasm when every batch item is invalid", async () => {
    const enqueueBatch = vi.fn();
    class FakeMachine {
      len() { return 0; }
      capacity() { return 1; }
      is_flushing() { return false; }
      is_scheduled() { return false; }
      enqueue() { return 0; }
      enqueue_batch = enqueueBatch;
      begin_flush() { return 0; }
      shift() { return 0; }
      end_flush() { return 2; }
      clear() {}
      stats_json() { return JSON.stringify({ len: 0 }); }
    }

    vi.doMock("../wasmModule", () => ({
      resolveWasmModule: () => ({ BrassWasmSchedulerStateMachine: FakeMachine }),
    }));

    const { Scheduler } = await import("../scheduler");
    const scheduler = new Scheduler({ engine: "wasm" });

    expect(scheduler.scheduleBatch([
      { fn: null as any, tag: "lane:a|bad" },
      { fn: "bad" as any, tag: "lane:a|bad" },
    ])).toEqual(["dropped", "dropped"]);
    expect(enqueueBatch).not.toHaveBeenCalled();
  });

  it("ignores wasm flushes that report no budget", async () => {
    const shift = vi.fn();

    class FakeMachine {
      len() { return 1; }
      capacity() { return 1; }
      is_flushing() { return false; }
      is_scheduled() { return true; }
      enqueue() { return 0; }
      enqueue_batch() { return Uint32Array.from([]); }
      begin_flush() { return 0; }
      shift = shift;
      end_flush() { return 2; }
      clear() {}
      stats_json() { return JSON.stringify({ len: 1 }); }
    }

    vi.doMock("../wasmModule", () => ({
      resolveWasmModule: () => ({ BrassWasmSchedulerStateMachine: FakeMachine }),
    }));

    const { Scheduler } = await import("../scheduler");
    const scheduler = new Scheduler({ engine: "wasm" });

    expect(scheduler.schedule(() => undefined, "lane:a|micro")).toBe("accepted");
    await waitMicro();
    expect(shift).not.toHaveBeenCalled();
    expect(scheduler.stats().data).toEqual({ len: 1 });
  });
});
