# Public API

This file tracks the package surface that users can import.

## Package exports

Defined in `package.json`:

- `brass-runtime` -> `dist/index.*`
- `brass-runtime/core` -> `dist/core/index.*`
- `brass-runtime/http` -> `dist/http/index.*`
- `brass-runtime/agent` -> `dist/agent/index.*`
- `brass-runtime/package.json`
- `brass-runtime/wasm/pkg/brass_runtime_wasm_engine.js`
- `brass-runtime/wasm/pkg/brass_runtime_wasm_engine_bg.wasm`

CLI:

- `brass-agent` -> `dist/agent/cli/main.cjs`

Bundle entries are defined in `tsup.config.ts`.

## Root export: `brass-runtime`

Source: `src/index.ts`

The root export is compatibility-first. New public APIs should prefer a named
subpath when they belong to an optional subsystem (`brass-runtime/http`,
`brass-runtime/agent`, future stream/runtime subpaths) instead of widening the
root surface by default.

Primary categories:

- effect/core types: `Effect`, `Async`, `Exit`, `Option`, cancel types
- runtime execution: `Runtime`, `fork`, `toPromise`, scheduler/fiber/scope
- resources and structured concurrency helpers
- semaphore, circuit breaker, ref, schedule, shutdown, testing
- layers, worker pool, tracing, metrics
- typed errors
- runtime engines and capabilities
- streams, buffers, queues, hubs, pipelines, chunks, operators

When adding a root export:

- Check whether it belongs in core or a subpath.
- Avoid exporting test/benchmark/internal implementation details.
- Add or update docs/examples when the export is user-facing.

## Core export: `brass-runtime/core`

Source: `src/core/index.ts`

This is the preferred stable core surface for new imports. It intentionally
exports effect/runtime/resource/layer/schedule/observability helpers without
the lower-level engine, scheduler queue, ring-buffer, and WASM bridge internals
that remain available from the root export for compatibility.

## HTTP export: `brass-runtime/http`

Source: `src/http/index.ts`

Recommended API order:

- `httpClient` for day-to-day typed text/JSON calls.
- `makeHttpClient` / `makeLifecycleClient` for cache, deduplication, priority
  queues, retry, lifecycle events, stats, and bulk cancellation.
- `makeHttp` / `makeHttpStream` for low-level wire behavior and middleware
  authors.
- `httpClientWithMeta` for metadata-oriented compatibility helpers.

Primary categories:

- low-level HTTP client and request/response types
- ergonomic HTTP client helpers
- pool, circuit breaker, tracing, validation
- lifecycle cache/dedup/priority/stats APIs
- retry middleware
- response and request compression middleware
- request batching middleware
- connection pre-warming utilities and middleware

When changing HTTP API:

- Keep wire/content/meta separation clear.
- Keep lazy execution and cancellation semantics.
- Update `docs/http.md` and `src/http/README.md` for user-visible behavior.
- Add focused tests under `src/http/__tests__`.

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
