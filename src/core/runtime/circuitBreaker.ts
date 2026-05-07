// src/core/runtime/circuitBreaker.ts
// Circuit breaker pattern for protecting against cascading failures.
//
// States:
//   CLOSED  → normal operation, requests pass through
//   OPEN    → failures exceeded threshold, requests fail fast
//   HALF_OPEN → testing if service recovered (one probe request allowed)

import { async, Async, asyncFail, asyncFold, asyncSucceed } from "../types/asyncEffect";
import { Exit } from "../types/effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitBreakerState = "closed" | "open" | "half-open";

export type CircuitBreakerError = {
  readonly _tag: "CircuitBreakerOpen";
  readonly openSince: number;
  readonly failures: number;
};

export type CircuitBreakerConfig = {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  readonly failureThreshold?: number;
  /** Time in ms to wait before transitioning from OPEN to HALF_OPEN. Default: 30000 */
  readonly resetTimeoutMs?: number;
  /** Number of successes in HALF_OPEN needed to close the circuit. Default: 1 */
  readonly successThreshold?: number;
  /** Custom predicate: should this error count as a failure? Default: all errors count. */
  readonly isFailure?: (error: unknown) => boolean;
  /** Called on state transitions (for observability). */
  readonly onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
};

export type CircuitBreakerStats = {
  readonly state: CircuitBreakerState;
  readonly failures: number;
  readonly successes: number;
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly totalSuccesses: number;
  readonly totalRejected: number;
  readonly lastFailureTime: number | null;
  readonly lastSuccessTime: number | null;
};

export type CircuitBreaker = {
  /** Current state of the circuit breaker. */
  readonly state: () => CircuitBreakerState;
  /** Run an effect through the circuit breaker. */
  readonly protect: <R, E, A>(effect: Async<R, E, A>) => Async<R, E | CircuitBreakerError, A>;
  /** Get current stats. */
  readonly stats: () => CircuitBreakerStats;
  /** Manually reset to closed state. */
  readonly reset: () => void;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a circuit breaker.
 *
 * ```ts
 * const breaker = makeCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000 });
 *
 * // Protect an effect:
 * const result = await run(breaker.protect(callExternalService()));
 * // Throws CircuitBreakerOpen if circuit is open
 * ```
 */
export function makeCircuitBreaker(config: CircuitBreakerConfig = {}): CircuitBreaker {
  const failureThreshold = config.failureThreshold ?? 5;
  const resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
  const successThreshold = config.successThreshold ?? 1;
  const isFailure = config.isFailure ?? (() => true);
  const onStateChange = config.onStateChange;

  let currentState: CircuitBreakerState = "closed";
  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;
  let openedAt = 0;

  // Stats
  let totalRequests = 0;
  let totalFailures = 0;
  let totalSuccesses = 0;
  let totalRejected = 0;
  let lastFailureTime: number | null = null;
  let lastSuccessTime: number | null = null;

  const transition = (to: CircuitBreakerState): void => {
    if (currentState === to) return;
    const from = currentState;
    currentState = to;
    onStateChange?.(from, to);
  };

  const onSuccess = (): void => {
    totalSuccesses++;
    lastSuccessTime = Date.now();
    consecutiveFailures = 0;

    if (currentState === "half-open") {
      consecutiveSuccesses++;
      if (consecutiveSuccesses >= successThreshold) {
        consecutiveSuccesses = 0;
        transition("closed");
      }
    }
  };

  const onFailure = (error: unknown): void => {
    if (!isFailure(error)) {
      // This error doesn't count as a circuit breaker failure
      onSuccess(); // treat as success for circuit purposes
      return;
    }

    totalFailures++;
    lastFailureTime = Date.now();
    consecutiveSuccesses = 0;
    consecutiveFailures++;

    if (currentState === "half-open") {
      // Any failure in half-open → back to open
      openedAt = Date.now();
      transition("open");
    } else if (currentState === "closed" && consecutiveFailures >= failureThreshold) {
      openedAt = Date.now();
      transition("open");
    }
  };

  const shouldAllow = (): boolean => {
    switch (currentState) {
      case "closed":
        return true;
      case "open": {
        const elapsed = Date.now() - openedAt;
        if (elapsed >= resetTimeoutMs) {
          transition("half-open");
          return true; // allow one probe
        }
        return false;
      }
      case "half-open":
        return true; // allow probes
    }
  };

  const protect = <R, E, A>(effect: Async<R, E, A>): Async<R, E | CircuitBreakerError, A> => {
    totalRequests++;

    if (!shouldAllow()) {
      totalRejected++;
      return asyncFail({
        _tag: "CircuitBreakerOpen",
        openSince: openedAt,
        failures: consecutiveFailures,
      } as E | CircuitBreakerError);
    }

    return asyncFold(
      effect,
      (error: E) => {
        onFailure(error);
        return asyncFail(error) as Async<R, E | CircuitBreakerError, A>;
      },
      (value: A) => {
        onSuccess();
        return asyncSucceed(value) as Async<R, E | CircuitBreakerError, A>;
      }
    );
  };

  const stats = (): CircuitBreakerStats => ({
    state: currentState,
    failures: consecutiveFailures,
    successes: consecutiveSuccesses,
    totalRequests,
    totalFailures,
    totalSuccesses,
    totalRejected,
    lastFailureTime,
    lastSuccessTime,
  });

  const reset = (): void => {
    consecutiveFailures = 0;
    consecutiveSuccesses = 0;
    transition("closed");
  };

  return {
    state: () => currentState,
    protect,
    stats,
    reset,
  };
}
