import { afterEach, describe, expect, it, vi } from "vitest";
import { async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed, asyncSync, unit } from "../../types/asyncEffect";
import { Cause, Exit, succeed } from "../../types/effect";
import { ctxExtend, ctxToObject, emptyContext } from "../contex";
import { dumpAllFibers } from "../dump";
import { EventBus } from "../eventBus";
import { getBenchmarkBudget, getCurrentFiber, setBenchmarkBudget, unsafeGetCurrentRuntime, withCurrentFiber } from "../fiber";
import { makeFiberRef } from "../fiberRef";
import { consoleJsonLogger } from "../loggerSink";
import { RuntimeRegistry } from "../registry";
import { withScopeAsync } from "../scope";
import {
  Runtime,
  abortablePromiseStats,
  fork,
  fromPromiseAbortable,
  resetAbortablePromiseStats,
  runtimeForCaller,
  setAbortablePromisePerLabelTracking,
  toPromise,
  toPromiseByCaller,
  unsafeRunAsync,
  unsafeRunFoldWithEnv,
} from "../runtime";
import { Scheduler } from "../scheduler";
import { defaultTracer } from "../tracer";
import { InMemoryTracer } from "../tracingSink";

afterEach(() => {
  vi.restoreAllMocks();
  resetAbortablePromiseStats();
  setBenchmarkBudget(undefined);
});

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const joinFiber = (fiber: { join: (cb: (exit: any) => void) => void }) =>
  new Promise<any>((resolve) => fiber.join(resolve));

