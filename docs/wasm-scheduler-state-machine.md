# WASM scheduler state machine

This change moves the scheduler bookkeeping hot path into `brass-runtime-wasm-engine` while keeping the public TypeScript scheduler API unchanged.

## What moved to Rust/WASM

- scheduler phase: `idle`, `scheduledMicro`, `scheduledMacro`, `flushing`
- bounded task-ref queue
- flush budget accounting
- micro vs macro scheduling policy
- counters for enqueued/executed/dropped tasks
- counters for budget yields and flush cycles

## What stays in TypeScript

- the actual task callbacks
- `queueMicrotask`, `setImmediate`, `MessageChannel`, `setTimeout`
- error logging
- Node/browser integration

This is intentional: WASM should coordinate the scheduler state machine, but it should not execute JS side effects directly.

## Usage

```ts
const scheduler = new Scheduler({ engine: "wasm" });

scheduler.schedule(() => {
  // task body still runs in JS/Node
}, "my-task");
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
  phase: "idle",
  len: 0,
  capacity: 1024,
  scheduledFlushes: 10,
  completedFlushes: 10,
  enqueuedTasks: 1000,
  executedTasks: 1000,
  droppedTasks: 0,
  yieldedByBudget: 0
}
```

## Build

After this patch, rebuild the WASM package locally:

```bash
npm run build:wasm
npm run build
```

The TypeScript changes compile without requiring the WASM artifact, but `engine: "wasm"` requires the generated `wasm/pkg` output at runtime.
