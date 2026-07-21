# Brass engine ABI v1

Status: **versioned experimental contract**. The binary format is stable within
ABI v1; the WASM engine remains optional and strict when explicitly selected.

The canonical Rust definitions and validators live in
`crates/brass-engine-core`. The TypeScript negotiation and encoder live in
`src/core/runtime/engine/abiContract.ts` and `binaryAbi.ts`.

`fixtures/native-lifecycle-v1.json` is the shared transition corpus. Its
program words round-trip through the TypeScript codec and execute against the
TypeScript reference machine, generated WASM, and the host-independent Rust
`FiberMachine`. Its host-lifecycle fixture is deliberately owned by TypeScript
and runs against both runtime engines to cover parent/child scopes, async
resume, interruption, finalizer order, pending-host counters, and orphan-free
cleanup.

## Handshake

Before copying program data, the TypeScript bridge requires these engine
methods:

| Method | ABI v1 value or meaning |
| --- | --- |
| `abi_version()` | Current engine ABI, currently `1`. |
| `min_compatible_abi_version()` | Oldest host ABI accepted by the engine, currently `1`. |
| `engine_version()` | Crate/package implementation version for diagnostics. |
| `capabilities()` | Bitmask described below. |
| `max_program_words()` | Hard upper bound accepted for a program buffer. |
| `max_patch_words()` | Hard upper bound accepted for a patch buffer. |
| `max_event_batch()` | Hard upper bound for one drive call. |

The host rejects an unknown newer ABI, an ABI range that excludes host v1,
missing required capabilities, malformed values, and advertised bounds above
the host safety contract. There is no silent downgrade. The negotiated
handshake is included in bridge diagnostics.

Callers may provide `boundaryDiagnostics` to the WASM engine. It emits the
shared version-1 `runtime.boundary` envelope for TS-to-WASM create, drive,
resume, patch, interrupt, and drop crossings. Events contain duration, byte
counts, outcome, correlation/subject IDs, and an error code only; the type
cannot carry prompts, paths, patches, source text, or secrets. With no sink,
the hot path performs no event construction or timing calls.

Capability bits:

| Bit | Hex | Capability |
| ---: | ---: | --- |
| 0 | `0x01` | Binary opcode ABI |
| 1 | `0x02` | Zero-copy program/patch buffers |
| 2 | `0x04` | Batched events |
| 3 | `0x08` | Non-JSON metrics snapshot |

All four capabilities are required by the current strict WASM hot path.

## Representation

- Every binary word is an unsigned 32-bit integer.
- Typed-array transfer uses WebAssembly's little-endian linear memory.
- IDs and host references are opaque `u32` values.
- `0xffffffff` is the absent optional-ID sentinel.
- A node is exactly four words: `[opcode, a, b, c]`.
- A terminal or boundary event is exactly five words:
  `[eventKind, fiberId, a, b, c]`.

Program buffer:

```text
[abiVersion, rootNodeId, nodeCount, ...nodeCount * 4 node words]
```

Patch buffer:

```text
[nodeCount, ...nodeCount * 4 node words]
```

Patch roots and node-to-node links are absolute within the complete program,
including nodes that existed before the patch.

Event batch:

```text
[eventCount, ...eventCount * 5 event words]
```

## Opcodes

| Code | Name | `a` | `b` | `c` |
| ---: | --- | --- | --- | --- |
| 0 | Succeed | value ref | 0 | 0 |
| 1 | Fail | error ref | 0 | 0 |
| 2 | Sync | function ref | 0 | 0 |
| 3 | Async | register ref | 0 | 0 |
| 4 | FlatMap | first node | function ref | 0 |
| 5 | Fold | first node | failure function ref | success function ref |
| 6 | Fork | effect ref | optional scope ID | 0 |
| 7 | HostAction | action ref | optional decoder ref | 0 |

Unknown opcodes are rejected before execution. Root, `FlatMap.first`, and
`Fold.first` must address an existing node.

## Events

| Code | Name | `a` | `b` | `c` |
| ---: | --- | --- | --- | --- |
| 0 | Continue | 0 | 0 | 0 |
| 1 | Done | value ref | 0 | 0 |
| 2 | Failed | error ref | 0 | 0 |
| 3 | Interrupted | reason ref | 0 | 0 |
| 4 | InvokeSync | function ref | 0 | 0 |
| 5 | InvokeAsync | register ref | 0 | 0 |
| 6 | InvokeFlatMap | function ref | value ref | 0 |
| 7 | InvokeFoldFailure | function ref | error ref | 0 |
| 8 | InvokeFoldSuccess | function ref | value ref | 0 |
| 9 | InvokeFork | effect ref | optional scope ID | 0 |
| 10 | InvokeHostAction | action ref | optional decoder ref | 0 |

## Limits and errors

ABI v1 limits one program to 1,048,576 nodes (roughly 16 MiB of node words),
4,194,307 program words, 4,194,305 patch words, and 65,536 events per batch.
Normal runtime batches are much smaller. Both sides validate limits before
reserving or copying.

Malformed version, length, count, root, opcode, reference, or limit failures
are recoverable boundary errors. New WASM entrypoints return JavaScript errors;
they do not panic. Runtime failures after a valid program entered the VM remain
typed engine events.

The VM lifecycle surface is deliberately small: construct, create/drive in
bounded batches, provide a host result, interrupt, drop a fiber, `reset()` all
VM-owned state, and the generated `free()` binding. `reset()` releases fibers
and scratch allocations but cannot release TypeScript host references; the
TypeScript engine clears those registries during shutdown. JSON compatibility
entrypoints and stats use recoverable serializer results rather than `expect`.
Collection/scheduler/timer/HTTP/retry helpers enforce their own hard allocation
limits before construction or growth. JSON programs and patches are capped at
64 MiB independently of the binary ABI.

## Verification

- `cargo test --workspace` validates canonical Rust fixtures and malformed input.
- `npm run rust:fuzz:check` compiles arbitrary-byte decoder and interleaved
  state-machine fuzz targets with the pinned nightly toolchain.
- `npm test -- src/core/runtime/__tests__/engine` validates TypeScript
  negotiation, encoding, bridge behavior, and real-WASM parity when built.
- `wasm-input-bounds.test.ts` calls the generated module and proves constructor,
  ABI, retry, serialization, and reset failures are recoverable.
- `npm run build:wasm` must precede release parity checks.
