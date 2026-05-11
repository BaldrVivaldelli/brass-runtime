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

## Schedule 2.0

For advanced use cases, use `Schedule` values. Schedules are declarative,
stateful only when driven, and runtime-clock aware when used by
`retryWithSchedule`, `repeatWithSchedule`, HTTP retry, supervisors, and server
shutdown polling.

```ts
import { exponential, intersect, maxElapsed, recurs, retryWithSchedule } from "brass-runtime";

// Retry 5 times with exponential backoff, but stop after 30s total
const policy = maxElapsed(
  intersect(recurs(5), exponential(100, 5000)),
  30_000,
);

const result = await run(retryWithSchedule(effect, policy));
```

### ScheduleDriver

Use a driver when you want to manually step a schedule, inspect state, reset it,
or emit observability events.

```ts
import { Schedule } from "brass-runtime";

const policy = Schedule.named(
  "api.retry",
  Schedule.jitter(Schedule.exponential(100, 5_000), { factor: 0.2 }),
);

const driver = Schedule.driver(policy, {
  onDecision: (event) => {
    console.log(event.name, event.attempt, event.decision.delayMs);
  },
});

const next = driver.next({ status: 503 });

if (next.continue) {
  console.log(`wait ${next.delayMs}ms before trying again`);
}

driver.snapshot();
driver.reset();
```

### Schedule combinators

```ts
import {
  Schedule,
  andThen,
  elapsed,
  exponential,
  fibonacci,
  fixed,
  forever,
  jitter,
  jittered,
  linear,
  maxDelay,
  maxElapsed,
  never,
  once,
  recurs,
  spaced,
  take,
  tapDecision,
  untilInput,
  untilOutput,
  windowed,
  whileOutput,
} from "brass-runtime";

// Fixed delay between retries
const fixed5s = fixed(5000);

// Alias for fixed delay
const every5s = spaced(5000);

// One-shot / forever / never policies
const oneRetry = once();
const always = forever();
const stop = never();

// Exponential: 100ms, 200ms, 400ms, 800ms... capped at 10s
const expo = exponential(100, 10_000);

// Linear: 100ms, 200ms, 300ms... capped at 10s
const lin = linear(100, 10_000);

// Fibonacci: 100ms, 100ms, 200ms, 300ms, 500ms... capped at 10s
const fib = fibonacci(100, 10_000);

// Full jitter: random in [0, exponential_delay]
const fullJitter = jittered(100, 10_000);

// Jitter any schedule by +/-20%
const softJitter = jitter(expo, { factor: 0.2 });

// Stop after N attempts
const limited = take(expo, 5);

// Cap delay or total elapsed runtime-clock budget
const cappedDelay = maxDelay(expo, 2_000);
const budgeted = maxElapsed(expo, 30_000);
const elapsedOnly = elapsed(30_000);

// Reset schedule state when the burst window expires
const rolling = windowed(recurs(3), 60_000);

// Stop based on inputs or outputs
const untilReady = untilInput<{ status: string }>((input) => input.status === "ready");
const whileSmall = whileOutput(linear(10), (attempt) => attempt < 5);
const untilAttempt5 = untilOutput(linear(10), (attempt) => attempt >= 5);

// Attach observability without changing retry semantics
const observed = tapDecision(Schedule.named("db.retry", expo), (event) => {
  console.log(event.name, event.attempt, event.decision.delayMs);
});

// First use fast retries, then switch to slow
const staged = andThen(take(fixed(100), 3), exponential(1000, 30_000));
```

Schedules also plug into HTTP retry middleware, so retry, polling, and
supervisor restarts can share the same timing model:

```ts
import { Schedule, exponential, jitter } from "brass-runtime";
import { withRetry } from "brass-runtime/http";

const retry = withRetry({
  maxRetries: 5,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  schedule: Schedule.named(
    "users-api.retry",
    jitter(exponential(100, 5_000), { factor: 0.2 }),
  ),
  onScheduleDecision: (event) => {
    console.log(event.name, event.attempt, event.decision.delayMs);
  },
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
