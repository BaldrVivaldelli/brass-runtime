# WASM stream chunks

This adds an optional WASM-backed chunk buffer for `ZStream`.

The goal is not to move all stream semantics to Rust. The goal is to make the hot path chunk-aware so downstream operators can process arrays/batches instead of one element at a time.

## API

```ts
import { chunks, chunksP, mapChunksEffectP } from "brass-runtime";
```

### Direct stream API

```ts
const chunked = chunks(stream, 1024, { engine: "wasm" });
```

`chunked` has type:

```ts
ZStream<R, E, readonly A[]>
```

### Pipeline API

```ts
const batched = via(stream, chunksP<number>(1024, { engine: "wasm" }));
```

### Effectful chunk mapping

```ts
const processed = via(
  stream,
  mapChunksEffectP(1024, (chunk) =>
    asyncSucceed(chunk.map((n) => n * 2))
  , { engine: "wasm" })
);
```

## Engine modes

```ts
{ engine: "js" }    // always JS arrays
{ engine: "wasm" }  // require wasm/pkg
{ engine: "auto" }  // WASM when available, otherwise JS fallback
```

## Why this shape

Crossing Node/JS ↔ WASM for every element can be slower than plain JS. This implementation makes WASM useful as a chunk boundary and gives the rest of the stream pipeline a batch-oriented representation.

The next optimization step would be to add specialized Rust operations for primitive chunks, for example numeric `sum`, `min`, `max`, `filterGt`, or binary/typed-array transforms. Generic JS callbacks should stay in TS.
