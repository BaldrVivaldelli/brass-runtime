// src/core/runtime/testing.ts
// Testing utilities for brass-runtime effects.

import { Async, async } from "../types/asyncEffect";
import { Cause, Exit } from "../types/effect";
import { Runtime } from "./runtime";
import { Scheduler, type SchedulerStats, type ScheduleResult, type Task } from "./scheduler";
import { runtimeClockFromEnv, type RuntimeClock, type RuntimeClockEnv, type RuntimeTimerId } from "./clock";

// ---------------------------------------------------------------------------
// TestScheduler — deterministic TS scheduler
// ---------------------------------------------------------------------------

export type TestRuntimeOptions = {
  /** Back-compat alias for autoFlush. When false, scheduled tasks only run when flushed. */
  readonly synchronous?: boolean;
  /** Automatically flush scheduled tasks in a microtask. Default: true. */
  readonly autoFlush?: boolean;
  /** Initial virtual clock time in milliseconds. Default: 0. */
  readonly initialTimeMs?: number;
  /** Safety limit for flushAll/runAllTimers. Default: 10_000. */
  readonly maxSteps?: number;
};

export type TestScheduledTask = {
  readonly tag: string;
  readonly run: Task;
};

export class TestScheduler {
  private readonly queue: TestScheduledTask[] = [];
  private readonly maxSteps: number;
  private autoFlushScheduled = false;
  private flushing = false;
  private enqueuedTasks = 0;
  private executedTasks = 0;
  private droppedTasks = 0;
  private scheduledFlushes = 0;
  private completedFlushes = 0;

  constructor(private readonly options: Pick<TestRuntimeOptions, "autoFlush" | "synchronous" | "maxSteps"> = {}) {
    this.maxSteps = options.maxSteps ?? 10_000;
  }

  schedule(task: Task, tag: string = "anonymous"): ScheduleResult {
    if (typeof task !== "function") {
      this.droppedTasks += 1;
      return "dropped";
    }
    this.queue.push({ tag, run: task });
    this.enqueuedTasks += 1;
    this.requestAutoFlush();
    return "accepted";
  }

  scheduleBatch(tasks: Array<{ fn: Task; tag: string }>): ScheduleResult[] {
    return tasks.map(({ fn, tag }) => this.schedule(fn, tag));
  }

  stats(): SchedulerStats {
    return {
      engine: "ts" as const,
      fallbackUsed: false as const,
      data: {
        len: this.queue.length,
        phase: this.flushing ? "flushing" : this.autoFlushScheduled ? "scheduled" : "idle",
        scheduledFlushes: this.scheduledFlushes,
        completedFlushes: this.completedFlushes,
        enqueuedTasks: this.enqueuedTasks,
        executedTasks: this.executedTasks,
        droppedTasks: this.droppedTasks,
        yieldedByBudget: 0,
        lanes: [{
          key: "test",
          len: this.queue.length,
          capacity: Number.POSITIVE_INFINITY,
          enqueuedTasks: this.enqueuedTasks,
          executedTasks: this.executedTasks,
          droppedTasks: this.droppedTasks,
        }],
      },
    };
  }

  pending(): readonly TestScheduledTask[] {
    return this.queue.slice();
  }

  size(): number {
    return this.queue.length;
  }

  flush(maxTasks = 1): number {
    if (this.flushing) return 0;
    this.flushing = true;
    this.autoFlushScheduled = false;
    let ran = 0;
    try {
      while (ran < maxTasks) {
        const next = this.queue.shift();
        if (!next) break;
        ran += 1;
        this.executedTasks += 1;
        try {
          next.run();
        } catch (error) {
          console.error(`[TestScheduler] task threw (tag=${next.tag})`, error);
        }
      }
      return ran;
    } finally {
      this.flushing = false;
      this.completedFlushes += ran > 0 ? 1 : 0;
      if (this.queue.length > 0) this.requestAutoFlush();
    }
  }

  flushAll(maxSteps = this.maxSteps): number {
    let ran = 0;
    while (this.queue.length > 0) {
      if (ran >= maxSteps) {
        throw new Error(`TestScheduler.flushAll exceeded ${maxSteps} steps; possible runaway fiber loop`);
      }
      ran += this.flush(Math.max(1, maxSteps - ran));
    }
    return ran;
  }

