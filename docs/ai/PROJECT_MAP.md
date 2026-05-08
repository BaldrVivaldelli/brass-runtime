# Project Map

This is the compact map for understanding `brass-runtime` quickly.

## Package entry points

- `src/index.ts` -> package root export `brass-runtime`.
- `src/http/index.ts` -> subpath export `brass-runtime/http`.
- `src/agent/index.ts` -> subpath export `brass-runtime/agent`.
- `src/agent/cli/main.ts` -> CLI binary `brass-agent`.
- `tsup.config.ts` -> CJS, ESM, and JS bundle entries.
- `package.json` -> scripts, exports, package files, CLI bin.

## Core runtime

Paths:

- `src/core/types`
- `src/core/runtime`
- `src/core/runtime/engine`

Purpose:

- Define `Effect`, `Async`, `Exit`, `Cause`, and cancellation types.
- Interpret `Async` values in fibers.
- Own scheduler, scopes, finalizers, runtime hooks, layers, metrics, tracing,
  schedules, semaphores, resources, worker pools, and engine selection.

Read first:

- `src/core/types/asyncEffect.ts`
- `src/core/runtime/runtime.ts`
- `src/core/runtime/fiber.ts`
- `src/core/runtime/scope.ts`
- `src/core/runtime/scheduler.ts`

Tests:

- `src/core/types/__tests__`
- `src/core/runtime/__tests__`

Docs:

- `docs/ARCHITECTURE.md`
- `docs/cancellation.md`
- `docs/observability.md`
- `docs/guides/testing.md`

## Streams

Paths:

- `src/core/stream`

Purpose:

- Provide pull-based streams, buffering, queues, hubs, pipelines, chunks,
  fusion, and stream operators.
- Preserve backpressure, cancellation, and resource safety.

Read first:

- `src/core/stream/stream.ts`
- `src/core/stream/buffer.ts`
- `src/core/stream/queue.ts`
- `src/core/stream/pipeline.ts`

Tests:

- `src/core/stream/__tests__`

Docs:

- `docs/guides/streams.md`
- `agent.md` stream and pipeline sections

## HTTP

Paths:

- `src/http`
- `src/http/retry`
- `src/http/lifecycle`
- `src/http/compression`
- `src/http/adaptiveLimiter`
- `src/http/prewarm`
- `src/http/optics`

Purpose:

- Provide a lazy, cancelable HTTP client on top of `Async`.
- Keep wire, content, metadata, lifecycle, retry, compression, batching,
  pre-warming, adaptive concurrency, tracing, and validation concerns separated.

Read first:

- `src/http/client.ts`
- `src/http/httpClient.ts`
- `src/http/index.ts`
- `src/http/lifecycle/lifecycleClient.ts`
- `src/http/lifecycle/batch.ts`
- `src/http/retry/retry.ts`
- `src/http/compression/middleware.ts`
- `src/http/adaptiveLimiter/adaptiveLimiter.ts`
- `src/http/prewarm/prewarmManager.ts`

Tests:

- `src/http/__tests__`
- `src/http/lifecycle/__tests__`
- `src/http/prewarm/__tests__`
- `src/http/adaptiveLimiter/__tests__`

Docs:

- `docs/http.md`
- `src/http/README.md`
- `src/http/lifecycle/README.md`
- `src/http/prewarm/README.md`

## Brass Agent

Paths:

- `src/agent/cli`
- `src/agent/core`
- `src/agent/node`
- `src/agent/tools`
- `src/agent/llm`
- `extensions/vscode-brass-agent`

Purpose:

- Inspect workspaces, discover commands/context, ask an LLM for patches, apply
  or roll back changes under policy, and expose CLI/VS Code surfaces.

Read first:

- `src/agent/core/runAgent.ts`
- `src/agent/core/contextDiscovery.ts`
- `src/agent/core/projectCommands.ts`
- `src/agent/core/projectProfile.ts`
- `src/agent/cli/main.ts`

Docs:

- `docs/agent-boundaries.md`
- `docs/agent-project-intelligence.md`
- `docs/agent-context-discovery.md`
- `docs/agent-cli.md`
- `docs/agent-vscode-install.md`

## WASM

Paths:

- `crates/brass-runtime-wasm-engine`
- `src/core/runtime/engine/WasmFiberEngine.ts`
- `src/core/runtime/wasmModule.ts`
- `src/http/wasmPermitPool.ts`
- `src/http/retry/wasmRetryPlanner.ts`
- `wasm/pkg` generated package output

Purpose:

- Provide strict WASM-backed state machines/engine pieces.
- Do not silently fall back to TypeScript when a caller requests WASM.

Docs:

- `docs/wasm-fiber-engine.md`
- `docs/wasm-scheduler-state-machine.md`
- `docs/wasm-bounded-queues.md`
- `docs/wasm-engine-observability-benchmarks.md`

## Benchmarks

Paths:

- `src/benchmarks`
- `src/core/runtime/bench`

Purpose:

- Track runtime and HTTP lifecycle overhead.
- Keep benchmark thresholds separate from correctness tests.

Commands:

- `npm run benchmark`
- `npm run benchmark:json`

## Where to start by task

- Runtime semantics: start in `docs/ai/INVARIANTS.md`, then `asyncEffect.ts`,
  `fiber.ts`, `runtime.ts`, and adjacent tests.
- Cancellation bug: start in `scope.ts`, `fiber.ts`, `runtime.ts`, and
  `docs/cancellation.md`.
- Stream bug: start in `stream.ts`, `queue.ts`, `buffer.ts`, and stream tests.
- HTTP behavior: start in `client.ts`, `httpClient.ts`, relevant middleware,
  and `src/http/__tests__`.
- HTTP compression: start in `src/http/compression/middleware.ts` and
  `src/http/__tests__/compression.property.test.ts`.
- HTTP batching: start in `src/http/lifecycle/batch.ts` and
  `src/http/lifecycle/__tests__/batch.property.test.ts`.
- HTTP prewarm: start in `src/http/prewarm/prewarmManager.ts` and
  `src/http/prewarm/__tests__/prewarmManager.test.ts`.
- HTTP adaptive concurrency: start in `src/http/adaptiveLimiter/adaptiveLimiter.ts`
  and `src/http/adaptiveLimiter/__tests__/`.
- Agent behavior: start in `src/agent/core`, then CLI/node adapters.
- Export/package issue: start in `package.json`, `tsup.config.ts`, `src/index.ts`,
  `src/http/index.ts`, and `src/agent/index.ts`.
