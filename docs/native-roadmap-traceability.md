# Native roadmap traceability

Source: `INFORME_ARQUITECTURA_Y_RUTA_NATIVA_VSCODE.md` (2026-07-21).

Status meanings: **done** has direct code/test/document evidence; **partial**
has an implemented subset but not its complete exit criterion; **pending** has
no sufficient current evidence. This file must not mark an item done from
intent or from an unrelated green test.

## Cross-area recommendations

| ID | Requirement | Status | Current evidence / next proof |
| --- | --- | --- | --- |
| CORE-1 | Core API maturity and subpath-first policy | done | `docs/api-maturity.md`, `docs/ai/PUBLIC_API.md`; package build/CJS gate remains the regression proof. |
| CORE-2 | Compact low-cost runtime diagnostics | done | Frozen `runtime.diagnostics()` v1 reports fibers/scopes/lanes/finalizers without hooks; finalizer lifecycle events add optional detail. |
| CORE-3 | Parent/child scope, interruption, async resume, finalizer model tests on both engines | done | `native-lifecycle-v1.json`, native Rust corpus test, TS-reference/real-WASM transition test, and structured TS/WASM runtime test cover subscopes, async resume, interrupt/canceler exactly once, LIFO child-before-parent finalizers, metrics, and zero orphans. The corpus exposed and fixed suspended/pending-host counter leaks. |
| CORE-4 | Versioned fork/resume/suspend/heap/fairness budgets | done | `runtime-budgets-v1.json`, `runtime-primitives.bench.ts`, and `benchmark:runtime:primitives:budget` gate TS/WASM fork-complete, suspend-resume, fairness and GC-aware suspended heap/RSS; release checks run the versioned gate. |
| STREAM-1 | Buffer-strategy behavior matrix and occupancy/wait instrumentation | done | `docs/guides/streams.md`; frozen `Queue.stats()` snapshots cover occupancy/high-water marks, outcomes, waiters, wait time, cancellation, and shutdown discards; deterministic tests cover all three policies. |
| STREAM-2 | Slow-consumer and simultaneous-close cancellation tests | done | `queue-stats.test.ts`, existing strategy/fast-path/property tests: suspended producers, cancelled consumers, idempotent close, waiter cleanup, FIFO, and sliding-model coverage. |
| HTTP-1 | Three observable profiles: editor, standard service, proxy | done | Explicit `editor`, `service`, and `highThroughputProxy` presets; `profile` plus frozen redaction-safe `effectiveConfig()` exposes resolved limits/retry/cache/priority/observability; profile tests and `docs/http-middleware-contract.md`. |
| HTTP-2 | Middleware compatibility contract and pairwise composition tests | done | `docs/http-middleware-contract.md` fixes order, immutability, keys, and cancellation ownership; cache/dedup/batch/retry/priority/custom-middleware pair suites pass (120 focused HTTP tests with transport contracts). |
| HTTP-3 | External Promise/Axios/undici transport and real abort contracts | done | Fluent config signal injection, Axios/undici/fetch-shaped response and error fixtures, direct/effect property parity, pre/in-flight abort, plus real local Node transport tests pass. |
| HTTP-4 | Native HTTP only after bottleneck evidence | done as policy | `docs/native-engine-boundary.md`; promotion remains conditional. |
| OBS-1 | One versioned runtime/agent/native event envelope | done | Payload-free `RuntimeBoundaryEvent` v1 is the shared runtime/agent IPC/native operational envelope; protocol v1 strictly validates its exact keys, while CLI events retain their explicit v1 terminal adapter envelope. |
| OBS-2 | TS-WASM and TS-IPC boundary traces, redacted | done | TS-WASM, TS-IPC and IPC-Rust emit duration, bytes, result, correlation, queue/error/cancellation/fallback and available allocation/fiber signals. Exact event allow-lists reject paths/content/secrets; focused tests and the pilot report capture all legs. |
| AGENT-1 | Host-independent `AgentHost` with Node and VS Code adapters | done | Public contract, Node CLI adapter, VS Code callback adapter, trust/lifecycle/persistence, and agent-core execution tests without a `vscode` import. |
| AGENT-2 | Explicit versioned IPC; CLI retained as fallback | done | Native IPC v1 has authenticated handshake, bounded request/response/progress/terminal/cancel/shutdown messages and canonical fixtures; `makeVsCodeNativeSearchPilot` is the direct extension-host composition and the CLI v1 protocol remains terminal/degraded-mode fallback. |
| AGENT-3 | Short-lived scoped approval capabilities | done | SHA-256-bound workspace/goal/action capabilities, expiry, validation, CLI/auto/learning services, and tamper tests. |
| AGENT-4 | Versioned session/workspace state, retention/redaction/encryption option | done | All core stores use the closed `AgentPersistence` v1 catalog with bounded writes and no Node imports; Node/VS Code accept legacy raw state, write v1 expiry envelopes, default session TTL to 24 h, redact secret fields, enforce quotas, and offer codecs; 51 focused adapter/store tests pass. |
| PKG-1 | Rust workspace and pinned toolchain/wasm-pack CI | done | Root `Cargo.toml`, `rust-toolchain.toml`, pinned release workflow, `npm run rust:check`. |
| PKG-2 | SBOM, licenses, and artifact checksums | done | `release:artifacts` generates SPDX 2.3, a complete npm/Cargo license inventory and SHA-256 manifests; release CI uploads metadata plus separately packaged Linux/macOS/Windows pilot binaries. Local generation found 232 packages and zero missing license assertions. |
| PKG-3 | ABI/protocol compatibility changelog | done | `docs/native-compatibility-changelog.md` records ABI, IPC, boundary-event, host and persistence compatibility rules/current v1 changes; canonical fixtures enforce current ABI/protocol shapes. |
| PKG-4 | Explicit lint/quality policy | done | `docs/api-maturity.md`; Rust is gated by fmt/Clippy/tests, TypeScript by `tsc` and tests. |

