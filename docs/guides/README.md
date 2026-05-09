# brass-runtime Guides

Guides for each feature of brass-runtime, organized by topic.

## Core

- [Getting Started](./getting-started.md) — Install, first effect, basic patterns
- [Effects & Fibers](./effects-and-fibers.md) — The effect system, fibers, and concurrency
- [Error Handling](./error-handling.md) — Typed errors, catchTag, recovery patterns
- [Resource Management](./resource-management.md) — bracket, ensuring, managed resources

## Concurrency

- [Streams & Pipelines](./streams.md) — ZStream, operators, fusion
- [Queue & Hub](./queue-and-hub.md) — Bounded queues, pub/sub
- [Semaphore & Rate Limiting](./semaphore.md) — Concurrency control
- [Circuit Breaker](./circuit-breaker.md) — Failure protection
- [Supervisors](./supervisors.md) — Restart and escalation policies for child fibers

## Resilience

- [Retry & Backoff](./retry.md) — retry, retryWithBackoff, Schedule
- [Timeout](./timeout.md) — Effect timeouts with cancellation

## Infrastructure

- [Layers (DI)](./layers.md) — Dependency injection with lifecycle
- [Ref (Shared State)](./ref.md) — Mutable state across fibers
- [Scheduler](./scheduler.md) — Task scheduling, lanes, budgets
- [Worker Pool](./worker-pool.md) — CPU-intensive offloading

## Observability

- [Tracing](./tracing.md) — OpenTelemetry-compatible spans
- [Metrics](./metrics.md) — Counters, gauges, histograms
- [Graceful Shutdown](./shutdown.md) — Clean process termination

## Testing

- [Testing Utilities](./testing.md) — TestRuntime, assertions, helpers
