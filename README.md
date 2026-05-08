# brass-runtime

A ZIO-inspired effect runtime for TypeScript with structured concurrency, pull-based streams, and a production-grade HTTP client.

Built without `Promise`/`async`/`await` as the primary semantic primitive. Effects are values — lazy, composable, and cancelable by default.

```bash
npm i brass-runtime
```

---

## What it does

**Core runtime** — algebraic effects, fibers, scopes, scheduler, layers, semaphores, circuit breakers, metrics, tracing.

**Streams** — pull-based with backpressure, bounded buffers, queues, hubs, pipelines, fusion optimization.

**HTTP client** — lazy/cancelable requests with a full middleware pipeline: adaptive concurrency, compression, batching, connection pre-warming, caching, deduplication, priority scheduling, and retry with backoff.

**WASM engine** — optional Rust/WASM-backed state machines for strict scheduling and bounded queues.

**Brass Agent** — experimental CLI coding agent with workspace inspection, LLM integration, and VS Code extension.

---

## Philosophy

- **Effects are values** — lazy, composable, referentially transparent
- **Async is explicit** — no hidden Promise semantics
- **Concurrency is structured** — fibers, scopes, finalizers
- **Side effects are interpreted** — not executed eagerly
- **Higher-level APIs are libraries** — HTTP, streams, agent are built on top of core

---

## Quick start

### Run an effect

```ts
import { Runtime, succeed, toPromise } from "brass-runtime";

const runtime = Runtime.make({});
const value = await runtime.toPromise(succeed(42));
```

### HTTP client with lifecycle middleware

```ts
import { makeLifecycleClient } from "brass-runtime/http";

const client = makeLifecycleClient({
  baseUrl: "https://api.example.com",
  cache: { ttlSeconds: 60, maxEntries: 512 },
  dedup: {},
  priority: { concurrency: 8 },
  retry: { maxAttempts: 3, baseDelayMs: 200 },
  batch: {
    windowMs: 50,
    maxBatchSize: 20,
    batchKey: (req) => req.url.startsWith("/graphql") ? "graphql" : "",
    batch: {
      coalesce: (reqs) => ({ method: "POST", url: "/graphql/batch", body: JSON.stringify(reqs) }),
      split: (res, reqs) => JSON.parse(res.bodyText),
    },
  },
});

// All requests go through: dedup → batch → cache → retry → priority → wire
const response = await runtime.toPromise(client({ method: "GET", url: "/users/1" }));
```

### Adaptive concurrency

```ts
import { makeHttp } from "brass-runtime/http";

const http = makeHttp({
  adaptiveLimiter: {
    initialLimit: 10,
    minLimit: 2,
    maxLimit: 100,
    onLimitChange: (event) => console.log(`limit: ${event.previousLimit} → ${event.newLimit}`),
  },
});
```

### Connection pre-warming

```ts
import { makePrewarmManager } from "brass-runtime/http";

const prewarm = makePrewarmManager({
  origins: ["https://api.example.com", "https://cdn.example.com"],
  keepAliveDurationMs: 55000,
  autoRefresh: true,
});

await prewarm.warmAll();
// Subsequent requests skip TCP+TLS handshake
```

### Response compression

```ts
import { makeCompressionMiddleware } from "brass-runtime/http";

const { middleware, stats } = makeCompressionMiddleware({ encodings: ["br", "gzip"] });
const client = baseClient.with(middleware);
// Responses are transparently decompressed (gzip, brotli, deflate)
```

### Structured concurrency

```ts
import { Runtime, fork, withScope } from "brass-runtime";

const runtime = Runtime.make({});

withScope(runtime, (scope) => {
  const fiber = scope.fork(someEffect);
  // scope.close() interrupts children + runs finalizers
});
```

### Streams

```ts
import { Stream, Pipeline } from "brass-runtime";

const numbers = Stream.fromIterable([1, 2, 3, 4, 5]);
const doubled = numbers.pipe(Pipeline.map((n) => n * 2));
const result = await runtime.toPromise(doubled.runCollect());
// [2, 4, 6, 8, 10]
```

---

## Package exports

| Import | Purpose |
|--------|---------|
| `brass-runtime` | Core runtime: effects, fibers, scheduler, streams, layers |
| `brass-runtime/core` | Stable core surface (preferred for new code) |
| `brass-runtime/http` | HTTP client, lifecycle middleware, compression, batching, prewarm, adaptive limiter |
| `brass-runtime/agent` | Brass Agent core (experimental) |

CLI: `brass-agent`

---

