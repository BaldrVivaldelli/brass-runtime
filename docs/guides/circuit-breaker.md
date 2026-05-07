# Circuit Breaker

Protect against cascading failures when downstream services are unhealthy.

## How it works

```
CLOSED → (failures exceed threshold) → OPEN → (timeout expires) → HALF-OPEN
  ↑                                                                    |
  └──────────── (probe succeeds) ──────────────────────────────────────┘
                                        (probe fails) → back to OPEN
```

## Basic usage

```ts
import { makeCircuitBreaker } from "brass-runtime";

const breaker = makeCircuitBreaker({
  failureThreshold: 5,     // open after 5 consecutive failures
  resetTimeoutMs: 30_000,  // try again after 30 seconds
});

// Protect any effect
const result = await run(breaker.protect(callPaymentService()));
```

## Configuration

```ts
const breaker = makeCircuitBreaker({
  failureThreshold: 3,      // trips after 3 failures
  resetTimeoutMs: 10_000,   // 10s cooldown
  successThreshold: 2,      // need 2 successes in half-open to close
  
  // Only count certain errors as failures
  isFailure: (error) => {
    if (error._tag === "NotFound") return false;  // 404 is not a failure
    if (error._tag === "BadRequest") return false; // client error, not service
    return true; // everything else counts
  },
  
  // Observe state transitions
  onStateChange: (from, to) => {
    metrics.counter("circuit_breaker_transitions", { from, to }).increment();
  },
});
```

## With retry

```ts
import { makeCircuitBreaker, retryWithBackoff } from "brass-runtime";

const breaker = makeCircuitBreaker({ failureThreshold: 5 });

// Retry, but stop if circuit opens
const resilient = retryWithBackoff(
  breaker.protect(callService()),
  {
    maxRetries: 3,
    shouldRetry: (error) => {
      // Don't retry if circuit is open — it'll just fail fast anyway
      if (error._tag === "CircuitBreakerOpen") return false;
      return true;
    },
  }
);
```

## Monitoring

```ts
const stats = breaker.stats();
// {
//   state: "closed",
//   failures: 2,
//   successes: 0,
//   totalRequests: 150,
//   totalFailures: 5,
//   totalSuccesses: 143,
//   totalRejected: 2,
//   lastFailureTime: 1699000000000,
//   lastSuccessTime: 1699000001000,
// }

// Manual reset (e.g., after deploying a fix)
breaker.reset();
```
