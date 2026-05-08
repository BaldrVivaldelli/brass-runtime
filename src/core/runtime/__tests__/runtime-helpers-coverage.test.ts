import { afterEach, describe, expect, it, vi } from "vitest";
import { asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { engineStats, selectedEngineStats } from "../engineStats";
import {
  assertCompletesWithin,
  assertFails,
  assertFailsWith,
  assertSucceeds,
  delayedEffect,
  flakyEffect,
  makeTestRuntime,
  neverEffect,
} from "../testing";
import { makeTracer } from "../tracing";
import { makeWorkerPool } from "../workerPool";
import { Runtime } from "../runtime";

const wait = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("engine stats helpers", () => {
  it("builds engine stats and rejects strict selection mismatches", () => {
    expect(engineStats("ts", { fibers: 1 })).toEqual({
      engine: "ts",
      data: { fibers: 1 },
      fallbackUsed: false,
    });
    expect(selectedEngineStats("wasm", "wasm", { batches: 2 })).toEqual({
      requested: "wasm",
      engine: "wasm",
      data: { batches: 2 },
      fallbackUsed: false,
    });
    expect(() => selectedEngineStats("wasm", "ts", {})).toThrow(/strict engine mismatch/);
  });
});

describe("testing utilities", () => {
  it("runs effects and exposes exits through makeTestRuntime", async () => {
    const { runtime, run, runExit } = makeTestRuntime({ prefix: "t" });

    await expect(run(asyncSucceed("ok"))).resolves.toBe("ok");
    await expect(runExit(asyncFail("no"))).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: "no" },
    });
    await expect(runtime.toPromise(asyncSucceed(1))).resolves.toBe(1);
  });

  it("asserts success and failure cases with useful messages", async () => {
    await expect(assertSucceeds(asyncSucceed({ id: 1 }), { id: 1 })).resolves.toBeUndefined();
    await expect(assertSucceeds(asyncFail("bad"), "x")).rejects.toThrow(/Expected success/);
    await expect(assertSucceeds(asyncSucceed("a"), "b")).rejects.toThrow(/Expected "b"/);

    await expect(assertFails(asyncFail({ code: 404 }), { code: 404 })).resolves.toBeUndefined();
    await expect(assertFails(asyncSucceed("ok"), "bad")).rejects.toThrow(/Expected failure/);
    await expect(assertFails(asyncFail("actual"), "expected")).rejects.toThrow(/Expected error/);

    await expect(assertFailsWith(asyncFail({ _tag: "Nope" }), (e: any) => e._tag === "Nope")).resolves.toBeUndefined();
    await expect(assertFailsWith(asyncSucceed("ok"), () => true)).rejects.toThrow(/Expected failure/);
    await expect(assertFailsWith(asyncFail({ _tag: "Other" }), () => false)).rejects.toThrow(/predicate/);
  });

  it("builds flaky, delayed, and never-completing effects", async () => {
    const rt = Runtime.make({});
    const flaky = flakyEffect(2, "done", "try-again");

    await expect(rt.toPromise(flaky)).rejects.toBe("try-again");
    await expect(rt.toPromise(flaky)).rejects.toBe("try-again");
    await expect(rt.toPromise(flaky)).resolves.toBe("done");

    await expect(assertCompletesWithin(delayedEffect(1, "later"), 100)).resolves.toBe("later");

    const fiber = rt.fork(neverEffect());
    await wait();
    fiber.interrupt();
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit._tag).toBe("Failure");
      expect((exit as any).cause._tag).toBe("Interrupt");
      resolve();
    }));
  });
});