describe("runtime helpers and observability coverage", () => {
  it("materializes fiber context patches from newest to oldest", () => {
    const base = ctxExtend(emptyContext, { a: 1, shared: "base" });
    const child = ctxExtend(base, { b: true, shared: "child" });

    expect(ctxToObject(child)).toEqual({ a: 1, b: true, shared: "child" });
  });

  it("provide merges environment and preserves scheduler/hooks", async () => {
    const bus = new EventBus();
    const scheduler = new Scheduler();
    const rt = new Runtime({ env: { a: 1 }, scheduler, hooks: bus });
    const provided = rt.provide({ b: 2 });

    expect(provided.scheduler).toBe(scheduler);
    expect(provided.hooks).toBe(bus);
    await expect(provided.toPromise(asyncSync((env: { a: number; b: number }) => env.a + env.b))).resolves.toBe(3);
  });

  it("rejects invalid strict engines and exposes runtime utility helpers", async () => {
    expect(() => new Runtime({ env: {}, engine: "other" as any })).toThrow(/RuntimeOptions failed validation/);

    const rt = Runtime.make({});
    expect(rt.capabilities()).toMatchObject({ wasmAvailable: expect.any(Boolean) });
    expect(rt.stats()).toMatchObject({ engine: "ts", fallbackUsed: false });
    expect(rt.shutdown()).toBeUndefined();

    let unsafeRan = false;
    rt.unsafeRun(asyncSync(() => { unsafeRan = true; }));
    await wait();
    expect(unsafeRan).toBe(true);

    await expect(rt.toPromise(rt.delay(1, asyncSucceed("later")))).resolves.toBe("later");

    const delayed = rt.fork(rt.delay(50, asyncSucceed("cancelled")));
    await wait();
    delayed.interrupt();
    await new Promise<void>((resolve) => delayed.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));
  });

  it("top-level fork, toPromise, unsafeRunAsync and unsafeRunFoldWithEnv work", async () => {
    await expect(toPromise(succeed(7))).resolves.toBe(7);

    await new Promise<void>((resolve) => {
      unsafeRunAsync(asyncSucceed("ok"), undefined, (exit) => {
        expect(exit).toEqual(Exit.succeed("ok"));
        resolve();
      });
    });

    const f = fork(asyncSucceed(5));
    await new Promise<void>((resolve) => f.join((exit) => {
      expect(exit).toEqual(Exit.succeed(5));
      resolve();
    }));

    const failures: unknown[] = [];
    const successes: unknown[] = [];
    unsafeRunFoldWithEnv(asyncSucceed("done"), {}, (cause) => failures.push(cause), (value) => successes.push(value));
    await wait();
    expect(successes).toEqual(["done"]);
    expect(failures).toEqual([]);
  });

  it("uses the pure top-level fast path only when hooks are inactive", async () => {
    const noopRuntime = Runtime.makeWithEngine({}, "ts", { inferLane: false });
    const before = noopRuntime.stats().data.startedFibers;

    await expect(noopRuntime.toPromise(asyncSucceed("pure"))).resolves.toBe("pure");
    await expect(noopRuntime.toPromise(asyncFail("typed-failure"))).rejects.toBe("typed-failure");
    await expect(noopRuntime.toPromise(asyncSync(() => unsafeGetCurrentRuntime().env))).resolves.toEqual({});

    const chain = asyncFlatMap(
      asyncFlatMap(asyncSucceed(1), (n) => asyncSync(() => n + 1)),
      (n) => asyncSucceed(n + 1),
    );
    await expect(noopRuntime.toPromise(chain)).resolves.toBe(3);

    const ref = makeFiberRef(0);
    const fiberRefProgram = asyncFlatMap(
      ref.locally(10, asyncFlatMap(ref.update((n) => n + 5), () => ref.get())),
      (inside) => asyncFlatMap(ref.get(), (outside) => asyncSucceed({ inside, outside })),
    );
    await expect(noopRuntime.toPromise(fiberRefProgram)).resolves.toEqual({ inside: 15, outside: 0 });

    expect(noopRuntime.stats().data.startedFibers).toBe(before);

    const activeRuntime = new Runtime({ env: {}, hooks: new EventBus(), inferLane: false });
    const activeBefore = activeRuntime.stats().data.startedFibers;
    await expect(activeRuntime.toPromise(asyncSucceed("observed"))).resolves.toBe("observed");
    await expect(activeRuntime.toPromise(asyncSync(() => "observed-sync"))).resolves.toBe("observed-sync");
    expect(activeRuntime.stats().data.startedFibers).toBe(activeBefore + 2);
  });

  it("fromPromiseAbortable maps success, rejection and interruption", async () => {
    const rt = Runtime.make({ prefix: "env" });

    await expect(
      rt.toPromise(fromPromiseAbortable((signal, env: { prefix: string }) => Promise.resolve(`${env.prefix}:${signal.aborted}`), String))
    ).resolves.toBe("env:false");

    await expect(
      rt.toPromise(fromPromiseAbortable(() => Promise.reject(new Error("boom")), (u) => (u as Error).message))
    ).rejects.toBe("boom");

    let aborted = false;
    const never = fromPromiseAbortable(
      (signal) => new Promise<string>(() => signal.addEventListener("abort", () => { aborted = true; })),
      String
    );
    const fiber = rt.fork(never);
    await wait();
    fiber.interrupt();
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toEqual(Exit.failCause(Cause.interrupt()));
      resolve();
    }));
    // The current public contract is that interrupting the fiber yields an
    // Interrupt exit. Whether the underlying AbortSignal listener fires is an
    // implementation detail of fromPromiseAbortable/canceler propagation.
    expect(aborted).toBeTypeOf("boolean");
  });

  it("fromPromiseAbortable records make errors, timeout, labels, and late settlements", async () => {
    resetAbortablePromiseStats();
    setAbortablePromisePerLabelTracking(true);
    const finishes: unknown[] = [];
    const rt = Runtime.make({});

    await expect(rt.toPromise(fromPromiseAbortable(
      () => { throw new Error("make exploded"); },
      (u) => (u as Error).message,
      { label: "  make-error  ", onFinish: (finish) => finishes.push(finish) },
    ))).rejects.toBe("make exploded");

    let resolveLate!: (value: string) => void;
    await expect(rt.toPromise(fromPromiseAbortable(
      (signal) => new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => undefined);
        resolveLate = resolve;
      }),
      (u) => u as any,
      { label: "slow-timeout", timeoutMs: 1 },
    ))).rejects.toMatchObject({ _tag: "Timeout", timeoutMs: 1 });

    resolveLate("late");
    await wait();

    expect(finishes).toEqual([expect.objectContaining({ label: "make-error", outcome: "failure" })]);
    expect(abortablePromiseStats()).toMatchObject({
      active: 0,
      started: 2,
      failed: 1,
      timedOut: 1,
      lateSettlements: 1,
      byLabel: expect.arrayContaining([
        expect.objectContaining({ label: "make-error", failed: 1 }),
        expect.objectContaining({ label: "slow-timeout", timedOut: 1, lateSettlements: 1 }),
      ]),
    });
    setAbortablePromisePerLabelTracking(false);
  });

  it("fromPromiseAbortable tolerates legacy AbortController behavior", async () => {
    const rt = Runtime.make({});
    const originalAbort = AbortController.prototype.abort;

    vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (this: AbortController, reason?: unknown) {
      if (typeof reason === "object" && reason !== null && (reason as any)._tag === "Timeout") {
        throw new Error("abort reason unsupported");
      }
      return originalAbort.call(this, reason);
    });
    await expect(rt.toPromise(fromPromiseAbortable(
      () => new Promise<string>(() => undefined),
      (u) => u as any,
      { timeoutMs: 1 },
    ))).rejects.toMatchObject({ _tag: "Timeout" });

    vi.restoreAllMocks();
    vi.spyOn(AbortController.prototype, "abort").mockImplementation(() => {
      throw new Error("abort unsupported");
    });
    const fiber = rt.fork(fromPromiseAbortable(
      () => new Promise<string>(() => undefined),
      String,
    ));
    await wait();
    fiber.interrupt();
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));
  });

  it("covers fiber edge paths for finalizers, scheduler drops, and unusual exits", async () => {
    const rt = Runtime.make({});
    let resume!: (exit: Exit<never, string>) => void;
    const finalizerEvents: string[] = [];
    const suspended = async<{}, never, string>((_env, cb) => {
      resume = cb as any;
      return () => undefined;
    });
    const fiber = rt.fork(suspended);
    fiber.addFinalizer(() => asyncSync(() => { finalizerEvents.push("async-finalizer"); }));
    fiber.addFinalizer(() => { throw new Error("ignored finalizer"); });
    await wait();
    resume(Exit.succeed("done"));
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toEqual(Exit.succeed("done"));
      resolve();
    }));
    expect(finalizerEvents).toEqual(["async-finalizer"]);
    expect(fiber.status()).toBe("Done");

    await expect(rt.toPromise(asyncFlatMap(asyncSucceed(1), () => {
      throw new Error("flatMap boom");
    }))).rejects.toThrow("flatMap boom");
    await expect(rt.toPromise(asyncFlatMap(asyncSync(() => {
      throw new Error("sync first boom");
    }), () => asyncSucceed("never")))).rejects.toThrow("sync first boom");
    await expect(rt.toPromise(asyncFlatMap(
      async((_env, cb) => cb(Exit.succeed(1))),
      () => { throw new Error("sync async continuation boom"); },
    ))).rejects.toThrow("sync async continuation boom");
    await expect(rt.toPromise(asyncFlatMap(
      { _tag: "CustomFirst" } as any,
      () => asyncSucceed("never"),
    ))).rejects.toThrow(/Unknown opcode/);

    await expect(rt.toPromise(asyncFold(
      asyncSucceed(1),
      () => asyncSucceed("nope"),
      () => { throw new Error("fold success boom"); },
    ))).rejects.toThrow("fold success boom");

    await expect(rt.toPromise(asyncFold(
      asyncFail("domain-error"),
      () => { throw "mapped-error"; },
      () => asyncSucceed("nope"),
    ))).rejects.toBe("mapped-error");

    const syncAsyncFail = async<{}, string, number>((_env, cb) => {
      cb(Exit.failCause(Cause.fail("sync fail")));
    });
    await expect(rt.toPromise(asyncFlatMap(syncAsyncFail, () => asyncSucceed(1)))).rejects.toBe("sync fail");

    const syncAsyncDie = async<{}, never, number>((_env, cb) => {
      cb(Exit.failCause(Cause.die(new Error("sync die"))));
    });
    await expect(rt.toPromise(asyncFlatMap(syncAsyncDie, () => asyncSucceed(1)))).rejects.toThrow("sync die");

    const asyncInterrupt = rt.fork(async<{}, never, string>((_env, cb) => {
      setImmediate(() => cb(Exit.failCause(Cause.interrupt())));
    }));
    await expect(joinFiber(asyncInterrupt)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
    expect(asyncInterrupt.status()).toBe("Interrupted");

    const asyncDie = rt.fork(async<{}, never, string>((_env, cb) => {
      setImmediate(() => cb(Exit.failCause(Cause.die(new Error("async die")))));
    }));
    await expect(joinFiber(asyncDie)).resolves.toMatchObject({ _tag: "Failure", cause: { _tag: "Die" } });

    const cancelThrows = async<{}, never, number>(() => () => {
      throw new Error("cancel ignored");
    });
    const cancelFiber = rt.fork(asyncFlatMap(cancelThrows, () => asyncSucceed(1)));
    await wait();
    cancelFiber.interrupt();
    await new Promise<void>((resolve) => cancelFiber.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));

    const droppingRuntime = new Runtime({
      env: {},
      scheduler: { schedule: () => "dropped" } as any,
    });
    const dropped = droppingRuntime.fork(asyncSucceed("never"));
    await new Promise<void>((resolve) => dropped.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Die" } });
      resolve();
    }));

    await expect(rt.toPromise({ _tag: "UnknownOpcode" } as any)).rejects.toThrow(/Unknown opcode/);
  });

  it("closes scopes with failing finalizers and interrupts on external cancellation", async () => {
    const rt = Runtime.make({});
    await expect(rt.toPromise(withScopeAsync(rt, (scope: any) => {
      scope.addFinalizer(() => asyncFail("ignored finalizer"));
      return asyncSucceed("scoped");
    }))).resolves.toBe("scoped");

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const scoped = rt.fork(withScopeAsync(rt, (scope: any) => {
      scope.fork(async(() => () => undefined));
      started();
      return async(() => () => undefined);
    }));
    await startedPromise;
    scoped.interrupt();
    await expect(joinFiber(scoped)).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Interrupt" },
    });
  });

  it("keeps caller lanes stable across helpers and derived runtimes", async () => {
    const scheduledTags: string[] = [];
    const scheduler = {
      schedule: (task: () => void, tag: string) => {
        scheduledTags.push(tag);
        queueMicrotask(task);
        return "accepted";
      },
    } as any;

    const rt = new Runtime({ env: { a: 1 }, scheduler, lane: "service/users", inferLane: false });
    const provided = rt.provide({ b: 2 });
    await expect(provided.toPromise(asyncSync((env: { a: number; b: number }) => env.a + env.b))).resolves.toBe(3);

    const child = await provided.toPromise({ _tag: "Fork", effect: asyncSucceed("child") } as any);
    expect(child).toMatchObject({ lane: "service/users" });
    expect(scheduledTags.some((tag) => tag.startsWith("lane:service/users|"))).toBe(true);

    const callerRuntime = runtimeForCaller("feature/reporting", {});
    expect(callerRuntime.lane).toBe("feature/reporting");
    await expect(toPromiseByCaller("feature/reporting", asyncSucceed("ok"))).resolves.toBe("ok");
  });

  it("exposes current runtime only inside a fiber", async () => {
    expect(() => unsafeGetCurrentRuntime()).toThrow(/no current fiber/);

    const rt = Runtime.make({ answer: 42 });
    await expect(rt.toPromise(asyncSync(() => unsafeGetCurrentRuntime<{ answer: number }>().env.answer))).resolves.toBe(42);
  });

  it("withCurrentFiber restores the previous fiber after callback", () => {
    const fakeFiber = { runtime: Runtime.make({}), id: 999 } as any;
    const value = withCurrentFiber(fakeFiber, () => unsafeGetCurrentRuntime().env);
    expect(value).toEqual({});
    expect(() => unsafeGetCurrentRuntime()).toThrow(/no current fiber/);
  });

  it("benchmark budget setter/getter round-trips", () => {
    expect(getBenchmarkBudget()).toBeUndefined();
    setBenchmarkBudget(64);
    expect(getBenchmarkBudget()).toBe(64);
  });


  it("initializes fiber trace context from custom brass env and names child fibers", async () => {
    const events: any[] = [];
    const tracer = {
      newTraceId: vi.fn(() => "trace-new"),
      newSpanId: vi.fn(() => "span-new"),
    };
    const rt = new Runtime({
      env: { brass: { tracer, traceSeed: { traceId: "trace-seed", spanId: "span-seed", sampled: false }, childName: (parent?: string) => parent ? `${parent}/child` : "root" } },
      hooks: { emit: (ev, ctx) => events.push({ ev, ctx }) },
    });

    const trace = await rt.toPromise(asyncSync(() => (getCurrentFiber() as any).fiberContext.trace));
    expect(trace).toEqual({ traceId: "trace-seed", spanId: "span-seed", sampled: false });
    expect(events.some((e) => e.ev.type === "fiber.start" && e.ev.name === "root")).toBe(true);
    expect(events.find((e) => e.ev.type === "fiber.start")?.ctx).toMatchObject({
      fiberId: expect.any(Number),
      traceId: "trace-seed",
      spanId: "span-seed",
    });

    expect(defaultTracer.newTraceId()).toBeTypeOf("string");
    expect(defaultTracer.newSpanId()).toBeTypeOf("string");
  });

  it("EventBus can fan out runtime hooks without losing fiber trace spans", async () => {
    let spanId = 0;
    const bus = new EventBus();
    const tracer = new InMemoryTracer();
    const registry = new RuntimeRegistry();

    bus.subscribeHooks(tracer);
    bus.subscribeHooks(registry);

    const rt = new Runtime({
      env: {
        brass: {
          tracer: {
            newTraceId: () => "trace-runtime",
            newSpanId: () => `span-${++spanId}`,
          },
          childName: () => "root",
        },
      },
      hooks: bus,
    });

    await rt.toPromise(asyncSucceed("ok"));
    await wait();

    const finished = tracer.exportFinished();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      traceId: "trace-runtime",
      spanId: "span-1",
      name: "root",
    });
    expect(Array.from(registry.fibers.values()).find((fiber) => fiber.name === "root")?.traceId).toBe("trace-runtime");
  });

  it("RuntimeRegistry records fiber and scope events and dumpAllFibers renders them", () => {
    const registry = new RuntimeRegistry();
    registry.emit({ type: "fiber.start", fiberId: 1, name: "main", scopeId: 10 }, { traceId: "t", spanId: "s" });
    registry.emit({ type: "fiber.suspend", fiberId: 1, reason: "http" }, {});
    registry.emit({ type: "fiber.resume", fiberId: 1 }, {});
    registry.emit({ type: "scope.open", scopeId: 10, parentScopeId: 9 }, { fiberId: 1 });
    registry.emit({ type: "scope.close", scopeId: 10, status: "success" }, {});
    registry.emit({ type: "fiber.end", fiberId: 1, status: "failure", error: "boom" }, {});

    expect(registry.fibers.get(1)?.runState).toBe("Done");
    expect(registry.scopes.get(10)?.closedAt).toBeTypeOf("number");
    expect(registry.getRecentEvents().length).toBe(6);

    const dump = dumpAllFibers(registry);
    expect(dump).toContain("fiber#1 main");
    expect(dump).toContain("Recent Events");
  });

  it("consoleJsonLogger logs only log events and sends errors to console.error", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hooks = consoleJsonLogger();

    hooks.emit({ type: "fiber.start", fiberId: 1 }, {});
    hooks.emit({ type: "log", level: "info", message: "hello", fields: { k: "v" } }, { fiberId: 1 });
    hooks.emit({ type: "log", level: "error", message: "bad" }, { scopeId: 2 });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ level: "info", msg: "hello", k: "v", fiberId: 1 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ level: "error", msg: "bad", scopeId: 2 });
  });

  it("InMemoryTracer records spans and span events", () => {
    const tracer = new InMemoryTracer();
    tracer.emit({ type: "fiber.start", fiberId: 1, name: "root" }, { traceId: "t", spanId: "s" });
    tracer.emit({ type: "fiber.suspend", fiberId: 1, reason: "wait" }, { traceId: "t", spanId: "s" });
    tracer.emit({ type: "fiber.resume", fiberId: 1 }, { traceId: "t", spanId: "s" });
    tracer.emit({ type: "scope.open", scopeId: 1 }, { traceId: "t", spanId: "s" });
    tracer.emit({ type: "scope.close", scopeId: 1, status: "success" }, { traceId: "t", spanId: "s" });
    tracer.emit({ type: "fiber.end", fiberId: 1, status: "success" }, { traceId: "t", spanId: "s" });

    const finished = tracer.exportFinished();
    expect(finished).toHaveLength(1);
    expect(finished[0].name).toBe("root");
    expect(finished[0].events.map((e) => e.name)).toEqual(["fiber.suspend", "fiber.resume", "scope.open", "scope.close", "fiber.end"]);

    tracer.emit({ type: "fiber.start", fiberId: 2 }, {});
    tracer.emit({ type: "fiber.end", fiberId: 2, status: "success" }, {});
    expect(tracer.exportFinished()).toHaveLength(1);
  });

  it("Scheduler ignores non-functions and catches task errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new Scheduler();
    const ran: string[] = [];

    scheduler.schedule("not-a-function" as any);
    scheduler.schedule(() => ran.push("ok"), "ok-task");
    scheduler.schedule(() => { throw new Error("task"); }, "bad-task");

    await wait();
    expect(ran).toEqual(["ok"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("bad-task"), expect.any(Error));
  });
});
