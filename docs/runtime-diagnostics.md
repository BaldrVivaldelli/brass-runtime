# Compact runtime diagnostics

`runtime.diagnostics()` returns a frozen, version-1 snapshot without enabling
runtime hooks. It is intended for health checks, editor status, native-boundary
decisions, and low-frequency operational inspection.

The snapshot contains:

- live, running, suspended, and queued fibers;
- completed, failed, and interrupted totals plus pending host effects;
- total/pending scopes and pending finalizers;
- last and maximum finalizer duration;
- scheduler phase, total queued work, and up to 128 lane occupancy/capacity
  entries.

TypeScript fiber and scope counters are maintained with compact engine/runtime
state. Calling the method does not install an event bus or allocate per-event
records. If a `RuntimeRegistry` is already the active hook, the snapshot uses
its run-state detail; it does not activate one implicitly. WASM values come
from the negotiated engine metrics.

Scope hooks now include `scope.finalizer.add`, `.start`, and `.end`, while
`scope.close` carries finalizer count and duration. These events are for sinks
that already opted into hooks; the compact counters do not depend on them.

The snapshot schema is additive within version 1. A breaking field/meaning
change requires a new version. Lane keys must remain low-cardinality and the
snapshot must never contain effect values, prompts, paths, patches, or secrets.

`RuntimeBoundaryEvent` is the shared version-1 operational envelope used by
runtime, agent IPC, and the native service. Its `ts-wasm`, `ts-ipc`, and
`ipc-rust` legs expose duration, request/response bytes, result, stable error,
correlation, queue depth, and—where the engine provides them—monotonic
allocation units and live fibers. Native progress/terminal messages use the
same IPC version but are lifecycle control records, not telemetry payloads.
The IPC decoder enforces an exact key allow-list so document content, prompts,
paths, patches, and secrets cannot be smuggled into this envelope.