describe("tracing utility", () => {
  it("records sampled successful and failed spans", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(15).mockReturnValueOnce(20).mockReturnValueOnce(25).mockReturnValueOnce(30);
    const ended: unknown[] = [];
    const tracer = makeTracer({ serviceName: "svc", onSpanEnd: (span) => ended.push(span) });
    const rt = Runtime.make({});

    await expect(rt.toPromise(tracer.span("ok", asyncSucceed(1), { route: "/ok" }))).resolves.toBe(1);
    await expect(rt.toPromise(tracer.span("bad", asyncFail("boom")))).rejects.toBe("boom");

    expect(tracer.spans()).toHaveLength(2);
    expect(tracer.spans()[0]).toMatchObject({
      name: "ok",
      status: "ok",
      attributes: { "service.name": "svc", route: "/ok" },
    });
    expect(tracer.spans()[1]).toMatchObject({
      name: "bad",
      status: "error",
      events: [{ name: "error", attributes: { "error.message": "boom" } }],
    });
    expect(ended).toHaveLength(2);

    tracer.clear();
    expect(tracer.spans()).toEqual([]);
  });

  it("skips spans when sampling is disabled and samples probabilistically", async () => {
    const rt = Runtime.make({});
    const neverSample = makeTracer({ serviceName: "svc", sampleRate: 0 });
    await expect(rt.toPromise(neverSample.span("skip", asyncSucceed("value")))).resolves.toBe("value");
    expect(neverSample.spans()).toEqual([]);

    vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const sampled = makeTracer({ serviceName: "svc", sampleRate: 0.5 });
    await rt.toPromise(sampled.span("in", asyncSucceed("yes")));
    await rt.toPromise(sampled.span("out", asyncSucceed("no")));
    expect(sampled.spans().map((span) => span.name)).toEqual(["in"]);
  });
});

describe("worker pool", () => {
  it("executes functions, string tasks, and records success/failure stats", async () => {
    const rt = Runtime.make({});
    const pool = makeWorkerPool({ size: 1, taskTimeoutMs: 50 });

    await expect(rt.toPromise(pool.execute(() => 2 + 3))).resolves.toBe(5);
    await expect(rt.toPromise(pool.run("return arg0 * arg1", [3, 4]))).resolves.toBe(12);
    await expect(rt.toPromise(pool.execute(() => { throw new Error("boom"); }))).rejects.toEqual({
      _tag: "WorkerTaskError",
      message: "Error: boom",
    });

    expect(pool.stats()).toMatchObject({
      size: 1,
      busy: 0,
      idle: 1,
      queued: 0,
      completed: 2,
      failed: 1,
      timedOut: 0,
    });

    await pool.shutdown();
    await expect(rt.toPromise(pool.execute(() => "closed"))).rejects.toEqual({ _tag: "WorkerPoolClosed" });
  });

  it("rejects full queues, times out queued work, cancels queued work, and closes queued tasks", async () => {
    const rt = Runtime.make({});
    const full = makeWorkerPool({ size: 0, maxQueue: 1, taskTimeoutMs: 50 });
    const blocked = rt.fork(full.execute(() => "blocked"));
    await wait();
    await expect(rt.toPromise(full.execute(() => "overflow"))).rejects.toEqual({ _tag: "WorkerPoolFull", queued: 1 });
    blocked.interrupt();
    await full.shutdown();

    const timeoutPool = makeWorkerPool({ size: 0, maxQueue: 2, taskTimeoutMs: 1 });
    await expect(rt.toPromise(timeoutPool.execute(() => "late"))).rejects.toEqual({ _tag: "WorkerTaskTimeout", ms: 1 });
    expect(timeoutPool.stats().timedOut).toBe(1);

    const cancelPool = makeWorkerPool({ size: 0, maxQueue: 2, taskTimeoutMs: 50 });
    const canceled = rt.fork(cancelPool.execute(() => "never"));
    await wait();
    expect(cancelPool.stats().queued).toBe(1);
    canceled.interrupt();
    await wait();
    expect(cancelPool.stats().queued).toBe(0);

    const closePool = makeWorkerPool({ size: 0, maxQueue: 2, taskTimeoutMs: 50 });
    const closing = rt.fork(closePool.execute(() => "never"));
    await wait();
    await closePool.shutdown();
    await new Promise<void>((resolve) => closing.join((exit) => {
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "WorkerPoolClosed" } },
      });
      resolve();
    }));
  });
});
