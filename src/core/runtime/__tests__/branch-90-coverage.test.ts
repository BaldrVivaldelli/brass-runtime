import { describe, expect, it, vi } from "vitest";
import { asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { Cause } from "../../types/effect";
import { Runtime } from "../runtime";
import { RuntimeRegistry } from "../registry";
import { InMemoryTracer } from "../tracingSink";
import {
  LayerContext,
  MissingLayerServiceError,
  formatLayerError,
  layer,
  makeLayerScope,
  serviceTag,
} from "../layer";
import {
  Scheduler,
  inferCallerLaneFromStack,
  laneTag,
  sanitizeLaneKey,
} from "../scheduler";
import { makeRuntimeRecorder } from "../recorder";
import {
  fixed,
  jitteredSchedule,
  makeScheduleDriver,
  maxElapsed,
  never,
  recurs,
  retryWithSchedule,
  runSchedule,
  tapDecision,
  windowed,
} from "../schedule";
import { makeSupervisor, supervise } from "../supervisor";

const wait = () => new Promise((resolve) => setImmediate(resolve));
const rt = Runtime.make({});

describe("runtime branch coverage edges", () => {
  it("records registry edge events and formats every supported error shape", () => {
    const registry = new RuntimeRegistry();

    for (let i = 0; i < 2_005; i++) {
      registry.emit({ type: "log", level: "info", message: `event-${i}` }, {});
    }

    expect(registry.getRecentEvents()).toHaveLength(2_000);

    registry.emit({ type: "fiber.suspend", fiberId: 404 }, {});
    registry.emit({ type: "fiber.resume", fiberId: 404 }, {});
    registry.emit({ type: "fiber.end", fiberId: 404, status: "success" }, {});
    registry.emit({ type: "scope.close", scopeId: 404, status: "success" }, {});

    registry.emit({ type: "fiber.start", fiberId: 1, name: "ok" }, { traceId: "t", spanId: "s" });
    registry.emit({ type: "fiber.end", fiberId: 1, status: "success" }, {});
    expect(registry.fibers.get(1)?.lastEnd).toEqual({ status: "success", error: undefined });

    registry.emit({ type: "fiber.start", fiberId: 2 }, {});
    registry.emit({ type: "fiber.end", fiberId: 2, status: "failure", error: new Error("boom") }, {});
    expect(registry.fibers.get(2)?.lastEnd?.error).toBe("boom");

    registry.emit({ type: "fiber.start", fiberId: 3 }, {});
    registry.emit({ type: "fiber.end", fiberId: 3, status: "failure", error: "plain" }, {});
    expect(registry.fibers.get(3)?.lastEnd?.error).toBe("plain");

    registry.emit({ type: "fiber.start", fiberId: 4 }, {});
    registry.emit({ type: "fiber.end", fiberId: 4, status: "interrupted", error: Cause.fail("bad") }, {});
    expect(registry.fibers.get(4)?.status).toBe("Interrupted");
    expect(registry.fibers.get(4)?.lastEnd?.error).toContain("Fail");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    registry.emit({ type: "fiber.start", fiberId: 5 }, {});
    registry.emit({ type: "fiber.end", fiberId: 5, status: "failure", error: circular }, {});
    expect(registry.fibers.get(5)?.lastEnd?.error).toBe("[object Object]");
  });

  it("covers tracer sampling, missing spans, pruning, and sanitizer paths", () => {
    let now = 0;
    const tracer = new InMemoryTracer({
      clock: () => now,
      sanitizeAttributes: (attrs) => ({ ...attrs, sanitized: true }),
      sanitizeError: (error) => `safe:${String(error)}`,
    });

    now = 1;
    tracer.emit({ type: "span.start", name: "not-sampled" }, { spanId: "skip", sampled: false });
    tracer.emit({ type: "fiber.start", fiberId: 1 }, {});
    expect(tracer.spans.size).toBe(0);

    tracer.emit({ type: "fiber.start", fiberId: 2, name: "fiber" }, { traceId: "t", spanId: "fiber-span" });
    tracer.emit({ type: "fiber.suspend", fiberId: 2, reason: "io" }, { spanId: "fiber-span" });
    tracer.emit({ type: "fiber.resume", fiberId: 2 }, { spanId: "fiber-span" });
    tracer.emit({ type: "scope.open", scopeId: 1 }, { spanId: "fiber-span" });
    tracer.emit({ type: "schedule.decision", attempt: 1, elapsedMs: 1, delayMs: 0, continue: false }, { spanId: "fiber-span" });
    now = 2;
    tracer.emit({ type: "fiber.end", fiberId: 2, status: "failure", error: Cause.fail("nope") }, { spanId: "fiber-span" });
    tracer.emit({ type: "fiber.end", fiberId: 2, status: "failure", error: "again" }, { spanId: "fiber-span" });

    const finishedFiber = tracer.exportFinished()[0]!;
    expect(finishedFiber.attrs).toMatchObject({ fiberId: 2, sanitized: true });
    expect(finishedFiber.events.at(-1)?.attrs).toMatchObject({ error: "safe:again", sanitized: true });

    tracer.emit({ type: "span.event", name: "missing-span" }, {});
    tracer.emit({ type: "span.event", name: "missing-span" }, { spanId: "unknown" });
    tracer.emit({ type: "span.end", status: "success" }, {});
    tracer.emit({ type: "span.end", status: "success" }, { spanId: "unknown" });

    tracer.emit({ type: "span.start", name: "open" }, { traceId: "t", spanId: "open" });
    expect(tracer.pruneFinished(["missing", "open", "fiber-span"])).toBe(1);
    expect(tracer.stats()).toMatchObject({ prunedFinishedSpans: 1 });
  });

  it("prunes finished spans by age and capacity", () => {
    let now = 0;
    const expired = new InMemoryTracer({ clock: () => now, maxSpanAgeMs: 5 });

    now = 10;
    expired.emit({ type: "span.start", name: "old" }, { spanId: "old" });
    now = 11;
    expired.emit({ type: "span.end", status: "success" }, { spanId: "old" });
    now = 20;
    expect(expired.pruneFinished()).toBe(1);
    expect(expired.exportFinished()).toEqual([]);

    const capped = new InMemoryTracer({ maxFinishedSpans: 1 });
    capped.emit({ type: "span.start", name: "a" }, { spanId: "a" });
    capped.emit({ type: "span.end", status: "success" }, { spanId: "a" });
    capped.emit({ type: "span.start", name: "b" }, { spanId: "b" });
    capped.emit({ type: "span.end", status: "success" }, { spanId: "b" });
    capped.pruneFinished();
    expect(capped.exportFinished().map((span) => span.spanId)).toEqual(["b"]);
  });

  it("covers layer context construction, formatting, cache, and closed-scope paths", async () => {
    const rt = Runtime.make({});
    const Tag = serviceTag<{ value: number }>("Svc");
    const context = new LayerContext([[Tag, { value: 1 }]]);
    const merged = new LayerContext(new Map()).merge(context);

    expect(merged.unsafeGet(Tag)).toEqual({ value: 1 });
    expect(merged.has(Tag)).toBe(true);
    expect(() => LayerContext.empty().unsafeGet(Tag)).toThrow(MissingLayerServiceError);
    expect(formatLayerError(new MissingLayerServiceError("Db"))).toContain("Db");
    expect(formatLayerError({ _tag: "MissingLayerService", serviceName: "Cache" })).toContain("Cache");
    expect(formatLayerError(new Error("boom"))).toBe("boom");
    expect(formatLayerError("plain")).toBe("plain");

    let acquired = 0;
    let released = 0;
    const serviceLayer = layer(
      () => {
        acquired++;
        return asyncSucceed({ id: acquired });
      },
      () => {
        released++;
        return asyncFail("ignored-release-failure") as any;
      },
    );

    const scope = makeLayerScope() as ReturnType<typeof makeLayerScope> & {
      addFinalizer: (release: () => ReturnType<typeof asyncSucceed<void>>) => ReturnType<typeof asyncSucceed<void>>;
    };
    const first = await rt.toPromise(scope.get(serviceLayer));
    const second = await rt.toPromise(scope.get(serviceLayer));
    expect(second).toBe(first);
    expect(scope.size()).toBe(1);

    await rt.toPromise(scope.close());
    await rt.toPromise(scope.close());
    expect(released).toBe(1);

    await expect(rt.toPromise(scope.get(serviceLayer))).rejects.toThrow(/closed/);
    await rt.toPromise(scope.addFinalizer(() => asyncSucceed(undefined)));
    expect(scope.size()).toBe(0);
  });

  it("normalizes scheduler lane keys and caller stack shapes", async () => {
    expect(sanitizeLaneKey("  alpha\tbeta\nx/y#z!  ")).toBe("alpha:beta:x/y#z_");
    expect(sanitizeLaneKey("")).toBe("anonymous");
    expect(sanitizeLaneKey("💥")).toBe("_");
    expect(sanitizeLaneKey("x".repeat(200))).toHaveLength(160);
    expect(laneTag(" api service ", "fetch")).toBe("lane:api:service|fetch");

    expect(inferCallerLaneFromStack("Error\n    at run (node:internal/process/task_queues:1:2)", "fallback lane")).toBe("fallback:lane");
    expect(inferCallerLaneFromStack(null as any, "null stack")).toBe("null:stack");
    expect(inferCallerLaneFromStack("Error\n    no location here", "no loc")).toBe("no:loc");
    expect(inferCallerLaneFromStack("Error\n    at handler /repo/src/app/space.ts:1:2")).toBe("app/space");
    expect(inferCallerLaneFromStack("Error\n    at Runtime.run (/repo/src/core/runtime/runtime.ts:1:2)\n    at user (/repo/apps/payments/client.ts:10:2)")).toBe("payments/client");
    expect(inferCallerLaneFromStack("Error\n    at /repo/src/app/service.ts:12:34")).toBe("app/service");
    expect(inferCallerLaneFromStack("Error\n    at handler (file:///repo/packages/api/index.js:12:34)")).toBe("api/index");
    expect(inferCallerLaneFromStack(`Error\n    at handler (${process.cwd()}/external/worker.ts:12:34)`)).toBe("external/worker");

    const originalProcess = globalThis.process;
    vi.stubGlobal("process", undefined);
    expect(inferCallerLaneFromStack("Error\n    at handler (/outside/path/job.ts:1:2)")).toBe("path/job");
    vi.stubGlobal("process", originalProcess);

    const errors: unknown[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    const single = new Scheduler({ laneMode: "single", initialCapacity: 1, maxCapacity: 1, flushBudget: 1, microThreshold: 0 });
    expect(single.schedule("not-a-function" as any)).toBe("dropped");
    expect(single.schedule(() => { throw new Error("single"); })).toBe("accepted");
    expect(single.schedule(() => undefined)).toBe("accepted");

    const lanes = new Scheduler({ maxLanes: 1, laneCapacity: 1, flushBudget: 1, microThreshold: 0 });
    expect(lanes.scheduleBatch([
      { fn: () => undefined, tag: "lane:a|one" },
      { fn: "bad" as any, tag: "lane:a|bad" },
      { fn: () => { throw new Error("lane"); }, tag: "lane:b|two" },
    ])).toEqual(["accepted", "dropped", "accepted"]);
    lanes.schedule(() => undefined, "caller:billing|task");
    lanes.schedule(() => undefined, "lane:|empty");

    const manualScheduler = new Scheduler() as any;
    const manualLane = manualScheduler.getOrCreateLane("manual");
    manualLane.tagQueue = { shift: () => undefined };
    manualLane.sharedTag = undefined;
    expect(manualLane.shiftTag()).toBe("manual");

    await wait();
    await wait();
    expect(single.stats().data.executedTasks).toBeGreaterThanOrEqual(1);
    expect(lanes.stats().data.lanes.map((lane) => lane.key)).toContain("overflow");
    expect(errors.length).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });

  it("explains recorder events across dropped, suspended, error, and optional-field paths", () => {
    const recorder = makeRuntimeRecorder({ maxEvents: 3 });
    expect(recorder.stats()).toEqual({ size: 0, capacity: 3, dropped: 0 });

    recorder.emit({ type: "fiber.start", fiberId: 1, name: "worker", parentFiberId: 0 }, { traceId: "t" });
    recorder.emit({ type: "fiber.suspend", fiberId: 1 }, {});
    recorder.emit({ type: "fiber.resume", fiberId: 1 }, {});
    recorder.emit({ type: "fiber.end", fiberId: 1, status: "failure", error: Cause.fail("bad") }, {});
    recorder.emit({ type: "scope.open", scopeId: 1, parentScopeId: 0 }, {});
    recorder.emit({ type: "scope.close", scopeId: 1, status: "failure", error: new Error("scope") }, {});
    recorder.emit({ type: "supervisor.child.restart", supervisorId: 1, childId: 2, restartCount: 3, delayMs: 4, reason: "boom" }, {});
    recorder.emit({ type: "supervisor.child.escalate", supervisorId: 1, childId: 2, reason: "fatal", error: "bad" }, {});
    recorder.emit({ type: "schedule.decision", name: "retry", attempt: 1, elapsedMs: 1.2, delayMs: 5, continue: true, reason: "again" }, {});
    recorder.emit({ type: "log", level: "warn", message: "careful", fields: { x: 1 } }, {});
    recorder.emit({ type: "log", level: "info", message: "quiet" }, {});
    recorder.emit({ type: "span.start", name: "span" }, { traceId: "trace" });
    recorder.emit({ type: "span.end", name: "span", status: "failure", error: new Error("span") }, {});

    const stats = recorder.stats();
    expect(stats.size).toBe(3);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.firstSeq).toBeDefined();
    expect(stats.lastSeq).toBeDefined();
    expect(recorder.explain({ maxEvents: 2 })).toContain("Runtime flight recorder");

    recorder.clear();
    expect(recorder.snapshot()).toEqual([]);
    expect(recorder.stats()).toEqual({ size: 0, capacity: 3, dropped: 0 });
  });

  it("explains recorder events when optional fields are absent", () => {
    const recorder = makeRuntimeRecorder({ maxEvents: 32 });

    recorder.emit({ type: "fiber.start", fiberId: 1 }, {});
    recorder.emit({ type: "fiber.suspend", fiberId: 1 }, {});
    recorder.emit({ type: "fiber.end", fiberId: 1, status: "success" }, {});
    recorder.emit({ type: "scope.open", scopeId: 1 }, {});
    recorder.emit({ type: "scope.close", scopeId: 1, status: "success" }, {});
    recorder.emit({ type: "supervisor.child.restart", supervisorId: 1, childId: 2, restartCount: 1, delayMs: 0 }, {});
    recorder.emit({ type: "supervisor.child.escalate", supervisorId: 1, childId: 2 }, {});
    recorder.emit({ type: "schedule.decision", attempt: 0, elapsedMs: 0, delayMs: 0, continue: false }, {});
    recorder.emit({ type: "log", level: "error", message: "plain" }, {});
    recorder.emit({ type: "span.start", name: "span" }, {});
    recorder.emit({ type: "span.end", status: "success" }, {});

    const explanation = recorder.explain();
    expect(explanation).not.toContain("dropped");
    expect(explanation).toContain("awaiting unknown");
    expect(explanation).toContain("schedule attempt=0 stops");
    expect(explanation).toContain("span ended success");
  });

  it("explains recorder positive optional branches kept in the snapshot", () => {
    const recorder = makeRuntimeRecorder({ maxEvents: 16 });

    recorder.emit({ type: "fiber.start", fiberId: 2 }, {});
    recorder.emit({ type: "fiber.suspend", fiberId: 2, reason: "db" }, {});
    recorder.emit({ type: "schedule.decision", name: "poll", attempt: 1, elapsedMs: 3, delayMs: 4, continue: true, reason: "wait" }, {});
    recorder.emit({ type: "log", level: "warn", message: "without-fields" }, {});

    const explanation = recorder.explain();
    expect(explanation).toContain("awaiting db");
    expect(explanation).toContain("continues");
    expect(explanation).toContain("warn: without-fields");
  });

  it("covers tracer missing-span, unsanitized error, stale finished set, and compaction branches", () => {
    let now = 0;
    const tracer = new InMemoryTracer({ clock: () => now, maxSpanAgeMs: 1 });

    tracer.emit({ type: "span.start", name: "no-span" }, {});
    tracer.emit({ type: "fiber.end", fiberId: 999, status: "success" }, { spanId: "missing" });
    tracer.emit({ type: "span.event", name: "missing-event" }, { spanId: "missing" });
    tracer.emit({ type: "scope.close", scopeId: 1, status: "success" }, {});
    tracer.emit({ type: "scope.close", scopeId: 1, status: "success" }, { spanId: "missing" });

    tracer.emit({ type: "span.start", name: "real" }, { spanId: "real" });
    tracer.emit({ type: "span.event", name: "event-without-attrs" }, { spanId: "real" });
    tracer.emit({ type: "span.end", status: "failure", error: new Error("raw") }, { spanId: "real" });
    tracer.emit({ type: "span.end", status: "success" }, { spanId: "real" });
    expect(tracer.exportFinished()[0]?.events.at(-1)?.attrs).toMatchObject({ status: "success", error: undefined });

    (tracer as any).finishedSpanSet.add("open");
    (tracer as any).finishedSpanIds.push("open");
    (tracer as any).finishedSpanCount++;
    tracer.spans.set("open", {
      traceId: "t",
      spanId: "open",
      name: "open",
      startWallTs: 0,
      attrs: {},
      links: [],
      events: [],
    });
    now = 10;
    expect(tracer.pruneFinished()).toBeGreaterThanOrEqual(1);

    (tracer as any).finishedSpanOffset = 1_024;
    (tracer as any).finishedSpanIds.push("kept");
    (tracer as any).compactFinishedIds();
    expect((tracer as any).finishedSpanOffset).toBe(0);
  });

  it("drives schedule defaults, observers, hooks, jitter, windows, and effect runners", async () => {
    let now = 0;
    const clock = {
      now: () => now,
      setTimeout,
      clearTimeout,
    };
    const hookEvents: unknown[] = [];
    const hooks = {
      emit: (event: unknown) => {
        hookEvents.push(event);
        throw new Error("ignored hook");
      },
    };

    const fullJitter = makeScheduleDriver(jitteredSchedule(fixed(10), 2), {
      clock,
      onDecision: () => {
        throw new Error("ignored observer");
      },
      hooks,
      captureInput: true,
      captureOutput: true,
      emitContext: { fiberId: 1 },
    });
    expect(fullJitter.next("input").delayMs).toBeGreaterThanOrEqual(0);
    expect(hookEvents).toHaveLength(1);

    const noJitter = makeScheduleDriver(jitteredSchedule(fixed(10), { factor: 0, random: () => 0.5 }), { clock });
    expect(noJitter.next("x").delayMs).toBe(10);

    const stopped = makeScheduleDriver(jitteredSchedule(never(), { factor: 1, random: () => 0.5 }), { clock });
    expect(stopped.next("x").continue).toBe(false);

    const rolling = makeScheduleDriver(windowed(fixed(1), 5, () => now), { clock });
    rolling.next("a");
    now = 10;
    expect(rolling.next("b").state).toMatchObject({ windowStartedAt: 10 });

    now = 0;
    const elapsed = makeScheduleDriver(maxElapsed(fixed(100), 10), { clock, startedAtMs: 0 });
    now = 5;
    expect(elapsed.next("a")).toMatchObject({ continue: true, delayMs: 5 });
    now = 10;
    expect(elapsed.next("b")).toMatchObject({ continue: false, delayMs: 0 });
    elapsed.reset();
    expect(elapsed.last()).toBeUndefined();

    const tapped = makeScheduleDriver(tapDecision(fixed(1), () => {
      throw new Error("observer");
    }), { clock });
    expect(tapped.next("tap").continue).toBe(true);

    expect(runSchedule(recurs(1), ["a", "b"])).toHaveLength(1);
    await expect(rt.toPromise(retryWithSchedule(asyncFail("no"), recurs(1)))).rejects.toBe("no");
    await expect(rt.toPromise(retryWithSchedule(asyncSucceed("ok"), recurs(2)))).resolves.toBe("ok");
  });

  it("covers supervisor shutdown, closed starts, direct supervise, and join branches", async () => {
    const runtime = Runtime.make({});
    const empty = makeSupervisor(runtime);
    await rt.toPromise(empty.shutdown());
    expect(() => empty.start({ effect: asyncSucceed("late") })).toThrow(/shut down/);

    const successful = supervise(runtime, { effect: () => asyncSucceed("ok"), name: "child", restart: "never" }, { restart: "never" });
    await new Promise<void>((resolve) => successful.join((exit) => {
      expect(exit).toEqual({ _tag: "Success", value: "ok" });
      resolve();
    }));

    const ignored = makeSupervisor(runtime, {
      escalation: "ignore",
      restart: { mode: "always", maxRestarts: 0, delayMs: () => Number.NaN },
    });
    const failed = ignored.start({ effect: asyncFail("boom"), name: "failed" });
    await new Promise<void>((resolve) => failed.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure" });
      resolve();
    }));
  });
});
