# 🛠️ brass-runtime — Mini ZIO-like runtime in TypeScript

A small experimental runtime inspired by **ZIO 2**, implemented in vanilla TypeScript and intentionally built without using `Promise` / `async`/`await` as the primary semantic primitive.

`brass-runtime` is the **foundation**: it provides the effect system, fibers, scheduler, scopes and streams.
Higher-level modules (HTTP, streaming utilities, integrations) are built **on top of this runtime**, not baked into it.

---

## Philosophy

- **Effects are values** — lazy, composable, referentially transparent
- **Async is explicit** — no hidden Promise semantics
- **Concurrency is structured** — fibers, scopes, finalizers
- **Side effects are interpreted** — not executed eagerly
- **Higher-level APIs are libraries, not magic**

If you like ZIO’s separation between `zio-core`, `zio-streams`, and `zio-http`, this project follows the same spirit.

---

## Core concepts (this package)

- Pure, sync core effect: `Effect<R, E, A>` and `Exit<E, A>`
- Algebraic async representation: `Async<R, E, A>`
- Cooperative `Scheduler` for deterministic execution
- Lightweight `Fiber`s with interruption and finalizers
- Structured `Scope`s for resource safety
- ZStream-style streams with backpressure

---

## Modules built on top of brass-runtime

These are **optional layers**, implemented using the runtime primitives.

### 🌐 brass-http (HTTP client)

A ZIO-style HTTP client built on top of fibers and `Async`.

- Lazy & cancelable HTTP requests
- No Promise-based semantics
- Explicit wire / content / metadata separation
- Middleware-friendly (logging, retry, timeout, etc.)
- Integrated with fiber interruption via `AbortController`


👉 [**Read the HTTP module docs:** ](./docs/http.md)

Example:
```ts
const http = httpClient({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

const post = await toPromise(
  http.getJson<Post>("/posts/1"),
  {}
);
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

## Getting Started

👉 **Start here:**  
➡️ [Getting Started](./docs/getting-started.md)

---

## What’s new (recent changes)

- Stream buffering with backpressure (`buffer`)
- Abortable async integration (`fromPromiseAbortable`)
- Fiber-safe `toPromise` for examples & DX
- New HTTP module (`brass-http`) built on top of the runtime

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
- [ ] Hubs / Broadcast
- [ ] Pipelines (`ZPipeline`-style)

### Libraries
- [x] HTTP client (`brass-http`)
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
- Small, focused PRs are welcome

---

## License

MIT License © 2025