  private requestAutoFlush(): void {
    const autoFlush = this.options.autoFlush ?? this.options.synchronous ?? true;
    if (!autoFlush || this.autoFlushScheduled || this.flushing) return;
    this.autoFlushScheduled = true;
    this.scheduledFlushes += 1;
    queueMicrotask(() => {
      if (!this.autoFlushScheduled) return;
      this.flushAll();
    });
  }
}

// ---------------------------------------------------------------------------
// TestClock — virtual time for sleeps/timeouts/retry backoff
// ---------------------------------------------------------------------------

type TestTimer = {
  readonly id: number;
  readonly dueAt: number;
  readonly seq: number;
  readonly task: () => void;
};

export type TestClockTimerSnapshot = {
  readonly id: number;
  readonly dueAt: number;
  readonly delayMs: number;
};

export class TestClock implements RuntimeClock {
  private nowMs: number;
  private nextId = 1;
  private nextSeq = 1;
  private readonly timers = new Map<number, TestTimer>();

  constructor(initialTimeMs = 0, private readonly flushScheduler: () => void = () => undefined, private readonly maxSteps = 10_000) {
    this.nowMs = Math.max(0, Math.floor(initialTimeMs));
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(task: () => void, ms: number): RuntimeTimerId {
    const id = this.nextId++;
    const delay = Math.max(0, Math.floor(ms));
    this.timers.set(id, {
      id,
      dueAt: this.nowMs + delay,
      seq: this.nextSeq++,
      task,
    });
    return id;
  }

  clearTimeout(timer: RuntimeTimerId): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  pendingTimers(): readonly TestClockTimerSnapshot[] {
    return Array.from(this.timers.values())
      .sort(compareTimers)
      .map((timer) => ({
        id: timer.id,
        dueAt: timer.dueAt,
        delayMs: Math.max(0, timer.dueAt - this.nowMs),
      }));
  }

  adjust(ms: number): number {
    return this.advance(ms);
  }

  advance(ms: number): number {
    return this.advanceTo(this.nowMs + Math.max(0, Math.floor(ms)));
  }

  advanceTo(targetMs: number): number {
    const target = Math.max(this.nowMs, Math.floor(targetMs));
    let ran = 0;

    while (true) {
      if (ran >= this.maxSteps) {
        throw new Error(`TestClock.advanceTo exceeded ${this.maxSteps} timers; possible runaway timer loop`);
      }
      const next = this.nextDueTimer(target);
      if (!next) break;
      this.timers.delete(next.id);
      this.nowMs = next.dueAt;
      ran += 1;
      next.task();
      this.flushScheduler();
    }

    this.nowMs = target;
    this.flushScheduler();
    return ran;
  }

  runDue(): number {
    return this.advanceTo(this.nowMs);
  }

  runAll(maxSteps = this.maxSteps): number {
    let ran = 0;
    while (this.timers.size > 0) {
      if (ran >= maxSteps) {
        throw new Error(`TestClock.runAll exceeded ${maxSteps} timers; possible runaway timer loop`);
      }
      const next = this.nextDueTimer(Number.POSITIVE_INFINITY);
      if (!next) break;
      ran += this.advanceTo(next.dueAt);
    }
    return ran;
  }

  clear(): void {
    this.timers.clear();
  }

  private nextDueTimer(targetMs: number): TestTimer | undefined {
    let selected: TestTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.dueAt > targetMs) continue;
      if (!selected || compareTimers(timer, selected) < 0) selected = timer;
    }
    return selected;
  }
}

function compareTimers(a: TestTimer, b: TestTimer): number {
  return a.dueAt === b.dueAt ? a.seq - b.seq : a.dueAt - b.dueAt;
}

// ---------------------------------------------------------------------------
// TestRuntime — runtime with controlled execution
// ---------------------------------------------------------------------------

export type TestRuntime<R> = {
  readonly env: R & RuntimeClockEnv;
  readonly runtime: Runtime<R & RuntimeClockEnv>;
  readonly scheduler: TestScheduler;
  readonly clock: TestClock;
  readonly run: <E, A>(effect: Async<any, E, A>) => Promise<A>;
  readonly runExit: <E, A>(effect: Async<any, E, A>) => Promise<Exit<E, A>>;
  readonly fork: <E, A>(effect: Async<any, E, A>) => ReturnType<Runtime<R & RuntimeClockEnv>["fork"]>;
  readonly flush: (maxTasks?: number) => number;
  readonly flushAll: (maxSteps?: number) => number;
  readonly advance: (ms: number) => number;
  readonly advanceTo: (targetMs: number) => number;
  readonly runDueTimers: () => number;
  readonly runAllTimers: (maxSteps?: number) => number;
};

