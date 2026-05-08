import { beforeEach, describe, expect, it, vi } from "vitest";
import { async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed, asyncSync } from "../../types/asyncEffect";
import { Cause, Exit } from "../../types/effect";
import { WasmFiberEngine } from "../engine/WasmFiberEngine";
import type { EngineEvent, WasmBridge } from "../engine/types";
import type { FiberId, OpcodeProgram, RefId } from "../engine/opcodes";

const mockReadyQueueState = vi.hoisted(() => ({
  dropEnqueue: false,
}));

const mockTimerWheelState = vi.hoisted(() => ({
  onExpired: undefined as undefined | ((events: any[]) => void),
  scheduled: [] as Array<{ subjectId: FiberId; kind: number; deadlineMs: number }>,
  cancelled: [] as Array<number | undefined>,
}));

vi.mock("../engine/bridge/WasmFiberRegistryBridge", () => ({
  WasmFiberRegistryBridge: class {
    addJoiner() {}
    markQueued() {}
    registerFiber() {}
    markRunning() {}
    markSuspended() {}
    markDone() {}
    dropFiber() {}
    wake() { return true; }
    drainWakeups() { return []; }
    stats() { return { fake: "registry" }; }
  },
}));

vi.mock("../engine/bridge/WasmFiberReadyQueueBridge", () => ({
  makeFiberReadyQueue: () => {
    const ids: FiberId[] = [];
    return {
      engine: "wasm",
      enqueue: (fiberId: FiberId) => {
        if (mockReadyQueueState.dropEnqueue) return "dropped";
        ids.push(fiberId);
        return "micro";
      },
      beginFlush: () => ids.length,
      shift: () => ids.shift(),
      endFlush: () => ids.length > 0 ? "micro" : "none",
      len: () => ids.length,
      clear: () => { ids.length = 0; },
      stats: () => ({ engine: "wasm", fallbackUsed: false, data: { len: ids.length } }),
    };
  },
}));

vi.mock("../engine/bridge/WasmTimerWheelBridge", () => ({
  makeWasmTimerWheel: ({ onExpired }: any) => ({
    schedule: (subjectId: FiberId, kind: number, deadlineMs: number) => {
      mockTimerWheelState.onExpired = onExpired;
      mockTimerWheelState.scheduled.push({ subjectId, kind, deadlineMs });
      return mockTimerWheelState.scheduled.length;
    },
    cancel: (timerId: number | undefined) => { mockTimerWheelState.cancelled.push(timerId); },
    dispose: () => undefined,
    stats: () => ({ fake: "timer" }),
  }),
}));

class FakeBridge implements WasmBridge {
  readonly kind = "wasm" as const;
  private nextId = 1;
  private programs = new Map<FiberId, OpcodeProgram>();
  readonly dropped: FiberId[] = [];

  createFiber(program: OpcodeProgram): FiberId {
    const id = this.nextId++;
    this.programs.set(id, program);
    return id;
  }

  poll(fiberId: FiberId): EngineEvent {
    const program = this.programs.get(fiberId)!;
    const node = program.nodes[program.root]!;
    const firstNode = (first: number) => program.nodes[first]!;
    switch (node.tag) {
      case "Succeed":
        return { kind: "Done", fiberId, valueRef: node.valueRef };
      case "Fail":
        return { kind: "Failed", fiberId, errorRef: node.errorRef };
      case "Sync":
        return { kind: "InvokeSync", fiberId, fnRef: node.fnRef };
      case "Async":
        return { kind: "InvokeAsync", fiberId, registerRef: node.registerRef };
      case "HostAction":
        return node.decodeRef === undefined
          ? { kind: "InvokeHostAction", fiberId, actionRef: node.actionRef }
          : { kind: "InvokeHostAction", fiberId, actionRef: node.actionRef, decodeRef: node.decodeRef };
      case "FlatMap": {
        const first = firstNode(node.first);
        return first.tag === "Succeed"
          ? { kind: "InvokeFlatMap", fiberId, fnRef: node.fnRef, valueRef: first.valueRef }
          : { kind: "Failed", fiberId, errorRef: first.tag === "Fail" ? first.errorRef : 0 };
      }
      case "Fold": {
        const first = firstNode(node.first);
        if (first.tag === "Succeed") {
          return { kind: "InvokeFoldSuccess", fiberId, fnRef: node.onSuccessRef, valueRef: first.valueRef };
        }
        if (first.tag === "Fail") {
          return { kind: "InvokeFoldFailure", fiberId, fnRef: node.onFailureRef, errorRef: first.errorRef };
        }
        return { kind: "Failed", fiberId, errorRef: 0 };
      }
      case "Fork":
        return node.scopeId === undefined
          ? { kind: "InvokeFork", fiberId, effectRef: node.effectRef }
          : { kind: "InvokeFork", fiberId, effectRef: node.effectRef, scopeId: node.scopeId };
      default:
        return { kind: "Failed", fiberId, errorRef: 0 };
    }
  }

