# WASM scheduler state machine

The scheduler bookkeeping hot path lives in `brass-runtime-wasm-engine` when the scheduler is created with `engine: "wasm"` or `engine: "auto"` and the WASM package is available. The public TypeScript scheduler API remains unchanged.

## What moved to Rust/WASM

- scheduler phase: `idle`, `scheduledMicro`, `scheduledMacro`, `flushing`
- inferred caller lanes from task tags
- one bounded task-ref queue per lane
- round-robin lane rotation
- per-lane execution budget
- global flush budget accounting
- micro vs macro scheduling policy
- global counters for enqueued/executed/dropped tasks
- per-lane counters for enqueued/executed/dropped tasks
- counters for budget yields and flush cycles

## What stays in TypeScript

- the actual task callbacks
- `queueMicrotask`, `setImmediate`, `MessageChannel`, `setTimeout`
- error logging
- Node/browser integration

This is intentional: WASM coordinates scheduler state and returns task refs, but JS still owns and executes side effects.

## Lane inference

Rust and TypeScript now use the same tag convention:

```txt
lane:<caller>|<task-label>
caller:<caller>|<task-label>
<fallback-prefix>#<id>.<task-label>
```

`Runtime.withLane("bff-security/generate")` ultimately schedules fibers with a `lane:` tag, so Brass does not need to know anything about the BFF implementation. It only sees a stable caller key.

When no explicit lane is set, the TypeScript runtime infers a lane once from the first non-Brass callsite and then passes that stable lane to JS or WASM scheduler state. Child fibers inherit their parent lane.

## Bounded queues and budgets

```ts
const scheduler = new Scheduler({
  engine: "wasm",
  laneCapacity: 512,
  laneBudget: 32,
  flushBudget: 1024,
  maxLanes: 256,
});
```

Semantics:

- `laneCapacity`: max queued task refs per lane. When a lane is full, the newly enqueued task is dropped, `droppedTasks` increments, and TS maps the Rust policy to `Scheduler.schedule() === "dropped"`. Runtime fibers fail fast rather than hanging.
- `laneBudget`: max tasks a single lane may run before the scheduler rotates to the next non-empty lane.
- `flushBudget`: max tasks per flush before yielding back to the event loop.
- `maxLanes`: max distinct inferred lanes before new unknown callers are grouped into `overflow`.

## Usage

```ts
const scheduler = new Scheduler({ engine: "wasm" });
const runtime = Runtime.make({}, scheduler).withLane("bff-security/validate");

await runtime.toPromise(effect);
```

For production-safe behavior use auto mode:

```ts
const scheduler = new Scheduler({ engine: "auto" });
```

`auto` uses WASM when `wasm/pkg/brass_runtime_wasm_engine.js` is available and falls back to the JS implementation otherwise.

## Introspection

```ts
console.log(scheduler.stats());
```

The WASM path returns counters from the Rust state machine:

```ts
{
  engine: "wasm",
  fallbackUsed: false,
  data: {
    phase: "idle",
    len: 0,
    capacity: 512,
    scheduledFlushes: 10,
    completedFlushes: 10,
    enqueuedTasks: 1000,
    executedTasks: 1000,
    droppedTasks: 0,
    yieldedByBudget: 0,
    lanes: [
      {
        key: "bff-security/validate",
        len: 0,
        capacity: 512,
        enqueuedTasks: 1000,
        executedTasks: 1000,
        droppedTasks: 0
      }
    ]
  }
}
```

## Build

After changing Rust, rebuild the WASM package locally:

```bash
npm run build:wasm
npm run build
```

The TypeScript changes compile without requiring the WASM artifact, but `engine: "wasm"` requires the generated `wasm/pkg` output at runtime.
