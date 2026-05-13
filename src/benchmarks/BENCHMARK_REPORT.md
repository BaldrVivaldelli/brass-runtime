# Benchmark Report

`npm run benchmark` is the canonical benchmark entrypoint. It discovers every
`*.bench.ts` suite in `src/benchmarks`, including runtime, HTTP lifecycle,
adaptive limiter, observability, WASM engine, and heap-per-suspended-fiber
suites.

Focused runs are still available through the same runner:

```bash
npm run benchmark -- scheduler-throughput
npm run benchmark:runtime
npm run benchmark:runtime:budget
npm run benchmark -- wasm-engines
npm run benchmark -- heap-suspended-fiber
npm run benchmark:http
npm run benchmark:adaptive
npm run benchmark:http:budget
npm run benchmark:http:ramp
npm run benchmark:json -- observability-overhead
```

HTTP concurrency has three modes:

```bash
npm run benchmark                         # daily mode: one 100k local HTTP scenario
npm run benchmark:http                    # compare mode: transport/wire/default/observed variants
npm run benchmark:http:budget             # compare mode with memory/adaptive budgets
npm run benchmark:http:soak               # opt-in soak mode
npm run benchmark:http:overhead           # in-process mocked transport overhead
BRASS_HTTP_OVERHEAD_CALLS=30000 BRASS_HTTP_OVERHEAD_WARMUP_CALLS=5000 npm run benchmark:http:overhead
BRASS_HTTP_BENCH_MODE=soak npm run benchmark:http
BRASS_HTTP_BENCH_CALLS=1000000 npm run benchmark -- http-concurrent
BRASS_HTTP_BENCH_CALLS=100000 node --expose-gc --import tsx src/benchmarks/runner.ts http-concurrent
```

`http-local-overhead` is the focused suite for adapter/proxy plumbing overhead:
it includes proxy lean, timeout/pool variants, raw observability metrics-only,
sampled span observability, HTTP metrics-only observability, runtime-hook
observability, and full client span observability. The default concurrency is
8 so the suite measures local per-request overhead without intentionally
saturating the Node event loop; set `BRASS_HTTP_OVERHEAD_CONCURRENCY=32` when
you want a saturation profile.

HTTP TPS ramp is open-loop: it schedules request arrivals at the requested TPS
instead of deriving TPS from max concurrency. A focused run defaults to
`60->120->180->240->300->240->180->120->60`, with 5 seconds per step:

```bash
npm run benchmark:http:ramp
BRASS_HTTP_RAMP_STEP_SECONDS=30 npm run benchmark:http:ramp
BRASS_HTTP_RAMP_CLIENT=proxy BRASS_HTTP_RAMP_MAX_TPS=300 BRASS_HTTP_RAMP_STEP_TPS=300 BRASS_HTTP_RAMP_STEP_SECONDS=180 npm run benchmark:http:ramp
npm run benchmark:http:proxy:300tps
BRASS_HTTP_RAMP_CLIENT=observed npm run benchmark:http:ramp
BRASS_HTTP_RAMP_MAX_TPS=600 BRASS_HTTP_RAMP_STEP_TPS=60 npm run benchmark:http:ramp
```

The normal `npm run benchmark` path keeps the ramp short
(`60->120->60`, 1 second per step) so the daily suite stays practical.

Adaptive limiter synthetic scenarios have daily and soak modes:

```bash
npm run benchmark:adaptive
npm run benchmark:adaptive:soak
BRASS_ADAPTIVE_BENCH_SAMPLES=500000 npm run benchmark -- adaptive-limiter-soak
BRASS_ADAPTIVE_BENCH_PRESET=conservative npm run benchmark:adaptive
```

Setting `BRASS_HTTP_BENCH_CALLS` to `1000000` or higher implies soak mode unless
`BRASS_HTTP_BENCH_MODE=compare` is explicitly set.
Use the explicit `node --expose-gc` form when investigating retained heap; the
normal `npm run benchmark` path still reports memory deltas, but without forced
GC they are a noisier allocation-pressure signal.

Runtime Performance Track focuses on core runtime overhead from the recent
runtime features:

```bash
npm run benchmark:runtime
npm run benchmark:runtime:budget
BRASS_RUNTIME_BENCH_SCHEDULE_STEPS=100000 npm run benchmark:runtime
```

It covers FlatMap chains, FiberRef updates, interruptibility mask/restore,
Layer 2 typed context builds, LayerScope diamond memoization, pure
ScheduleDriver decisions, and observed ScheduleDriver decisions through the
runtime recorder.

## Current Scale

- Scheduler throughput TS benchmarks use 1,000,000 tasks.
- Runtime Performance Track daily defaults use 1,000 FlatMap effects, 1,000
  FiberRef ops, 500 interruptibility regions, 100 Layer 2 typed builds, 50,000
  pure ScheduleDriver decisions, and 10,000 observed ScheduleDriver decisions.
- WASM engine comparison keeps WASM cases at 100,000 operations to avoid hiding
  JS/WASM boundary costs behind very long runs.
- TS ring-buffer and chunker cases in `wasm-engines.bench.ts` use 1,000,000
  records.
- Heap-per-suspended-fiber runs as part of the normal benchmark suite and emits
  memory details in the JSON report.
- Scheduler throughput includes the default fair lane scheduler and the
  `laneMode: "single"` fast path for high-throughput single-queue workloads.
- Heap-per-suspended-fiber is run in a child process with `--expose-gc` so
  heap deltas are meaningful.
- The benchmark runner derives throughput when a suite declares `unitsPerRun`
  and `unit`; concurrent-load reports request throughput as `req/s`.
