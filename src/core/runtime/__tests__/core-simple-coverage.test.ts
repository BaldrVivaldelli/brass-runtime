import { describe, expect, it, vi } from "vitest";
import { asyncFail, asyncSucceed, asyncSync } from "../../types/asyncEffect";
import { makeCancelToken, linkAbortController } from "../../types/cancel";
import { derivedRef, makeRef } from "../ref";
import {
  andThen,
  elapsed,
  exponential,
  fibonacci,
  fixed,
  intersect,
  jitter,
  jittered,
  map as mapSchedule,
  recurs,
  repeatWithSchedule,
  retryWithSchedule,
  take,
  union,
  windowed,
  whileInput,
} from "../schedule";
import {
  compose,
  layer,
  layerFail,
  layerFrom,
  layerSucceed,
  mapLayer,
  merge,
  provideLayer,
} from "../layer";
import { makeMetrics } from "../metrics";
import { gracefulShutdown, registerShutdownHooks } from "../shutdown";
import { Runtime } from "../runtime";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

describe("cancel utilities", () => {
  it("cancels once, supports unsubscribe, immediate callbacks, and AbortController linking", () => {
    const token = makeCancelToken();
    const calls: string[] = [];
    const unsubscribe = token.onCancel(() => calls.push("removed"));
    token.onCancel(() => calls.push("kept"));
    unsubscribe();

    const controller = new AbortController();
    linkAbortController(token, controller);

    expect(token.isCancelled()).toBe(false);
    token.cancel();
    token.cancel();

    expect(token.isCancelled()).toBe(true);
    expect(calls).toEqual(["kept"]);
    expect(controller.signal.aborted).toBe(true);

    token.onCancel(() => calls.push("late"));
    expect(calls).toEqual(["kept", "late"]);
  });
});

describe("Ref", () => {
  it("supports get, set, update, modify and derived refs", async () => {
    const ref = makeRef({ count: 1, label: "a" });
    const count = derivedRef(ref, (s) => s.count, (s, n: number) => ({ ...s, count: n }));

    await expect(run(ref.get())).resolves.toEqual({ count: 1, label: "a" });
    await run(ref.set({ count: 2, label: "b" }));
    await expect(run(ref.update((s) => ({ ...s, count: s.count + 1 })))).resolves.toEqual({ count: 3, label: "b" });
    await expect(run(ref.modify((s) => [`${s.label}:${s.count}`, { ...s, label: "c" }]))).resolves.toBe("b:3");

    await expect(run(count.get())).resolves.toBe(3);
    await run(count.set(10));
    expect(ref.unsafeGet()).toEqual({ count: 10, label: "c" });
    await expect(run(count.update((n) => n + 5))).resolves.toBe(15);
    await expect(run(count.modify((n) => [`count:${n}`, n + 1]))).resolves.toBe("count:15");
    expect(count.unsafeGet()).toBe(16);
    expect(ref.unsafeGet()).toEqual({ count: 16, label: "c" });
  });
});

describe("Layer", () => {
  it("builds, maps, composes, merges, provides, and releases in order", async () => {
    const releases: string[] = [];
    const base = layer(
      () => asyncSucceed({ db: "db" }),
      (svc) => asyncSync(() => { releases.push(`release:${svc.db}`); }) as any,
    );
    const repo = layerFrom<{ db: string }>()(
      (deps) => asyncSucceed({ repo: `${deps.db}:repo` }),
      (svc) => asyncSync(() => { releases.push(`release:${svc.repo}`); }) as any,
    );

    const app = mapLayer(compose(base, repo), (svc) => ({ app: `${svc.repo}:app` }));
    await expect(run(provideLayer(app, (svc) => asyncSucceed(svc.app)))).resolves.toBe("db:repo:app");
    expect(releases).toEqual(["release:db:repo", "release:db"]);

    const merged = merge(layerSucceed({ a: 1 }), layerSucceed({ b: 2 }));
    await expect(run(provideLayer(merged, (svc) => asyncSucceed(svc)))).resolves.toEqual({ a: 1, b: 2 });
  });

  it("releases acquired layers when compose/merge/use fails and propagates layer failures", async () => {
    const releases: string[] = [];
    const acquired = layer(() => asyncSucceed({ a: 1 }), () => asyncSync(() => { releases.push("release:a"); }) as any);
    const failing = layerFail("build-failed");

    await expect(run(provideLayer(compose(acquired, failing as any), () => asyncSucceed("never")))).rejects.toBe("build-failed");
    await expect(run(provideLayer(merge(acquired, failing as any), () => asyncSucceed("never")))).rejects.toBe("build-failed");
    await expect(run(provideLayer(acquired, () => asyncFail("use-failed")))).rejects.toBe("use-failed");
    expect(releases).toEqual(["release:a", "release:a", "release:a"]);
  });
});

