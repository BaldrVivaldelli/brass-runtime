# 🧱 ARCHITECTURE — brass-runtime

This document explains the **architectural structure** of `brass-runtime`, how the layers relate to each other, and the design principles behind them.

The architecture is intentionally inspired by **ZIO 2**, but implemented from scratch in **TypeScript**, without relying on `Promise` as the semantic runtime primitive.

---

## High-level overview

```
┌────────────────────────────────────────────┐
│              User Programs                 │
│  (examples, apps, libraries, tests)        │
└────────────────────────────────────────────┘
                ▲
                │
┌────────────────────────────────────────────┐
│           High-level Modules                │
│   (HTTP, Streams, Resources, etc.)          │
└────────────────────────────────────────────┘
                ▲
                │
┌────────────────────────────────────────────┐
│        Core Effect Runtime                  │
│  Async / Effect / Fiber / Scope / Scheduler │
└────────────────────────────────────────────┘
                ▲
                │
┌────────────────────────────────────────────┐
│      JavaScript Host Environment            │
│   (event loop, timers, fetch, callbacks)   │
└────────────────────────────────────────────┘
```

Key idea:
> **Only the core runtime knows about execution.**  
> Everything else is *pure descriptions* interpreted by the runtime.

---

## Core principles

### 1. No Promise-based semantics
- `Promise` is never the semantic primitive.
- Async work is represented explicitly as data (`Async`).
- The runtime *interprets* async effects using callbacks and schedulers.

This ensures:
- Deterministic scheduling
- Cooperative cancellation
- Structured concurrency
- Testability

---

### 2. Lazy by default
All effects are **lazy**:
- Nothing runs until interpreted by a `Fiber`
- Creating an effect is pure and side-effect free

```ts
const eff = http.getJson<Post>("/posts/1")
// nothing has happened yet
```

Execution only begins when:
- Forked into a fiber
- Or awaited via `toPromise` (interop helper)

---

### 3. Structured concurrency
Fibers always belong to a **Scope**.

Rules:
- Child fibers cannot outlive their parent scope
- Closing a scope interrupts all children
- Finalizers run in LIFO order

This prevents:
- Leaked async tasks
- Forgotten cleanups
- Detached background work

---

## Core Runtime Layer

### Main components

```
Async
  │
  ▼
Fiber ── Scheduler
  │
  ▼
Scope ── Finalizers
```

#### `Async<R, E, A>`
- Algebraic data type representing effectful computation
- Variants: `Succeed | Fail | Sync | Async | FlatMap`
- Pure data, no execution

#### `Fiber<E, A>`
- Interpreter of `Async`
- Owns:
  - Stack
  - RunState
  - Interrupt status
  - Finalizers
- Can be:
  - Joined
  - Interrupted
  - Forked

#### `Scheduler`
- Cooperative task queue
- Ensures fairness
- No preemption
- Explicit scheduling boundaries

#### `Scope`
- Lifetime manager
- Owns:
  - Child fibers
  - Sub-scopes
  - Finalizers
- Deterministic cleanup

---

## Streams Architecture

Streams are **pull-based**, inspired by ZIO Streams.

```
ZStream
   │
   ▼
 Pull<R, Option<E>, A>
```

### Characteristics
- Backpressure-aware
- Resource-safe
- Scope-bound
- Deterministic cleanup

### Why pull-based?
- Simpler cancellation semantics
- Natural backpressure
- Easier reasoning about lifetimes

---

## HTTP Module Architecture (brass-http)

HTTP is **not part of the core runtime**.

It is implemented as a **high-level module** built entirely on `Async`.

```
HttpRequest
     │
     ▼
HttpClient (Request => Async)
     │
     ▼
 Middlewares
 (withMeta, logging, retries)
     │
     ▼
 Content helpers
 (getJson, getText)
```

### Important properties
- Fully lazy
- Cancelable via fiber interruption
- Composable via middleware functions
- Environment-aware (baseUrl, headers, auth)

HTTP execution only happens when:
- The returned `Async` is run by a fiber

---

## Middleware model

Middlewares are pure functions:

```ts
type Middleware = (client: HttpClient) => HttpClient
```

They:
- Do not execute effects
- Only transform descriptions
- Compose left-to-right

Examples:
- `withMeta`
- logging
- retries
- tracing
- auth injection

---

## Interop Layer

### `toPromise`
- Thin boundary for examples and DX
- Not part of core semantics
- Converts fiber execution into a `Promise`

### `fromPromiseAbortable`
- Adapts Promise APIs that support `AbortSignal`
- Preserves cooperative cancellation
- Integrates cleanly with fibers

Interop is **explicit and contained**.

---

## What is NOT allowed

By design:
- ❌ Hidden Promises inside effects
- ❌ Detached async work
- ❌ Implicit background execution
- ❌ Fire-and-forget APIs

If something runs:
> It must be owned by a fiber and a scope.

---

## Extension points

Designed to grow horizontally:

- New modules (HTTP, FS, DB, etc.)
- New stream combinators
- New schedulers (priority, test)
- New runtimes (browser, workers)

Without changing the core semantics.

---

## Mental model (TL;DR)

- **Core** = execution + rules
- **Async** = description
- **Fiber** = interpreter
- **Scope** = lifetime
- **Modules** = pure libraries on top
- **Interop** = explicit escape hatch

If you understand this:
👉 you understand the entire system.

---

## Status

This architecture is:
- Experimental
- Intentionally minimal
- Designed for learning, exploration, and correctness

But:
> It already enforces stronger guarantees than most Promise-based codebases.

---

MIT License © 2025


---

## Further reading

- [Getting started](./getting-started.md)
- [Modules overview](./modules.md)
- [Cancellation & interruption](./cancellation.md)
- [Observability (hooks & events)](./observability.md)
- [HTTP client](./http.md)
