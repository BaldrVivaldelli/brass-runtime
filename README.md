# 🛠️ brass-runtime — Mini ZIO-like runtime in TypeScript

A small experimental runtime inspired by ZIO 2, implemented in vanilla TypeScript and intentionally built without using `Promise` / `async`/`await` as the primary semantic primitive.

Goals: explore typed effects, structured concurrency, fibers, cooperative scheduling, resource safety and streams with backpressure — in a deterministic, pure-FP friendly way.

---

## Key ideas

- Pure, sync core effect: `Effect<R, E, A>` and `Exit<E, A>`.
- An algebraic representation for async work: `Async<R, E, A>` with an explicit interpreter (no `Promise` as runtime primitive).
- A cooperative `Scheduler` for deterministic task interleaving and fairness.
- Lightweight `Fiber`s with cooperative interruption, `join`, and LIFO finalizers.
- Structured `Scope`s that manage child fibers, sub-scopes and finalizers; closing a scope cleans up children deterministically.
- Resource-safe `acquireRelease` semantics (acquire + release tied to scope finalizers).
- Structured concurrency combinators: `race`, `zipPar`, `collectAllPar`.
- ZStream-style streams with backpressure, `Pull` semantics and resource safety.

---

## What's new (recent changes)

- Implemented stream buffering primitives: `buffer` supports bounded buffering with backpressure semantics.
- Added `fromPromiseAbortable` helper to integrate callback/Promise APIs that support `AbortSignal`, preserving cooperative cancellation.
- Added `toPromise` for interop convenience (tests/examples use it to await results from the runtime).
- New example: `src/examples/fromPromise.ts` — demonstrates creating a stream from abortable Promises and using `buffer` + `collectStream`.
- Misc: tests and examples updated to exercise buffer modes and abortable integration.

Branch containing recent work: `feature/buffer-pipes`.

---

## Features (status)

- [x] Sync core: `Effect` (pure FP core)
- [x] Async algebra: `Async` (no Promises in semantics)
- [x] Cooperative `Scheduler`
- [x] Fibers with LIFO finalizers and interruption
- [x] `Scope` (structured concurrency and finalizers)
- [x] `acquireRelease` / resource safety
- [x] Structured concurrency: `race`, `zipPar`, `collectAllPar`
- [x] ZStream-like core (pull-based, resource-aware)
- [x] Buffering in streams (bounded/backpressure modes)
- [ ] Merge / zipPar of streams
- [ ] Hubs / Broadcast / Multicast
- [ ] Pipelines (`ZPipeline`-style)
- [ ] Advanced Channels / Sinks

---

## API highlights

Core types
- `type Exit<E, A> = Success | Failure`
- `type Effect<R, E, A> = (env: R) => Exit<E, A>`
- `type Async<R, E, A> = Succeed | Fail | Sync | Async | FlatMap`

Async constructors
- `asyncSucceed`, `asyncFail`, `asyncSync`, `asyncTotal`
- `async` primitive for callback integration
- `asyncMap`, `asyncFlatMap`
- `fromPromiseAbortable` — integrate APIs that accept `AbortSignal` and support cooperative cancellation

Fibers / Concurrency
- `Fiber<E, A>`: `id`, `status()`, `join(cb)`, `interrupt()`, `addFinalizer(...)`
- `Scheduler.schedule(task: () => void)`
- `race`, `zipPar`, `collectAllPar` — structured concurrency semantics

Scopes & Resource safety
- `class Scope<R>`: `fork`, `subScope`, `addFinalizer`, `close`, `isClosed`
- `acquireRelease(acquire, release, scope)`

Streams (ZStream-like)
- `type Pull<R, E, A> = Async<R, Option<E>, A>`
- `type ZStream<R, E, A> = { open: (scope: Scope<R>) => Pull<R, E, A> }`
- Constructors: `empty`, `streamOf`, `fromArray`, `fromPull`
- Transformations: `map`, `filter`, `fromResource`
- Buffering: `buffer(stream, capacity, mode)` — bounded buffer with backpressure or dropping modes
- Interop: `collectStream`, `runCollect`, `toPromise` for awaiting results in examples

---

## Example (what to look at)

See `src/examples/fromPromise.ts`:
- Shows `fromPromiseAbortable` producing stream elements with cooperative cancellation.
- Demonstrates `buffer` with a bounded capacity and backpressure semantics.
- Uses `collectStream` + `toPromise` to gather stream output in an example-run friendly way.

