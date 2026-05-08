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
- HTTP is a high-level module on top of effects/fibers: `src/http`.
- Brass Agent is an application/library layer: `src/agent`.
- WASM is an optional strict engine/accelerator: `crates/brass-runtime-wasm-engine`, `wasm/pkg`.

Core must not know about HTTP, agent, VS Code, or docs tooling.

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
- Agent subpath and CLI exported at `brass-runtime/agent` and `brass-agent`.
- Rust/WASM engine sources under `crates/`.

When a change touches more than one product, update docs and validation notes in
the same change.