- Concurrent load includes a diagnostic ladder: native timer pool, runtime with
  fixed lane, runtime with inferred lane, semaphore only, breaker only, and the
  full semaphore + breaker stack.
- HTTP concurrency includes a real local `node:http` JSON server with
  configurable delay. Daily defaults are `BRASS_HTTP_BENCH_CALLS=100000`,
  `BRASS_HTTP_BENCH_CONCURRENCY=512`, and `BRASS_HTTP_BENCH_DELAY_MS=2`.
  Focused `http-concurrent` runs switch to compare mode and include a
  controlled `node:http` transport baseline, wire client, default client
  presets, balanced-without-adaptive, balanced/default adaptive, and observed
  HTTP variants. The million-call run is soak-only/opt-in; public demo APIs
  such as jsonplaceholder should only be used for small manual smoke tests.
- HTTP concurrency reports suite throughput plus per-request latency
  percentiles (`requestP50Ms`, `requestP99Ms`), requested concurrency,
  observed server max in-flight, logical client max in-flight, and sampled
  wire/pool/lifecycle queue peaks when available.
- HTTP concurrency also reports memory deltas (`heapDeltaMb`, `rssDeltaMb`,
  `externalDeltaMb`, `gcAvailable`) and adaptive limiter snapshots
  (`adaptiveMinLimit`, `adaptiveMaxQueueDepth`, `adaptiveMaxInFlight`) so local
  slowdowns can be separated into retained heap, runtime RSS retention, limiter
  throttling, or transport pressure.
- HTTP TPS ramp uses the same local server, but measures a fixed arrival-rate
  profile. It reports the target profile, scheduled/sent/dropped/missed counts,
  per-step actual TPS and latency percentiles, max client/server in-flight, and
  the same memory/adaptive/client counters when available.
- The default HTTP adaptive limiter uses `minSamples`, `decreaseThreshold`, and
  `maxDecreaseRatio` to avoid collapse from cold-start or low-latency jitter.
  `npm run benchmark:http:budget` fails if adaptive variants fall below the
  configured final-limit/in-flight budgets or retain too much heap after GC.
- HTTP concurrency warms each variant before measurement. Warmup URLs are
  disjoint from measured URLs so cache-enabled presets do not inherit warmup
  hits. Cache-enabled default clients are cleared after warmup. `throughputDurationMs`
  is used for `http/s`, while the runner's `totalMs` still includes setup,
  warmup, and teardown.
- Adaptive limiter synthetic benchmarks run stable-latency and
  saturation/recovery scenarios without network I/O. They report sample
  throughput, state count, final aggregate limit, min/max per-key limits seen,
  limit-change count, and final percentile/throughput diagnostics. Daily
  defaults are `BRASS_ADAPTIVE_BENCH_SAMPLES=25000`,
  `BRASS_ADAPTIVE_BENCH_KEYS=16`, and preset `balanced`.

## Latest Local Read

Captured on linux-x64, Node v22.21.1:

| Benchmark | Scale | Latest local read |
|-----------|-------|-------------------|
| RuntimeTrack flatMap chain | 1,000 effects | ~0.12ms/op, ~8M effects/s |
| RuntimeTrack FiberRef update/get | 1,000 ops | ~0.15ms/op, ~6.7M ops/s |
| RuntimeTrack interruptibility mask/restore | 500 regions | ~0.11ms/op, ~4.6M regions/s |
| RuntimeTrack Layer 2 typed provideContext | 100 builds | ~1.3ms/op, ~75k builds/s |
| RuntimeTrack LayerScope memoized diamond graph | shared dependency | ~0.05ms/op, acquired/released once |
| RuntimeTrack ScheduleDriver pure | 50,000 decisions | ~3.7ms/op, ~13M decisions/s |
| RuntimeTrack ScheduleDriver observed | 10,000 decisions | ~2.3ms/op, ~4.3M decisions/s |
| Scheduler fair sequential TS | 1,000,000 tasks | ~46ms/op |
| Scheduler single-lane sequential TS | 1,000,000 tasks | ~15ms/op |
| Scheduler fair fan-out TS | 100 x 10,000 tasks | ~48ms/op |
| Scheduler single-lane fan-out TS | 100 x 10,000 tasks | ~17ms/op |
| Concurrent full stack | 420 reqs, sem=50 | ~34ms/op, ~12k req/s |
| Concurrent full stack | 1,000 reqs, sem=100 | ~41ms/op, ~24k req/s |
| Concurrent full stack | 10,000 reqs, sem=500 | ~233ms/op, ~43k req/s |
| HTTP local dummy default JSON | 100,000 calls, concurrency=512, delay=2ms | daily local benchmark |
| HTTP local dummy soak | 1,000,000 calls, opt-in | `BRASS_HTTP_BENCH_MODE=soak` |
| Adaptive limiter stable | 25,000 samples x 16 keys | ~16k samples/s, balanced preset |
| Adaptive limiter saturation/recovery | 25,000 samples x 16 keys | ~16k samples/s, balanced preset |
| Ring buffer TS | 1,000,000 push then shift | ~12ms/op |
| Chunker TS | 1,000,000 items / 256 | ~10ms/op |
| Heap per suspended fiber TS closure | 10,000 fibers | ~3.8KB heap/fiber |
| Heap per suspended fiber WASM host-action | 10,000 fibers | ~5.9KB heap/fiber |

The terminal `⚠` marker is a generic `perOpMs >= 1` display hint from the
runner, not a benchmark-specific failure budget.
