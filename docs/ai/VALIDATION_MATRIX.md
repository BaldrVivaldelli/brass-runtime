# Validation Matrix

Use this to choose the smallest useful validation set for a change.

## Baseline

Run these for normal code changes:

```bash
npm run test:types
npm test
```

## Full package confidence

Run this before release, package export work, or broad refactors:

```bash
npm run check:full
npm run validate:cjs
```

Notes:

- `npm run build` and `npm run check:full` require `wasm-pack`.
- `npm run check` includes coverage and is slower than the baseline.

## By changed area

| Changed area | Useful commands | Also inspect |
| --- | --- | --- |
| `src/core/types` | `npm run test:types`; `npm test -- src/core/types src/core/runtime/__tests__/flatmap` | `docs/ai/INVARIANTS.md`; `docs/ARCHITECTURE.md` |
| `src/core/runtime` | `npm run test:types`; `npm test -- src/core/runtime/__tests__` | engine parity tests; scheduler/fiber/scope/resource/supervisor invariants |
| `src/core/runtime/engine` | `npm run test:types`; `npm test -- src/core/runtime/__tests__/engine` | `docs/wasm-fiber-engine.md`; TS/WASM parity |
| `src/observability` | `npm run test:types`; `npm test -- src/observability/__tests__ src/core/runtime/__tests__/eventBus.test.ts` | `docs/observability.md`; `docs/ai/PUBLIC_API.md` |
| `src/perf` | `npm run test:types`; `npm test -- src/perf/__tests__`; `npm run perf -- --profile runtime`; `npm run perf:history -- --profile runtime`; `npm run perf:runtime:ab`; `npm run perf:runtime:soak`; `npm run perf:runtime:budget`; `npm run perf:http:memory -- --calls 1000 --concurrency 64 --warmup 0 --variants default-json,default-json-observed`; optional `node --expose-gc --import tsx src/perf/cli.ts --profile http-memory --calls 1000 --concurrency 64 --force-gc` | `docs/performance-profiler.md`; `docs/ai/PUBLIC_API.md` |
| `src/examples/observability*` | `npm run example:observability:express`; `npm run example:observability:fastify`; `npm run example:observability:nest` after installing optional framework deps | `docs/observability-framework-examples.md` |
| observability collector smoke | `npm run build:ts`; `docker compose -f docker-compose.observability.yml up`; `npm run smoke:observability:collector` | `docs/observability-collector-smoke.md`; `docs/otel-collector-smoke.yaml` |
| `src/core/stream` | `npm run test:types`; `npm test -- src/core/stream/__tests__` | stream ordering, backpressure, cancellation |
| `src/http/client.ts`, `src/http/httpClient.ts` | `npm run test:types`; `npm test -- src/http/__tests__/http` | `docs/http.md`; `src/http/README.md` |
| `src/http/server.ts` | `npm run test:types`; `npm test -- src/http/__tests__/server.test.ts src/observability/__tests__/productionObservability.test.ts` | `docs/http.md`; `src/http/README.md`; `docs/observability.md` |
| `src/http/batching.ts`, `src/http/prewarm.ts` | `npm run test:types`; `npm test -- src/http/__tests__/batching.test.ts src/http/__tests__/prewarm.test.ts` | batching encoder/decoder shape; cancellation before flush |
| `src/http/retry` | `npm run test:types`; `npm test -- src/http/__tests__/retry` | retry budgets, aborts, pool interaction |
| `src/http/lifecycle` | `npm run test:types`; `npm test -- src/http/__tests__/cacheKey src/http/__tests__/dedup src/http/__tests__/lifecycleClient src/http/__tests__/lruCache src/http/__tests__/priority src/http/__tests__/responseCache src/http/__tests__/stats src/http/__tests__/middleware` | `src/http/lifecycle/README.md` |
| `src/http/compression` | `npm run test:types`; `npm test -- src/http/__tests__/compression.test.ts` | content/header semantics and environment support |
| `src/agent` | `npm run test:types`; `npm run agent:test:smoke` | `docs/agent-boundaries.md`; config/policy docs |
| native service / IPC pilot | `npm run native:build:debug`; `npm run native:test`; `npm test -- src/agent/native src/agent/node/__tests__/nativeServiceProcess.integration.test.ts src/agent/vscode/__tests__/nativeSearchPilot.test.ts`; promotion evidence: `npm run benchmark:native:pilot` | `docs/native-service-protocol.md`; trust, cancellation, saturation, restart, drain, fallback, redaction |
| `extensions/vscode-brass-agent` | extension build/test command if present; `npm run agent:vscode:package` | VS Code install/clean docs |
| `crates/brass-engine-core`, `crates/brass-runtime-wasm-engine`, `crates/brass-native-service` | `npm run rust:check`; `npm run rust:fuzz:check`; `npm run build:wasm`; `npm run native:build`; `npm test -- src/core/runtime/__tests__/engine src/core/runtime/__tests__/scheduler src/agent/native` | ABI/IPC handshake and limits, Rust code, generated bridge shape, shared fixtures |
| `package.json`, `tsup.config.ts`, exports | `npm run build`; `npm run validate:cjs`; `npm run test:types`; `npm run native:package`; `npm run release:artifacts` | `docs/ai/PUBLIC_API.md`; `docs/native-compatibility-changelog.md`; README install examples; SBOM/licenses/checksums |
| release candidate | `npm run release:check`; optional GC-aware `node --expose-gc --import tsx src/perf/cli.ts --profile http-memory --calls 100000 --concurrency 512 --delay-ms 2 --force-gc` | `docs/release.md`; `CHANGELOG.md`; `docs/recipes/` |
| docs only | link/path review; optional `npm run context` | `docs/README.md`; public API examples |
| benchmarks | `npm run benchmark`; `npm run benchmark:json`; `npm run benchmark:runtime`; `npm run benchmark:runtime:budget`; `npm run benchmark:runtime:primitives:budget`; `npm run benchmark:native:pilot`; `npm run benchmark:http:budget`; `npm run benchmark:observability`; `npm run benchmark:observability:budget`; `npm run benchmark:perf`; `npm run perf:runtime:budget`; related tests | versioned thresholds, warnings, decision reports, profiler output, and heap-per-suspended-fiber details |

## Property tests

Prefer property tests when changing:

- algebra laws (`flatMap`, `map`, reassociation)
- schedulers, queues, ring buffers, caches
- stream ordering/backpressure behavior
- retry/lifecycle policies with many combinations

## Test naming conventions

- Deterministic unit tests use `*.test.ts`.
- Property tests use `*.pbt.test.ts` or `*.property.test.ts`.
- Keep tests under the owning module's `__tests__` directory.