## Fifteen-step Rust/WASM plan

| Step | Deliverable and exit criterion | Status | Evidence / remaining work |
| ---: | --- | --- | --- |
| 1 | 100% candidate ownership inventory | done | `docs/native-engine-boundary.md` classifies portable, host, UX, and authorization areas. |
| 2 | Approved responsibility boundary with no host permission in core | done | Dependency rule in `docs/native-engine-boundary.md`; dependency-free `brass-engine-core`. |
| 3 | Versioned ABI, handshake, rejection of unknown newer versions | done | `docs/wasm-engine-abi.md`, Rust handshake exports, TS negotiation and tests. |
| 4 | Canonical requests/results/diagnostics/metrics/cancellation fixtures | done | ABI/opcode corpus plus `native-ipc-v1.json` cover request/result/progress/boundary/terminal/cancellation/shutdown and limits; TypeScript and Rust decode/re-encode every canonical request without loss. |
| 5 | Promotion thresholds defined before migration | done | `docs/native-performance-gates.md` fixed parity, fallback, cancellation, memory, gain, idle and error gates before the pilot; the later dated harness applies them without reinterpretation. |
| 6 | Pure `brass-engine-core` without host/WASM dependencies | done | Dependency-free core owns ABI validation, scheduler/fairness, timer wheel, fiber registry, and generational slab; WASM is a conversion/diagnostic adapter. |
| 7 | Bounded input validation and recoverable exposed errors | done | Program/patch/root/opcode/link/budget plus all exposed collection/scheduler/timer/HTTP/retry allocations are bounded; JSON is capped, non-finite retry/registry inputs are rejected, slab/timer exhaustion is recoverable, and exposed serialization has no `expect`. Real-WASM rejection tests pass. |
| 8 | Native unit/property/fuzz tests; fmt/Clippy/tests green | done | Deterministic model/property suites cover scheduler, timer, registry and slab; arbitrary ABI bytes and interleaved state have pinned `cargo-fuzz` targets. fmt, Clippy `-D warnings`, 10 Rust tests, and fuzz compilation pass. |
| 9 | Minimal versioned WASM API | done | Handshake plus strict zero-copy create/drive/provide/interrupt/drop, reusable `reset`, generated `free`, bounded helpers, and real generated-module tests define the WASM v1 surface. |
| 10 | TS adapter negotiation, typed translation, controlled fallback | done | Strict `wasm` negotiation/translation remains fail-fast; explicit `auto` catches initialization/ABI failures only at selection, records actual/requested engine plus stable fallback code, and emits a payload-free correlated boundary event. Contract tests cover fallback and strict failure. |
| 11 | Shared end-to-end TS/WASM/Rust lifecycle corpus | done | One versioned fixture drives the pure Rust `FiberMachine`, TypeScript reference bridge, generated WASM and actual TS/WASM runtimes. It covers value/error, sync/async resumes, flatMap/fold patches, fork, host action, interruption, terminal metrics, parent/child scopes and TypeScript-owned finalizers with 100% transition parity. |
| 12 | Cancellation/restart/crash/memory/orphan lifecycle suite | done | Real-process tests cover cooperative cancel, timeout/drain, crash/restart/rehydration, ordered shutdown and process exit; saturated client control capacity is reserved and tested. WASM reset/lifecycle tests release state. The committed 20-trial native cancellation p95 is 0.426 ms and health reports zero active work. |
| 13 | Redacted ABI/IPC boundary telemetry | done | Shared v1 events cover all three legs with strict payload-free validation; WASM supplies allocation/live-fiber signals, IPC supplies queue/bytes/errors/cancel/fallback, and benchmark/tests assert sensitive paths/content never appear. |
| 14 | Read-only indexing/search pilot with TypeScript fallback | done | `brass-native-service`, client/process owner, bounded async event stream, `NativeSearchPilot` and VS Code composition implement trusted cancelable in-memory search. Canary/restart tests prove no workspace writes/direct access; `auto` falls back deterministically to TS. WASM search is explicitly out of scope by the approved ownership boundary and its optional runtime path remains separately parity-tested. |
| 15 | Evidence-based incremental adoption decision | done | Same-machine TS/WASM/native evidence and commands live in `docs/native-search-pilot-decision.md`. Two final-worktree runs promote read-only editor search: committed p95/CPU improve 85.082%/93.984%, RSS/heap are 106.6%/101.8%, cancellation p95 is 0.426 ms, parity is 100%, and fallback/errors pass. WASM, cold/full indexing, HTTP, agent scheduling, incremental indexing and binary IPC remain no-adopt pending focused evidence; distribution/reversal are documented. |

## Required completion evidence

The roadmap is complete only when every row above is **done**, the relevant
validation matrix commands pass against the current worktree, the native pilot
passes trust/cancellation/restart/saturation tests, and conditional promotions
have an explicit measured adopt/no-adopt record. A generated WASM build or a
narrow unit suite alone is not completion evidence.
