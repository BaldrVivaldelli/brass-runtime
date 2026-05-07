# Getting Started

## Install

```bash
npm install brass-runtime
```

## Your first effect

```ts
import { Runtime, asyncSucceed, asyncFlatMap, asyncFail } from "brass-runtime";

// Create a runtime
const runtime = Runtime.make({});

// Effects are values — they describe what to do, not how
const greet = asyncSucceed("Hello, brass!");

// Run the effect
const result = await runtime.toPromise(greet);
console.log(result); // "Hello, brass!"
```

## Composing effects

```ts
import { asyncSucceed, asyncFlatMap, asyncFail, asyncFold } from "brass-runtime";

// Chain effects with flatMap
const program = asyncFlatMap(
  asyncSucceed(21),
  (n) => asyncSucceed(n * 2)
);
// Result: 42

// Handle errors
const safe = asyncFold(
  asyncFail("oops"),
  (error) => asyncSucceed(`recovered from: ${error}`),
  (value) => asyncSucceed(value)
);
```

## Async operations

```ts
import { async } from "brass-runtime";

// Wrap any callback-based API
const fetchData = async((_env, cb) => {
  const controller = new AbortController();
  
  fetch("https://api.example.com/data", { signal: controller.signal })
    .then(res => res.json())
    .then(data => cb({ _tag: "Success", value: data }))
    .catch(err => cb({ _tag: "Failure", cause: { _tag: "Fail", error: err } }));

  // Return a canceler
  return () => controller.abort();
});
```

## Concurrency with fibers

```ts
import { Runtime, asyncSucceed, asyncFlatMap } from "brass-runtime";

const runtime = Runtime.make({});

// Fork runs an effect in a new fiber (lightweight thread)
const fiber = runtime.fork(longRunningEffect);

// Join waits for the fiber to complete
fiber.join((exit) => {
  if (exit._tag === "Success") console.log(exit.value);
  else console.log("Failed:", exit.cause);
});

// Interrupt cancels a fiber
fiber.interrupt();
```

## Streams

```ts
import { fromArray, collectStream, via, mapP, filterP, andThen } from "brass-runtime";

// Create a stream from an array
const numbers = fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

// Build a pipeline (auto-fused for performance)
const pipeline = andThen(
  mapP((x: number) => x * 2),
  filterP((x: number) => x > 10)
);

// Apply and collect
const result = await runtime.toPromise(collectStream(via(numbers, pipeline)));
// [12, 14, 16, 18, 20]
```

## What's next?

- [Effects & Fibers](./effects-and-fibers.md) — Deep dive into the effect system
- [Error Handling](./error-handling.md) — Typed errors and recovery
- [Streams & Pipelines](./streams.md) — Stream processing with fusion