describe("Schedule", () => {
  it("steps constructor and combinator decisions", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(125);

    expect(recurs(2).step(0, "x")).toEqual([{ continue: true, delayMs: 0 }, 1, 1]);
    const fixedSchedule = fixed(5);
    expect(fixedSchedule.initial()).toBe(0);
    expect(fixedSchedule.step(0, "x")).toEqual([{ continue: true, delayMs: 5 }, 1, 1]);
    const exponentialSchedule = exponential(10, 15);
    expect(exponentialSchedule.initial()).toBe(0);
    expect(exponentialSchedule.step(1, "x")).toEqual([{ continue: true, delayMs: 15 }, 2, 2]);
    expect(jittered(10, 100).step(1, "x")).toEqual([{ continue: true, delayMs: 10 }, 2, 2]);
    const elapsedSchedule = elapsed(50);
    const started = elapsedSchedule.initial();
    expect(elapsedSchedule.step(started, "x")[0]).toEqual({ continue: true, delayMs: 0 });
    const positiveInput = whileInput<number>((n) => n > 0);
    expect(positiveInput.initial()).toBeUndefined();
    expect(positiveInput.step(undefined, -1)[0].continue).toBe(false);

    const taken = take(fixed(1), 1);
    expect(taken.step(taken.initial(), "x")[0].continue).toBe(false);
    expect(take(fixed(1), 0).step({ inner: 0, count: 0 }, "x")[0].continue).toBe(false);

    const chained = andThen(recurs(1), fixed(2));
    const [firstDecision, secondState] = chained.step(chained.initial(), "x");
    expect(firstDecision).toEqual({ continue: true, delayMs: 0 });
    expect(chained.step(secondState, "x")[0]).toEqual({ continue: true, delayMs: 2 });
    expect(andThen(recurs(3), fixed(2)).step({ phase: "first", inner: 0 }, "x")[1]).toEqual({
      phase: "first",
      inner: 1,
    });

    const both = intersect(fixed(3), fixed(7));
    expect(both.initial()).toEqual({ left: 0, right: 0 });
    expect(both.step({ left: 0, right: 0 }, "x")[0]).toEqual({ continue: true, delayMs: 7 });
    const either = union(recurs(0), fixed(4));
    expect(either.initial()).toEqual({ left: 0, right: 0 });
    expect(either.step({ left: 0, right: 0 }, "x")[0]).toEqual({ continue: true, delayMs: 0 });

    const fib = fibonacci(10, 100);
    let fibState = fib.initial();
    const fibDelays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [decision, nextState] = fib.step(fibState, "x");
      fibDelays.push(decision.delayMs);
      fibState = nextState;
    }
    expect(fibDelays).toEqual([10, 10, 20, 30, 50]);

    const stableJitter = jitter(fixed(100), { factor: 0.2, random: () => 1 });
    expect(stableJitter.step(stableJitter.initial(), "x")[0].delayMs).toBe(120);
    const fullJitter = jittered(100, 1000);
    vi.spyOn(Math, "random").mockReturnValueOnce(0.5);
    expect(fullJitter.step(fullJitter.initial(), "x")[0].delayMs).toBe(50);
    vi.restoreAllMocks();

    let now = 0;
    const rolling = windowed(recurs(2), 100, () => now);
    let rollingState = rolling.initial();
    const first = rolling.step(rollingState, "x");
    expect(first[0].continue).toBe(true);
    rollingState = first[1];
    expect(rolling.step(rollingState, "x")[0].continue).toBe(false);
    now = 101;
    expect(rolling.step(rollingState, "x")[0].continue).toBe(true);

    const mapped = mapSchedule(fixed(1), (n) => `attempt-${n}`);
    expect(mapped.step(mapped.initial(), "x")[2]).toBe("attempt-1");
  });

  it("retries and repeats effects according to schedules", async () => {
    let attempts = 0;
    const flaky = asyncSync(() => {
      attempts++;
      if (attempts < 2) throw "boom";
      return "ok";
    }) as any;

    await expect(run(retryWithSchedule(flaky, recurs(3) as any))).resolves.toBe("ok");
    await expect(run(retryWithSchedule(asyncFail("nope"), recurs(1) as any))).rejects.toBe("nope");

    let value = 0;
    const repeated = asyncSync(() => ++value);
    await expect(run(repeatWithSchedule(repeated, recurs(3) as any))).resolves.toBe(3);
    await expect(run(repeatWithSchedule(asyncFail("repeat-fail"), recurs(3) as any))).rejects.toBe("repeat-fail");

    let delayedAttempts = 0;
    const delayedFlaky = asyncSync(() => {
      delayedAttempts++;
      if (delayedAttempts < 2) throw "delayed-boom";
      return "delayed-ok";
    }) as any;
    await expect(run(retryWithSchedule(delayedFlaky, fixed(1) as any))).resolves.toBe("delayed-ok");

    let delayedValue = 0;
    await expect(run(repeatWithSchedule(asyncSync(() => ++delayedValue), take(fixed(1), 2) as any))).resolves.toBe(2);

    let failAfterFirst = 0;
    const delayedFailure = asyncSync(() => {
      failAfterFirst++;
      if (failAfterFirst > 1) throw "delayed-repeat-fail";
      return failAfterFirst;
    }) as any;
    await expect(run(repeatWithSchedule(delayedFailure, fixed(1) as any))).rejects.toBe("delayed-repeat-fail");
  });
});