  provideValue(fiberId: FiberId, valueRef: RefId): EngineEvent {
    return { kind: "Done", fiberId, valueRef };
  }

  provideError(fiberId: FiberId, errorRef: RefId): EngineEvent {
    return { kind: "Failed", fiberId, errorRef };
  }

  provideEffect(fiberId: FiberId, _root: number, nodes: any[]): EngineEvent {
    const node = nodes.find((candidate) => candidate.tag === "Succeed" || candidate.tag === "Fail");
    if (node?.tag === "Succeed") return { kind: "Done", fiberId, valueRef: node.valueRef };
    if (node?.tag === "Fail") return { kind: "Failed", fiberId, errorRef: node.errorRef };
    return { kind: "Done", fiberId, valueRef: 0 };
  }

  interrupt(fiberId: FiberId): EngineEvent {
    return { kind: "Interrupted", fiberId, reasonRef: 0 };
  }

  dropFiber(fiberId: FiberId): void {
    this.dropped.push(fiberId);
  }

  stats() {
    return { fake: "bridge" };
  }
}

const wait = () => new Promise((resolve) => setImmediate(resolve));
const joinExit = (fiber: any) => new Promise<any>((resolve) => fiber.join(resolve));

beforeEach(() => {
  mockReadyQueueState.dropEnqueue = false;
  mockTimerWheelState.onExpired = undefined;
  mockTimerWheelState.scheduled.length = 0;
  mockTimerWheelState.cancelled.length = 0;
});

function makeRuntime(env: unknown = {}) {
  const events: unknown[] = [];
  const runtime = {
    env,
    lane: "runtime-lane",
    scheduler: { schedule: vi.fn((task: () => void) => { task(); return "accepted"; }) },
    hooks: { emit: (ev: unknown, ctx: unknown) => events.push({ ev, ctx }) },
    hostExecutor: { execute: vi.fn(async () => ({ kind: "ok", value: "host-ok" })) },
    fork: vi.fn(() => ({ child: true })),
  } as any;
  return { runtime, events };
}

