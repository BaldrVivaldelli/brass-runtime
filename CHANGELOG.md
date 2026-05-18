# Changelog

## 1.20.0 - Agent Intelligence Layer

### Features

- **LLM Budget Optimization** (`src/agent/core/llmBudget/`): Token budget tracking,
  response confidence estimation, and complexity-based model routing for brass-agent.
  - `resolveBudgetConfig` / `validateBudgetConfig`: merge goal+config budgets with defaults,
    reject invalid inputs at construction time.
  - `BudgetState` tracking: immutable accumulation of token usage across LLM calls with
    three-zone classification (under / warning / exceeded).
  - `estimateTokens`: chars/4 fallback when providers don't report usage.
  - `estimateConfidence`: heuristic scoring (diff blocks, conciseness, goal references,
    hedging language) for response quality signals.
  - `routeModel`: complexity-based "small" vs "large" tier selection using goal length,
    files read, search matches, validation errors, and repair attempts.
  - Budget gate in `runAgent`: intercepts `llm.complete` actions, emits structured events
    (`budget.usage`, `budget.routed`, `budget.confidence`, `budget.warning`, `budget.exceeded`),
    and gracefully terminates on hard cap with phase-aware summaries.
  - `LearningStore` persistence: cross-run history at `.brass/llm-budget.json` with cap
    enforcement and corrupt-file recovery.

- **Adaptive Context Budget** (`src/agent/core/contextBudget/`): Multi-armed bandit
  prioritization for context discovery actions using Thompson Sampling.
  - Bandit engine with Beta-distributed arms, Bayesian updates, and configurable
    exploration/exploitation tradeoff.
  - Context action scoring and ranking based on historical reward signals.
  - State persistence at `.brass/context-budget.json` with graceful degradation.

- **Adaptive Patch Strategy** (`src/agent/core/patchStrategy/`): Feedback-driven patch
  generation strategy selection using reward-weighted history.
  - Strategy selector choosing between diff formats based on historical success rates.
  - Reward tracking with exponential decay for recency weighting.
  - Integration with the patch generation pipeline in `decide.ts`.

- **Agent Host LLM Refactor** (`src/agent/core/`): Restructured LLM interaction layer
  for cleaner separation between host profile detection and LLM provider routing.
  - Unified host profile inference with transport-aware defaults.
  - Cleaner LLM request/response pipeline with typed purpose discrimination.

### Testing

- 14 property-based tests (fast-check) covering budget config, state accumulation,
  immutability, zone classification, token estimation, confidence bounds/signals,
  model routing, and persistence invariants.
- 5 integration tests for the budget-aware runner (warning zone, hard cap, no-budget
  passthrough, no-LLM graceful degradation, subsequent call blocking).
- Full property test suites for context budget bandit engine, patch strategy selector,
  and host LLM refactor modules.

### Validation

- `npm run test:types` — 0 errors
- `npm test` — 1860+ tests passing

## 1.19.0 - Bare-Metal HTTP Mode

### Features

- Added `makeBareMetalHttp` factory: a zero-overhead HTTP client that bypasses
  all middleware layers (retry, dedup, cache, batch, priority, compression,
  adaptive limiter, prewarm) and delegates directly to the wire transport.
  Preserves typed errors, cancellation, pool/adaptive-limiter, and stats.
- Added `makeBareMetalHttpStream` factory: streaming counterpart with the same
  zero-overhead guarantees. Pool leases are released on headers received.
- Added `preset: "bareMetal"` to `makeDefaultHttpClient` for easy opt-in via
  the standard preset system. DX helpers (get, post, getJson, postJson, getText)
  work identically. Lifecycle config keys are ignored with a construction-time
  warning. User middleware is still applied.
- Bare-metal clients expose `.with(mw)` escape hatch for composing observability
  without pulling in the full lifecycle stack.
- Exported `runDirectTransport`, `runPoolTransport`, and related wire-level
  helpers from `src/http/client.ts` for advanced custom client composition.

### Usage

```typescript
import { makeBareMetalHttp, makeDefaultHttpClient } from "brass-runtime/http";

// Standalone factory
const client = makeBareMetalHttp({ baseUrl: "https://api.internal" });

// Via preset
const defaultClient = makeDefaultHttpClient({ preset: "bareMetal" });

// With custom transport (e.g., Axios adapter)
const axiosClient = makeBareMetalHttp({ transport: myAxiosTransport });
```

## 1.18.3 - HTTP Pool/Timeout Fast Path

### Performance

- Connected the non-streaming HTTP wire client to the existing `runPoolTransport`
  fast path whenever a request uses `pool`, `adaptiveLimiter`, or `timeoutMs`.
  The uncontended pool path now uses synchronous `tryAcquireSync` before falling
  back to queued async acquire, avoiding the generic `fromPromiseAbortable`
  wrapper and extra promise/microtask boundaries on hot BFF/proxy paths.
- Improved local HTTP overhead benchmark results for the proxy effect transport
  path with 30k calls, 5k warmup, concurrency 32:
  - `default-proxy-effect-timeout`: p99 `1.915ms` -> `1.559ms`,
    throughput `70.9k/s` -> `101.5k/s`.
  - `default-proxy-effect-pool`: p99 `1.564ms` -> `1.276ms`,
    throughput `79.2k/s` -> `115.7k/s`.
  - `default-proxy-effect-timeout-pool`: p99 `2.014ms` -> `1.209ms`,
    throughput `70.2k/s` -> `103.1k/s`.

### Fixed

- Preserved real host-request cancellation on the pool/timeout fast path by
  passing transports a request-scoped `AbortController` signal. Promise
  transports such as Axios can now observe aborts on cancellation and timeout
  while still benefiting from the pool fast path.
- Added regression coverage ensuring uncontended pool transports run during
  effect registration and that cancellation aborts the signal passed to the
  transport.

### Validation

- `npm run test:types`
- `npm test -- src/http/__tests__`
- `BRASS_HTTP_OVERHEAD_CALLS=30000 BRASS_HTTP_OVERHEAD_WARMUP_CALLS=5000 BRASS_HTTP_OVERHEAD_CONCURRENCY=32 BRASS_HTTP_OVERHEAD_VARIANTS=default-proxy-effect-transport,default-proxy-effect-timeout,default-proxy-effect-pool,default-proxy-effect-timeout-pool npm run benchmark:http:overhead`

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