Do not copy the example here — open `src/examples/fromPromise.ts` for details.

---

## Running examples and tests

- Use your editor's run configuration (WebStorm 2025.3.1 recommended) or run with `ts-node` for quick iteration.
- Typical flow:
  - Install deps: `npm install`
  - Run an example directly: `npx ts-node src/examples/fromPromise.ts` (or configure a Node run config that compiles first)
  - Build: `npm run build` → run compiled files from `dist/`

Adjust the commands to your preferred setup. The project intentionally leaves runtime execution flexible (ts-node, esbuild, tsc + node, etc.).


## Examples — abortable Promises (DX)

Below are small, copy-pasteable examples showing how to use the abortable helpers: `tryPromiseAbortable` and `fromPromiseAbortable`. Use these snippets in examples or docs to demonstrate typical flows: plain signal, env+signal, custom error mapping and cancellation.

### 1) Signal-only thunk (uses `tryPromiseAbortable`)
```typescript
import { tryPromiseAbortable, toPromise, fork } from './src/asyncEffect';

// A thunk that only expects an AbortSignal
const fetchUser = tryPromiseAbortable(async (signal: AbortSignal) => {
  const res = await fetch('https://jsonplaceholder.typicode.com/users/1', { signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
});

async function example() {
  // Await via runtime helper toPromise (env = {})
  try {
    const user = await toPromise(fetchUser, {});
    console.log('user', user);
  } catch (err) {
    console.error('failed', err);
  }
}

// Cancellation example using fork + interrupt
function cancelExample() {
  const fiber = fork(fetchUser as any, {}); // fork returns a Fiber
  setTimeout(() => {
    fiber.interrupt(); // will abort the underlying fetch via AbortController
    console.log('interrupt requested');
  }, 50);
}
```


### 2) Env + signal thunk (uses `fromPromiseAbortable`)
```typescript
import { tryPromiseAbortable, toPromise } from './src/asyncEffect';

type Env = { baseUrl: string };

const fetchWithEnv = tryPromiseAbortable<Env, any>((env, signal) =>
        fetch(`${env.baseUrl}/users/1`, { signal }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
);

async function runEnv() {
  const env: Env = { baseUrl: 'https://jsonplaceholder.typicode.com' };
  try {
    const user = await toPromise(fetchWithEnv, env);
    console.log('user with env', user);
  } catch (e) {
    console.error('error', e);
  }
}

```

### 3) Custom error mapping with fromPromiseAbortable
```typescript
import { fromPromiseAbortable, toPromise } from './src/asyncEffect';

// Map any rejection (including non-abort) to a custom error shape
const safeFetch = fromPromiseAbortable(
  (signal: AbortSignal) => fetch('https://example.com/data', { signal }).then((r) => r.json()),
  (e) => ({ kind: 'FetchError', detail: String(e) })
);

async function runSafe() {
  try {
    const data = await toPromise(safeFetch, {});
    console.log('data', data);
  } catch (err) {
    console.error('mapped error', err);
  }
}
```
---

## Project structure (recommended)
Examples:
- `src/examples/fromPromise.ts` (abortable promise -> stream + buffer)
- `src/examples/resourceExample.ts` (acquire/release + scope)
- `src/examples/fiberFinalizer.ts` (fiber finalizer LIFO semantics)

---

## Design notes

- Determinism: scheduling is explicit and testable via the cooperative `Scheduler`.
- No hidden `Promise` semantics: the runtime models async as an algebraic datatype with an explicit interpreter.
- Resource safety is structural — scopes tie resource lifetimes to lexical structure, ensuring deterministic cleanup.
- Streaming model uses pull-based backpressure; buffering is explicit and configurable.

---

## Contributing

- Branch for current work: `feature/buffer-pipes`.
- Open issues / PRs welcome. Aim for small, focused PRs that preserve the runtime invariants (no hidden Promise semantics).
- Tests should exercise scheduling determinism, interruption guarantees and resource cleanup.

---

## License

MIT License © 2025

---

If you need the README translated to Spanish or a trimmed/expanded version for npm package metadata, a shorter project landing page, or a CHANGELOG entry for the branch `feature/buffer-pipes`, provide the preference and a target audience.
