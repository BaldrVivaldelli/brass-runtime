# Retry & Backoff

brass-runtime provides multiple retry strategies, from simple to composable.

## Quick retry (no delay)

```ts
import { retryN } from "brass-runtime";

// Retry up to 3 times with no delay
const result = await run(retryN(fetchData(), 3));
```

## Exponential backoff with jitter

```ts
import { retryWithBackoff } from "brass-runtime";

const result = await run(retryWithBackoff(callApi(), {
  maxRetries: 5,
  baseDelayMs: 100,     // first retry: random 0-100ms
  maxDelayMs: 10_000,   // cap at 10s
  maxElapsedMs: 60_000, // total budget: 60s
  shouldRetry: (error) => error._tag !== "NotFound", // don't retry 404s
}));
```

## Full control with retry()

```ts
import { retry } from "brass-runtime";

const result = await run(retry(effect, {
  maxRetries: 10,
  baseDelayMs: 50,
  maxDelayMs: 5000,
  maxElapsedMs: 30_000,
  jitter: "full",  // or "none" for deterministic delays
  shouldRetry: (error, attempt) => {
    if (error._tag === "RateLimit") return true;
    if (attempt > 5) return false;
    return true;
  },
}));
```

## Composable Schedules

For advanced use cases, use the Schedule type:

```ts
import { exponential, intersect, recurs, retryWithSchedule } from "brass-runtime";

// Retry 5 times with exponential backoff, but stop after 30s total
const policy = intersect(
  recurs(5),
  exponential(100, 5000)
);

const result = await run(retryWithSchedule(effect, policy));
```

### Schedule combinators

```ts
import {
  andThen,
  elapsed,
  exponential,
  fibonacci,
  fixed,
  jitter,
  jittered,
  recurs,
  take,
  windowed,
} from "brass-runtime";

// Fixed delay between retries
const fixed5s = fixed(5000);

// Exponential: 100ms, 200ms, 400ms, 800ms... capped at 10s
const expo = exponential(100, 10_000);

// Fibonacci: 100ms, 100ms, 200ms, 300ms, 500ms... capped at 10s
const fib = fibonacci(100, 10_000);

// Full jitter: random in [0, exponential_delay]
const fullJitter = jittered(100, 10_000);

// Jitter any schedule by +/-20%
const softJitter = jitter(expo, { factor: 0.2 });

// Stop after N attempts
const limited = take(expo, 5);

// Stop after elapsed time
const budgeted = intersect(expo, elapsed(30_000));

// Reset schedule state when the burst window expires
const rolling = windowed(recurs(3), 60_000);

// First use fast retries, then switch to slow
const staged = andThen(take(fixed(100), 3), exponential(1000, 30_000));
```

Schedules also plug into HTTP retry middleware, so retry, polling, and
supervisor restarts can share the same timing model:

```ts
import { exponential, jitter } from "brass-runtime";
import { withRetry } from "brass-runtime/http";

const retry = withRetry({
  maxRetries: 5,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  schedule: jitter(exponential(100, 5_000), { factor: 0.2 }),
});
```

### Repeat (not just retry)

```ts
import { repeatWithSchedule, fixed } from "brass-runtime";

// Poll every 5 seconds
const poller = repeatWithSchedule(checkStatus(), fixed(5000));
```

## With Circuit Breaker

```ts
import { makeCircuitBreaker, retryWithBackoff } from "brass-runtime";

const breaker = makeCircuitBreaker({ failureThreshold: 5 });

const resilient = retryWithBackoff(
  breaker.protect(callService()),
  { maxRetries: 3, shouldRetry: (e) => e._tag !== "CircuitBreakerOpen" }
);
```
