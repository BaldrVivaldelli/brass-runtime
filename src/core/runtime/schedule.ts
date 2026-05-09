// src/core/runtime/schedule.ts
// Schedule — composable policies for retry and repetition.
//
// A Schedule describes when and how many times to repeat or retry an effect.
// Schedules are values that can be composed, mapped, and combined.

import { Async, asyncFlatMap, asyncSucceed, asyncFail } from "../types/asyncEffect";
import { asyncFold } from "../types/asyncEffect";
import { sleep } from "./combinators";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleDecision = {
  readonly continue: boolean;
  readonly delayMs: number;
};

export type ScheduleJitterOptions = {
  /** 1 means full jitter in [0, delay], 0.2 means +/-20% around delay. */
  readonly factor?: number;
  /** Deterministic hook for tests. Defaults to Math.random. */
  readonly random?: () => number;
};

/**
 * A Schedule<I, O> takes an input I (typically the error or output of an effect)
 * and decides whether to continue and with what delay.
 */
export type Schedule<I, O> = {
  readonly _tag: "Schedule";
  /** Initial state */
  readonly initial: () => any;
  /** Given current state and input, produce a decision and next state */
  readonly step: (state: any, input: I) => [ScheduleDecision, any, O];
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

/** Fixed delay between each retry/repeat. */
export function fixed(delayMs: number): Schedule<unknown, number> {
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number, _input: unknown) => {
      return [{ continue: true, delayMs }, count + 1, count + 1];
    },
  };
}

/** Exponential backoff: delay doubles each time, capped at maxDelayMs. */
export function exponential(baseMs: number, maxMs: number = Infinity): Schedule<unknown, number> {
  return {
    _tag: "Schedule",
    initial: () => 0,
    step: (count: number, _input: unknown) => {
      const delay = Math.min(baseMs * Math.pow(2, count), maxMs);
      return [{ continue: true, delayMs: delay }, count + 1, count + 1];
    },
  };
}

