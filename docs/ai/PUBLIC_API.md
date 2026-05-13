# Public API

This file tracks the package surface that users can import.

## Package exports

Defined in `package.json`:

- `brass-runtime` -> `dist/index.*`
- `brass-runtime/core` -> `dist/core/index.*`
- `brass-runtime/http` -> `dist/http/index.*`
- `brass-runtime/http/testing` -> `dist/http/testing.*`
- `brass-runtime/schema` -> `dist/schema/index.*`
- `brass-runtime/observability` -> `dist/observability/index.*`
- `brass-runtime/perf` -> `dist/perf/index.*`
- `brass-runtime/agent` -> `dist/agent/index.*`
- `brass-runtime/package.json`
- `brass-runtime/wasm/pkg/brass_runtime_wasm_engine.js`
- `brass-runtime/wasm/pkg/brass_runtime_wasm_engine_bg.wasm`

CLI:

- `brass-agent` -> `dist/agent/cli/main.cjs`
- `brass-perf` -> `dist/perf/cli.cjs`

Bundle entries are defined in `tsup.config.ts`. Package files include `dist`,
`wasm/pkg`, `README.md`, `CHANGELOG.md`, `docs`, `LICENSE`, and `package.json`.

## Root export: `brass-runtime`

Source: `src/index.ts`

The root export is compatibility-first. New public APIs should prefer a named
subpath when they belong to an optional subsystem (`brass-runtime/http`,
`brass-runtime/agent`, future stream/runtime subpaths) instead of widening the
root surface by default.

Primary categories:

- effect/core types: `Async`, `ZIO`, `Exit`, `Cause`, `Option`, cancel types
- runtime execution: `Runtime`, `makeRuntime`, `runPromise`, `runExit`,
  `runEffect`, `fork`, `toPromise`, scheduler/fiber/scope
- resources and structured concurrency helpers: `Resource`, `managed`,
  `Supervisor`, `makeSupervisor`, `joinSupervised`
- interruptibility helpers: `uninterruptible`, `interruptible`,
  `uninterruptibleMask`
- semaphore, circuit breaker, `Ref`, `FiberRef`, declarative `Schedule`,
  `ScheduleDriver`, Schedule 2.0 combinators/observers, shutdown, TS
  `TestRuntime`, `TestScheduler`, `TestClock`, and testing helpers
- Layer 2.0 dependency graph helpers: `Layer`, `LayerContext`,
  `ServiceTag`, `makeServiceTag`, `layerValue`, `layerEffect`,
  `defineService`, `getService`, `getServices`, `useService`,
  `useServices`, `composeAll`, `mergeAll`, `makeConfigLayer`,
  `makeRuntimeLayer`, `RuntimeService`, `makeTestLayer`, `makeTestLayers`,
  `formatLayerError`, `buildLayer`, `makeLayerScope`, `provide`, and
  `provideLayerContext`
- worker pool, tracing, metrics, runtime observability hooks/events
- typed errors
- runtime engines and capabilities
- streams, buffers, queues, hubs, pipelines, chunks, operators, and root-level
  `Stream` / `Pipeline` DX facades

When adding a root export:

- Check whether it belongs in core or a subpath.
- Avoid exporting test/benchmark/internal implementation details.
- Add or update docs/examples when the export is user-facing.
- Keep `Cause<E>` compatible with typed failures, defects, interruptions, and
  composed `Then` / `Both` failure trees.

## Core export: `brass-runtime/core`

Source: `src/core/index.ts`

This is the preferred stable core surface for new imports. It intentionally
exports effect/runtime/resource/layer/schedule/observability helpers without
the lower-level engine, scheduler queue, ring-buffer, and WASM bridge internals
that remain available from the root export for compatibility.

Observability helpers include `RuntimeHooks`, `RuntimeEvent`,
`RuntimeEventRecord`, `EventBus`, `makeRuntimeRecorder`, `consoleJsonLogger`,
`RuntimeRegistry`, `dumpAllFibers`, and `InMemoryTracer`. Core also exposes
`Resource`, `makeResource`, `resourceAll`, `Schedule` constructors/combinators,
`Schedule.driver` / `makeScheduleDriver`, runtime-clock-aware schedule runners,
supervisor APIs, `makeRuntime` / `runPromise` / `runExit`, and Layer 2.0
primitives for typed service tags, immutable contexts, scoped memoized builds,
multi-layer `Layer.all(...)` composition for independent layers,
`Layer.composeAll(...)` for ordered context graphs, typed `Layer.use(...)` /
`Layer.useAll(...)` accessors, schema-backed config layers, runtime service
layers, test-service replacement layers, missing-service formatting, and
idempotent release.

