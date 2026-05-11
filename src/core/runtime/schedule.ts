// src/core/runtime/schedule.ts
// Schedule - composable policies for retry, repetition, polling, and restarts.
//
// A Schedule describes when and how many times to repeat or retry an effect.
// Schedules are values that can be composed, mapped, observed, and driven by a
// runtime-aware clock.

import { Async, asyncFlatMap, asyncSucceed, asyncFail } from "../types/asyncEffect";
import { asyncFold } from "../types/asyncEffect";
import { sleep } from "./combinators";
import { liveClock, runtimeClockFromEnv, type RuntimeClock } from "./clock";
import type { RuntimeEmitContext, RuntimeHooks } from "./events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleDecision = {
  readonly continue: boolean;
  readonly delayMs: number;
  readonly attempt?: number;
  readonly elapsedMs?: number;
  readonly reason?: string;
  readonly name?: string;
};

export type ScheduleJitterOptions = {
  /** 1 means full jitter in [0, delay], 0.2 means +/-20% around delay. */
  readonly factor?: number;
  /** Deterministic hook for tests. Defaults to Math.random. */
  readonly random?: () => number;
};

export type ScheduleStepContext = {
  readonly clock: RuntimeClock;
  readonly startedAtMs: number;
  readonly attempt: number;
  readonly name?: string;
};

/**
 * A Schedule<I, O> takes an input I (typically the error or output of an effect)
 * and decides whether to continue and with what delay.
 */
export type Schedule<I, O> = {
  readonly _tag: "Schedule";
  readonly name?: string;
  /** Initial state */
  readonly initial: (context?: ScheduleStepContext) => any;
  /** Given current state and input, produce a decision and next state */
  readonly step: (state: any, input: I, context?: ScheduleStepContext) => [ScheduleDecision, any, O];
};

export type ScheduleObserverEvent<I, O> = {
  readonly name?: string;
  readonly input: I;
  readonly output: O;
  readonly decision: ScheduleDecision;
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly state: unknown;
  readonly nextState: unknown;
  readonly timestamp: number;
};

export type ScheduleObserver<I, O> = (event: ScheduleObserverEvent<I, O>) => void;

export type ScheduleDriverDecision<O> = {
  readonly continue: boolean;
  readonly delayMs: number;
  readonly output: O;
  readonly decision: ScheduleDecision;
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly state: unknown;
};

export type ScheduleDriverSnapshot<O = unknown> = {
  readonly name?: string;
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly state: unknown;
  readonly last?: ScheduleDriverDecision<O>;
};

export type ScheduleDriverOptions<I = unknown, O = unknown> = {
  readonly name?: string;
  readonly clock?: RuntimeClock;
  readonly startedAtMs?: number;
  readonly onDecision?: ScheduleObserver<I, O>;
  readonly hooks?: RuntimeHooks;
  readonly emitContext?: RuntimeEmitContext;
  readonly captureInput?: boolean;
  readonly captureOutput?: boolean;
};

export type ScheduleDriver<I, O> = {
  readonly next: (input: I) => ScheduleDriverDecision<O>;
  readonly reset: () => void;
  readonly snapshot: () => ScheduleDriverSnapshot<O>;
  readonly state: () => unknown;
  readonly last: () => ScheduleDriverDecision<O> | undefined;
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Retry/repeat up to N times with no delay. */
export function recurs(n: number): Schedule<unknown, number> {
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number, _input: unknown) => {
      const next = count + 1;
      return [{ continue: next < n, delayMs: 0 }, next, next];
    },
  };
}

/** Continue forever with no delay. */
export function forever(): Schedule<unknown, number> {
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number) => {
      const next = count + 1;
      return [{ continue: true, delayMs: 0 }, next, next];
    },
  };
}

/** Never continue. */
export function never(): Schedule<unknown, number> {
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number) => {
      const next = count + 1;
      return [{ continue: false, delayMs: 0 }, next, next];
    },
  };
}

/** Continue exactly once. */
export function once(): Schedule<unknown, number> {
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number) => {
      const next = count + 1;
      return [{ continue: count === 0, delayMs: 0 }, next, next];
    },
  };
}