/** Fibonacci backoff: base, base, 2*base, 3*base, 5*base, capped at maxDelayMs. */
export function fibonacci(baseMs: number, maxMs: number = Infinity): Schedule<unknown, number> {
  const base = Math.max(0, baseMs);
  const cap = Math.max(0, maxMs);
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
  return {
    _tag: "Schedule",
    initial: () => performance.now(),
    step: (startedAt: number, _input: unknown) => {
      const el = performance.now() - startedAt;
      return [{ continue: el < maxMs, delayMs: 0 }, startedAt, el];
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

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Limit a schedule to N repetitions. */
export function take<I, O>(schedule: Schedule<I, O>, n: number): Schedule<I, O> {
  return {
    _tag: "Schedule",
    initial: () => ({ inner: schedule.initial(), count: 0 }),
    step: (state: any, input: I) => {
      if (state.count >= n) return [{ continue: false, delayMs: 0 }, state, undefined as any];
      const [decision, nextInner, output] = schedule.step(state.inner, input);
      const nextState = { inner: nextInner, count: state.count + 1 };
      return [{ continue: decision.continue && state.count + 1 < n, delayMs: decision.delayMs }, nextState, output];
    },
  };
}

/** Transform schedule output while preserving decisions and state. */
export function map<I, O, O2>(schedule: Schedule<I, O>, f: (output: O) => O2): Schedule<I, O2> {
  return {
    _tag: "Schedule",
    initial: schedule.initial,
    step: (state: any, input: I) => {
      const [decision, nextState, output] = schedule.step(state, input);
      return [decision, nextState, f(output)];
    },
  };
}

/** Transform schedule input before it reaches the wrapped schedule. */
export function contramap<I0, I, O>(schedule: Schedule<I, O>, f: (input: I0) => I): Schedule<I0, O> {
  return {
    _tag: "Schedule",
    initial: schedule.initial,
    step: (state: any, input: I0) => schedule.step(state, f(input)),
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
    initial: schedule.initial,
    step: (state: any, input: I) => {
      const [decision, nextState, output] = schedule.step(state, input);
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
  clock: () => number = defaultClock,
): Schedule<I, O> {
  const window = Math.max(0, windowMs);
  return {
    _tag: "Schedule",
    initial: () => ({ inner: schedule.initial(), windowStartedAt: clock() }),
    step: (state: any, input: I) => {
      const now = clock();
      const shouldReset = window > 0 && now - state.windowStartedAt > window;
      const inner = shouldReset ? schedule.initial() : state.inner;
      const windowStartedAt = shouldReset ? now : state.windowStartedAt;
      const [decision, nextInner, output] = schedule.step(inner, input);
      return [decision, { inner: nextInner, windowStartedAt }, output];
    },
  };
}

function defaultClock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Compose two schedules: use the first, then switch to the second. */
export function andThen<I, O1, O2>(
  first: Schedule<I, O1>,
  second: Schedule<I, O2>
): Schedule<I, O1 | O2> {
  return {
    _tag: "Schedule",
    initial: () => ({ phase: "first" as const, inner: first.initial() }),
    step: (state: any, input: I) => {
      if (state.phase === "first") {
        const [decision, nextInner, output] = first.step(state.inner, input);
        if (decision.continue) {
          return [decision, { phase: "first", inner: nextInner }, output];
        }
        // Switch to second schedule
        return [{ continue: true, delayMs: decision.delayMs }, { phase: "second", inner: second.initial() }, output];
      }
      const [decision, nextInner, output] = second.step(state.inner, input);
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
    initial: () => ({ left: left.initial(), right: right.initial() }),
    step: (state: any, input: I) => {
      const [ld, ls, lo] = left.step(state.left, input);
      const [rd, rs, ro] = right.step(state.right, input);
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
    initial: () => ({ left: left.initial(), right: right.initial() }),
    step: (state: any, input: I) => {
      const [ld, ls, lo] = left.step(state.left, input);
      const [rd, rs, ro] = right.step(state.right, input);
      const cont = ld.continue || rd.continue;
      const delay = Math.min(ld.delayMs, rd.delayMs);
      return [{ continue: cont, delayMs: delay }, { left: ls, right: rs }, [lo, ro] as [O1, O2]];
    },
  };
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
  schedule: Schedule<E, O>
): Async<R, E, A> {
  const loop = (state: any): Async<R, E, A> =>
    asyncFold(
      effect,
      (error: E) => {
        const [decision, nextState, _output] = schedule.step(state, error);
        if (!decision.continue) return asyncFail(error) as Async<R, E, A>;
        if (decision.delayMs <= 0) return loop(nextState);
        return asyncFlatMap(sleep(decision.delayMs) as any, () => loop(nextState));
      },
      (value: A) => asyncSucceed(value) as Async<R, E, A>
    );

  return loop(schedule.initial());
}

/**
 * Repeat an effect according to a schedule.
 * The schedule receives the success value as input on each iteration.
 * Returns the last successful value.
 */
export function repeatWithSchedule<R, E, A, O>(
  effect: Async<R, E, A>,
  schedule: Schedule<A, O>
): Async<R, E, A> {
  const loop = (state: any, lastValue: A): Async<R, E, A> => {
    const [decision, nextState, _output] = schedule.step(state, lastValue);
    if (!decision.continue) return asyncSucceed(lastValue);
    if (decision.delayMs <= 0) {
      return asyncFold(
        effect,
        (error: E) => asyncFail(error) as Async<R, E, A>,
        (value: A) => loop(nextState, value)
      );
    }
    return asyncFlatMap(sleep(decision.delayMs) as any, () =>
      asyncFold(
        effect,
        (error: E) => asyncFail(error) as Async<R, E, A>,
        (value: A) => loop(nextState, value)
      )
    );
  };

  return asyncFold(
    effect,
    (error: E) => asyncFail(error) as Async<R, E, A>,
    (value: A) => loop(schedule.initial(), value)
  );
}
