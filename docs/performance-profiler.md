# Brass Performance Profiler

`brass-runtime/perf` is the built-in profiling surface for runtime and HTTP
performance work. It is intentionally dependency-free and runs against a local
Node HTTP server so it can be used in CI, during local optimization, and before
changing runtime internals.

## Run it

```bash
npm run perf
npm run perf:json
npm run benchmark:perf
npm run perf:runtime:ab
npm run perf:runtime:soak
npm run perf:runtime:budget
npm run perf:http:memory
npm run perf:history
```

For memory-sensitive runs, expose GC:

```bash
node --expose-gc --import tsx src/perf/cli.ts --force-gc
node --expose-gc --import tsx src/perf/cli.ts --profile http-memory --calls 100000 --concurrency 512 --delay-ms 2 --force-gc
```

Focused examples:

```bash
npm run perf -- --profile runtime --runtime-iterations 10000
npm run perf -- --profile runtime-ab --baseline fiber-only --candidate default
npm run perf -- --profile runtime-soak --rounds 10 --runtime-iterations 100000
npm run perf -- --profile http --calls 20000 --concurrency 512 --delay-ms 2 --force-gc
npm run perf -- --profile http --variants default-json,default-json-observed --json
npm run perf -- --profile http-memory --calls 20000 --concurrency 512 --rounds 2 --force-gc
npm run perf -- --profile runtime-ab --record-history --save-baseline runtime-main
npm run perf -- --profile runtime-ab --compare-baseline runtime-main --fail-on-baseline-regression
```

Environment variables mirror the CLI flags:

- `BRASS_PERF_PROFILE=all|runtime|http`
- `BRASS_PERF_CALLS`
- `BRASS_PERF_CONCURRENCY`
- `BRASS_PERF_DELAY_MS`
- `BRASS_PERF_WARMUP_CALLS`
- `BRASS_PERF_VARIANTS`
- `BRASS_PERF_RUNTIME_ITERATIONS`
- `BRASS_PERF_RUNTIME_CHAIN_DEPTH`
- `BRASS_PERF_RUNTIME_VARIANT`
- `BRASS_PERF_BASELINE`
- `BRASS_PERF_CANDIDATE`
- `BRASS_PERF_ROUNDS`
- `BRASS_PERF_FORCE_GC=true`
- `BRASS_PERF_JSON=true`
- `BRASS_PERF_RECORD_HISTORY=true`
- `BRASS_PERF_HISTORY_DIR`
- `BRASS_PERF_SAVE_BASELINE`
- `BRASS_PERF_COMPARE_BASELINE`
- `BRASS_PERF_FAIL_ON_BASELINE_REGRESSION=true`

## Import it

```ts
import {
  comparePerfToBaseline,
  formatPerformanceReport,
  loadPerfBaseline,
  profileHttpLayers,
  profileRuntimePrimitives,
  runBrassPerformanceProfile,
  savePerfBaseline,
  createPerfHistoryEntry,
} from "brass-runtime/perf";

const report = await runBrassPerformanceProfile({
  http: {
    calls: 20_000,
    concurrency: 512,
    delayMs: 2,
    forceGc: true,
    variants: ["default-json", "default-json-observed"],
  },
});

console.log(formatPerformanceReport(report));

const entry = createPerfHistoryEntry("all", report);
await savePerfBaseline("daily-main", entry);
const baseline = await loadPerfBaseline("daily-main");
if (baseline) {
  console.log(comparePerfToBaseline(entry, baseline));
}
```

## What it measures

Runtime profile:

- top-level `asyncSucceed`
- top-level `asyncFail`
- top-level `asyncSync`
- deep `flatMap` chains
- `FiberRef` update/get chains
- fibers started per primitive
- ns/op and operations per second

Runtime A/B profile:

- `fiber-only` baseline for forced fiber execution
- `default` candidate with native top-level fast path for no-hooks/no-lane
  `Succeed`, `Fail`, `Sync`, synchronous continuations, `FiberRef` locals, and
  synchronous/asynchronous callback effects
- `active-hooks` to measure EventBus overhead
- `recorder` to measure bounded flight recorder overhead
- `wide-scheduler` to measure larger single-lane queue settings

Runtime soak profile:

- repeated runtime-only rounds
- throughput trend from first to last round
- heap/rss trend across rounds
- hottest primitive per round

HTTP layer profile:

- `node-http-text`
- `wire-raw`
- `default-minimal-json`
- `default-balanced-no-adaptive-json`
- `default-balanced-json`
- `default-json`
- `default-json-observed`

Each HTTP variant reports throughput, latency percentiles, client/server
in-flight peaks, queue depth, adaptive limiter state when present, span
retention when observability is enabled, and memory deltas.

HTTP long-run memory lab:

- defaults to `forceGc: true`, so use `node --expose-gc` for the strongest
  retained-memory signal
- compares node transport, wire raw, minimal, balanced without adaptive,
  balanced, default, and default+observability variants
- reports heap/rss totals, max p99, mean throughput, errors, and
  `heapDeltaPer10kRequestsMb`
- highlights whether memory is `ok`, `watch`, `critical`, or `unknown-gc`
- compares default+observability against default for heap/10k and throughput

Memory profile:

- before/after snapshots
- heap/rss/external/array-buffer deltas
- GC availability
- optional forced GC via `--force-gc`

## History and baselines

Perf history is local and dependency-free:

- history appends compact JSONL entries to `.brass/perf-history/runs.jsonl`
- baselines are stored under `.brass/perf-history/baselines/*.json`
- entries keep normalized metrics rather than full reports by default
- `--record-history` writes the current run
- `--save-baseline NAME` stores the current run as a named baseline
- `--compare-baseline NAME` compares matching metrics by name/tags
- `--fail-on-baseline-regression` turns a failed baseline comparison into a
  non-zero CLI exit code

Thresholds are intentionally simple:

- throughput and ops/s are higher-is-better
- latency, heap/rss, ns/op, and errors are lower-is-better
- `--baseline-max-regression-percent` defaults to `10`
- `--baseline-max-heap-regression-percent` defaults to `25`
- `--baseline-warn-at-ratio` defaults to `0.5`

## Recommendations

`recommendPerformance` turns raw numbers into actionable warnings:

- default client throughput compared to `node:http`
- observability overhead compared to unobserved default client
- retained heap per HTTP variant and full profile
- queueing and adaptive limiter pressure
- high HTTP p99 latency
- runtime primitives below local thresholds

These recommendations are heuristics, not release gates. Use the focused
benchmark budgets for stable regression checks:

```bash
npm run perf:runtime:budget
npm run perf:http:memory
npm run benchmark:runtime:budget
npm run benchmark:http:budget
npm run benchmark:observability:budget
```