/** Fixed delay between each retry/repeat. */
export function fixed(delayMs: number): Schedule<unknown, number> {
  const delay = normalizeDelay(delayMs);
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number, _input: unknown) => {
      return [{ continue: true, delayMs: delay }, count + 1, count + 1];
    },
  };
}

/** Alias for fixed delay schedules. */
export const spaced = fixed;

/** Exponential backoff: delay doubles each time, capped at maxDelayMs. */
export function exponential(baseMs: number, maxMs: number = Infinity): Schedule<unknown, number> {
  const base = Math.max(0, baseMs);
  const cap = normalizeCap(maxMs);
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number, _input: unknown) => {
      const delay = Math.min(base * Math.pow(2, count), cap);
      return [{ continue: true, delayMs: delay }, count + 1, count + 1];
    },
  };
}

/** Linear backoff: base, 2*base, 3*base... capped at maxDelayMs. */
export function linear(baseMs: number, maxMs: number = Infinity): Schedule<unknown, number> {
  const base = Math.max(0, baseMs);
  const cap = normalizeCap(maxMs);
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number, _input: unknown) => {
      const next = count + 1;
      return [{ continue: true, delayMs: Math.min(base * next, cap) }, next, next];
    },
  };
}

/** Fibonacci backoff: base, base, 2*base, 3*base, 5*base, capped at maxDelayMs. */
export function fibonacci(baseMs: number, maxMs: number = Infinity): Schedule<unknown, number> {
  const base = Math.max(0, baseMs);
  const cap = normalizeCap(maxMs);
  return {
    _tag: "Schedule",
    initial: () => ({ prev: 0, curr: 1, count: 0 }),
    step: (state: { prev: number; curr: number; count: number }, _input: unknown) => {
      const delay = Math.min(base * state.curr, cap);
      const next = {
        prev: state.curr,
        curr: state.prev + state.curr,
        count: state.count + 1,
      };
      return [{ continue: true, delayMs: delay }, next, state.count + 1];
    },
  };
}

/** Exponential backoff with full jitter (random in [0, delay]). */
export function jittered(baseMs: number, maxMs: number = Infinity): Schedule<unknown, number> {
  return jitteredSchedule(exponential(baseMs, maxMs), { factor: 1 });
}

/** Stop after a total elapsed time. */
export function elapsed(maxMs: number): Schedule<unknown, number> {
  const max = Math.max(0, maxMs);
  return {
    _tag: "Schedule",
    initial: (context) => nowFromContext(context),
    step: (startedAt: number, _input: unknown, context) => {
      const el = nowFromContext(context) - startedAt;
      return [{ continue: el < max, delayMs: 0 }, startedAt, el];
    },
  };
}

/** Only continue while a predicate holds on the input. */
export function whileInput<I>(pred: (input: I) => boolean): Schedule<I, I> {
  return {
    _tag: "Schedule",
    initial: () => undefined,
    step: (_state: any, input: I) => {
      return [{ continue: pred(input), delayMs: 0 }, undefined, input];
    },
  };
}

/** Continue until the input predicate becomes true. */
export function untilInput<I>(pred: (input: I) => boolean): Schedule<I, I> {
  return {
    _tag: "Schedule",
    initial: () => undefined,
    step: (_state: any, input: I) => {
      return [{ continue: !pred(input), delayMs: 0 }, undefined, input];
    },
  };
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Limit a schedule to N repetitions. */
export function take<I, O>(schedule: Schedule<I, O>, n: number): Schedule<I, O> {
  const limit = Math.max(0, Math.floor(n));
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: (context) => ({ inner: schedule.initial(context), count: 0 }),
    step: (state: any, input: I, context) => {
      if (state.count >= limit) return [{ continue: false, delayMs: 0 }, state, undefined as any];
      const [decision, nextInner, output] = schedule.step(state.inner, input, context);
      const nextState = { inner: nextInner, count: state.count + 1 };
      return [{ continue: decision.continue && state.count + 1 < limit, delayMs: decision.delayMs }, nextState, output];
    },
  };
}

