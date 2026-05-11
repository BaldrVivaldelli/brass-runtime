import { describe, expect, it } from "vitest";

import { asyncSync } from "../../types/asyncEffect";
import { makeRuntimeRecorder } from "../recorder";
import {
  fixed,
  forever,
  linear,
  makeScheduleDriver,
  maxDelay,
  maxElapsed,
  named,
  never,
  once,
  repeatWithSchedule,
  retryWithSchedule,
  runSchedule,
  Schedule,
  spaced,
  tapDecision,
  untilInput,
  untilOutput,
  upTo,
  whileOutput,
} from "../schedule";
import { makeTestRuntime } from "../testing";
import type { RuntimeClock } from "../clock";

const tick = () => Promise.resolve();

function manualClock(nowRef: { value: number }): RuntimeClock {
  return {
    now: () => nowRef.value,
    setTimeout: (task, _ms) => {
      task();
      return 0;
    },
    clearTimeout: () => undefined,
  };
}

describe("Schedule 2.0", () => {
  it("drives schedules with snapshots, reset, names, observers, and runtime hooks", () => {
    const now = { value: 0 };
    const observerEvents: any[] = [];
    const recorder = makeRuntimeRecorder();
    const policy = named("db.retry", maxDelay(linear(10), 15));
    const driver = makeScheduleDriver(policy, {
      clock: manualClock(now),
      onDecision: (event) => observerEvents.push(event),
      hooks: recorder.hooks,
      captureInput: true,
      captureOutput: true,
    });

    const first = driver.next("first");
    expect(first).toMatchObject({
      continue: true,
      delayMs: 10,
      output: 1,
      attempt: 0,
      elapsedMs: 0,
      decision: { name: "db.retry", attempt: 0, elapsedMs: 0 },
    });

    now.value = 5;
    const second = driver.next("second");
    expect(second).toMatchObject({ continue: true, delayMs: 15, output: 2, attempt: 1, elapsedMs: 5 });
    expect(driver.snapshot()).toMatchObject({
      name: "db.retry",
      attempt: 2,
      elapsedMs: 5,
      last: { output: 2 },
    });
    expect(driver.last()).toBe(second);

    expect(observerEvents).toHaveLength(2);
    expect(observerEvents[1]).toMatchObject({
      name: "db.retry",
      input: "second",
      output: 2,
      attempt: 1,
      decision: { delayMs: 15 },
    });
    expect(recorder.snapshot().filter((event) => event.type === "schedule.decision")).toHaveLength(2);
    expect(recorder.explain()).toContain('schedule "db.retry" attempt=1 continues delay=15ms');

    now.value = 100;
    driver.reset();
    expect(driver.snapshot()).toMatchObject({ attempt: 0, elapsedMs: 0, state: 0 });
  });

  it("adds common constructors and combinators", () => {
    expect(forever().step(0, "x")[0]).toEqual({ continue: true, delayMs: 0 });
    expect(never().step(0, "x")[0]).toEqual({ continue: false, delayMs: 0 });

    const single = once();
    const first = single.step(single.initial(), "x");
    expect(first[0].continue).toBe(true);
    expect(single.step(first[1], "x")[0].continue).toBe(false);

    expect(spaced(12).step(0, "x")[0].delayMs).toBe(12);
    expect(linear(5, 12).step(2, "x")[0].delayMs).toBe(12);

    const now = { value: 0 };
    const capped = maxElapsed(fixed(50), 100);
    const context = (attempt: number) => ({ clock: manualClock(now), startedAtMs: 0, attempt });
    let state = capped.initial(context(0));
    expect(capped.step(state, "x", context(0))[0]).toEqual({
      continue: true,
      delayMs: 50,
    });
    now.value = 75;
    const next = capped.step(state, "x", context(1));
    expect(next[0]).toEqual({ continue: true, delayMs: 25 });
    state = next[1];
    now.value = 100;
    expect(capped.step(state, "x", context(2))[0]).toEqual({
      continue: false,
      delayMs: 0,
    });

    expect(upTo(fixed(25), 10).step(upTo(fixed(25), 10).initial(), "x")[0].delayMs).toBeLessThanOrEqual(10);
    expect(untilInput<number>((n) => n > 2).step(undefined, 1)[0].continue).toBe(true);
    expect(untilInput<number>((n) => n > 2).step(undefined, 3)[0].continue).toBe(false);
    expect(whileOutput(linear(1), (n) => n < 2).step(0, "x")[0].continue).toBe(true);
    expect(untilOutput(linear(1), (n) => n >= 1).step(0, "x")[0].continue).toBe(false);
  });

  it("supports tapDecision and pure schedule simulation", () => {
    const tapped: any[] = [];
    const policy = tapDecision(named("simulation", linear(10)), (event) => tapped.push(event));

    const decisions = runSchedule(policy, ["a", "b", "c"]);
    expect(decisions.map((decision) => decision.delayMs)).toEqual([10, 20, 30]);
    expect(decisions.map((decision) => decision.output)).toEqual([1, 2, 3]);
    expect(tapped).toEqual([
      expect.objectContaining({ name: "simulation", input: "a", output: 1, attempt: 0 }),
      expect.objectContaining({ name: "simulation", input: "b", output: 2, attempt: 1 }),
      expect.objectContaining({ name: "simulation", input: "c", output: 3, attempt: 2 }),
    ]);
  });

  it("uses the runtime clock in retry and repeat runners", async () => {
    const { run, clock, advance } = makeTestRuntime();
    let attempts = 0;
    const flaky = asyncSync(() => {
      attempts++;
      if (attempts < 2) throw "again";
      return "ok";
    }) as any;

    const result = run(retryWithSchedule(flaky, fixed(25)));
    await tick();
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 25, delayMs: 25 }]);
    advance(25);
    await expect(result).resolves.toBe("ok");
    expect(clock.now()).toBe(25);

    let values = 0;
    const repeated = run(repeatWithSchedule(asyncSync(() => ++values), Schedule.take(Schedule.fixed(10), 2)));
    await tick();
    expect(clock.pendingTimers()).toMatchObject([{ dueAt: 35, delayMs: 10 }]);
    advance(10);
    await expect(repeated).resolves.toBe(2);
  });
});
