# Testing Utilities

brass-runtime provides helpers for testing effects deterministically.

## TestRuntime

```ts
import { makeTestRuntime } from "brass-runtime";

const { runtime, run, runExit } = makeTestRuntime();

// run() returns the value (throws on failure)
const value = await run(myEffect);

// runExit() returns the full Exit (never throws)
const exit = await runExit(myEffect);
if (exit._tag === "Success") console.log(exit.value);
else console.log(exit.cause);
```

## Assertion helpers

```ts
import { assertSucceeds, assertFails, assertFailsWith, assertCompletesWithin } from "brass-runtime";

// Assert success with specific value
await assertSucceeds(myEffect, 42);

// Assert failure with specific error
await assertFails(myEffect, "not found");

// Assert failure matching a predicate
await assertFailsWith(myEffect, (e) => e._tag === "NetworkError");

// Assert effect completes within time limit
const result = await assertCompletesWithin(myEffect, 100); // max 100ms
```

## Test effect builders

```ts
import { flakyEffect, delayedEffect, neverEffect } from "brass-runtime";

// Fails N times, then succeeds (for testing retry)
const flaky = flakyEffect(3, "success!", "temporary error");
// Call 1: fails with "temporary error"
// Call 2: fails with "temporary error"
// Call 3: fails with "temporary error"
// Call 4: succeeds with "success!"

// Completes after a delay (for testing timeouts)
const slow = delayedEffect(500, "done");

// Never completes (for testing interruption)
const hanging = neverEffect();
```

## Testing retry logic

```ts
import { flakyEffect, retryN, makeTestRuntime } from "brass-runtime";

const { run } = makeTestRuntime();

it("retries and eventually succeeds", async () => {
  const effect = retryN(flakyEffect(2, "ok", "fail"), 3);
  const result = await run(effect);
  expect(result).toBe("ok");
});

it("fails after exhausting retries", async () => {
  const effect = retryN(flakyEffect(10, "ok", "fail"), 2);
  const exit = await runExit(effect);
  expect(exit._tag).toBe("Failure");
});
```

## Testing timeouts

```ts
import { timeout, delayedEffect, neverEffect, makeTestRuntime } from "brass-runtime";

const { run } = makeTestRuntime();

it("succeeds before timeout", async () => {
  const result = await run(timeout(delayedEffect(10, "fast"), 1000));
  expect(result).toBe("fast");
});

it("times out on slow effect", async () => {
  try {
    await run(timeout(neverEffect(), 50));
    fail("should have thrown");
  } catch (e) {
    expect(e._tag).toBe("TimeoutError");
  }
});
```

## Testing concurrency

```ts
import { makeSemaphore, makeTestRuntime, delayedEffect } from "brass-runtime";

const { run } = makeTestRuntime();

it("limits concurrency", async () => {
  const sem = makeSemaphore(2);
  let maxConcurrent = 0;
  let current = 0;

  const task = sem.withPermit(async((_env, cb) => {
    current++;
    maxConcurrent = Math.max(maxConcurrent, current);
    setTimeout(() => { current--; cb({ _tag: "Success", value: undefined }); }, 10);
  }));

  await Promise.all([run(task), run(task), run(task), run(task)]);
  expect(maxConcurrent).toBeLessThanOrEqual(2);
});
```