describe("Metrics", () => {
  it("tracks counters, gauges, histograms, percentiles, snapshots and reset", () => {
    const metrics = makeMetrics();
    const counter = metrics.counter("requests", { route: "/a", method: "GET" });
    counter.increment();
    counter.increment(-5);
    counter.increment(4);
    expect(counter.value()).toBe(5);

    const gauge = metrics.gauge("in_flight");
    gauge.set(10);
    gauge.increment(2);
    gauge.decrement(3);
    expect(gauge.value()).toBe(9);

    const histogram = metrics.histogram("latency", [10, 20]);
    histogram.observe(5);
    histogram.observe(15);
    histogram.observe(30);
    expect(histogram.buckets()).toMatchObject({ counts: [1, 1, 1], count: 3, min: 5, max: 30, sum: 50 });
    expect(histogram.percentile(50)).toBe(20);
    expect(histogram.percentile(100)).toBe(30);

    const snapshot = metrics.snapshot();
    expect(snapshot.counters[0]).toMatchObject({ name: "requests", value: 5 });
    expect(snapshot.gauges[0]).toMatchObject({ name: "in_flight", value: 9 });
    expect(snapshot.histograms[0].name).toBe("latency");

    metrics.reset();
    expect(metrics.snapshot()).toEqual({ counters: [], gauges: [], histograms: [] });
  });
});

describe("Shutdown", () => {
  it("reports completed and timed-out graceful shutdowns", async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const completed = await gracefulShutdown({ shutdown: () => undefined } as any, { timeoutMs: 5, onStart, onComplete });

    expect(completed.timedOut).toBe(false);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(completed);

    const onTimeout = vi.fn();
    const timedOut = await gracefulShutdown({ shutdown: () => new Promise(() => undefined) } as any, { timeoutMs: 1, onTimeout });

    expect(timedOut.timedOut).toBe(true);
    expect(onTimeout).toHaveBeenCalledWith(timedOut);
  });

  it("registers and cleans shutdown hooks", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const cleanup = registerShutdownHooks({ shutdown: () => undefined } as any, { onComplete: () => undefined });

    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);

    cleanup();
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });
});