/** Transform schedule output while preserving decisions and state. */
export function map<I, O, O2>(schedule: Schedule<I, O>, f: (output: O) => O2): Schedule<I, O2> {
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: schedule.initial,
    step: (state: any, input: I, context) => {
      const [decision, nextState, output] = schedule.step(state, input, context);
      return [decision, nextState, f(output)];
    },
  };
}

/** Transform schedule input before it reaches the wrapped schedule. */
export function contramap<I0, I, O>(schedule: Schedule<I, O>, f: (input: I0) => I): Schedule<I0, O> {
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: schedule.initial,
    step: (state: any, input: I0, context) => schedule.step(state, f(input), context),
  };
}

/** Add jitter to any schedule's delay. */
export function jitteredSchedule<I, O>(
  schedule: Schedule<I, O>,
  options: number | ScheduleJitterOptions = {},
): Schedule<I, O> {
  const factor = typeof options === "number" ? options : options.factor ?? 1;
  const random = typeof options === "number" ? Math.random : options.random ?? Math.random;
  const spread = Math.max(0, factor);

  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: schedule.initial,
    step: (state: any, input: I, context) => {
      const [decision, nextState, output] = schedule.step(state, input, context);
      if (!decision.continue || decision.delayMs <= 0 || spread === 0) {
        return [decision, nextState, output];
      }

      const delay = spread >= 1
        ? Math.floor(random() * decision.delayMs)
        : Math.floor(decision.delayMs * (1 - spread + random() * spread * 2));
      return [{ ...decision, delayMs: Math.max(0, delay) }, nextState, output];
    },
  };
}

export const jitter = jitteredSchedule;

/**
 * Reset a schedule's internal state after a rolling time window.
 * Useful for retry/polling policies that should forgive old bursts.
 */
export function windowed<I, O>(
  schedule: Schedule<I, O>,
  windowMs: number,
  clock?: () => number,
): Schedule<I, O> {
  const window = Math.max(0, windowMs);
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: (context) => ({ inner: schedule.initial(context), windowStartedAt: clockNow(clock, context) }),
    step: (state: any, input: I, context) => {
      const now = clockNow(clock, context);
      const shouldReset = window > 0 && now - state.windowStartedAt > window;
      const inner = shouldReset ? schedule.initial(context) : state.inner;
      const windowStartedAt = shouldReset ? now : state.windowStartedAt;
      const [decision, nextInner, output] = schedule.step(inner, input, context);
      return [decision, { inner: nextInner, windowStartedAt }, output];
    },
  };
}

/** Cap a schedule's delay without changing its state or output. */
export function maxDelay<I, O>(schedule: Schedule<I, O>, maxMs: number): Schedule<I, O> {
  const cap = Math.max(0, maxMs);
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: schedule.initial,
    step: (state: any, input: I, context) => {
      const [decision, nextState, output] = schedule.step(state, input, context);
      return [{ ...decision, delayMs: Math.min(decision.delayMs, cap) }, nextState, output];
    },
  };
}

/** Stop a schedule after a total elapsed runtime-clock budget. */
export function maxElapsed<I, O>(schedule: Schedule<I, O>, maxMs: number): Schedule<I, O> {
  const max = Math.max(0, maxMs);
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: (context) => ({ inner: schedule.initial(context), startedAt: nowFromContext(context) }),
    step: (state: any, input: I, context) => {
      const now = nowFromContext(context);
      const elapsedMs = Math.max(0, now - state.startedAt);
      if (elapsedMs >= max) return [{ continue: false, delayMs: 0 }, state, undefined as any];
      const [decision, nextInner, output] = schedule.step(state.inner, input, context);
      const remaining = Math.max(0, max - elapsedMs);
      return [
        { ...decision, continue: decision.continue && remaining > 0, delayMs: Math.min(decision.delayMs, remaining) },
        { inner: nextInner, startedAt: state.startedAt },
        output,
      ];
    },
  };
}

export const upTo = maxElapsed;

