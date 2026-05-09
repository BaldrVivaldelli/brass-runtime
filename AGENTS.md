# brass-runtime agent guide

This file is the fast path for humans and coding agents working in this repo.
Use it together with the focused context docs under `docs/ai/`.

## Start here

- Project map: `docs/ai/PROJECT_MAP.md`
- Non-negotiable invariants: `docs/ai/INVARIANTS.md`
- Validation by change area: `docs/ai/VALIDATION_MATRIX.md`
- Public API/export surface: `docs/ai/PUBLIC_API.md`
- Context command: `npm run context`

For a compact view of the current workspace:

```bash
npm run context
npm run context -- --changed
npm run context -- --module http
```

## Mental model

`brass-runtime` is a small ZIO-like runtime for TypeScript.

- Core describes and interprets effects: `src/core/types`, `src/core/runtime`.
- Streams are library code on top of core: `src/core/stream`.
- Schema is a tiny first-party validation module: `src/schema`.
- HTTP is a high-level module on top of effects/fibers: `src/http`.
- Brass Agent is an application/library layer: `src/agent`.
- WASM is an optional strict engine/accelerator: `crates/brass-runtime-wasm-engine`, `wasm/pkg`.

Core must not know about HTTP, agent, VS Code, or docs tooling.

## Schema module

`src/schema` is first-party and dependency-free by design. Do not add Zod,
Valibot, Yup, Ajv, or other validation dependencies for package runtime
validation unless the task explicitly changes that product decision.

Key public exports:

- `Schema` / `s`: schema builders.
- `InferSchema`: static inference from first-party schemas.
- Common shortcuts include `email`, `url`, `uuid`, `int`, `positive`,
  `nonEmptyString`, and `dateIso`.
- `validateValue`, `formatIssues`: reusable validation helpers.
- `parseConfig`, `ConfigValidationError`: construction-time config validation.

Schema is exported as `brass-runtime/schema` and re-exported through HTTP
validation for the HTTP DX path.

## HTTP module structure

The HTTP module (`src/http`) is composed of several sub-modules:

- **Wire client** (`client.ts`, `httpClient.ts`): Low-level fetch wrapper with pool, timeout, typed errors.
- **Default client** (`defaultClient.ts`): Recommended one-stop HTTP factory with DX helpers, lifecycle defaults, compression, stats, and middleware integration.
- **Lifecycle** (`lifecycle/`): Middleware composition — dedup, batch, cache, priority, retry, stats.
- **Compression** (`compression/`): Response decompression middleware (gzip, br, deflate) with environment detection.
- **Adaptive Limiter** (`adaptiveLimiter/`): Gradient-based adaptive concurrency control per-key.
- **Prewarm** (`prewarm/`): Connection pre-warming with probes, auto-refresh, and lifecycle integration.
- **Retry** (`retry/`): Retry middleware with backoff, circuit breaker awareness, priority boost.
- **Optics** (`optics/`): Response lenses and transformers.
- **Schema validation** (`validation.ts`): First-party JSON response/request validation integrated with DX helpers.

### Lifecycle middleware stack (innermost to outermost)

```
Wire → Priority → Retry → Cache → Batch → Dedup
```

Each layer is independently optional. Set to `false` or omit to disable.
`makeDefaultHttpClient` applies preset defaults over this lifecycle stack,
adds response compression outside it, and accepts user middleware such as
observability as the outermost layer.

### Key patterns

- All middleware conforms to `HttpMiddleware = (next: HttpClientFn) => HttpClientFn`.
- Effects are lazy `Async` values — side effects only happen when `register` is called.
- Cancellation is ref-counted: cancel functions returned by `register` propagate through the stack.
- Stats are tracked via `LifecycleStatsTracker` and exposed as frozen snapshots.
- Events are emitted via `onEvent` callbacks threaded through config.
- Default HTTP adaptive limiter settings are conservative: warmup samples,
  deadband, capped decreases, and non-1 minimum limits in user-facing presets.
  It also supports per-key TTL eviction, probe jitter, explicit warmup,
  slow-start recovery, proportional/custom headroom, circuit-breaker feedback,
  and explicit `destroy()`/`shutdown()` cleanup. Check adaptive stats before
  treating low throughput as a memory leak.

