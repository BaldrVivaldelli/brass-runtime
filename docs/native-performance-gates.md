# Native engine performance gates

These gates decide whether a capability remains TypeScript-only, stays optional
in WASM, or is promoted to the future native service. They are not correctness
tests and must run on the same machine, runtime versions, fixture corpus, and
load parameters.

## Mandatory correctness gates

- 100% parity for selected results, failures, wakeups, interruption,
  finalizers, and contract metrics.
- Zero unexpected fallbacks. Explicit `auto` fallback must emit a redacted
  diagnostic with the reason.
- Zero orphaned tasks after cancellation, timeout, restart, or shutdown.
- Invalid and oversized inputs return typed/recoverable errors without panic or
  unbounded allocation.

## Promotion budgets

| Signal | Gate |
| --- | ---: |
| Cancellation acknowledgement p95 | <= 50 ms |
| Candidate JS heap or process RSS | <= 110% of TypeScript baseline |
| Selected workload p95 latency or CPU | at least 15% better than TypeScript |
| Idle native-service CPU | no sustained busy loop; report exact measured value |
| Error rate | no regression from the TypeScript baseline |

Meeting only an average-throughput improvement is insufficient. Reports must
include p50/p95/p99, CPU time, RSS, JS heap, crossing count/bytes, cancellation
latency, error rate, engine/build versions, and fixture hash.

## Reproducible tracks

Existing runtime evidence:

```bash
npm run benchmark:runtime
npm run benchmark:runtime:budget
npm run perf:runtime:ab
npm run perf:runtime:soak
npm run perf:runtime:budget
```

Release-machine evidence is recorded outside Git unless explicitly requested:

```bash
npm run perf -- --profile runtime-ab --record-history --save-baseline native-roadmap-ts
npm run perf:history -- --profile runtime-ab
```

The native indexing pilot uses one isolated-process harness for the identical
TypeScript/Rust corpus and records WASM as not applicable to search under the
approved ownership boundary:

```bash
npm run benchmark:native:pilot
```

The 2026-07-21 record is `docs/evidence/native-search-pilot-2026-07-21.json` and
the gate interpretation is `docs/native-search-pilot-decision.md`. Read-only
editor search is **promoted** after two consecutive final-worktree runs passed
every gate. The committed confirmation recorded 100% result parity, 85.082%
better p95, 93.984% lower query CPU, a 106.6% RSS ratio, a 101.8% JS-heap ratio,
and 0.426 ms cancellation p95. Full replacement indexing, native HTTP, agent
scheduling, incremental indexing, and binary IPC remain outside this promotion.
Any later expansion must rerun the focused harness and replace—not
reinterpret—the dated decision record.