## HTTP export: `brass-runtime/http`

Source: `src/http/index.ts`

Recommended API order:

- `makeDefaultHttpClient` for the one-stop default client with JSON/text
  helpers, lifecycle presets (`production`, `default`, `balanced`,
  `highThroughputProxy`, `proxy`, `minimal`),
  compression, stats, cache controls, `cancelAll`, and middleware integration.
- `HttpClientService` and `makeDefaultHttpClientLayer` for optional Layer/DI
  application graphs with owned default-client lifecycle.
- `makeHttpRouter`, `route` / `httpRoute`, and `makeNodeHttpServerResource`
  for the first-party HTTP server MVP: Node adapter, simple router,
  effect-based middleware, schema validation, observability, runtime
  health/readiness probes, typed path params, and managed `.listen()`
  lifecycle.
- `HttpServer` for the discoverable server DX object: routes, router, listen,
  resource, JSON/text/empty responses, health/readiness routes, and simple
  middleware helpers.
- `httpClient` for day-to-day typed text/JSON calls.
- `s` / `schema` and `validatedJson` for dependency-free HTTP JSON
  validation with typed validation errors.
- `httpClientBuilder` / `makeHttpClientBuilder` for a discoverable builder
  API over the default client presets and lifecycle layers.
- `adaptiveLimiterPresets` / `makeAdaptiveLimiterConfig` for documented
  `conservative`, `balanced`, and `aggressive` adaptive concurrency baselines.
- `makeHttpClient` / `makeLifecycleClient` for cache, deduplication, priority
  queues, retry, lifecycle events, stats, and bulk cancellation.
- `makeHttp` / `makeHttpStream` for low-level wire behavior and middleware
  authors.
- `HttpTransport`, `HttpStreamTransport`, `makeFetchTransport`, and
  `makeFetchStreamTransport` for replacing the default fetch-backed transport
  with an effect-based backend such as Axios, undici, or test doubles.
- `makeNodeHttpProxyClient`, `makeNodeHttpTransport`, `NodeHttpTransport`, and
  `NodeHttpTransportConfig` for Node-only BFF/proxy workloads that should use
  `node:http` / `node:https` keep-alive agents instead of the default fetch
  backend.
- `makePromiseHttpTransport`, `promiseHttpTransport`, and
  `normalizeHttpHeaders` for adapting Promise-based clients without writing
  `Async.async` / `Cause.fail` plumbing in consuming projects; the fluent
  builder supports `requestConfig(...).send(...).json()` for
  Axios/Fetch-shaped responses with automatic `AbortSignal` injection.
- `toHttpError`, `isAbortHttpError`, `isTimeoutHttpError`,
  `isFetchHttpError`, `httpErrorStatus`, `isRetryableHttpStatus`, and
  `isRetryableHttpError` for normalizing external client failures
  (including Axios-like `response.status`, aborts, and timeout codes) and
  deciding retryability.
- `HttpRequestPolicy`, `HttpRequestPolicyRef`, `HttpPolicyPresets`,
  `ResolveHttpRequestPolicyOptions`, `defineHttpPolicyPresets`, `httpPolicy`,
  `getHttpRequestPolicy`, `withHttpRequestPolicy`, and `withHttpPolicyPresets`
  for structured
  per-request execution knobs (`preset`, `priority`, `dedupKey`, `retry`,
  `poolKey`, `lane`) while preserving legacy top-level request fields.
- `DefaultHttpClientConfig.policyPresets` for resolving `policy: "name"` and
  `policy: { preset: "name", ...overrides }` before lifecycle middleware.
- `httpClientWithMeta` for metadata-oriented compatibility helpers.

Primary categories:

- low-level HTTP client and request/response types
- effect-based transport boundary with fetch as the default implementation
- structured per-request policy shared by transport, retry, deduplication,
  priority scheduling, pool/circuit-breaker keying, and DX request helpers
- ergonomic HTTP client helpers
- HTTP server router, Node adapter, response helpers, and server resources
- HTTP runtime probe helpers: `makeRuntimeHealthRoute` and
  `makeRuntimeReadinessRoute`