### HTTP + schema patterns

- `getJson` and `postJson` accept `{ schema }` for runtime response validation.
  The returned `HttpResponse.body` type is inferred from the schema.
- `postJson` accepts `{ bodySchema }` to validate request bodies before calling
  `fetch`; the body argument should be inferred from `bodySchema`. Body
  validation failures are `ValidationError` with `phase: "request"` and must
  not touch the network.
- Response parse/schema failures are `ValidationError` with
  `phase: "response"`.
- Error helpers (`isHttpError`, `isValidationError`, `matchHttpError`,
  `formatHttpError`) live in `src/http/errors.ts`.
- Keep legacy custom validator callbacks compatible with the same validation
  path; first-party schemas are preferred for new code.
- Strip `schema`, `schemaName`, `bodySchema`, and `bodySchemaName` before
  passing request init through to `fetch`.
- Config validation uses the schema module at construction boundaries:
  runtime options, HTTP client configs, lifecycle/default-client configs, and
  observability options should fail with `ConfigValidationError` and clear field
  paths when invalid.
- Keep `docs/http-recipes.md` current when adding high-level HTTP workflows.

## Editing rules

- Preserve existing public exports unless the task explicitly changes API.
- Do not edit generated outputs (`dist`, `coverage`, `wasm/pkg`) unless the task is a build/release task.
- Prefer local patterns over new abstractions.
- Keep `Promise` usage at explicit interop/host boundaries.
- Keep async work owned by a fiber/scope; avoid detached background work.
- Keep tests close to the changed module and add property tests when an invariant is broad.

## Validation shortcuts

Baseline confidence:

```bash
npm run test:types
npm test
```

Before changing public package shape:

```bash
npm run build
npm run validate:cjs
```

`npm run build` requires `wasm-pack` and a valid WASM toolchain.

## Current repo shape

The repo intentionally contains multiple products:

- Runtime package exported at `brass-runtime`.
- HTTP subpath exported at `brass-runtime/http`.
- Schema subpath exported at `brass-runtime/schema`.
- Agent subpath and CLI exported at `brass-runtime/agent` and `brass-agent`.
- Rust/WASM engine sources under `crates/`.

When a change touches more than one product, update docs and validation notes in
the same change.

## HTTP sub-modules quick reference

| Module | Path | Key export | Purpose |
|--------|------|-----------|---------|
| Default Client | `src/http/defaultClient.ts` | `makeDefaultHttpClient` | One-stop HTTP client with default presets and JSON/text helpers |
| Compression | `src/http/compression/` | `makeCompressionMiddleware` | Transparent gzip/br/deflate decompression |
| Batching | `src/http/lifecycle/batch.ts` | `withBatch` | Time-window request coalescing with split |
| Prewarm | `src/http/prewarm/` | `makePrewarmManager` | Proactive TCP+TLS connection establishment |
| Adaptive Limiter | `src/http/adaptiveLimiter/` | `AdaptiveLimiter` | Gradient-based dynamic concurrency control |
| Dedup | `src/http/lifecycle/dedup.ts` | `withDedup` | Ref-counted request deduplication |
| Cache | `src/http/lifecycle/responseCache.ts` | `withCache` | LRU + TTL + stale-while-revalidate |
| Priority | `src/http/lifecycle/priorityScheduler.ts` | `withPriority` | Priority queue for request scheduling |
| Retry | `src/http/retry/retry.ts` | `withRetry` | Backoff with circuit breaker awareness |

### Testing patterns for HTTP middleware

- Property tests use `fast-check` with 100+ iterations.
- Use `vi.useFakeTimers()` for timer-dependent middleware (batch, prewarm auto-refresh).
- Use `registerHttpEffect` from `src/http/effectRunner.ts` to run `Async` effects in tests.
- Mock `globalThis.fetch` for integration tests involving the wire client.
- Each middleware has its own test directory close to the source.
