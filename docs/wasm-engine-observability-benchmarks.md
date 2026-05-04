# WASM engine observability and benchmarks

This layer makes `auto` observable instead of implicit.

```ts
type EngineStats<T> = {
  engine: "js" | "wasm";
  data: T;
  fallbackUsed: boolean;
};
```

## Capability detection

```ts
import { runtimeCapabilities } from "brass-runtime";

console.log(runtimeCapabilities());
```

Returns:

```ts
{
  wasmAvailable: boolean;
  wasmFiberEngine: boolean;
  wasmRingBuffer: boolean;
  wasmScheduler: boolean;
  wasmFiberRegistry: boolean;
  wasmStreamChunks: boolean;
}
```

## Runtime stats

```ts
const runtime = Runtime.makeWithEngine({}, "auto");
console.log(runtime.capabilities());
console.log(runtime.stats());
```

`runtime.stats()` now returns `EngineStats<FiberEngineStats>`.

## Scheduler stats

```ts
const scheduler = new Scheduler({ engine: "auto" });
console.log(scheduler.stats());
```

`fallbackUsed: true` means `auto` selected JS because the corresponding WASM capability was not available.

## Ring buffer stats

```ts
const q = makeBoundedRingBuffer<number>(1024, 1024, { engine: "auto" });
q.push(1);
q.shift();
console.log(q.stats());
```

## Stream chunk stats

```ts
const chunker = makeStreamChunker<number>(256, { engine: "auto" });
console.log(chunker.stats());
```

## Benchmarks

Run:

```bash
npm run build:wasm
npm run benchmark wasm-engines
```

JSON output:

```bash
npm run build:wasm
npm run benchmark:json wasm-engines
```

The benchmark report includes the runtime capability snapshot, so results can be compared against whether WASM was actually available.
