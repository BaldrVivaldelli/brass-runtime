import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";
import { Cause, Exit } from "../../types/effect";
import {
  Runtime,
  fromPromiseAbortable,
  resetAbortablePromiseStats,
  type AbortablePromiseOptions,
} from "../runtime";

/**
 * Property-based tests for Promise adapter Exit equivalence.
 * Feature: http-p99-optimization
 *
 * **Validates: Requirement 3.7**
 *
 * Property P6: Promise adapter Exit equivalence
 *
 * For any combination of (timeout/no-timeout, success/failure/interrupt),
 * the optimized paths (no-timeout path, hook-eliminated path) produce the
 * same Exit values as the full path (with hooks, with timeout).
 */

// --- Helpers ---

/** Run an effect and collect its Exit value. */
function collectExit<E, A>(
  effect: ReturnType<typeof fromPromiseAbortable<E, A, Record<string, never>>>,
  options?: { interrupt?: boolean },
): Promise<Exit<E, A>> {
  return new Promise<Exit<E, A>>((resolve) => {
    const rt = Runtime.make({});
    const fiber = rt.fork(effect);
    if (options?.interrupt) {
      // Interrupt on next microtask to allow the effect to register
      Promise.resolve().then(() => fiber.interrupt());
    }
    fiber.join(resolve);
  });
}

/** Create a mock timer wheel that uses setTimeout internally (for testing equivalence). */
function makeMockTimerWheel() {
  return {
    schedule(timeoutMs: number, cb: () => void) {
      const handle = setTimeout(() => {
        cb();
      }, timeoutMs);
      return {
        cancel() {
          clearTimeout(handle);
        },
      };
    },
  };
}

/**
 * Compare two Exit values structurally, ignoring label-specific content in
 * timeout messages (since different labels produce different messages).
 */
function assertExitEquivalent(
  actual: Exit<unknown, unknown>,
  expected: Exit<unknown, unknown>,
): void {
  expect(actual._tag).toBe(expected._tag);

  if (expected._tag === "Success" && actual._tag === "Success") {
    expect(actual.value).toEqual(expected.value);
  } else if (expected._tag === "Failure" && actual._tag === "Failure") {
    expect(actual.cause._tag).toBe(expected.cause._tag);
    if (expected.cause._tag === "Fail" && actual.cause._tag === "Fail") {
      const expectedErr = expected.cause.error;
      const actualErr = actual.cause.error;
      // For timeout errors, compare structurally but ignore label-dependent message
      if (isTimeoutError(expectedErr) && isTimeoutError(actualErr)) {
        expect(actualErr._tag).toBe(expectedErr._tag);
        expect(actualErr.timeoutMs).toBe(expectedErr.timeoutMs);
      } else {
        expect(actualErr).toEqual(expectedErr);
      }
    }
  }
}

function isTimeoutError(err: unknown): err is { _tag: string; timeoutMs: number; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "_tag" in err &&
    (err as any)._tag === "Timeout"
  );
}

// --- Arbitraries ---

type PromiseOutcome = "success" | "failure" | "hang";

const outcomeArb: fc.Arbitrary<PromiseOutcome> = fc.constantFrom(
  "success",
  "failure",
  "hang",
);

const valueArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 20 }),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
);

const errorArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.integer(),
  fc.record({ message: fc.string(), code: fc.integer() }),
);

const timeoutMsArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(0),
  fc.integer({ min: 5, max: 200 }),
);

/** Whether to include hooks (onStart/onFinish) in options. */
const hooksArb = fc.boolean();

/** Whether to use a timer wheel for timeout scheduling. */
const timerWheelArb = fc.boolean();

type TestScenario = {
  outcome: PromiseOutcome;
  value: unknown;
  error: unknown;
  timeoutMs: number | undefined;
  withHooks: boolean;
  useTimerWheel: boolean;
};

/**
 * Scenario for the main equivalence test.
 * We exclude "hang" + no-timeout + no-interrupt because that would never complete.
 */
