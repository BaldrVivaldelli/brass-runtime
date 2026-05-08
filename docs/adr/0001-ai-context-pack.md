# ADR 0001: Maintain an AI Context Pack

Status: accepted

## Context

`brass-runtime` contains a core effect runtime, streams, HTTP modules, WASM
engine pieces, benchmarks, and Brass Agent surfaces. The codebase is still small
enough to navigate manually, but large enough that a contributor or coding agent
needs a compact map before making safe changes.

## Decision

Maintain a small context pack:

- `AGENTS.md` for root-level contributor/agent guidance.
- `docs/ai/PROJECT_MAP.md` for module navigation.
- `docs/ai/INVARIANTS.md` for semantic rules.
- `docs/ai/VALIDATION_MATRIX.md` for test selection.
- `docs/ai/PUBLIC_API.md` for exports and compatibility.
- `scripts/context-pack.mjs` for generated workspace summaries.

The generated context command prints to stdout and does not create tracked
artifacts by default.

## Consequences

- Future changes should update the context pack when they move module
  boundaries, change public API, or add validation expectations.
- Agents can gather focused context without rereading the entire repository.
- The context pack is documentation, not a replacement for tests.