/** Continue while a predicate holds on the wrapped schedule output. */
export function whileOutput<I, O>(schedule: Schedule<I, O>, pred: (output: O) => boolean): Schedule<I, O> {
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: schedule.initial,
    step: (state: any, input: I, context) => {
      const [decision, nextState, output] = schedule.step(state, input, context);
      return [{ ...decision, continue: decision.continue && pred(output) }, nextState, output];
    },
  };
}

/** Continue until a predicate holds on the wrapped schedule output. */
export function untilOutput<I, O>(schedule: Schedule<I, O>, pred: (output: O) => boolean): Schedule<I, O> {
  return whileOutput(schedule, (output) => !pred(output));
}

/** Attach an observability name to a schedule. */
export function named<I, O>(name: string, schedule: Schedule<I, O>): Schedule<I, O> {
  return {
    _tag: "Schedule",
    name,
    initial: schedule.initial,
    step: schedule.step,
  };
}

/** Observe each schedule decision without changing semantics. */
export function tapDecision<I, O>(
  schedule: Schedule<I, O>,
  tap: ScheduleObserver<I, O>,
): Schedule<I, O> {
  return {
    _tag: "Schedule",
    name: schedule.name,
    initial: schedule.initial,
    step: (state: any, input: I, context) => {
      const [decision, nextState, output] = schedule.step(state, input, context);
      const enriched = enrichDecision(decision, context, schedule.name);
      safeObserve(tap, {
        name: enriched.name,
        input,
        output,
        decision: enriched,
        attempt: enriched.attempt ?? context?.attempt ?? 0,
        elapsedMs: enriched.elapsedMs ?? elapsedFromContext(context),
        state,
        nextState,
        timestamp: wallClockNow(),
      });
      return [decision, nextState, output];
    },
  };
}

/** Compose two schedules: use the first, then switch to the second. */
export function andThen<I, O1, O2>(
  first: Schedule<I, O1>,
  second: Schedule<I, O2>
): Schedule<I, O1 | O2> {
  return {
    _tag: "Schedule",
    name: first.name ?? second.name,
    initial: (context) => ({ phase: "first" as const, inner: first.initial(context) }),
    step: (state: any, input: I, context) => {
      if (state.phase === "first") {
        const [decision, nextInner, output] = first.step(state.inner, input, context);
        if (decision.continue) {
          return [decision, { phase: "first", inner: nextInner }, output];
        }
        return [{ continue: true, delayMs: decision.delayMs }, { phase: "second", inner: second.initial(context) }, output];
      }
      const [decision, nextInner, output] = second.step(state.inner, input, context);
      return [decision, { phase: "second", inner: nextInner }, output];
    },
  };
}

/** Run both schedules and continue while BOTH say continue. Use max delay. */
export function intersect<I, O1, O2>(
  left: Schedule<I, O1>,
  right: Schedule<I, O2>
): Schedule<I, [O1, O2]> {
  return {
    _tag: "Schedule",
    name: left.name ?? right.name,
    initial: (context) => ({ left: left.initial(context), right: right.initial(context) }),
    step: (state: any, input: I, context) => {
      const [ld, ls, lo] = left.step(state.left, input, context);
      const [rd, rs, ro] = right.step(state.right, input, context);
      const cont = ld.continue && rd.continue;
      const delay = Math.max(ld.delayMs, rd.delayMs);
      return [{ continue: cont, delayMs: delay }, { left: ls, right: rs }, [lo, ro] as [O1, O2]];
    },
  };
}

