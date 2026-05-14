# Changelog

## 1.18.2 - Release Metadata Alignment

### Fixed

- Aligned `package.json` and `package-lock.json` with the npm release line after
  the `1.18.0`/`1.18.1` publishes were cut from commits whose checked-in
  package metadata still referenced older versions.
- Kept the HTTP P99 consolidation and runtime performance changes from the
  `1.17.0` entry as the functional release contents; this patch is for
  traceable version metadata and tag hygiene.

## 1.17.0 - HTTP P99 Consolidation & Runtime Performance

### Performance

- **HTTP P99/P50 ratio reduced from 12.3x to 2.5–3.5x** across `default-proxy-effect-transport`,
  `default-proxy-effect-timeout-pool`, and `axios-brass-promise-pool-timeout` benchmark variants.
- **Runtime overhead reduced by ~46%** (P50 0.072ms → 0.039ms): hoisted the per-request frame
  object inside `NativeTopLevelRunner` (eliminated 4 closures per `unsafeRunAsync`), made
  `stack`/`joiners`/`finalizers` lazy-allocated, and stored the first joiner directly to skip
  the array iteration on the happy path.
- **Schema nested object validation reduced by ~52%** (1.07μs → 0.51μs/op): pre-computed
  `fieldKeys`/`fieldSchemas` arrays at construction, replaced `for...of` with indexed loops,
  removed `issues.push(...result.issues)` spread allocations.
- **Cache middleware key computation reduced by ~84%** (+0.069ms → +0.011ms per request):
  introduced `makeCacheKeyContext` and `computeCacheKeyFast` that hoist the relevant headers
  Set, base URL origin, and validation once at middleware construction.
- **Dedup middleware key computation** mirrors the cache fast path via `makeDedupKeyContext`
  and `computeDedupKeyFast`.
- **HTTP direct/pool transport**: added fast-path bypass for bare `Async`, `Succeed`, and
  `Fail` effects that resolves transports synchronously; conditional `AbortController`
  allocation using a shared `noopSignal` singleton; restructured `runPoolTransport` to use a
  per-request `PoolRequestState` class that hoists shared logic as methods (closure budget
  ≤ 3 in the uncontended sync path).
- **Promise transport adapter**: removed the per-request `async () => {}` wrapper IIFE,
  inlined sync vs async response mapping, skipped `addEventListener` registration when the
  signal is the shared `noopSignal`.
- **Stream `readerStream`**: cached `ABORTED_ERROR` singleton (no per-chunk `DOMException`
  allocation), conditional signal listener registration, eliminated the separate `cleanup`
  closure (inlined into `finish`).
- **Timer wheel**: added fine-tick scheduling path with `fineTickMs` (default 4ms) for
  deadlines ≤ `fineThresholdMs` (default 50ms), so short timeouts overshoot by ≤ 4ms instead
  of one coarse tick.
- **Conditional diagnostics**: per-label tracking in `recordAbortablePromiseStart`/`Finish`
  is now opt-in via `setAbortablePromisePerLabelTracking(enabled)` (default `false`), making
  the hot path allocation-free.
- **Observability**: collapsed the full middleware path's `asyncFlatMap × 4` chain into a
  single `Async` with direct callbacks, reducing microtask hops per request; added a
  base-labels cache keyed by `(method, host, route, preset)`.

### Tooling

- Added `scripts/measure-p50.ts`, `scripts/measure-obs.ts`, `scripts/measure-schema.ts`, and
  `scripts/measure-lifecycle.ts` for component-level latency breakdowns.
- HTTP P99/P50 regression gate (`src/benchmarks/http-local-overhead-gate.ts`) now runs with
  `node --expose-gc` for stable measurements: 2000 calls × 2000 warmup × concurrency 8.
  Asserts P99/P50 ≤ 4.0x for each gated variant and exits non-zero on regression.

### Backward compatibility

- All public type signatures preserved (`makeHttp`, `makeDefaultHttpClient`, `makeHttpStream`,
  schema builders).
- New configuration options (`fineTickMs`, `fineThresholdMs`, per-label tracking toggle) are
  optional and default to pre-optimization behavior.

## 1.14.0 - First Public Release Candidate

- Added mature core runtime features: structured concurrency, `Cause`,
  interruptibility, `FiberRef`, Layer 2.0, Schedule 2.0, TestRuntime, streams,
  and runtime observability.
- Added HTTP client/server surface with schema validation, lifecycle
  middleware, adaptive limiter, retry, compression, health/readiness, and
  observability hooks.
- Added `brass-runtime/perf` with runtime A/B, soak profiling, HTTP memory lab,
  benchmark budgets, and local perf history/baseline storage.
- Added DX helpers: `runPromise`, `runExit`, `makeRuntime`, `defineService`,
  `getService`, `provide`, `formatLayerError`, `formatConfigError`, and
  `HttpServer`.
- Added first-release recipes under `docs/recipes/` and release validation via
  `npm run release:check`.