## HTTP middleware pipeline

The lifecycle client composes middleware in this order (innermost to outermost):

```
Wire → Adaptive Limiter → Priority → Retry → Cache → Batch → Dedup → Compression
```

Each layer is independently optional. Set to `false` or omit to disable.

| Layer | What it does |
|-------|-------------|
| **Adaptive Limiter** | Gradient-based dynamic concurrency control per origin |
| **Priority** | Priority queue for request scheduling (0-9 levels) |
| **Retry** | Exponential backoff with circuit breaker awareness |
| **Cache** | LRU + TTL + stale-while-revalidate |
| **Batch** | Time-window request coalescing with split/distribute |
| **Dedup** | Ref-counted in-flight request deduplication |
| **Compression** | Transparent gzip/br/deflate decompression |
| **Prewarm** | Proactive TCP+TLS connection establishment |

All layers emit lifecycle events, track stats, and support cancellation.

---

## WASM engine

Optional Rust/WASM-backed components for strict execution:

- Fiber engine state machine
- Scheduler queue
- Bounded queues
- Permit pool
- Retry planner

```bash
npm run build:wasm  # requires wasm-pack
```

The WASM engine never silently falls back to TypeScript — if you request WASM and it's unavailable, it fails explicitly.

---

## Brass Agent (experimental)

A CLI-first coding agent built on the runtime. Inspects workspaces, discovers validation commands, gathers bounded context, asks an LLM for patches, and applies/rolls back changes under policy.

```bash
npm run agent:vscode:install   # VS Code extension
brass-agent --doctor           # check setup
brass-agent --init             # initialize workspace
brass-agent --preset inspect   # run inspection
```

Docs: [Install](./docs/agent-install-and-configure.md) · [CLI](./docs/agent-cli.md) · [Project intelligence](./docs/agent-project-intelligence.md) · [VS Code](./docs/agent-vscode-install.md)

---

## Testing

```bash
npm test              # 1198 tests via vitest
npm run test:types    # TypeScript type checking
npm run test:coverage # coverage with baseline gate
npm run benchmark     # runtime & HTTP lifecycle benchmarks
```

Property-based tests use `fast-check` with 100+ iterations per property. Each HTTP middleware has dedicated property tests verifying correctness invariants.

---

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Cancellation & Interruption](./docs/cancellation.md)
- [Observability: Hooks & Tracing](./docs/observability.md)
- [HTTP module](./docs/http.md)
- [Streams guide](./docs/guides/streams.md)
- [Testing guide](./docs/guides/testing.md)
- [WASM engine](./docs/wasm-fiber-engine.md)

---

## Features

### Runtime (core)

- [x] Sync effect: `Effect<R, E, A>`
- [x] Algebraic async: `Async<R, E, A>`
- [x] Cooperative scheduler (observable, testable)
- [x] Fibers with interruption & finalizers
- [x] Structured scopes & resource safety
- [x] Layers, semaphores, circuit breakers
- [x] Metrics, tracing, runtime hooks
- [x] Worker pools
- [x] WASM engine (optional)

### Streams

- [x] Pull-based streams with backpressure
- [x] Bounded buffers, queues, hubs
- [x] Pipelines with fusion optimization
- [x] Stream merge, zip, broadcast
- [x] Chunks & batch operators

### HTTP

- [x] Lazy, cancelable HTTP client
- [x] Lifecycle client with middleware composition
- [x] Response cache (LRU + TTL + SWR)
- [x] Request deduplication (ref-counted)
- [x] Priority scheduling
- [x] Retry with exponential backoff
- [x] Response compression (gzip, br, deflate)
- [x] Request batching (time-window coalesce/split)
- [x] Connection pre-warming (probes, auto-refresh)
- [x] Adaptive concurrency (gradient-based)
- [x] Circuit breaker
- [x] Tracing & validation

---

## Design notes

- **No hidden Promises** — async is always modeled explicitly via `Async`
- **Deterministic execution** — scheduler is observable and testable
- **Resource safety is structural** — scopes guarantee cleanup
- **Middleware composes via functions** — `(next: HttpClientFn) => HttpClientFn`
- **Cancellation propagates** — ref-counted through the entire middleware stack
- **Stats are frozen snapshots** — no mutable state leaks to consumers

---

## Contributing

- Runtime invariants matter — avoid sneaking Promises into core semantics
- Prefer libraries on top of the runtime over changes in core
- Add property tests when an invariant is broad
- Keep tests close to the changed module
- Small, focused PRs are welcome

---

## License

MIT © 2025
