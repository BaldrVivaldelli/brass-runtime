# Portable Rust verification

`brass-engine-core` has no runtime dependencies and owns ABI decoding,
scheduler/fairness state, the timer wheel, fiber registry, and generational
slab, plus the deterministic host-free fiber transition machine. The WASM
crate converts JavaScript values and serializes diagnostics; it does not own
host permissions or callbacks.

Run the deterministic unit/model-property suite and quality gates with:

```bash
npm run rust:check
```

The model tests execute many deterministic seeds against FIFO/fairness,
deadline/cancellation, wakeup coalescing, and stale-slab-ID invariants. The
`cargo-fuzz` targets exercise arbitrary ABI bytes and interleaved native state
operations:

```bash
npm run rust:fuzz:check
cargo +nightly-2026-07-01 fuzz run --fuzz-dir crates/brass-engine-core/fuzz abi_decoder
cargo +nightly-2026-07-01 fuzz run --fuzz-dir crates/brass-engine-core/fuzz state_models
```

CI pins both the nightly toolchain and `cargo-fuzz`, then compiles both targets.
Long fuzz campaigns belong in a
separate scheduled/security job; any minimized crashing input must be committed
under the matching fuzz corpus and replayed by a deterministic regression test.

`cargo test --workspace` also consumes `fixtures/native-lifecycle-v1.json`.
Vitest consumes the same file for the TypeScript reference and real generated
WASM implementations, so a minimized semantic divergence has one canonical
fixture rather than three engine-specific copies.

The native service additionally round-trips every request in
`fixtures/native-ipc-v1.json`. TypeScript parses the same requests, responses,
progress, terminal, and redacted boundary messages. Real-process Vitest covers
trust before spawn, read-only behavior, timeout/cancellation, saturation,
crash/restart/rehydration, ordered drain, and process release.