describe("WasmFiberEngine", () => {
  it("drives success, failure, sync, async, host action, interrupt, stats, and shutdown paths", async () => {
    const bridge = new FakeBridge();
    const { runtime, events } = makeRuntime({ n: 41 });
    const engine = new WasmFiberEngine(runtime, { bridge });

    const success = engine.fork(asyncSucceed("ok"));
    success.schedule?.("success");
    await new Promise<void>((resolve) => success.join((exit) => {
      expect(exit).toEqual(Exit.succeed("ok"));
      resolve();
    }));

    const failure = engine.fork({ _tag: "Fail", error: "bad" } as any);
    failure.schedule?.("failure");
    await new Promise<void>((resolve) => failure.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: "bad" } });
      resolve();
    }));

    const syncFiber = engine.fork(asyncSync((env: any) => env.n + 1));
    syncFiber.schedule?.("sync");
    await new Promise<void>((resolve) => syncFiber.join((exit) => {
      expect(exit).toEqual(Exit.succeed(42));
      resolve();
    }));

    const asyncFiber = engine.fork(async((_env, cb) => {
      setImmediate(() => cb(Exit.succeed("later")));
      return () => undefined;
    }));
    asyncFiber.schedule?.("async");
    await wait();
    await new Promise<void>((resolve) => asyncFiber.join((exit) => {
      expect(exit).toEqual(Exit.succeed("later"));
      resolve();
    }));

    const hostFiber = engine.fork({
      _tag: "HostAction",
      action: { kind: "custom", target: "host", timeoutMs: 10 },
      decode: (result: any) => `decoded:${result.value}`,
    } as any);
    hostFiber.schedule?.("host");
    await wait();
    await new Promise<void>((resolve) => hostFiber.join((exit) => {
      expect(exit).toEqual(Exit.succeed("decoded:host-ok"));
      resolve();
    }));

    const interrupted = engine.fork(async(() => () => undefined));
    interrupted.schedule?.("interrupt");
    interrupted.interrupt();
    await new Promise<void>((resolve) => interrupted.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));

    expect(engine.stats()).toMatchObject({
      engine: "wasm",
      startedFibers: 6,
      completedFibers: 4,
      failedFibers: 1,
      interruptedFibers: 1,
      wasm: { fake: "bridge" },
      fiberRegistry: { fake: "registry" },
      readyQueue: { engine: "wasm" },
      timerWheel: { fake: "timer" },
    });
    expect(events.some((entry: any) => entry.ev.type === "fiber.suspend")).toBe(true);

    const pending = engine.fork(async(() => () => undefined));
    await engine.shutdown();
    expect(bridge.dropped).toContain((pending as any).id);
  });

  it("rejects non-wasm bridges", () => {
    const { runtime } = makeRuntime();
    expect(() => new WasmFiberEngine(runtime, { bridge: { kind: "wasm-reference" } as any })).toThrow(/strict mode/);
  });

  it("drives flatMap, fold success/failure, fork, and fallback failed events", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    const flatMapped = engine.fork(asyncFlatMap(asyncSucceed(2), (n) => asyncSucceed(n + 3)));
    flatMapped.schedule?.("flatmap");
    await new Promise<void>((resolve) => flatMapped.join((exit) => {
      expect(exit).toEqual(Exit.succeed(5));
      resolve();
    }));

    const foldedSuccess = engine.fork(asyncFold(
      asyncSucceed("ok"),
      () => asyncSucceed("failure-branch"),
      (value) => asyncSucceed(`success:${value}`),
    ));
    foldedSuccess.schedule?.("fold-success");
    await new Promise<void>((resolve) => foldedSuccess.join((exit) => {
      expect(exit).toEqual(Exit.succeed("success:ok"));
      resolve();
    }));

    const foldedFailure = engine.fork(asyncFold(
      asyncFail("bad"),
      (error) => asyncSucceed(`recovered:${error}`),
      () => asyncSucceed("success-branch"),
    ));
    foldedFailure.schedule?.("fold-failure");
    await new Promise<void>((resolve) => foldedFailure.join((exit) => {
      expect(exit).toEqual(Exit.succeed("recovered:bad"));
      resolve();
    }));

    const forked = engine.fork({ _tag: "Fork", effect: asyncSucceed("child"), scopeId: 99 } as any);
    forked.schedule?.("fork");
    await new Promise<void>((resolve) => forked.join((exit) => {
      expect(exit._tag).toBe("Success");
      resolve();
    }));
    expect(runtime.fork).toHaveBeenCalledWith(expect.objectContaining({ _tag: "Succeed", value: "child" }), 99);

    const unknownFailure = engine.fork({ _tag: "Unknown" } as any);
    unknownFailure.schedule?.("unknown");
    await new Promise<void>((resolve) => unknownFailure.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail" } });
      resolve();
    }));
  });

  it("maps sync, flatMap, and fold failures through the engine", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    const syncThrows = engine.fork(asyncSync(() => { throw new Error("sync exploded"); }));
    syncThrows.schedule?.("sync-throws");
    await expect(joinExit(syncThrows)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: expect.any(Error) } });

    const flatMapThrows = engine.fork(asyncFlatMap(asyncSucceed(1), () => { throw new Error("flatmap exploded"); }));
    flatMapThrows.schedule?.("flatmap-throws");
    await expect(joinExit(flatMapThrows)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: expect.any(Error) } });

    const foldThrows = engine.fork(asyncFold(
      asyncFail("bad"),
      () => { throw new Error("fold failure exploded"); },
      asyncSucceed,
    ));
    foldThrows.schedule?.("fold-throws");
    await expect(joinExit(foldThrows)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: expect.any(Error) } });
  });

  it("maps async registration failures through the engine", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    const asyncRegisterThrows = engine.fork(async(() => { throw new Error("register exploded"); }));
    asyncRegisterThrows.schedule?.("async-register-throws");
    await expect(joinExit(asyncRegisterThrows)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: expect.any(Error) } });
  });

  it("maps async callback failure through the engine", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    const asyncFailing = engine.fork(async((_env, cb) => {
      cb(Exit.failCause(Cause.fail("async failed")));
    }));
    asyncFailing.schedule?.("async-failing");
    await expect(joinExit(asyncFailing)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: "async failed" } });
  });

  it("maps async callback defects through the engine", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    const asyncDying = engine.fork(async((_env, cb) => {
      cb(Exit.failCause(Cause.die(new Error("async died"))));
    }));
    asyncDying.schedule?.("async-dying");
    await expect(joinExit(asyncDying)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Die", defect: expect.any(Error) } });
  });

  it("maps host action errors and rejected host actions through the engine", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    runtime.hostExecutor.execute.mockResolvedValueOnce({ kind: "error", error: "host failed" });
    const hostError = engine.fork({ _tag: "HostAction", action: { kind: "custom", target: "host" } } as any);
    hostError.schedule?.("host-error");
    await wait();
    await expect(joinExit(hostError)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: "host failed" } });

    runtime.hostExecutor.execute.mockRejectedValueOnce(new Error("host rejected"));
    const hostReject = engine.fork({ _tag: "HostAction", action: { kind: "custom", target: "host" } } as any);
    hostReject.schedule?.("host-reject");
    await wait();
    await expect(joinExit(hostReject)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: expect.any(Error) } });
  });

  it("times out pending host actions through the wasm timer wheel", async () => {
    const bridge = new FakeBridge();
    const hostSignals: AbortSignal[] = [];
    const { runtime } = makeRuntime();
    runtime.hostExecutor.execute.mockImplementation((_action: any, ctx: any) => {
      hostSignals.push(ctx.signal);
      return new Promise(() => undefined);
    });
    const engine = new WasmFiberEngine(runtime, { bridge });

    const fiber = engine.fork({ _tag: "HostAction", action: { kind: "custom", target: "slow", timeoutMs: 25 } } as any);
    fiber.schedule?.("host-timeout");

    expect(mockTimerWheelState.scheduled).toHaveLength(1);
    const [{ subjectId, kind, deadlineMs }] = mockTimerWheelState.scheduled;
    mockTimerWheelState.onExpired?.([{ kind, timerId: 1, subjectId, deadlineMs }]);

    const exit = await joinExit(fiber);
    expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: expect.any(Error) } });
    expect(exit.cause.error.message).toContain("host action timed out");
    expect(hostSignals[0]?.aborted).toBe(true);
    expect(engine.stats()).toMatchObject({ pendingHostEffects: 0, failedFibers: 1 });
  });

  it("fails fibers when the wasm ready queue or scheduler drops work", async () => {
    const bridge = new FakeBridge();
    const { runtime } = makeRuntime();
    const engine = new WasmFiberEngine(runtime, { bridge });

    mockReadyQueueState.dropEnqueue = true;
    const readyDropped = engine.fork(asyncSucceed("never"));
    readyDropped.schedule?.("ready-drop");
    await expect(joinExit(readyDropped)).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Die", defect: expect.objectContaining({ message: expect.stringContaining("scheduler dropped") }) },
    });

    mockReadyQueueState.dropEnqueue = false;
    runtime.scheduler.schedule.mockImplementationOnce(() => "dropped");
    const schedulerDropped = engine.fork(asyncSucceed("also-never"));
    schedulerDropped.schedule?.("scheduler-drop");
    await expect(joinExit(schedulerDropped)).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Die", defect: expect.objectContaining({ message: expect.stringContaining("scheduler dropped") }) },
    });
  });
});
