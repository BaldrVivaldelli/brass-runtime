# 🛠️ brass-runtime — Mini ZIO-like runtime in TypeScript

A small experimental runtime inspired by **ZIO 2**, implemented in vanilla TypeScript and intentionally built without using `Promise` / `async`/`await` as the **primary semantic primitive**.

`brass-runtime` is the foundation: it provides an effect system, fibers, scheduler, scopes, and streams.
Higher-level modules (HTTP, streaming utilities, integrations) are built **on top of the runtime**, not baked into it.

> You can still interop with the outside world (timers, fetch, Node APIs) via explicit, cancellable bridges such as `fromPromiseAbortable`.

---

## Philosophy

- **Effects are values** — lazy, composable, referentially transparent
- **Async is explicit** — no hidden Promise semantics
- **Concurrency is structured** — fibers, scopes, finalizers
- **Side effects are interpreted** — not executed eagerly
- **Higher-level APIs are libraries, not magic**

If you like ZIO’s separation between `zio-core`, `zio-streams`, and `zio-http`, this project follows the same spirit.

---

## Core concepts

- Sync core effect: `Effect<R, E, A>` and `Exit<E, A>`
- Algebraic async representation: `Async<R, E, A>`
- Cooperative `Scheduler` (observable / testable)
- Lightweight `Fiber`s with interruption & finalizers
- Structured `Scope`s for resource safety
- ZStream-style streams with backpressure

---

## Install

```bash
npm i brass-runtime
```

---

## Quick start

### Run an effect

```ts
import { succeed } from "brass-runtime";
import { Runtime, toPromise } from "brass-runtime/runtime";

const runtime = new Runtime({ env: {} });

const value = await toPromise(succeed(123), runtime.env);
console.log(value); // 123
```

### Structured concurrency with Scope

```ts
import { withScope } from "brass-runtime/scope";
import { Runtime } from "brass-runtime/runtime";

const runtime = new Runtime({ env: {} });

withScope(runtime, (scope) => {
  const f = scope.fork(/* Async effect */);
  // later...
  scope.close(); // interrupts child fibers + runs finalizers
});
```

> `toPromise` is just a convenience bridge for examples/DX. The runtime semantics remain explicit.

---

## Modules built on top of brass-runtime

These are optional layers, implemented using the runtime primitives.

### 🌐 HTTP client (brass-http layer)

A ZIO-style HTTP client built on top of fibers and `Async`.

- Lazy & cancelable HTTP requests
- Explicit wire/content separation
- Middleware-friendly (logging, retry, timeout, etc.)
- Integrated with fiber interruption via `AbortController`

👉 **Docs:** [HTTP module](./docs/http.md)

Example:

```ts
import { httpClientStream } from "brass-runtime/http";
import { toPromise, Runtime } from "brass-runtime/runtime";

type Post = { id: number; title: string; body: string };

const runtime = new Runtime({ env: {} });

const client = httpClientStream({ baseUrl: "https://jsonplaceholder.typicode.com" });

const res = await toPromise(client.getJson<Post>("/posts/1"), runtime.env);
console.log(res.status, res.value.title);
```

---

### 🌊 Streams (ZStream-like)

Pull-based, resource-aware streams with backpressure.

- `ZStream<R, E, A>`
- `Pull` semantics
- Bounded buffers
- Deterministic resource cleanup

Examples:
- `src/examples/fromPromise.ts`
- `src/examples/mergeStreamSync.ts`

---

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Cancellation & Interruption](./docs/cancellation.md)
- [Observability: Hooks & Tracing](./docs/observability.md)
- [HTTP module](./docs/http.md)
- [Modules overview](./docs/modules.md)

---

## What’s new (recent changes)

- Stream buffering with backpressure (`buffer`)
- Abortable async integration (`fromPromiseAbortable`)
- Fiber-safe `toPromise` for examples & DX
- HTTP client module built on top of the runtime

---

## Features (status)

### Runtime (core)
- [x] Sync core: `Effect`
- [x] Async algebra: `Async`
- [x] Cooperative `Scheduler`
- [x] Fibers with interruption & finalizers
- [x] Structured `Scope`
- [x] Resource safety (`acquireRelease`)

### Concurrency & Streams
- [x] `race`, `zipPar`, `collectAllPar`
- [x] ZStream-like core
- [x] Bounded buffers & backpressure
- [x] Stream merge / zip
- [x] Hubs / Broadcast
- [x] Pipelines (`ZPipeline`-style)

### Libraries
- [x] HTTP client
- [ ] Retry / timeout middleware
- [ ] Logging / metrics layers

---

## Design notes

- **No hidden Promises**: async is always modeled explicitly
- **Deterministic execution**: scheduler is observable & testable
- **Resource safety is structural**: scopes guarantee cleanup
- **Libraries compose via functions**: middleware, not inheritance

---

## Contributing

- Runtime invariants matter — avoid sneaking Promises into semantics
- Prefer libraries on top of the runtime over changes in the core
- Small, focused PRs are welcome (your repo may enforce PR-only changes)

---

## License

MIT License © 2025
