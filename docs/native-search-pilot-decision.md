# Native adoption decision: 2026-07-21

Decision: **promote read-only native search as the preferred editor backend**.
`NativeSearchPilot` and `makeVsCodeNativeSearchPilot` keep `auto` as their
default: they try the Rust service first and retain the deterministic
TypeScript implementation as the diagnosed fallback. This does not change the
main runtime default: TypeScript remains the default fiber engine and WASM
remains explicit/optional.

## Reproduction

```bash
npm run benchmark:runtime:primitives:budget
npm run benchmark:native:pilot
```

The committed native-search record is
`docs/evidence/native-search-pilot-2026-07-21.json`. Its v1 workload used 4,000
deterministically generated in-memory documents, 20 warmups, 200 searches, and
20 cancellation trials. Both workers ran as isolated processes on the same
Ryzen 9 5900X / Linux WSL2 machine with Node 22.23.1 and Rust 1.94.0. The
fixture descriptor SHA-256 is
`9f8e9cfd68282732c67d5d3391c70e22a484a0b9c94443aefb7c04bee23b1acf`.

Two consecutive runs against the final worktree passed every promotion gate.
The first recorded 85.584% p95 and 93.816% CPU improvements, 0.995 RSS and
1.005 heap ratios, and 0.423 ms cancellation p95. The committed confirmation
below recorded 85.082%, 93.984%, 1.066, 1.018, and 0.426 ms respectively.

## Native search results

| Signal | TypeScript | Rust service | Gate/result |
| --- | ---: | ---: | --- |
| Search p50 | 13.688 ms | 2.567 ms | measured |
| Search p95 | 20.794 ms | 3.102 ms | **85.082% better** |
| Search p99 | 25.524 ms | 3.439 ms | measured |
| Query CPU | 3,443.326 ms | 207.150 ms | **93.984% better**; passes 15% gate |
| Initial full index | 26.654 ms | 61.545 ms | native slower; amortized editor startup cost |
| Full replacement reindex | 17.600 ms | 42.491 ms | native slower; no incremental API in v1 |
| JS heap | 13,039,168 B | 13,272,896 B | 101.8%; passes 110% gate |
| Total process RSS | 144,543,744 B | 154,083,328 B | 106.6%; passes 110% gate |
| Cancellation p95 | 0.047 ms | 0.426 ms | passes 50 ms gate |
| Idle CPU | 0% | 0% | passes |
| Startup | n/a | 4.673 ms | measured |
| Errors | 0 | 0 | parity |
| Unexpected fallback | 0 | 0 | passes |

The result digest is identical
(`fc173ca79dbe6ec237e43be4df4afb6ff6783ec0bacf04811fac08f0678d4a07`),
so selected-result parity is 100%. The native path produced 506 correlated
boundary events and 21,257,579 counted request/response bytes, without payload
data. Every predeclared correctness, cancellation, fallback, CPU, heap, RSS,
idle, and error gate passes; the recorded decision is `adopt-native-search`.

Promotion is scoped to long-lived, read-only editor search. Native v1 full
index replacement remains slower, so this decision does not claim faster cold
indexing or incremental reindexing.

## WASM decision

Search is not implemented in WASM: its approved boundary owns fiber
coordination, not indexing. The same-machine v1 primitive track measured:

| Primitive | TypeScript | WASM |
| --- | ---: | ---: |
| Fork/complete | 39.884 µs/fiber | 44.470 µs/fiber |
| Suspend/resume | 40.660 µs/op | 48.104 µs/op |
| Lane fairness | 0.214 µs/task | 0.395 µs/task |
| Suspended heap | 3,911 B/fiber | 5,914 B/fiber |
| Suspended RSS | 5,797 B/fiber | 8,729 B/fiber |

WASM does not meet the 15% latency/CPU promotion gain and exceeds the 110%
memory ratio for suspended fibers. It remains optional and strict when
requested; `auto` may fall back only with a stable redacted diagnostic.

## Conditional backlog decisions

- Native HTTP remains **not adopted**: no transport bottleneck evidence was
  produced, and host fetch/credentials/cookies/abort ownership stays in TS.
- Native agent scheduling remains **not adopted**: search evidence does not
  prove scheduling semantics or performance, and authorization/actions remain
  in `AgentHost`.
- Binary IPC remains **not adopted**. JSON v1 exposes crossing count/bytes and
  full-index cost, but this run did not isolate serialization from copying,
  process scheduling, or index construction as the dominant bottleneck. A
  binary protocol needs a focused A/B result before P3 activation.
- Incremental indexing is not claimed by protocol v1; the measured operation is
  explicitly full replacement. A future update method is a new capability and
  must repeat all gates.

## Distribution and reversal

CI builds separately checksummed Linux, macOS, and Windows editor-companion
bundles with SPDX/license metadata. They remain separate from the generic npm
runtime package because the native backend is editor-specific. Reversal is
immediate: select `ts`, remove/disable the native bundle, or let `auto` fall
back. The service persists no index and has no workspace access, so restart or
reversion rehydrates from TypeScript-owned validated documents without a data
migration.