/** Run both schedules and continue while EITHER says continue. Use min delay. */
export function union<I, O1, O2>(
  left: Schedule<I, O1>,
  right: Schedule<I, O2>
): Schedule<I, [O1, O2]> {
  return {
    _tag: "Schedule",
    name: left.name ?? right.name,
    initial: (context) => ({ left: left.initial(context), right: right.initial(context) }),
    step: (state: any, input: I, context) => {
      const [ld, ls, lo] = left.step(state.left, input, context);
      const [rd, rs, ro] = right.step(state.right, input, context);
      const cont = ld.continue || rd.continue;
      const delay = Math.min(ld.delayMs, rd.delayMs);
      return [{ continue: cont, delayMs: delay }, { left: ls, right: rs }, [lo, ro] as [O1, O2]];
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function makeScheduleDriver<I, O>(
  schedule: Schedule<I, O>,
  options: ScheduleDriverOptions<I, O> = {},
): ScheduleDriver<I, O> {
  const clock = options.clock ?? liveClock;
  let startedAtMs = options.startedAtMs ?? clock.now();
  let attempt = 0;
  let lastDecision: ScheduleDriverDecision<O> | undefined;
  let state = schedule.initial(makeContext(clock, startedAtMs, attempt, options.name ?? schedule.name));

  return {
    next: (input) => {
      const currentState = state;
      const context = makeContext(clock, startedAtMs, attempt, options.name ?? schedule.name);
      const [decision, nextState, output] = schedule.step(currentState, input, context);
      const enriched = enrichDecision(decision, context, schedule.name);
      state = nextState;
      const result: ScheduleDriverDecision<O> = {
        continue: enriched.continue,
        delayMs: enriched.delayMs,
        output,
        decision: enriched,
        attempt: enriched.attempt ?? attempt,
        elapsedMs: enriched.elapsedMs ?? elapsedFromContext(context),
        state: nextState,
      };
      lastDecision = result;
      const event: ScheduleObserverEvent<I, O> = {
        name: enriched.name,
        input,
        output,
        decision: enriched,
        attempt: result.attempt,
        elapsedMs: result.elapsedMs,
        state: currentState,
        nextState,
        timestamp: wallClockNow(),
      };
      observeDriverDecision(event, options);
      attempt++;
      return result;
    },
    reset: () => {
      startedAtMs = clock.now();
      attempt = 0;
      lastDecision = undefined;
      state = schedule.initial(makeContext(clock, startedAtMs, attempt, options.name ?? schedule.name));
    },
    snapshot: () => ({
      name: options.name ?? schedule.name,
      attempt,
      elapsedMs: Math.max(0, clock.now() - startedAtMs),
      state,
      last: lastDecision,
    }),
    state: () => state,
    last: () => lastDecision,
  };
}

export const scheduleDriver = makeScheduleDriver;

export function runSchedule<I, O>(
  schedule: Schedule<I, O>,
  inputs: Iterable<I>,
  options: ScheduleDriverOptions<I, O> = {},
): ScheduleDriverDecision<O>[] {
  const driver = makeScheduleDriver(schedule, options);
  const decisions: ScheduleDriverDecision<O>[] = [];
  for (const input of inputs) {
    const next = driver.next(input);
    decisions.push(next);
    if (!next.continue) break;
  }
  return decisions;
}

function driverFromRuntime<R, I, O>(
  schedule: Schedule<I, O>,
  options: ScheduleDriverOptions<I, O> = {},
): Async<R, never, ScheduleDriver<I, O>> {
  return Async.sync<R, never, ScheduleDriver<I, O>>((env: R) => makeScheduleDriver(schedule, {
    ...options,
    clock: options.clock ?? runtimeClockFromEnv(env),
  }));
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/**
 * Retry an effect according to a schedule.
 * The schedule receives the error as input on each failure.
 */
export function retryWithSchedule<R, E, A, O>(
  effect: Async<R, E, A>,
  schedule: Schedule<E, O>,
  options: ScheduleDriverOptions<E, O> = {},
): Async<R, E, A> {
  return asyncFlatMap(driverFromRuntime<R, E, O>(schedule, options), (driver) => {
    const loop = (): Async<R, E, A> =>
      asyncFold(
        effect,
        (error: E) => {
          const next = driver.next(error);
          if (!next.continue) return asyncFail(error) as Async<R, E, A>;
          if (next.delayMs <= 0) return loop();
          return asyncFlatMap(sleep(next.delayMs) as any, () => loop());
        },
        (value: A) => asyncSucceed(value) as Async<R, E, A>
      );

    return loop();
  });
}

export const retry = retryWithSchedule;

/**
 * Repeat an effect according to a schedule.
 * The schedule receives the success value as input on each iteration.
 * Returns the last successful value.
 */
export function repeatWithSchedule<R, E, A, O>(
  effect: Async<R, E, A>,
  schedule: Schedule<A, O>,
  options: ScheduleDriverOptions<A, O> = {},
): Async<R, E, A> {
  return asyncFlatMap(driverFromRuntime<R, A, O>(schedule, options), (driver) => {
    const loop = (lastValue: A): Async<R, E, A> => {
      const next = driver.next(lastValue);
      if (!next.continue) return asyncSucceed(lastValue);
      if (next.delayMs <= 0) {
        return asyncFold(
          effect,
          (error: E) => asyncFail(error) as Async<R, E, A>,
          (value: A) => loop(value)
        );
      }
      return asyncFlatMap(sleep(next.delayMs) as any, () =>
        asyncFold(
          effect,
          (error: E) => asyncFail(error) as Async<R, E, A>,
          (value: A) => loop(value)
        )
      );
    };

    return asyncFold(
      effect,
      (error: E) => asyncFail(error) as Async<R, E, A>,
      (value: A) => loop(value)
    );
  });
}

export const repeat = repeatWithSchedule;
export const poll = repeatWithSchedule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor(ms));
}

function normalizeCap(ms: number): number {
  if (ms === Infinity) return Infinity;
  return normalizeDelay(ms);
}

function defaultClock(): number {
  return liveClock.now();
}

function nowFromContext(context: ScheduleStepContext | undefined): number {
  return context?.clock.now() ?? defaultClock();
}

function clockNow(clock: (() => number) | undefined, context: ScheduleStepContext | undefined): number {
  return clock ? clock() : nowFromContext(context);
}

function elapsedFromContext(context: ScheduleStepContext | undefined): number {
  if (!context) return 0;
  return Math.max(0, context.clock.now() - context.startedAtMs);
}

function makeContext(
  clock: RuntimeClock,
  startedAtMs: number,
  attempt: number,
  name: string | undefined,
): ScheduleStepContext {
  return { clock, startedAtMs, attempt, name };
}

function enrichDecision(
  decision: ScheduleDecision,
  context: ScheduleStepContext | undefined,
  fallbackName: string | undefined,
): ScheduleDecision {
  const delayMs = normalizeDelay(decision.delayMs);
  return {
    ...decision,
    continue: decision.continue,
    delayMs,
    attempt: decision.attempt ?? context?.attempt,
    elapsedMs: decision.elapsedMs ?? elapsedFromContext(context),
    name: decision.name ?? context?.name ?? fallbackName,
  };
}

function wallClockNow(): number {
  return Date.now();
}

function safeObserve<I, O>(observer: ScheduleObserver<I, O>, event: ScheduleObserverEvent<I, O>): void {
  try {
    observer(event);
  } catch {
    // Schedule observers are diagnostic hooks and must not change semantics.
  }
}

function observeDriverDecision<I, O>(
  event: ScheduleObserverEvent<I, O>,
  options: ScheduleDriverOptions<I, O>,
): void {
  if (options.onDecision) safeObserve(options.onDecision, event);
  if (!options.hooks) return;
  try {
    options.hooks.emit({
      type: "schedule.decision",
      name: event.name,
      attempt: event.attempt,
      elapsedMs: event.elapsedMs,
      delayMs: event.decision.delayMs,
      continue: event.decision.continue,
      reason: event.decision.reason,
      ...(options.captureInput ? { input: event.input } : {}),
      ...(options.captureOutput ? { output: event.output } : {}),
    }, options.emitContext ?? {});
  } catch {
    // Runtime hooks are sinks; sink failures must not affect effect semantics.
  }
}

export const Schedule = Object.freeze({
  driver: makeScheduleDriver,
  run: runSchedule,
  recurs,
  forever,
  never,
  once,
  fixed,
  spaced,
  linear,
  exponential,
  fibonacci,
  jittered,
  jitteredSchedule,
  jitter,
  elapsed,
  whileInput,
  untilInput,
  whileOutput,
  untilOutput,
  take,
  map,
  contramap,
  maxDelay,
  maxElapsed,
  upTo,
  windowed,
  named,
  tapDecision,
  andThen,
  intersect,
  union,
  retry: retryWithSchedule,
  repeat: repeatWithSchedule,
  poll: repeatWithSchedule,
});
