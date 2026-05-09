# Production Readiness

This checklist is the release gate for using `brass-runtime` in production-like
services.

## HTTP Defaults

Use `makeDefaultHttpClient` for application clients. The `default` preset enables
timeout, deduplication, priority scheduling, retry, conservative adaptive
concurrency, safe-method cache, compression, stats, cache controls, and
`cancelAll`.

The adaptive limiter is intentionally conservative in presets:

- `minSamples` prevents cold-start latency from changing limits too early.
- `decreaseThreshold` creates a deadband for normal latency jitter.
- `maxDecreaseRatio` caps one-step decreases so a noisy sample cannot collapse
  concurrency.
- Presets avoid `minLimit: 1`; use that only when a caller explicitly wants a
  nearly-closed circuit under pressure.

When debugging throughput, compare requested concurrency with
`serverMaxInFlight`, `adaptiveFinalLimit`, and `adaptiveMaxQueueDepth` before
assuming a memory leak.

## Validation

Baseline gate:

```bash
npm run test:types
npm test
```

Public package gate:

```bash
npm run build
npm run validate:cjs
```

Benchmark gates:

```bash
npm run benchmark:observability:budget
npm run benchmark:http:budget
npm run benchmark:adaptive
```

Soak gate:

```bash
npm run benchmark:http:soak
npm run benchmark:adaptive:soak
BRASS_HTTP_BENCH_CALLS=100000 node --expose-gc --import tsx src/benchmarks/runner.ts http-concurrent
```

Treat sustained positive `heapDeltaMb` after explicit GC as leak evidence. Treat
RSS-only growth as a signal to investigate, not proof of a leak.

## Operational Notes

- Attach HTTP observability with `middleware: [withHttpObservability(obs)]`.
- HTTP observability records adaptive limiter gauges when the wrapped client
  owns a limiter; keep the optional limiter key label disabled unless keys are
  low-cardinality.
- Always call `observability.shutdown()` during service shutdown.
- Call HTTP `shutdown()` as part of graceful shutdown when using default or
  adaptive-limiter clients so queue/TTL timers and waiters are cleaned up.
- Keep exporter queues bounded and use `flush()` before process exit.
- Prefer local benchmark servers over public demo APIs for repeatable numbers.
- Keep benchmark budgets advisory in developer machines and mandatory in CI once
  the CI hardware profile is stable.
