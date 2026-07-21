# Native engine ownership and boundary

This document is the P0 ownership contract for the TypeScript runtime, the
portable Rust core, the WASM adapter, and the native editor service. It is
normative: moving a capability across this boundary requires benchmark and
security evidence, not only an implementation opportunity.

## Ownership matrix

| Capability or data | Owner today | Portable Rust candidate | Host/UX rule |
| --- | --- | --- | --- |
| Public `Async`, typed errors, and effect construction | TypeScript core | No | The public API and laziness contract stay in TypeScript. |
| JavaScript closures and continuation callbacks | TypeScript engine | No | Rust stores only opaque `u32` references; it never executes a closure. |
| `Promise`, `AbortController`, Node/Electron/VS Code APIs | TypeScript host adapters | No | Every host operation remains cancelable and owned by a fiber/scope. |
| Scope ownership and host-resource finalizers | TypeScript runtime | No, unless a future pure subset is proved | Finalizers that release host resources remain exactly-once TypeScript work. |
| Opcode validation and canonical binary layout | `brass-engine-core` | Yes, implemented | The WASM binding is an adapter over the dependency-free contract. |
| Compact suspended-fiber state and deterministic frames | WASM VM | Yes | Continue extracting only data/state transitions that need no host callback. |
| Ready queues, lane selection, timer wheel, fiber registry and generational slab | `brass-engine-core` | Yes, implemented | WASM only converts JS values and exposes bounded adapter methods; native model/property tests own fairness, deadlines, wake coalescing and stale-ID laws. |
| Host-valued ring/chunk buffers | WASM adapter | Conditional | `JsValue` storage stays at the JS boundary; capacities are bounded and promotion needs a serializable-data workload. |
| HTTP/fetch, cookies, proxies, credentials | TypeScript HTTP/host | No by default | A native transport needs workload-specific evidence and an explicit credential boundary. |
| Agent decisions, permissions, approvals, patch policy | TypeScript agent/extension host | No | A native service may propose declarative work but cannot authorize or apply it. |
| Workspace filesystem, shell, LLM, and secrets | TypeScript `AgentHost` adapters | No direct native access in the pilot | Every call carries policy, deadline, cancellation, and correlation metadata. |
| Indexing, ranking, deterministic search, in-memory cache | `brass-native-service` editor companion | Read-only search promoted; full indexing remains v1 | The extension host supplies bounded content after trust checks. No persisted cache exists in v1; `auto` retains the TS fallback. |
| Renderer UI, diff, progress, approval prompts | VS Code TypeScript | No | Renderer never invokes filesystem, shell, network, or model directly. |

## Allowed dependency direction

```text
TypeScript public/runtime API
  -> TypeScript host adapters
  -> WASM binding -> brass-engine-core

VS Code renderer
  -> extension host / AgentHost
  -> authenticated versioned IPC
  -> native service -> brass-engine-core
```

`brass-engine-core` must remain free of `wasm-bindgen`, `JsValue`, I/O,
filesystem, network, secrets, permission decisions, and TypeScript callbacks.
The WASM and future service crates are adapters; neither may reverse the
dependency into host policy.

## Promotion rule

A candidate crosses into Rust only after it has a canonical fixture corpus,
100% semantic parity for the selected capability, bounded inputs, typed
recoverable failures, lifecycle tests, boundary telemetry, and a reproducible
performance result meeting `docs/native-performance-gates.md`. A failed gate is
a valid no-promotion decision and leaves the TypeScript fallback active.

The 2026-07-21 evidence in `docs/native-search-pilot-decision.md` promotes
read-only native search for the editor path: two final-worktree runs passed all
gates while `auto` retained immediate TS reversal. The evidence does not
promote cold/full indexing. WASM failed its gain/memory gates. Native HTTP,
agent scheduling, incremental indexing, and binary IPC are explicitly not
adopted without new focused evidence.
