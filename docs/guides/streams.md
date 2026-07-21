# Streams & Pipelines

brass-runtime provides ZIO-style streams with automatic fusion for high performance.

## Creating streams

```ts
import { fromArray, emptyStream, fromPull } from "brass-runtime";

// From an array (optimized: uses FromArray node, no per-element overhead)
const numbers = fromArray([1, 2, 3, 4, 5]);

// Empty stream
const empty = emptyStream();
```

## Pipelines (transformers)

Pipelines are reusable stream transformers:

```ts
import { mapP, filterP, takeP, dropP, andThen, via } from "brass-runtime";

// Single operators
const doubled = mapP((x: number) => x * 2);
const evens = filterP((x: number) => x % 2 === 0);
const first10 = takeP(10);
const skipFirst5 = dropP(5);

// Compose pipelines (auto-fused!)
const pipeline = andThen(
  andThen(doubled, evens),
  first10
);

// Apply to a stream
const result = await run(collectStream(via(fromArray(data), pipeline)));
```

## Stream Fusion

When you compose pure operators with `andThen`, brass-runtime automatically fuses them into a single loop — no intermediate fibers, no per-element scheduling overhead.

```ts
// This pipeline:
const pipeline = andThen(
  andThen(mapP(x => x * 2), filterP(x => x > 10)),
  takeP(100)
);

// Is executed as a single tight loop equivalent to:
// for (const x of input) {
//   const mapped = x * 2;
//   if (mapped > 10) { output.push(mapped); if (output.length >= 100) break; }
// }
```

**Performance:** 10,000 elements through map+filter in **0.25ms** (vs 84ms without fusion).

## Stream Operators

```ts
import { zip, zipWith, scan, interleave, take, drop, throttle, debounce } from "brass-runtime";

// Zip two streams element-by-element
const pairs = zip(names, ages); // ["Alice", 30], ["Bob", 25], ...

// Running accumulator
const runningSum = scan(numbers, 0, (acc, n) => acc + n);
// 0, 1, 3, 6, 10, 15, ...

// Interleave (alternate elements)
const mixed = interleave(evens, odds);

// Rate limiting
const throttled = throttle(events, 1000); // max 1 per second
const debounced = debounce(keystrokes, 300); // emit after 300ms silence
```

## Collecting results

```ts
import { collectStream } from "brass-runtime";

// Collect all elements into an array
const all = await run(collectStream(stream));

// With pipeline
const filtered = await run(collectStream(via(stream, pipeline)));
```

## Queue-based streams

```ts
import { bounded } from "brass-runtime";

const queue = await run(bounded(100, "backpressure"));

// Producer
for (const item of items) {
  await run(queue.offer(item));
}

// Consumer
const value = await run(queue.take());

// Batch operations
const results = await run(queue.offerBatch(items));
const batch = await run(queue.takeBatch(50));
```

### Bounded queue strategy contract

| Strategy | Full-queue `offer` | Retained order | Producer waits |
| --- | --- | --- | --- |
| `backpressure` | Suspends until a take admits the value; a cancelled offer is removed | FIFO | Yes |
| `dropping` | Returns `false` and keeps the existing values | FIFO for accepted values | No |
| `sliding` | Evicts the oldest value, accepts the newest, and returns `true` | FIFO after eviction | No |

All strategies hand a value directly to an already-waiting taker. `shutdown()`
is idempotent, fails suspended and future takes with `QueueClosed`, resolves
suspended offers with `false`, clears retained values, and leaves no waiters.
`offerBatch` never suspends: a full backpressure queue returns `false` for each
value that cannot be admitted.

`queue.stats()` returns a frozen point-in-time snapshot with occupancy and high
water marks, offered/accepted/dropped/slid totals, waiting producer/consumer
counts, cancellation counts, cumulative/max wait durations, and values cleared
by shutdown. The optional `now` clock exists for deterministic tests; use a
monotonic source in production when overriding it.

## Performance tips

1. **Use `andThen` for composition** — triggers automatic fusion
2. **Use `fromArray` for known data** — uses optimized FromArray node
3. **Use `via` instead of calling pipeline directly** — enables fusion fast-path
4. **Batch queue operations** — `offerBatch`/`takeBatch` for bulk work
