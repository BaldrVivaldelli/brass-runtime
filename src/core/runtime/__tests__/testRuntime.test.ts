import { afterEach, describe, expect, it, vi } from "vitest";

import { async, asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { Cause, Exit } from "../../types/effect";
import { liveClock, runtimeClockFromEnv } from "../clock";
import { retry, sleep, timeout } from "../combinators";
import {
  assertCompletesWithin,
  delayedEffect,
  flakyEffect,
  makeTestRuntime,
  neverEffect,
  TestClock,
  TestScheduler,
} from "../testing";

const tick = () => Promise.resolve();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TestRuntime", () => {
  it("can keep scheduled fibers pending until manually flushed", async () => {
    const { runtime, scheduler, flushAll, run } = makeTestRuntime({}, { autoFlush: false });

    let settled = false;
    const promise = runtime.toPromise(asyncSucceed("manual")).then((value) => {
      settled = true;
      return value;
    });

    await tick();
    expect(settled).toBe(false);
    expect(scheduler.size()).toBe(1);
    expect(scheduler.pending()[0]?.tag).toContain("initial-step");

    expect(flushAll()).toBe(1);
    await expect(promise).resolves.toBe("manual");
    expect(settled).toBe(true);

    await expect(run(asyncSucceed("run-helper"))).resolves.toBe("run-helper");
  });

  it("drives sleep and delayed effects with virtual time", async () => {
    const { run, clock, advance } = makeTestRuntime();

    let slept = false;
    const sleepPromise = run(sleep(100)).then(() => {
      slept = true;
    });

    await tick();
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 100, delayMs: 100 }]);

    expect(advance(99)).toBe(0);
    await tick();
    expect(slept).toBe(false);

    expect(advance(1)).toBe(1);
    await expect(sleepPromise).resolves.toBeUndefined();
    expect(slept).toBe(true);
    expect(clock.now()).toBe(100);

    const delayed = run(delayedEffect(25, "done"));
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 125, delayMs: 25 }]);
    advance(25);
    await expect(delayed).resolves.toBe("done");
  });

  it("drives timeout failures without waiting for real time", async () => {
    const { runExit, clock, advance } = makeTestRuntime();

    const exit = runExit(timeout(neverEffect(), 50));
    await tick();

    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 50, delayMs: 50 }]);
    advance(50);

    await expect(exit).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "TimeoutError", ms: 50 } },
    });
    expect(clock.pendingTimers()).toEqual([]);
  });

  it("drives retry backoff deterministically", async () => {
    const { run, clock, advance } = makeTestRuntime();
    const effect = retry(flakyEffect(2, "ok", "try-again"), {
      maxRetries: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      jitter: "none",
    });

    const result = run(effect);
    await tick();
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 10, delayMs: 10 }]);

    advance(10);
    await tick();
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 30, delayMs: 20 }]);

    advance(20);
    await expect(result).resolves.toBe("ok");
    expect(clock.now()).toBe(30);
  });

  it("uses virtual time for Runtime.delay", async () => {
    const { runtime, run, clock, advance } = makeTestRuntime();

    const result = run(runtime.delay(15, asyncSucceed("later")));
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 15, delayMs: 15 }]);

    advance(15);
    await expect(result).resolves.toBe("later");
  });

  it("exposes fork, flush, timer, and clock helper methods", async () => {
    const test = makeTestRuntime({}, { autoFlush: false });

    const fiber = test.fork(asyncSucceed("forked"));
    await expect(new Promise((resolve) => fiber.join(resolve))).resolves.toMatchObject({
      _tag: "Success",
      value: "forked",
    });
    expect(test.flush()).toBe(0);

    const slept = test.run(sleep(5));
    expect(test.advanceTo(4)).toBe(0);
    expect(test.runDueTimers()).toBe(0);
    expect(test.clock.adjust(1)).toBe(1);
    await expect(slept).resolves.toBeUndefined();

    const delayed = test.run(delayedEffect(5, "timer"));
    expect(test.runAllTimers()).toBe(1);
    await expect(delayed).resolves.toBe("timer");
  });

  it("reports scheduler saturation through flushAll guard from runtime helpers", () => {
    const test = makeTestRuntime({}, { autoFlush: false });
    test.scheduler.schedule(() => undefined, "one");
    test.scheduler.schedule(() => undefined, "two");
    expect(() => test.flushAll(1)).toThrow(/exceeded 1 steps/);
  });

  it("surfaces failures, defects, and interrupts through run()", async () => {
    const { run } = makeTestRuntime();

    await expect(run(asyncFail("nope"))).rejects.toBe("nope");
    await expect(run(async((_env, cb) => cb(Exit.failCause(Cause.die(new Error("boom"))))))).rejects.toThrow("boom");
    await expect(run(async((_env, cb) => cb(Exit.failCause(Cause.interrupt()))))).rejects.toThrow("Interrupted");
  });

  it("exposes scheduler stats, batches, thrown tasks, and guard rails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = new TestScheduler({ autoFlush: false, maxSteps: 1 });
    const order: string[] = [];

    expect(scheduler.schedule("not-a-function" as any)).toBe("dropped");
    expect(scheduler.scheduleBatch([
      { fn: () => order.push("a"), tag: "a" },
      { fn: () => { throw new Error("bad-task"); }, tag: "bad" },
    ])).toEqual(["accepted", "accepted"]);
    expect(scheduler.stats()).toMatchObject({
      data: { len: 2, phase: "idle", enqueuedTasks: 2, droppedTasks: 1 },
    });

    expect(scheduler.flush()).toBe(1);
    expect(scheduler.flush()).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("bad"), expect.any(Error));
    expect(scheduler.flush()).toBe(0);
    expect(order).toEqual(["a"]);

    scheduler.schedule(() => undefined, "first");
    scheduler.schedule(() => undefined, "second");
    expect(() => scheduler.flushAll(1)).toThrow(/exceeded 1 steps/);
  });

  it("auto-flushes scheduled tasks and handles nested scheduling", async () => {
    const scheduler = new TestScheduler();
    const order: string[] = [];

    scheduler.schedule(() => {
      order.push("outer");
      scheduler.schedule(() => order.push("inner"), "inner");
    }, "outer");
    expect(scheduler.stats().data.phase).toBe("scheduled");

    await tick();
    expect(order).toEqual(["outer", "inner"]);
    expect(scheduler.stats()).toMatchObject({
      data: { len: 0, phase: "idle", executedTasks: 2 },
    });
  });

  it("orders, clears, runs, and guards virtual timers", () => {
    const flushed = vi.fn();
    const clock = new TestClock(-5, flushed, 10);
    const fired: string[] = [];

    expect(clock.now()).toBe(0);
    const cleared = clock.setTimeout(() => fired.push("cleared"), 5);
    clock.clearTimeout(cleared);
    clock.clearTimeout({ id: "not-a-test-timer" });
    clock.setTimeout(() => fired.push("b"), 10);
    clock.setTimeout(() => fired.push("a"), 10);

    expect(clock.runDue()).toBe(0);
    expect(clock.advanceTo(9)).toBe(0);
    expect(clock.runAll()).toBe(2);
    expect(fired).toEqual(["b", "a"]);
    expect(flushed).toHaveBeenCalled();

    clock.clear();
    expect(clock.pendingTimers()).toEqual([]);

    const runaway = new TestClock(0, () => undefined, 1);
    runaway.setTimeout(() => runaway.setTimeout(() => undefined, 0), 0);
    expect(() => runaway.advanceTo(0)).toThrow(/exceeded 1 timers/);

    const guardedRunAll = new TestClock();
    guardedRunAll.setTimeout(() => undefined, 1);
    expect(() => guardedRunAll.runAll(0)).toThrow(/exceeded 0 timers/);
  });

  it("exposes live and injected clock helpers", () => {
    const custom = new TestClock(123);
    expect(runtimeClockFromEnv({ brass: { clock: custom } })).toBe(custom);
    expect(runtimeClockFromEnv({})).toBe(liveClock);

    const timer = liveClock.setTimeout(() => undefined, -1);
    liveClock.clearTimeout(timer);
    expect(liveClock.now()).toBeTypeOf("number");

    const originalPerformance = globalThis.performance;
    try {
      Object.defineProperty(globalThis, "performance", { configurable: true, value: undefined });
      expect(liveClock.now()).toBeTypeOf("number");
    } finally {
      Object.defineProperty(globalThis, "performance", { configurable: true, value: originalPerformance });
    }
  });

  it("can assert completion against virtual elapsed time", async () => {
    const test = makeTestRuntime();
    const assertion = assertCompletesWithin(delayedEffect(10, "slow"), 5, test.runtime);

    await tick();
    test.advance(10);

    await expect(assertion).rejects.toThrow(/Effect took 10.0ms/);
  });
});
