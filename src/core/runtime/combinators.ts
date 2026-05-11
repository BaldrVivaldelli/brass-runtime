// src/core/runtime/combinators.ts
// Generic effect combinators: timeout, retry, sleep, race (scope-free).
//
// These provide production-ready patterns without requiring explicit Scope management.

import { async, Async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../types/asyncEffect";
import { Cause, Exit } from "../types/effect";
import { Canceler } from "../types/cancel";
import { unsafeGetCurrentRuntime } from "./fiber";
import { runtimeClockFromEnv, type RuntimeClock } from "./clock";

// ---------------------------------------------------------------------------
// sleep — generic delay (cancellable)
// ---------------------------------------------------------------------------

export type TimeoutError = { readonly _tag: "TimeoutError"; readonly ms: number };

/**
 * Suspends the fiber for `ms` milliseconds. Cancellable via fiber interruption.
 */
export function sleep(ms: number): Async<unknown, never, void> {
  return async((env, cb) => {
    const clock = runtimeClockFromEnv(env);
    const id = clock.setTimeout(() => cb({ _tag: "Success", value: undefined }), ms);
    return () => clock.clearTimeout(id);
  });
}

// ---------------------------------------------------------------------------
// timeout — race an effect against a timer
// ---------------------------------------------------------------------------

/**
 * Runs `effect` with a timeout of `ms` milliseconds.
 * - If the effect completes before the timeout, returns its result.
 * - If the timeout fires first, the effect is cancelled and a TimeoutError is returned.
 *
 * Works with ANY effect type (Async, FlatMap, Fold, etc.) by forking
 * the effect into a child fiber and interrupting it on timeout.
 */
export function timeout<R, E, A>(
  effect: Async<R, E, A>,
  ms: number
): Async<R, E | TimeoutError, A> {
  // Race the effect against a sleep timer using asyncFold
  // The effect runs first; if it completes, we return its result.
  // If it doesn't complete within ms, we fail with TimeoutError.
  return async((env, cb) => {
    const clock = runtimeClockFromEnv(env);
    let done = false;
    let timerId: unknown;
    let fiber: ReturnType<ReturnType<typeof unsafeGetCurrentRuntime>["fork"]> | undefined;

    // Start the timeout timer
    timerId = clock.setTimeout(() => {
      if (done) return;
      done = true;
      fiber?.interrupt();
      cb({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "TimeoutError", ms } as E | TimeoutError },
      });
    }, ms);

    // Fork the effect — we need to use the runtime to execute it
    // Since we're inside an Async register, we have access to env.
    const runtime = unsafeGetCurrentRuntime();

    fiber = runtime.fork(effect as any);
    fiber.join((exit: any) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timerId);
      cb(exit);
    });

    // Return canceler that interrupts the fiber and clears the timer
    return () => {
      if (done) return;
      done = true;
      clock.clearTimeout(timerId);
      fiber.interrupt();
    };
  });
}

// ---------------------------------------------------------------------------
// retry — generic retry with configurable policy
// ---------------------------------------------------------------------------

export type RetryPolicy = {
  /** Maximum number of retry attempts (0 = no retries, just the initial attempt) */
  readonly maxRetries: number;
  /** Base delay in ms for exponential backoff */
  readonly baseDelayMs: number;
  /** Maximum delay cap in ms */
  readonly maxDelayMs: number;
  /** Total time budget in ms (optional). Retries stop if elapsed time exceeds this. */
  readonly maxElapsedMs?: number;
  /** Custom predicate: should this error trigger a retry? Default: always retry. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Jitter strategy. Default: "full" (random 0..delay). "none" = no jitter. */
  readonly jitter?: "full" | "none";
};

export type RetryState = {
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly lastError: unknown;
};

/**
 * Retries an effect according to the given policy.
 * Uses exponential backoff with full jitter by default.
 *
 * ```ts
 * const result = retry(
 *   fetchData(),
 *   { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000 }
 * );
 * ```
 */
export function retry<R, E, A>(
  effect: Async<R, E, A>,
  policy: RetryPolicy
): Async<R, E, A> {
  const shouldRetry = policy.shouldRetry ?? (() => true);
  const jitter = policy.jitter ?? "full";
  const maxElapsedMs = policy.maxElapsedMs;

  const computeDelay = (attempt: number): number => {
    const exp = policy.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exp, policy.maxDelayMs);
    if (jitter === "none") return capped;
    // Full jitter: random in [0, capped]
    return Math.floor(Math.random() * capped);
  };

  const loop = (attempt: number, startedAt: number, clock: RuntimeClock): Async<R, E, A> =>
    asyncFold(
      effect,
      (error: E) => {
        // Check if we should retry
        if (attempt >= policy.maxRetries) return asyncFail(error);
        if (!shouldRetry(error, attempt)) return asyncFail(error);

        // Check time budget
        if (maxElapsedMs !== undefined) {
          const elapsed = clock.now() - startedAt;
          if (elapsed >= maxElapsedMs) return asyncFail(error);
        }

        // Compute delay and retry
        const delay = computeDelay(attempt);
        return asyncFlatMap(sleep(delay), () => loop(attempt + 1, startedAt, clock));
      },
      (value: A) => asyncSucceed(value)
    );

  return asyncFlatMap(
    { _tag: "Sync", thunk: (env: R) => {
      const clock = runtimeClockFromEnv(env);
      return { clock, startedAt: clock.now() };
    } } as Async<R, E, { clock: RuntimeClock; startedAt: number }>,
    ({ clock, startedAt }) => loop(0, startedAt, clock)
  ) as Async<R, E, A>;
}

/**
 * Retry with a simple count (no backoff, immediate retry).
 * Useful for flaky operations that just need a few attempts.
 */
export function retryN<R, E, A>(
  effect: Async<R, E, A>,
  n: number
): Async<R, E, A> {
  return retry(effect, {
    maxRetries: n,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: "none",
  });
}

/**
 * Retry with exponential backoff and full jitter.
 * Convenience wrapper with sensible defaults.
 */
export function retryWithBackoff<R, E, A>(
  effect: Async<R, E, A>,
  opts: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxElapsedMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  } = {}
): Async<R, E, A> {
  return retry(effect, {
    maxRetries: opts.maxRetries ?? 3,
    baseDelayMs: opts.baseDelayMs ?? 100,
    maxDelayMs: opts.maxDelayMs ?? 10_000,
    maxElapsedMs: opts.maxElapsedMs,
    shouldRetry: opts.shouldRetry,
    jitter: "full",
  });
}