/**
 * Creates a deterministic TypeScript test runtime.
 *
 * The returned runtime uses:
 * - a `TestScheduler` that can be flushed manually,
 * - a `TestClock` for virtual `sleep`, `timeout`, retry backoff, and `Runtime.delay`,
 * - the normal TS fiber interpreter, so tests exercise the same runtime model as production.
 */
export function makeTestRuntime<R extends object = {}>(
  env?: R,
  options: TestRuntimeOptions = {},
): TestRuntime<R> {
  const scheduler = new TestScheduler(options);
  const clock = new TestClock(options.initialTimeMs, () => scheduler.flushAll(options.maxSteps), options.maxSteps);
  const testEnv = withTestClock(env ?? ({} as R), clock);
  const runtime = Runtime.makeWithEngine(testEnv, "ts", { scheduler: scheduler as unknown as Scheduler });

  const flush = (maxTasks?: number) => scheduler.flush(maxTasks);
  const flushAll = (maxSteps?: number) => scheduler.flushAll(maxSteps);
  const advance = (ms: number) => clock.advance(ms);
  const advanceTo = (targetMs: number) => clock.advanceTo(targetMs);
  const runDueTimers = () => clock.runDue();
  const runAllTimers = (maxSteps?: number) => clock.runAll(maxSteps);

  const runExit = <E, A>(effect: Async<any, E, A>): Promise<Exit<E, A>> => {
    const promise = new Promise<Exit<E, A>>((resolve) => {
      runtime.unsafeRunAsync(effect as Async<any, E, A>, resolve);
    });
    flushAll();
    return promise;
  };

  const run = async <E, A>(effect: Async<any, E, A>): Promise<A> => exitToPromise(await runExit(effect));

  const fork = <E, A>(effect: Async<any, E, A>) => {
    const fiber = runtime.fork(effect as Async<any, E, A>);
    flushAll();
    return fiber;
  };

  return {
    env: testEnv,
    runtime,
    scheduler,
    clock,
    run,
    runExit,
    fork,
    flush,
    flushAll,
    advance,
    advanceTo,
    runDueTimers,
    runAllTimers,
  };
}

function withTestClock<R extends object>(env: R, clock: RuntimeClock): R & RuntimeClockEnv {
  const current = env as R & { brass?: Record<string, unknown> };
  return {
    ...env,
    brass: {
      ...(current.brass ?? {}),
      clock,
    },
  } as R & RuntimeClockEnv;
}

function exitToPromise<E, A>(exit: Exit<E, A>): A {
  if (exit._tag === "Success") return exit.value;

  const failure = Cause.firstFailure(exit.cause);
  if (failure._tag === "Some") throw failure.value;

  const defect = Cause.firstDefect(exit.cause);
  if (defect._tag === "Some") {
    throw defect.value instanceof Error ? defect.value : new Error(String(defect.value));
  }

  if (Cause.containsInterrupt(exit.cause)) throw new Error("Interrupted");
  throw Cause.toError(exit.cause);
}

