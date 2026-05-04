# WASM bounded queues / ring buffers

`brass-runtime` now has an engine-selectable bounded ring buffer abstraction.

The public queue API remains backward compatible:

```ts
bounded<number>(1024, "backpressure");
```

You can force the ring storage engine when benchmarking:

```ts
bounded<number>(1024, "backpressure", { engine: "wasm" });
bounded<number>(1024, "sliding", { engine: "wasm" });
bounded<number>(1024, "dropping", { engine: "wasm" });
```

Or use the lower-level ring buffer factory:

```ts
import { makeBoundedRingBuffer } from "brass-runtime";

const ring = makeBoundedRingBuffer<number>(1024, 1024, { engine: "wasm" });
ring.push(1);
ring.shift();
```

## Engine semantics

- `engine: "js"`: always uses the TypeScript `RingBuffer`.
- `engine: "wasm"`: requires `wasm/pkg` to expose `BrassWasmRingBuffer`; throws if the WASM package was not rebuilt.
- `engine: "auto"`: uses WASM when available, otherwise falls back to the JS ring buffer.

## Performance note

This is intentionally selective. WASM helps most when the queue is hot, bounded, and dominated by ring-buffer state management. If every operation crosses the JS/WASM boundary with large object payloads, JS can still win. Benchmark both modes before making WASM the default in production.

After changing Rust, rebuild the package:

```bash
npm run build:wasm
npm run build
```