- production HTTP client presets (`minimal`, `proxy`, `highThroughputProxy`, `balanced`, `default`, `production`)
- dependency-free schema validation for JSON responses
- builder API for default HTTP client configuration
- adaptive limiter presets, diagnostics, and public config helper
- pool, circuit breaker, tracing, validation
- lifecycle cache/dedup/priority/stats APIs
- retry middleware
- retry middleware accepts an optional declarative `Schedule` for retry delays
  while preserving `Retry-After`, max retries, elapsed-budget behavior, and
  `onScheduleDecision` observability through the Schedule 2.0 driver
- response and request compression middleware
- request batching middleware
- connection pre-warming utilities and middleware

## HTTP testing export: `brass-runtime/http/testing`

Source: `src/http/testing.ts`

Dependency-free helpers for users' test suites:

- `makeMockHttpClient`, `makeSequenceHttpClient`,
  `makeMockDefaultHttpClient`, and `makeMockDefaultHttpClientLayer`
- `makeHttpResponse`, `makeTextHttpResponse`, `makeJsonHttpResponse`
- `runHttpEffect`
- `installMockFetch`, `withMockFetch`
- `makeFetchResponse`, `makeJsonFetchResponse`

## Schema export: `brass-runtime/schema`

Source: `src/schema/index.ts`

Dependency-free validation DSL shared by HTTP and any future package area that
needs runtime data validation:

- `s` / `schema` / `Schema`
- `Schema`, `InferSchema`, `SchemaResult`, `SchemaIssue`
- primitive/object/array/record/union/literal/enum/custom schemas
- shortcuts: `email`, `url`, `uuid`, `int`, `positive`, `nonEmptyString`, `dateIso`
- `optional`, `nullable`, `refine`, `transform`
- `formatIssues`, `validateValue`, `parseConfig`, `formatConfigError`,
  `isConfigValidationError`
- `SchemaValidationException`, `ConfigValidationError`

When changing HTTP API:

- Keep wire/content/meta separation clear.
- Keep lazy execution and cancellation semantics.
- `postJson(..., body, { bodySchema })` should infer the request body type from
  `bodySchema` and validate it before network I/O.
- Public error helpers live in `src/http/errors.ts` and are exported from
  `brass-runtime/http`.
- `AdaptiveLimiter` exposes per-key TTL eviction, explicit warmup,
  `probeJitterRatio`, slow-start recovery, `headroomStrategy`,
  `baselineStrategy`, `decreaseCooldownSamples`, limit-change `history(key)`,
  weighted windows via `windowDecayFactor`, multi-signal error gradients via
  `errorWeight`, priority queue/load-shedding knobs, `PoolRejected.retryAfterMs`
  backoff hints, `markCircuitOpen(key)`, diagnostics (`keys`, `snapshot`,
  `dump`) with utilization/throughput/error rate, and `destroy()`/`shutdown()`.
- `AdaptiveLimiterConfig.preset` accepts `conservative`, `balanced`, and
  `aggressive`; caller overrides apply on top of the selected preset.
- Update `docs/http.md` and `src/http/README.md` for user-visible behavior.
- Add focused tests under `src/http/__tests__`.

## Observability export: `brass-runtime/observability`

Source: `src/observability/index.ts`

This is the preferred production export surface for taking runtime signals out
of process without adding mandatory vendor dependencies.

Primary categories:

- Prometheus text formatting and registry exporters for `MetricsRegistry`
- OTLP JSON/HTTP exporters for metrics and spans
- runtime metrics sink for `EventBus.subscribeHooks`
- structured log sink plus effect-level logging helpers
- `withSpan` and `spanEvent` for trace spans across effect composition
- `makeObservability` production preset with `flush()` and `shutdown()`
- `ObservabilityService`, `makeObservabilityLayer`,
  `makeObservedRuntimeLayer`, and `makeObservedHttpClientLayer` for optional
  Layer/DI wiring across observability, runtime, and HTTP without making any
  factory mandatory.
- `withHttpObservability` middleware for HTTP client metrics, logs, spans, and
  W3C `traceparent` injection, including request-policy context in logs/spans
  and opt-in policy metric labels. Hot proxy paths can use
  `spans: { events: false, sampleRate }` plus `spanSink` to emit sampled HTTP
  spans without enabling global runtime hooks.
- `HTTP_OBSERVABILITY_CONTRACT` for stable dashboard metric names, label names,
  span attribute names, and structured log message names
- adaptive limiter gauges and HTTP span attributes when the wrapped client
  exposes an owned limiter
