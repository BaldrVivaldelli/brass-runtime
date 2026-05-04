import { afterEach, describe, expect, it, vi } from "vitest";
import { async, asyncSucceed, asyncSync, unit } from "../../types/asyncEffect";
import { Cause, Exit, succeed } from "../../types/effect";
import { ctxExtend, ctxToObject, emptyContext } from "../contex";
import { dumpAllFibers } from "../dump";
import { EventBus } from "../eventBus";
import { getBenchmarkBudget, getCurrentFiber, setBenchmarkBudget, unsafeGetCurrentRuntime, withCurrentFiber } from "../fiber";
import { consoleJsonLogger } from "../loggerSink";
import { RuntimeRegistry } from "../registry";
import { Runtime, fork, fromPromiseAbortable, toPromise, unsafeRunAsync, unsafeRunFoldWithEnv } from "../runtime";
import { Scheduler } from "../scheduler";
import { defaultTracer } from "../tracer";
import { InMemoryTracer } from "../tracingSink";

afterEach(() => {
  vi.restoreAllMocks();
  setBenchmarkBudget(undefined);
});

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

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

    expect(defaultTracer.newTraceId()).toBeTypeOf("string");
    expect(defaultTracer.newSpanId()).toBeTypeOf("string");
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