const scenarioArb: fc.Arbitrary<TestScenario> = fc
  .record({
    outcome: outcomeArb,
    value: valueArb,
    error: errorArb,
    timeoutMs: timeoutMsArb,
    withHooks: hooksArb,
    useTimerWheel: timerWheelArb,
  })
  .filter((s) => {
    // Exclude hang scenarios without timeout — they'd never complete
    const effectiveTimeout = s.timeoutMs !== undefined && s.timeoutMs > 0 ? s.timeoutMs : undefined;
    if (s.outcome === "hang" && effectiveTimeout === undefined) return false;
    return true;
  });

// --- Tests ---

describe("Property P6: Promise adapter Exit equivalence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAbortablePromiseStats();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAbortablePromiseStats();
  });

  /**
   * Core property: For any scenario, running fromPromiseAbortable with the
   * optimized path (no hooks) and the full path (with hooks) produces
   * structurally identical Exit values.
   *
   * **Validates: Requirement 3.7**
   */
  it("optimized path (no hooks) produces same Exit as full path (with hooks) for all input combinations", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { outcome, value, error, timeoutMs, withHooks, useTimerWheel } = scenario;

        // Effective timeout: only positive values enable timeout
        const effectiveTimeout =
          timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined;

        // Use a shared label so timeout messages are identical
        const sharedLabel = "test-equiv";

        // Build the promise factory based on outcome
        const makePromise = (_signal: AbortSignal): Promise<unknown> => {
          switch (outcome) {
            case "success":
              return Promise.resolve(value);
            case "failure":
              return Promise.reject(error);
            case "hang":
              return new Promise<unknown>(() => {});
          }
        };

        const onReject = (u: unknown) => u;
        const wheel = makeMockTimerWheel();

        // --- Run with hooks (full path) ---
        const optsFull: AbortablePromiseOptions = {
          label: sharedLabel,
          timeoutMs: effectiveTimeout,
          onStart: () => {},
          onFinish: () => {},
          ...(useTimerWheel && effectiveTimeout ? { timerWheel: wheel } : {}),
        };
        const effectFull = fromPromiseAbortable(makePromise, onReject, optsFull);

        // --- Run without hooks (optimized path) ---
        const optsOptimized: AbortablePromiseOptions = {
          label: sharedLabel,
          timeoutMs: effectiveTimeout,
          ...(useTimerWheel && effectiveTimeout ? { timerWheel: wheel } : {}),
        };
        const effectOptimized = fromPromiseAbortable(
          makePromise,
          onReject,
          optsOptimized,
        );

        // Collect exits (no interrupt — we test interrupt separately)
        const exitFullPromise = collectExit(effectFull);
        const exitOptimizedPromise = collectExit(effectOptimized);

        // Advance timers to fire timeouts if configured
        if (effectiveTimeout !== undefined) {
          await vi.advanceTimersByTimeAsync(effectiveTimeout + 50);
        }

        // Allow microtasks to settle
        await vi.advanceTimersByTimeAsync(1);

        const exitFull = await exitFullPromise;
        const exitOptimized = await exitOptimizedPromise;

        // Compare Exit structures
        assertExitEquivalent(exitOptimized, exitFull);
      }),
      { numRuns: 150 },
    );
  }, 30000);

  /**
   * Timer wheel path produces same Exit as setTimeout path for timeout scenarios.
   *
   * **Validates: Requirement 3.7**
   */
  it("timer wheel path produces same Exit as setTimeout path for timeout scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          outcome: outcomeArb,
          value: valueArb,
          error: errorArb,
          timeoutMs: fc.integer({ min: 5, max: 200 }),
        }),
        async ({ outcome, value, error, timeoutMs }) => {
          // Use same label so timeout messages match
          const sharedLabel = "test-timer-equiv";

          const makePromise = (_signal: AbortSignal): Promise<unknown> => {
            switch (outcome) {
              case "success":
                return Promise.resolve(value);
              case "failure":
                return Promise.reject(error);
              case "hang":
                return new Promise<unknown>(() => {});
            }
          };

          const onReject = (u: unknown) => u;
          const wheel = makeMockTimerWheel();

          // --- Run with setTimeout (default) ---
          const optsSetTimeout: AbortablePromiseOptions = {
            label: sharedLabel,
            timeoutMs,
          };
          const effectSetTimeout = fromPromiseAbortable(
            makePromise,
            onReject,
            optsSetTimeout,
          );

          // --- Run with timer wheel ---
          const optsWheel: AbortablePromiseOptions = {
            label: sharedLabel,
            timeoutMs,
            timerWheel: wheel,
          };
          const effectWheel = fromPromiseAbortable(
            makePromise,
            onReject,
            optsWheel,
          );

          const exitSetTimeoutPromise = collectExit(effectSetTimeout);
          const exitWheelPromise = collectExit(effectWheel);

          // Advance timers
          await vi.advanceTimersByTimeAsync(timeoutMs + 50);
          await vi.advanceTimersByTimeAsync(1);

          const exitSetTimeout = await exitSetTimeoutPromise;
          const exitWheel = await exitWheelPromise;

          // Both should produce the same Exit structure
          assertExitEquivalent(exitWheel, exitSetTimeout);
        },
      ),
      { numRuns: 150 },
    );
  }, 30000);

  /**
   * No-timeout path produces same Exit as timeout path (with large timeout that won't fire)
   * for success and failure scenarios.
   *
   * **Validates: Requirement 3.7**
   */
  it("no-timeout path produces same Exit as timeout path for success/failure (timeout never fires)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          outcome: fc.constantFrom("success" as const, "failure" as const),
          value: valueArb,
          error: errorArb,
        }),
        async ({ outcome, value, error }) => {
          const makePromise = (_signal: AbortSignal): Promise<unknown> => {
            switch (outcome) {
              case "success":
                return Promise.resolve(value);
              case "failure":
                return Promise.reject(error);
            }
          };

          const onReject = (u: unknown) => u;

          // --- No timeout path ---
          const optsNoTimeout: AbortablePromiseOptions = {
            label: "test-no-timeout",
          };
          const effectNoTimeout = fromPromiseAbortable(
            makePromise,
            onReject,
            optsNoTimeout,
          );

          // --- Timeout path with large timeout that won't fire ---
          const optsWithTimeout: AbortablePromiseOptions = {
            label: "test-no-timeout",
            timeoutMs: 999999,
          };
          const effectWithTimeout = fromPromiseAbortable(
            makePromise,
            onReject,
            optsWithTimeout,
          );

          const exitNoTimeoutPromise = collectExit(effectNoTimeout);
          const exitWithTimeoutPromise = collectExit(effectWithTimeout);

          // Allow microtasks to settle (don't advance far enough for timeout)
          await vi.advanceTimersByTimeAsync(10);

          const exitNoTimeout = await exitNoTimeoutPromise;
          const exitWithTimeout = await exitWithTimeoutPromise;

          // Both should produce the same Exit
          assertExitEquivalent(exitNoTimeout, exitWithTimeout);
        },
      ),
      { numRuns: 150 },
    );
  });

  /**
   * Interrupt produces Exit.failCause(Cause.interrupt()) regardless of path configuration.
   *
   * **Validates: Requirement 3.7**
   */
  it("interrupt produces Interrupt exit regardless of timeout/hooks configuration", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          withHooks: hooksArb,
          useTimerWheel: timerWheelArb,
        }),
        async ({ withHooks, useTimerWheel }) => {
          // Use a hanging promise so interrupt is the only way to complete
          const makePromise = (_signal: AbortSignal): Promise<unknown> =>
            new Promise<unknown>(() => {});

          const onReject = (u: unknown) => u;
          const wheel = makeMockTimerWheel();

          // No timeout — interrupt is the only completion path
          const opts: AbortablePromiseOptions = {
            label: "test-interrupt",
            ...(withHooks
              ? { onStart: () => {}, onFinish: () => {} }
              : {}),
          };

          const effect = fromPromiseAbortable(makePromise, onReject, opts);

          const exit = await new Promise<Exit<unknown, unknown>>((resolve) => {
            const rt = Runtime.make({});
            const fiber = rt.fork(effect);
            // Interrupt on next microtask
            Promise.resolve().then(() => fiber.interrupt());
            fiber.join(resolve);
          });

          // Should always be an Interrupt exit
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(exit.cause._tag).toBe("Interrupt");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
