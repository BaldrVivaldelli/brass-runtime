import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeEvent, decodeEventBatch, encodeOpcodeNodes, encodeOpcodeProgram, EVENT_WORDS, NONE_U32 } from "../engine/binaryAbi";
import { inferCallerLaneFromStack, laneTag, sanitizeLaneKey, Scheduler } from "../scheduler";

const waitMicro = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const waitMacro = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("binary ABI", () => {
  it("encodes every opcode shape and decodes every event shape", () => {
    const nodes = [
      { tag: "Succeed", valueRef: 1 },
      { tag: "Fail", errorRef: 2 },
      { tag: "Sync", fnRef: 3 },
      { tag: "Async", registerRef: 4 },
      { tag: "FlatMap", first: 5, fnRef: 6 },
      { tag: "Fold", first: 7, onFailureRef: 8, onSuccessRef: 9 },
      { tag: "Fork", effectRef: 10 },
      { tag: "Fork", effectRef: 11, scopeId: 12 },
      { tag: "HostAction", actionRef: 13 },
      { tag: "HostAction", actionRef: 14, decodeRef: 15 },
    ] as any;

    expect(Array.from(encodeOpcodeProgram({ version: 1, root: 3, nodes }).slice(0, 3))).toEqual([1, 3, nodes.length]);
    expect(encodeOpcodeNodes(nodes)[0]).toBe(nodes.length);

    expect(decodeEvent([0, 1, 0, 0, 0])).toEqual({ kind: "Continue", fiberId: 1 });
    expect(decodeEvent([1, 1, 2, 0, 0])).toEqual({ kind: "Done", fiberId: 1, valueRef: 2 });
    expect(decodeEvent([2, 1, 3, 0, 0])).toEqual({ kind: "Failed", fiberId: 1, errorRef: 3 });
    expect(decodeEvent([3, 1, 4, 0, 0])).toEqual({ kind: "Interrupted", fiberId: 1, reasonRef: 4 });
    expect(decodeEvent([4, 1, 5, 0, 0])).toEqual({ kind: "InvokeSync", fiberId: 1, fnRef: 5 });
    expect(decodeEvent([5, 1, 6, 0, 0])).toEqual({ kind: "InvokeAsync", fiberId: 1, registerRef: 6 });
    expect(decodeEvent([6, 1, 7, 8, 0])).toEqual({ kind: "InvokeFlatMap", fiberId: 1, fnRef: 7, valueRef: 8 });
    expect(decodeEvent([7, 1, 9, 10, 0])).toEqual({ kind: "InvokeFoldFailure", fiberId: 1, fnRef: 9, errorRef: 10 });
    expect(decodeEvent([8, 1, 11, 12, 0])).toEqual({ kind: "InvokeFoldSuccess", fiberId: 1, fnRef: 11, valueRef: 12 });
    expect(decodeEvent([9, 1, 13, NONE_U32, NONE_U32])).toEqual({ kind: "InvokeFork", fiberId: 1, effectRef: 13 });
    expect(decodeEvent([9, 1, 13, 14, 0])).toEqual({ kind: "InvokeFork", fiberId: 1, effectRef: 13, scopeId: 14 });
    expect(decodeEvent([10, 1, 15, NONE_U32, 0])).toEqual({ kind: "InvokeHostAction", fiberId: 1, actionRef: 15 });
    expect(decodeEvent([10, 1, 15, 16, 0])).toEqual({ kind: "InvokeHostAction", fiberId: 1, actionRef: 15, decodeRef: 16 });
    expect(decodeEvent([999, 1, 0, 0, 0])).toEqual({ kind: "Failed", fiberId: 1, errorRef: 0 });

    const batch = new Uint32Array(1 + EVENT_WORDS * 2);
    batch.set([3, 0, 1, 0, 0, 0, 1, 2, 3, 0, 0]);
    expect(decodeEventBatch(batch)).toEqual([
      { kind: "Continue", fiberId: 1 },
      { kind: "Done", fiberId: 2, valueRef: 3 },
    ]);
    expect(decodeEventBatch(null)).toEqual([]);
    expect(decodeEventBatch(new Uint32Array())).toEqual([]);
  });
});

describe("scheduler edges", () => {
  it("sanitizes lane keys and infers caller lanes from stack shapes", () => {
    expect(sanitizeLaneKey("  A B\tC$  ")).toBe("A:B:C_");
    expect(sanitizeLaneKey("")).toBe("anonymous");
    expect(laneTag(" my lane ", "work")).toBe("lane:my:lane|work");

    expect(inferCallerLaneFromStack("Error\n    at userFn (/repo/src/app/service.ts:10:2)", "fallback")).toBe("app/service");
    expect(inferCallerLaneFromStack("Error\n    at node:internal/foo:1:1", "fallback lane")).toBe("fallback:lane");
    expect(inferCallerLaneFromStack("Error\n    at Runtime.foo (/repo/src/core/runtime/runtime.ts:1:1)\n    at /x/lib/file.js:2:3", "fallback")).toBe("lib/file");
  });

  it("handles TS queue drops, lane overflow, task throws, budget yields, batches, and stats", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new Scheduler({ flushBudget: 1, microThreshold: 0, laneCapacity: 1, laneBudget: 1, maxLanes: 1 });
    const ran: string[] = [];

    expect(scheduler.schedule("bad" as any)).toBe("dropped");
    expect(scheduler.schedule(() => { ran.push("a"); }, "lane:a|one")).toBe("accepted");
    expect(scheduler.schedule(() => { ran.push("b"); }, "lane:a|two")).toBe("accepted");
    expect(scheduler.schedule(() => { throw new Error("task"); }, "lane:b|overflow")).toBe("accepted");

    await waitMicro();
    await waitMacro();
    await waitMacro();
    await waitMacro();
    await waitMacro();

    expect(ran).toContain("a");
    expect(error).toHaveBeenCalled();
    expect(scheduler.stats()).toMatchObject({
      engine: "ts",
      fallbackUsed: false,
      data: {
        droppedTasks: expect.any(Number),
        yieldedByBudget: expect.any(Number),
        lanes: expect.arrayContaining([expect.objectContaining({ key: "a" })]),
      },
    });

    const batch = new Scheduler({ laneCapacity: 4 });
    const batchRan: number[] = [];
    expect(batch.scheduleBatch([
      { fn: () => batchRan.push(1), tag: "x" },
      { fn: "bad" as any, tag: "x" },
      { fn: () => batchRan.push(2), tag: "x" },
    ])).toEqual(["accepted", "dropped", "accepted"]);
    await waitMicro();
    expect(batchRan).toEqual([1, 2]);
  });

  it("rejects invalid scheduler engines", () => {
    expect(() => new Scheduler({ engine: "bad" as any })).toThrow(/scheduler engine/);
  });
});
