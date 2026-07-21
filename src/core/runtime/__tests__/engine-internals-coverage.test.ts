import { describe, expect, it, vi } from "vitest";
import { async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed, asyncSync } from "../../types/asyncEffect";
import { Cause, Exit } from "../../types/effect";
import { JsFiberEngine } from "../engine/JsFiberEngine";
import { EngineFiberHandle } from "../engine/FiberHandleImpl";
import { HostRegistry, ProgramBuilder } from "../engine/opcodes";
import type { RuntimeEvent } from "../events";

describe("HostRegistry and ProgramBuilder", () => {
  it("tracks generational refs, stale reads, reuse, set, delete, clear, and size", () => {
    const registry = new HostRegistry();
    const a = registry.register("a");
    const b = registry.register("b");

    expect(registry.size()).toBe(2);
    expect(registry.get(a)).toBe("a");
    registry.set(a, "aa");
    expect(registry.get(a)).toBe("aa");

    registry.delete(a);
    expect(registry.size()).toBe(1);
    registry.delete(a);
    expect(() => registry.get(a)).toThrow(/stale/);

    const c = registry.register("c");
    expect(registry.get(c)).toBe("c");
    expect(registry.stats()).toMatchObject({ live: 2, allocated: 3, released: 1, reused: expect.any(Number), staleReads: 1 });

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.stats().released).toBeGreaterThanOrEqual(3);
  });

  it("compiles every Async opcode shape and appends patches", () => {
    const builder = new ProgramBuilder();
    const hostAction = {
      _tag: "HostAction",
      action: { kind: "custom", target: "x" },
      decode: (result: unknown) => result,
    } as any;
    const effect = asyncFold(
      asyncFlatMap(asyncSync(() => 1), () => async((_env, cb) => cb(Exit.succeed("async")))),
      () => asyncFail("bad"),
      () => ({ _tag: "Fork", effect: hostAction, scopeId: 7 } as any),
    );

    const compiled = builder.compile(effect as any);
    expect(compiled.program.version).toBe(1);
    expect(compiled.program.nodes.map((node) => node.tag)).toEqual(
      expect.arrayContaining(["Sync", "FlatMap", "Fold"]),
    );

    const patch = builder.append({ _tag: "Mystery" } as any);
    expect(patch.nodes).toHaveLength(1);
    expect(patch.nodes[0]).toMatchObject({ tag: "Fail" });
    expect(compiled.registry.size()).toBeGreaterThan(0);

    const hostPatch = builder.append(hostAction);
    expect(hostPatch.nodes[0]).toMatchObject({ tag: "HostAction" });

    const asyncPatch = builder.append(async((_env, cb) => cb(Exit.succeed("async"))));
    expect(asyncPatch.nodes[0]).toMatchObject({ tag: "Async" });

    const forkPatch = builder.append({ _tag: "Fork", effect: asyncSucceed("child"), scopeId: 7 } as any);
    expect(forkPatch.nodes[0]).toMatchObject({ tag: "Fork", scopeId: 7 });
  });
});

describe("EngineFiberHandle", () => {
  it("schedules, emits, joins, finalizes once, and reports terminal statuses", () => {
    const events: Array<{ ev: RuntimeEvent; ctx: unknown }> = [];
    const scheduled: string[] = [];
    const dropped: string[] = [];
    const forkedFinalizers: unknown[] = [];
    const runtime = {
      lane: "rt-lane",
      scheduler: { schedule: vi.fn((task: () => void, label?: string) => { scheduled.push(label ?? ""); task(); return "accepted"; }) },
      hooks: { emit: (ev: RuntimeEvent, ctx: unknown) => events.push({ ev, ctx }) },
      fork: (eff: unknown) => { forkedFinalizers.push(eff); },
    } as any;
    const onStep = vi.fn();
    const onInterrupt = vi.fn();
    const onJoiner = vi.fn();
    const onQueued = vi.fn();
    const handle = new EngineFiberHandle<number, string, number>(
      42,
      runtime,
      onStep,
      onInterrupt,
      onJoiner,
      onQueued,
      (_id, label) => dropped.push(label),
    );
    handle.fiberContext = { trace: { traceId: "t", spanId: "s" } };
    handle.scopeId = 9;

    const joiner = vi.fn();
    handle.join(joiner);
    expect(onJoiner).toHaveBeenCalledWith(42);
    expect(handle.status()).toBe("Running");
    expect(handle.engineStatus()).toBe("running");

    handle.schedule("first");
    handle.schedule("ignored-while-queued");
    expect(onQueued).toHaveBeenCalledWith(42);
    expect(onStep).toHaveBeenCalledWith(42);
    expect(scheduled[0]).toContain("wasm-fiber#42.first");

    handle.addFinalizer(() => asyncSucceed(undefined));
    handle.addFinalizer(() => { throw new Error("ignored"); });
    handle.succeed(7);
    handle.succeed(8);
    expect(joiner).toHaveBeenCalledWith(Exit.succeed(7));
    expect(forkedFinalizers).toHaveLength(1);
    expect(handle.status()).toBe("Done");
    expect(handle.engineStatus()).toBe("done");
    expect(events.at(-1)?.ev).toMatchObject({ type: "fiber.end", fiberId: 42, status: "success" });
    handle.join((exit) => expect(exit).toEqual(Exit.succeed(7)));

    const droppedHandle = new EngineFiberHandle(43, runtime, onStep, onInterrupt, undefined, undefined, (_id, label) => dropped.push(label), () => "dropped");
    droppedHandle.schedule("drop");
    expect(dropped).toContain("wasm-fiber#43.drop");
    expect(droppedHandle.engineStatus()).toBe("queued");

    const interrupted = new EngineFiberHandle(44, runtime, onStep, onInterrupt);
    interrupted.interrupt();
    expect(onInterrupt).toHaveBeenCalledWith(44, Cause.interrupt());
    interrupted.interrupted();
    expect(interrupted.status()).toBe("Interrupted");
    expect(interrupted.engineStatus()).toBe("interrupted");

    const failed = new EngineFiberHandle(45, runtime, onStep, onInterrupt);
    failed.fail("nope");
    expect(failed.engineStatus()).toBe("failed");
    const died = new EngineFiberHandle(46, runtime, onStep, onInterrupt);
    died.die(new Error("boom"));
    expect(died.engineStatus()).toBe("failed");
  });
});

describe("JsFiberEngine", () => {
  it("forks runtime fibers, assigns scope ids, and reports stats", () => {
    const runtime = {
      env: {},
      scheduler: { schedule: () => "accepted" },
      hooks: { emit: () => undefined },
      forkPolicy: { initChild: () => undefined },
    } as any;
    const engine = new JsFiberEngine(runtime);
    const fiber = engine.fork(asyncSucceed("ok"), 123) as any;

    expect(fiber.scopeId).toBe(123);
    expect(engine.stats()).toEqual({
      engine: "ts",
      startedFibers: 1,
      runningFibers: 1,
      suspendedFibers: 0,
      queuedFibers: 0,
      completedFibers: 0,
      failedFibers: 0,
      interruptedFibers: 0,
      pendingHostEffects: 0,
    });
  });
});
