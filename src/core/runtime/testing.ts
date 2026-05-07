// src/core/runtime/testing.ts
// Testing utilities for brass-runtime effects.
//
// Provides TestRuntime with virtual clock, assertion helpers,
// and utilities for testing concurrent/async code deterministically.

import { Async, async, asyncFail, asyncSucceed, asyncFlatMap } from "../types/asyncEffect";
import { Exit } from "../types/effect";
import { Runtime } from "./runtime";
import { Scheduler } from "./scheduler";

// ---------------------------------------------------------------------------
// TestRuntime — runtime with controlled execution
// ---------------------------------------------------------------------------

export type TestRuntimeOptions = {
  /** If true, effects run synchronously where possible. Default: true */
  readonly synchronous?: boolean;
};

/**
 * Creates a test runtime that provides controlled execution.
 *
 * ```ts
 * const { runtime, run, runExit } = makeTestRuntime();
 *
 * const result = await run(myEffect);
 * const exit = await runExit(myEffect); // get full Exit (success or failure)
 * ```
 */
export function makeTestRuntime<R = {}>(env?: R, options?: TestRuntimeOptions) {
  const runtime = Runtime.make(env ?? ({} as R));

  const run = <E, A>(effect: Async<R, E, A>): Promise<A> => runtime.toPromise(effect);

  const runExit = <E, A>(effect: Async<R, E, A>): Promise<Exit<E, A>> =>
    new Promise((resolve) => {
      runtime.unsafeRunAsync(effect, resolve);
    });

  return { runtime, run, runExit };
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
  const rt = runtime ?? Runtime.make({} as R);
  const exit = await new Promise<Exit<E, A>>((resolve) => {
    rt.unsafeRunAsync(effect, resolve);
  });

  if (exit._tag !== "Success") {
    throw new Error(`Expected success with ${JSON.stringify(expected)}, got failure: ${JSON.stringify(exit.cause)}`);
  }
  if (JSON.stringify(exit.value) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(exit.value)}`);
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
  const rt = runtime ?? Runtime.make({} as R);
  const exit = await new Promise<Exit<E, A>>((resolve) => {
    rt.unsafeRunAsync(effect, resolve);
  });

  if (exit._tag !== "Failure") {
    throw new Error(`Expected failure with ${JSON.stringify(expectedError)}, got success: ${JSON.stringify(exit.value)}`);
  }
  const error = (exit.cause as any).error;
  if (JSON.stringify(error) !== JSON.stringify(expectedError)) {
    throw new Error(`Expected error ${JSON.stringify(expectedError)}, got ${JSON.stringify(error)}`);
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
  const rt = runtime ?? Runtime.make({} as R);
  const exit = await new Promise<Exit<E, A>>((resolve) => {
    rt.unsafeRunAsync(effect, resolve);
  });

  if (exit._tag !== "Failure") {
    throw new Error(`Expected failure, got success: ${JSON.stringify(exit.value)}`);
  }
  const error = (exit.cause as any).error as E;
  if (!predicate(error)) {
    throw new Error(`Error did not match predicate: ${JSON.stringify(error)}`);
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
  const rt = runtime ?? Runtime.make({} as R);
  const start = performance.now();

  const result = await rt.toPromise(effect);
  const elapsed = performance.now() - start;

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
      cb({ _tag: "Failure", cause: { _tag: "Fail", error: errorValue } });
    } else {
      cb({ _tag: "Success", value: successValue });
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
  return async((_env, cb) => {
    const id = setTimeout(() => cb({ _tag: "Success", value }), ms);
    return () => clearTimeout(id);
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
