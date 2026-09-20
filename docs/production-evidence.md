# Production evidence

Brass separates three evidence levels so benchmark results are useful without
being oversold.

| Level | What it proves | Current evidence |
| --- | --- | --- |
| Contract | Package shape, types, compatibility, cancellation semantics | CI tests, API fingerprint, packed-consumer smoke tests |
| Production-like | Behavior under controlled runtime, HTTP, memory, and observability workloads | [`production-like-baseline-2026-09-19.json`](./evidence/production-like-baseline-2026-09-19.json) |
| External production | Outcomes in an identifiable, consenting user workload | Not yet claimed |

The committed production-like baseline was recorded on a Ryzen 9 8945HS with
Node 22.23.2. It contains seven runtime measurements, eleven local HTTP
variants with explicit GC and zero errors, and five observability measurements.
Every recorded result is stored next to its predeclared budget. Run the
integrity check with:

```bash
npm run validate:evidence
```

## Reproduce the workloads

Run on an otherwise quiet machine. Absolute throughput will vary; the budget
result and semantic invariants are the release decisions.

```bash
npm run benchmark:runtime:budget
npm run benchmark:http:budget
npm run benchmark:observability:budget
```

For raw JSON:

```bash
npm run benchmark:json -- runtime-performance-track
npm run benchmark:json -- observability-overhead
BRASS_HTTP_BENCH_MODE=compare \
BRASS_HTTP_BENCH_CALLS=1000 \
BRASS_HTTP_BENCH_CONCURRENCY=64 \
BRASS_HTTP_BENCH_DELAY_MS=1 \
node --expose-gc --import tsx src/benchmarks/runner.ts --json http-concurrent
```

Record the OS, CPU, logical CPU count, memory, Node version, exact workload,
warmup, GC mode, thresholds, errors, and all material negative findings. Do not
compare an explicit-GC heap delta with a non-GC run.

## Turning usage into a case study

External adoption is tracked under [`case-studies`](./case-studies/README.md).
A case study requires consent, a reproducible workload or operational trace,
before/after data, and limitations. Anonymous or unverifiable anecdotes may
inform the backlog but are not labeled production evidence.
