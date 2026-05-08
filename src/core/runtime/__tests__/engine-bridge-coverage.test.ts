import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceWasmBridge } from "../engine/bridge/ReferenceWasmBridge";
import { makeFiberReadyQueue } from "../engine/bridge/WasmFiberReadyQueueBridge";
import { WasmFiberRegistryBridge } from "../engine/bridge/WasmFiberRegistryBridge";
import { makeWasmTimerWheel, WasmTimerWheelBridge } from "../engine/bridge/WasmTimerWheelBridge";
import { WasmPackFiberBridge } from "../engine/bridge/WasmPackFiberBridge";
import { EventKindCode } from "../engine/binaryAbi";
import type { OpcodeProgram } from "../engine/opcodes";

vi.mock("../wasmModule", () => ({
  resolveWasmModule: vi.fn(),
  wasmModuleResolutionErrors: vi.fn(() => ["missing wasm for test"]),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReferenceWasmBridge", () => {
  it("drives success, failure, continuations, host events, interruption, stats, and drops", () => {
    const bridge = new ReferenceWasmBridge();
    const succeedProgram: OpcodeProgram = {
      version: 1,
      root: 1,
      nodes: [
        { tag: "Succeed", valueRef: 10 },
        { tag: "FlatMap", first: 0, fnRef: 20 },
      ],
    };

    const fiberId = bridge.createFiber(succeedProgram);
    expect(bridge.poll(fiberId)).toEqual({ kind: "InvokeFlatMap", fiberId, fnRef: 20, valueRef: 10 });
    expect(bridge.provideEffect(fiberId, 2, [{ tag: "Succeed", valueRef: 30 }])).toEqual({ kind: "Done", fiberId, valueRef: 30 });

    const failProgram: OpcodeProgram = {
      version: 1,
      root: 1,
      nodes: [
        { tag: "Fail", errorRef: 40 },
        { tag: "Fold", first: 0, onFailureRef: 50, onSuccessRef: 60 },
      ],
    };
    const failedFiber = bridge.createFiber(failProgram);
    expect(bridge.driveBatch(failedFiber, 10)).toEqual([
      { kind: "InvokeFoldFailure", fiberId: failedFiber, fnRef: 50, errorRef: 40 },
    ]);
    expect(bridge.provideError(failedFiber, 70)).toEqual({ kind: "Failed", fiberId: failedFiber, errorRef: 70 });

    const foldedSuccess = bridge.createFiber({
      version: 1,
      root: 1,
      nodes: [
        { tag: "Succeed", valueRef: 41 },
        { tag: "Fold", first: 0, onFailureRef: 51, onSuccessRef: 61 },
      ],
    });
    expect(bridge.poll(foldedSuccess)).toEqual({
      kind: "InvokeFoldSuccess",
      fiberId: foldedSuccess,
      fnRef: 61,
      valueRef: 41,
    });
    expect(bridge.provideValue(foldedSuccess, 71)).toEqual({ kind: "Done", fiberId: foldedSuccess, valueRef: 71 });

    const eventPrograms: OpcodeProgram[] = [
      { version: 1, root: 0, nodes: [{ tag: "Sync", fnRef: 1 }] },
      { version: 1, root: 0, nodes: [{ tag: "Async", registerRef: 2 }] },
      { version: 1, root: 0, nodes: [{ tag: "Fork", effectRef: 3 }] },
      { version: 1, root: 0, nodes: [{ tag: "Fork", effectRef: 4, scopeId: 99 }] },
      { version: 1, root: 0, nodes: [{ tag: "HostAction", actionRef: 5 }] },
      { version: 1, root: 0, nodes: [{ tag: "HostAction", actionRef: 6, decodeRef: 7 }] },
    ];
    const events = eventPrograms.map((program) => {
      const id = bridge.createFiber(program);
      return bridge.poll(id);
    });
    expect(events).toEqual([
      { kind: "InvokeSync", fiberId: 4, fnRef: 1 },
      { kind: "InvokeAsync", fiberId: 5, registerRef: 2 },
      { kind: "InvokeFork", fiberId: 6, effectRef: 3 },
      { kind: "InvokeFork", fiberId: 7, effectRef: 4, scopeId: 99 },
      { kind: "InvokeHostAction", fiberId: 8, actionRef: 5 },
      { kind: "InvokeHostAction", fiberId: 9, actionRef: 6, decodeRef: 7 },
    ]);

    expect(bridge.interrupt(4, 123)).toEqual({ kind: "Interrupted", fiberId: 4, reasonRef: 123 });
    expect(bridge.poll(4)).toEqual({ kind: "Interrupted", fiberId: 4, reasonRef: 123 });

    const badRoot = bridge.createFiber({ version: 1, root: 9, nodes: [] });
    expect(bridge.poll(badRoot)).toEqual({ kind: "Failed", fiberId: badRoot, errorRef: 0 });
    expect(() => bridge.poll(999)).toThrow(/Fiber 999 not found/);

    bridge.dropFiber(fiberId);
    expect(bridge.stats()).toMatchObject({
      started: 10,
      completed: 2,
      failed: 2,
      interrupted: 1,
      bridge: { supportsBinary: false, eventCalls: expect.any(Number), maxEventsPerCall: 1 },
    });
  });
});

describe("WasmFiberRegistryBridge", () => {
  it("adapts registry lifecycle, state mapping, wakeups, stats, and unavailable constructor", async () => {
    const wasmModule = await import("../wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);
    const calls: unknown[][] = [];

    class FakeRegistry {
      private states = new Map<number, number>();
      private wakeups = [7, 8, 0];
      register_fiber(...args: unknown[]) { calls.push(["register", ...args]); this.states.set(args[0] as number, 0); return true; }
      mark_queued(id: number) { this.states.set(id, 0); return true; }
      mark_running(id: number) { this.states.set(id, 1); return true; }
      mark_suspended(id: number) { this.states.set(id, 2); return true; }
      mark_done(id: number, state: number) { this.states.set(id, state); return 2; }
      drop_fiber(id: number) { this.states.delete(id); return true; }
      add_joiner() { return 1; }
      wake() { return true; }
      drain_wakeup() { return this.wakeups.shift() ?? 0; }
      wake_queue_len() { return this.wakeups.filter((id) => id !== 0).length; }
      state_of(id: number) { return this.states.get(id) ?? 0xffffffff; }
      stats_json() { return JSON.stringify({ live: this.states.size, queued: 1, running: 2 }); }
    }

    resolveWasmModule.mockReturnValueOnce({ BrassWasmFiberRegistry: FakeRegistry });
    const registry = new WasmFiberRegistryBridge();

    registry.registerFiber(1, 2, 3);
    registry.markQueued(1);
    registry.markRunning(1);
    expect(registry.stateOf(1)).toBe("running");
    registry.markSuspended(1);
    expect(registry.stateOf(1)).toBe("suspended");
    expect(registry.markDone(1, "done")).toBe(2);
    expect(registry.stateOf(1)).toBe("done");
    registry.markDone(1, "failed");
    expect(registry.stateOf(1)).toBe("failed");
    registry.markDone(1, "interrupted");
    expect(registry.stateOf(1)).toBe("interrupted");
    registry.addJoiner(1);
    expect(registry.wake(1)).toBe(true);
    expect(registry.drainWakeups()).toEqual([7, 8]);
    expect(registry.wakeQueueLength()).toBe(0);
    expect(registry.stats()).toMatchObject({ live: 1, queued: 1, running: 2 });
    registry.dropFiber(1);
    expect(registry.stateOf(1)).toBe("missing");
    expect(calls[0]?.slice(0, 4)).toEqual(["register", 1, 2, 3]);

    resolveWasmModule.mockReturnValueOnce({});
    expect(() => new WasmFiberRegistryBridge()).toThrow(/wasm fiber registry is not available/);
  });
});

describe("WasmTimerWheelBridge", () => {
  it("schedules, cancels, flushes, reads events, reports stats, and resolves from WASM module", async () => {
    const wasmModule = await import("../wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);
    const expired: unknown[] = [];

    class FakeWheel {
      readonly buffer = new ArrayBuffer(96);
      constructor(readonly tickMs: bigint, readonly bucketCount: number) {}
      memory() { return { buffer: this.buffer }; }
      schedule_deadline(subjectId: number, kind: number, deadlineMs: bigint) {
        expect(typeof deadlineMs).toBe("bigint");
        return subjectId + kind;
      }
      cancel() { return true; }
      advance_time() {
        new Uint32Array(this.buffer).set([2, 1, 10, 20, 5, 1, 2, 11, 21, 6, 0], 1);
        return 4;
      }
      expired_len() { return 11; }
      next_deadline_ms() { return -1; }
      metric_u64(id: number) { return id + 1; }
    }

    const wheel = new WasmTimerWheelBridge(FakeWheel, {
      tickMs: 2.9,
      bucketCount: 4,
      onExpired: (events) => expired.push(...events),
    });

    expect(wheel.schedule(3, 4, 5.8)).toBe(7);
    wheel.cancel(undefined);
    wheel.cancel(7);
    wheel.flush(10);
    expect(expired).toEqual([
      { timerId: 1, subjectId: 10, kind: 20, deadlineMs: 0x1_0000_0000 + 5 },
      { timerId: 2, subjectId: 11, kind: 21, deadlineMs: 6 },
    ]);
    expect(wheel.stats()).toEqual({ live: 1, scheduled: 2, canceled: 3, expired: 4, buckets: 5 });
    wheel.dispose();

    resolveWasmModule.mockReturnValueOnce({ BrassWasmTimerWheel: FakeWheel });
    expect(makeWasmTimerWheel({ onExpired: () => undefined })).toBeInstanceOf(WasmTimerWheelBridge);

    resolveWasmModule.mockReturnValueOnce({});
    expect(() => makeWasmTimerWheel({ onExpired: () => undefined })).toThrow(/wasm timer wheel is not available/);
  });
});

describe("WasmPackFiberBridge", () => {
  it("drives the strict zero-copy bridge, fallbacks, drops, and metrics", async () => {
    const wasmModule = await import("../wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);

    class FakeVm {
      readonly buffer = new ArrayBuffer(1024);
      private eventLen = 0;
      private readonly eventPtr = 64;
      private readonly wordsPtr = 256;
      private readonly metricsPtr = 512;
      dropped: number[] = [];

      memory() { return { buffer: this.buffer }; }
      prepare_program_words() { return this.wordsPtr; }
      prepare_patch_words() { return this.wordsPtr; }
      create_fiber_from_program_words(wordLen: number) { expect(wordLen).toBeGreaterThan(0); return 42; }
      event_batch_len() { return this.eventLen; }
      drive_batch_ptr(fiberId: number) { return this.writeEvents([[EventKindCode.Done, fiberId, 10, 0, 0]]); }
      provide_value_ptr() { return this.writeEvents([]); }
      provide_error_ptr(fiberId: number, errorRef: number) { return this.writeEvents([[EventKindCode.Failed, fiberId, errorRef, 0, 0]]); }
      provide_effect_from_words(fiberId: number, _root: number, wordLen: number) {
        expect(wordLen).toBeGreaterThan(0);
        return this.writeEvents([[EventKindCode.InvokeSync, fiberId, 77, 0, 0]]);
      }
      interrupt_ptr() { return this.writeEvents([]); }
      metrics_snapshot_ptr() {
        new Float64Array(this.buffer, this.metricsPtr, 3).set([1, 2, 3]);
        return this.metricsPtr;
      }
      metrics_snapshot_len() { return 3; }
      drop_fiber(fiberId: number) { this.dropped.push(fiberId); }

      create_fiber_bin() { return 0; }
      drive_batch_bin() { return new Uint32Array([0]); }
      provide_value_bin() { return new Uint32Array([0]); }
      provide_error_bin() { return new Uint32Array([0]); }
      provide_effect_bin() { return new Uint32Array([0]); }
      interrupt_bin() { return new Uint32Array([0]); }

      create_fiber() { return 0; }
      poll() { return JSON.stringify({ kind: "Continue", fiberId: 1 }); }
      provide_value() { return JSON.stringify({ kind: "Continue", fiberId: 1 }); }
      provide_error() { return JSON.stringify({ kind: "Failed", fiberId: 1, errorRef: 2 }); }
      provide_effect() { return JSON.stringify({ kind: "Continue", fiberId: 1 }); }
      interrupt() { return JSON.stringify({ kind: "Interrupted", fiberId: 1, reasonRef: 2 }); }
      stats_json() { return "{}"; }

      private writeEvents(events: number[][]) {
        const words = new Uint32Array(this.buffer, this.eventPtr, 1 + events.length * 5);
        words[0] = events.length;
        events.forEach((event, index) => words.set(event, 1 + index * 5));
        this.eventLen = words.length;
        return this.eventPtr;
      }
    }

    const vm = new FakeVm();
    resolveWasmModule.mockReturnValueOnce({ BrassWasmVm: class { constructor() { return vm; } } });
    const bridge = new WasmPackFiberBridge();

    expect(bridge.supportsBinary).toBe(true);
    expect(bridge.supportsZeroCopy).toBe(true);
    expect(bridge.supportsNoJsonMetrics).toBe(true);
    expect(bridge.createFiber({ version: 1, root: 0, nodes: [{ tag: "Succeed", valueRef: 1 }] })).toBe(42);
    expect(bridge.poll(5)).toEqual({ kind: "Done", fiberId: 5, valueRef: 10 });
    expect(bridge.provideValue(5, 11)).toEqual({ kind: "Continue", fiberId: 5 });
    expect(bridge.provideError(5, 12)).toEqual({ kind: "Failed", fiberId: 5, errorRef: 12 });
    expect(bridge.provideEffect(5, 0, [{ tag: "Sync", fnRef: 77 }])).toEqual({ kind: "InvokeSync", fiberId: 5, fnRef: 77 });
    expect(bridge.interrupt(5, 99)).toEqual({ kind: "Interrupted", fiberId: 5, reasonRef: 99 });
    bridge.dropFiber(5);
    expect(vm.dropped).toEqual([5]);
    expect(bridge.stats()).toMatchObject({
      started: 1,
      live: 2,
      running: 3,
      bridge: {
        supportsBinary: true,
        supportsZeroCopy: true,
        supportsNoJsonMetrics: true,
        zeroCopyPrograms: 1,
        zeroCopyPatches: 1,
      },
    });
  });

  it("rejects modules missing strict hot-path exports and reports load failures", async () => {
    const wasmModule = await import("../wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);

    resolveWasmModule.mockReturnValueOnce({ BrassWasmVm: class {
      create_fiber() { return 0; }
      poll() { return "{}"; }
      provide_value() { return "{}"; }
      provide_error() { return "{}"; }
      provide_effect() { return "{}"; }
      interrupt() { return "{}"; }
      drop_fiber() {}
      stats_json() { return "{}"; }
    } });
    expect(() => new WasmPackFiberBridge()).toThrow(/strict Rust\/WASM hot path/);

    resolveWasmModule.mockReturnValueOnce(null);
    expect(() => new WasmPackFiberBridge()).toThrow(/could not load wasm/);
  });
});

describe("fiber ready queue bridge", () => {
  it("drives TS queue lane inference, budgets, clear, stats, invalid engine, and WASM queue", async () => {
    const tsQueue = makeFiberReadyQueue({ flushBudget: 2, microThreshold: 1, laneCapacity: 2, laneBudget: 1, maxLanes: 1 });

    expect(tsQueue.enqueue(1, "lane:alpha|x")).toBe("micro");
    expect(tsQueue.enqueue(2, "caller:beta|x")).toBe("none");
    expect(tsQueue.enqueue(3, "pkg.module")).toBe("none");
    expect(tsQueue.len()).toBe(3);
    expect(tsQueue.beginFlush()).toBe(2);
    expect(tsQueue.beginFlush()).toBe(0);
    expect(tsQueue.shift()).toBe(1);
    expect(tsQueue.endFlush(2)).toBe("macro");
    expect(tsQueue.shift()).toBe(2);
    expect(tsQueue.shift()).toBe(3);
    expect(tsQueue.endFlush(1)).toBe("none");
    expect(tsQueue.enqueue(4, "")).toBe("micro");
    tsQueue.clear();
    expect(tsQueue.len()).toBe(0);
    expect(tsQueue.stats()).toMatchObject({
      engine: "ts",
      fallbackUsed: false,
      data: { completedFlushes: 2, lanes: expect.any(Array) },
    });
    expect(() => makeFiberReadyQueue({ engine: "bad" as any })).toThrow(/must be 'ts' or 'wasm'/);

    const wasmModule = await import("../wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);

    class FakeReadyQueue {
      private items = [10, 0];
      constructor(
        readonly flushBudget: number,
        readonly microThreshold: number,
        readonly laneCapacity: number,
        readonly laneBudget: number,
        readonly maxLanes: number,
      ) {}
      intern_lane(key: string) { return key.length; }
      enqueue_fiber_lane() { return 1; }
      enqueue_fiber() { return 0; }
      begin_flush() { return 1; }
      shift_fiber() { return this.items.shift() ?? 0; }
      end_flush() { return 3; }
      len() { return this.items.length; }
      clear() { this.items = []; }
      stats_json() { return JSON.stringify({ wasm: true }); }
    }

    resolveWasmModule.mockReturnValueOnce({ BrassWasmFiberReadyQueue: FakeReadyQueue });
    const wasmQueue = makeFiberReadyQueue({ engine: "wasm", flushBudget: 5 });
    expect(wasmQueue.enqueue(1, "caller:abc|effect")).toBe("macro");
    expect(wasmQueue.beginFlush()).toBe(1);
    expect(wasmQueue.shift()).toBe(10);
    expect(wasmQueue.shift()).toBeUndefined();
    expect(wasmQueue.endFlush(1)).toBe("dropped");
    expect(wasmQueue.stats()).toEqual({ engine: "wasm", fallbackUsed: false, data: { wasm: true } });

    class MissingLaneReadyQueue {
      enqueue_fiber() { return 0; }
      begin_flush() { return 0; }
      shift_fiber() { return 0; }
      end_flush() { return 0; }
      len() { return 0; }
      clear() {}
      stats_json() { return "{}"; }
    }
    resolveWasmModule.mockReturnValueOnce({ BrassWasmFiberReadyQueue: MissingLaneReadyQueue });
    expect(() => makeFiberReadyQueue({ engine: "wasm" })).toThrow(/requires laneId/);

    resolveWasmModule.mockReturnValueOnce({});
    expect(() => makeFiberReadyQueue({ engine: "wasm" })).toThrow(/wasm fiber ready queue is not available/);
  });
});