function runExitWithRuntime<R, E, A>(
  runtime: Runtime<R>,
  effect: Async<R, E, A>,
): Promise<Exit<E, A>> {
  return new Promise((resolve) => {
    runtime.unsafeRunAsync(effect, resolve);
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function firstFailureValue<E>(exit: Exit<E, unknown>): E | undefined {
  if (exit._tag !== "Failure") return undefined;
  const failure = Cause.firstFailure(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
}

function makeAssertionRuntime<R>(runtime?: Runtime<R>): Runtime<R> {
  return runtime ?? Runtime.make({} as R);
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that an effect succeeds with a specific value.
 *
 * ```ts
 * await assertSucceeds(myEffect, 42);
 * ```
 */
export async function assertSucceeds<R, E, A>(
  effect: Async<R, E, A>,
  expected: A,
  runtime?: Runtime<R>
): Promise<void> {
  const rt = makeAssertionRuntime(runtime);
  const exit = await runExitWithRuntime(rt, effect);

  if (exit._tag !== "Success") {
    throw new Error(`Expected success with ${stableJson(expected)}, got failure: ${stableJson(exit.cause)}`);
  }
  if (stableJson(exit.value) !== stableJson(expected)) {
    throw new Error(`Expected ${stableJson(expected)}, got ${stableJson(exit.value)}`);
  }
}

/**
 * Asserts that an effect fails with a specific error.
 *
 * ```ts
 * await assertFails(myEffect, "not found");
 * ```
 */
export async function assertFails<R, E, A>(
  effect: Async<R, E, A>,
  expectedError: E,
  runtime?: Runtime<R>
): Promise<void> {
  const rt = makeAssertionRuntime(runtime);
  const exit = await runExitWithRuntime(rt, effect);

  if (exit._tag !== "Failure") {
    throw new Error(`Expected failure with ${stableJson(expectedError)}, got success: ${stableJson(exit.value)}`);
  }
  const error = firstFailureValue(exit);
  if (stableJson(error) !== stableJson(expectedError)) {
    throw new Error(`Expected error ${stableJson(expectedError)}, got ${stableJson(error)}`);
  }
}

/**
 * Asserts that an effect fails with an error matching a predicate.
 *
 * ```ts
 * await assertFailsWith(myEffect, (e) => e._tag === "NotFound");
 * ```
 */
export async function assertFailsWith<R, E, A>(
  effect: Async<R, E, A>,
  predicate: (error: E) => boolean,
  runtime?: Runtime<R>
): Promise<void> {
  const rt = makeAssertionRuntime(runtime);
  const exit = await runExitWithRuntime(rt, effect);

  if (exit._tag !== "Failure") {
    throw new Error(`Expected failure, got success: ${stableJson(exit.value)}`);
  }
  const error = firstFailureValue(exit);
  if (error === undefined || !predicate(error)) {
    throw new Error(`Error did not match predicate: ${stableJson(error)}`);
  }
}

/**
 * Asserts that an effect completes within a time limit.
 *
 * ```ts
 * await assertCompletesWithin(myEffect, 100); // must finish in 100ms
 * ```
 */
export async function assertCompletesWithin<R, E, A>(
  effect: Async<R, E, A>,
  maxMs: number,
  runtime?: Runtime<R>
): Promise<A> {
  const rt = makeAssertionRuntime(runtime);
  const start = runtimeClockFromEnv(rt.env).now();

  const result = await rt.toPromise(effect);
  const elapsed = runtimeClockFromEnv(rt.env).now() - start;

  if (elapsed > maxMs) {
    throw new Error(`Effect took ${elapsed.toFixed(1)}ms, expected < ${maxMs}ms`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Effect builders for testing
// ---------------------------------------------------------------------------

/**
 * Creates an effect that fails on the first N calls, then succeeds.
 * Useful for testing retry logic.
 *
 * ```ts
 * const flaky = flakyEffect(3, "success!", "temporary error");
 * // Fails 3 times, then returns "success!"
 * ```
 */
export function flakyEffect<E, A>(
  failCount: number,
  successValue: A,
  errorValue: E
): Async<unknown, E, A> {
  let calls = 0;
  return async((_env, cb) => {
    calls++;
    if (calls <= failCount) {
      cb(Exit.failCause(Cause.fail(errorValue)));
    } else {
      cb(Exit.succeed(successValue));
    }
  });
}

/**
 * Creates an effect that takes a specific amount of time to complete.
 * Useful for testing timeouts and concurrency.
 *
 * ```ts
 * const slow = delayedEffect(100, "done"); // completes after 100ms
 * ```
 */
export function delayedEffect<A>(ms: number, value: A): Async<unknown, never, A> {
  return async((env, cb) => {
    const clock = runtimeClockFromEnv(env);
    const id = clock.setTimeout(() => cb(Exit.succeed(value)), ms);
    return () => clock.clearTimeout(id);
  });
}

/**
 * Creates an effect that never completes (hangs forever).
 * Useful for testing timeouts and interruption.
 */
export function neverEffect<A = never>(): Async<unknown, never, A> {
  return async(() => {
    // Never calls cb
    return () => {}; // canceler is a no-op
  });
}