- W3C trace-context helpers (`parseTraceparent`, `extractTraceContext`,
  `formatTraceparent`, `injectTraceContext`) plus request adapters for seeding
  runtime traces from incoming headers
- production hardening helpers for exporter pipelines, sampling, redaction,
  metric-cardinality limiting, environment presets, no-op setup, and inbound
  adapters for Fetch/Node/Express/Fastify-style request objects
- `makeOtlpOptions` for turning a backend-neutral OTLP HTTP collector endpoint
  into metrics/traces/logs URLs while forwarding headers, custom `fetch`,
  timeout, retry, pipeline tuning, and optional signal selection
- OTLP log export, server-side HTTP request metrics/spans, span retention
  pruning, single-flight flush behavior, collector smoke script, and
  observability benchmark budgets
- runtime health helpers: `makeRuntimeHealth`, `runtimeHealth`, `readiness`,
  and `healthToHttpResponse` for runtime/fiber/scope/scheduler plus registered
  circuit breaker/adaptive limiter health
- runtime supervisor events are counted by runtime metrics sinks and are
  available to structured log/tracing sinks via `RuntimeHooks`

When changing observability API:

- Keep exporters dependency-free and backend-neutral.
- Do not let sink/exporter failures affect effect semantics.
- Keep high-cardinality labels opt-in.
- Add tests under `src/observability/__tests__`.

## Performance export: `brass-runtime/perf`

Source: `src/perf/index.ts`

This is the built-in performance profiling surface for runtime and HTTP work.
It is intentionally a separate subpath because it depends on runtime, HTTP, and
observability modules.

Primary categories:

- `makePerfRecorder` and `summarizePerfEvents` for low-overhead local
  measurement with a bounded ring buffer.
- `captureMemorySnapshot`, `diffMemorySnapshots`, and
  `profileMemoryRetention` for heap/rss/external memory reports with optional
  forced GC.
- `profileRuntimePrimitives` for sampled runtime primitive throughput.
- `diagnoseRuntimeProfile` for hot primitive, fiber pressure, and hook/recorder
  diagnostics.
- `profileRuntimeAb` / `formatRuntimeAbReport` for runtime-only baseline vs
  candidate comparisons.
- `profileRuntimeSoak` / `formatRuntimeSoakReport` for repeated runtime-only
  soak profiles.
- `runRuntimePerfBudget` for CI-friendly runtime profiler budgets.
- `profileHttpLayers` for local HTTP layer comparison across `node:http`, wire
  client, default presets, adaptive limiter, and observability.
- `profileHttpMemoryLab` / `formatHttpMemoryLabReport` for long-run HTTP
  memory comparisons with heap/rss totals, heap per 10k requests, GC signal,
  and per-variant verdicts.
- `createPerfHistoryEntry`, `recordPerfHistoryRun`, `readPerfHistory`,
  `savePerfBaseline`, `loadPerfBaseline`, `comparePerfToBaseline`, and
  `formatPerfBaselineComparison` for local JSONL perf history and named
  baseline regression checks.
- `recommendPerformance` for heuristic warnings and next actions.
- `runBrassPerformanceProfile` and `formatPerformanceReport` for the complete
  report used by `npm run perf`, `npm run perf:json`, `npm run benchmark:perf`,
  `npm run perf:history`, and the `brass-perf` binary.

When changing performance API:

- Keep profiler defaults small enough for local iteration.
- Keep long, stable regression checks in `src/benchmarks` and budget scripts.
- Do not make core depend on HTTP or observability.
- Prefer JSON-friendly report shapes.

## Agent export: `brass-runtime/agent`

Source: `src/agent/index.ts`

Primary categories:

- agent state, reducer, decisions, events, config
- project commands/profile/context discovery
- patch quality, rollback safety, redaction, language, batch
- permissions, approvals, policy, retry, timeout, patch tools
- node services for shell, filesystem, patching, config, workspace discovery
- LLM adapters

When changing agent API:

- Preserve boundaries in `docs/agent-boundaries.md`.
- Keep CLI/node adapters separate from pure core logic.
- Update relevant `docs/agent-*.md` files.

## Generated outputs

Do not edit these directly during normal source changes:

- `dist`
- `coverage`
- `wasm/pkg`

Regenerate them with build/test commands when the task requires generated
artifacts.

## Compatibility checklist

For public API changes:

- Is the export intentional?
- Does the package export map expose it?
- Do both CJS and ESM builds work?
- Do type declarations include it?
- Are README/docs examples still correct?
- Is the change semver-relevant?
