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

**Schema validation** — dependency-free runtime schemas for JSON, config, and protocol boundaries, with typed inference and path-rich validation issues.

**Observability export** — Prometheus metrics, OTLP metrics/traces/logs, structured logging, W3C trace-context propagation, request adapters, sampling, redaction, bounded exporters, and production flush/shutdown controls.

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
import { Runtime, succeed } from "brass-runtime";

const runtime = Runtime.make({});
const value = await runtime.toPromise(succeed(42));
```

### Recommended HTTP client

```ts
import { makeDefaultHttpClient, s } from "brass-runtime/http";

const User = s.object({
  id: s.number({ int: true }),
  name: s.string({ minLength: 1 }),
  role: s.enum(["admin", "user"] as const).optional(),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  headers: { accept: "application/json" },
});

const user = await http.getJson("/users/1", { schema: User }).unsafeRunPromise();

console.log(user.body.name);
console.log(http.stats());
console.log(http.compression?.stats());
```

`makeDefaultHttpClient` is the batteries-included entrypoint: timeout,
deduplication, priority scheduling, retry, adaptive concurrency, safe-method
response cache, decompression, stats, `cancelAll`, and JSON/text helpers. Use
`preset: "balanced"` to skip the default cache, or `preset: "minimal"` for a
cheap wire client with the same helper API.

The HTTP stack is meant to replace the usual `fetch` wrapper plus Zod/Valibot
glue: schemas are dependency-free, responses and request bodies are validated in
the same effect, config validation fails at construction time, and the client
still owns cancellation, retries, compression, observability, and adaptive
limits as one pipeline.

The default adaptive limiter uses the `aggressive` preset: warmup sample floor,
P5 baseline, error-rate signal, priority-aware queueing, jittered probes,
proportional headroom, capped decreases, and TTL-evicted per-key state.
Call `shutdown()` for explicit cleanup.

The same schema DSL is available outside HTTP:

```ts
import { Schema } from "brass-runtime/schema";

const Config = Schema.object({
  port: Schema.int({ min: 1 }),
  callbackUrl: Schema.url(),
});

const config = Config.parse({ port: 3000, callbackUrl: "https://example.com/cb" });
```

Schemas can validate request bodies before the HTTP request is sent:

```ts
import { Schema } from "brass-runtime/schema";

const CreateUser = Schema.object({
  name: Schema.string({ minLength: 1 }),
});

await http.postJson(
  "/users",
  { name: "Ada" },
  { bodySchema: CreateUser, schema: User }
).unsafeRunPromise();
```

The same validation machinery checks runtime, HTTP, and observability configs
at construction time, so invalid values fail with field paths like
`$.otlp.pipeline.batchSize` instead of surfacing later as ambiguous behavior.

### Discoverable HTTP builder

```ts
import { httpClientBuilder } from "brass-runtime/http";

declare const token: string;

const http = httpClientBuilder()
  .baseUrl("https://api.example.com")
  .balanced()
  .balancedLimiter({ maxLimit: 128 })
  .header("authorization", `Bearer ${token}`)
  .cache({ ttlSeconds: 30, maxEntries: 512 })
  .retry({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000 })
  .build();
```

### HTTP test helpers

```ts
import {
  makeJsonHttpResponse,
  makeMockHttpClient,
  runHttpEffect,
} from "brass-runtime/http/testing";

const mock = makeMockHttpClient((req) => makeJsonHttpResponse({ url: req.url }));
const response = await runHttpEffect(mock({ method: "GET", url: "/users/1" }));
```

Domain-specific layers still fit in the same config:

```ts
const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
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

const response = await http.getJson<User>("/users/1").unsafeRunPromise();
```

### Adaptive concurrency

```ts
import { makeAdaptiveLimiterConfig, makeHttp } from "brass-runtime/http";

const http = makeHttp({
  adaptiveLimiter: makeAdaptiveLimiterConfig("balanced", {
    maxLimit: 100,
    stateTtlMs: 300_000,
    warmupRequests: 20,
    minSamples: 25,
    decreaseCooldownSamples: 3,
    decreaseThreshold: 0.6,
    maxDecreaseRatio: 0.15,
    historySize: 64,
    onLimitChange: (event) => console.log(`limit: ${event.previousLimit} → ${event.newLimit}`),
  }),
});

console.log(http.adaptiveLimiter?.dump());
console.log(http.adaptiveLimiter?.history("https://api.example.com"));
http.shutdown?.();
```

More end-to-end examples live in [`docs/http-recipes.md`](docs/http-recipes.md).

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
import { makeCompressionMiddleware, makeDefaultHttpClient } from "brass-runtime/http";

const { middleware, stats } = makeCompressionMiddleware({ encodings: ["br", "gzip"] });
const baseClient = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  compression: false,
});
const client = baseClient.with(middleware);
// Responses are transparently decompressed (gzip, brotli, deflate)
```

### Production observability

```ts
import { Runtime, asyncSucceed } from "brass-runtime/core";
import {
  makeObservability,
  runObservedHttpServerEffect,
  withHttpObservability,
} from "brass-runtime/observability";
import { makeDefaultHttpClient } from "brass-runtime/http";

const obs = makeObservability({
  serviceName: "api",
  logs: { minLevel: "info" },
  sampling: { ratio: 0.25, respectRemoteSampled: true, forceSampleOnError: true },
  redaction: {},
  cardinality: { maxValuesPerLabel: 100 },
  otlp: {
    metricsUrl: "http://collector:4318/v1/metrics",
    tracesUrl: "http://collector:4318/v1/traces",
    logsUrl: "http://collector:4318/v1/logs",
  },
  flushIntervalMs: 10_000,
});

const runtime = new Runtime({ env: obs.env, hooks: obs.hooks });
const client = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  middleware: [withHttpObservability(obs)],
});

await runObservedHttpServerEffect(
  obs,
  { method: "GET", route: "/users/:id" },
  asyncSucceed("ok")
);
await runtime.toPromise(client.getText("/health"));
await obs.shutdown();
```

HTTP client observability automatically reads adaptive limiter diagnostics when
the wrapped client owns a limiter, exposing gauges for current limit, queue
depth, utilization, error rate, request/completion rate, rejection rate, and
state count.

### Structured concurrency

```ts
import { Runtime, asyncSucceed, withScope } from "brass-runtime";

const runtime = Runtime.make({});

await runtime.toPromise(
  withScope(runtime, (scope) => {
    scope.fork(asyncSucceed("child"));
    // scope close interrupts children + runs finalizers
  })
);
```

### Streams

```ts
import { Runtime, collectStream, fromArray, mapP, via } from "brass-runtime";

const runtime = Runtime.make({});
const numbers = fromArray([1, 2, 3, 4, 5]);
const doubled = via(numbers, mapP((n: number) => n * 2));
const result = await runtime.toPromise(collectStream(doubled));
// [2, 4, 6, 8, 10]
```

---

## Package exports

| Import | Purpose |
|--------|---------|
| `brass-runtime` | Core runtime: effects, fibers, scheduler, streams, layers |
| `brass-runtime/core` | Stable core surface (preferred for new code) |
| `brass-runtime/http` | Default HTTP client factory, lifecycle middleware, compression, batching, prewarm, adaptive limiter |
| `brass-runtime/http/testing` | Dependency-free mock clients, mock fetch, response factories, and effect runner helpers |
| `brass-runtime/schema` | Dependency-free runtime schema DSL with type inference |
| `brass-runtime/observability` | Prometheus/OTLP exporters, logs, spans, trace propagation, request adapters |
| `brass-runtime/agent` | Brass Agent core (experimental) |

CLI: `brass-agent`

---

## HTTP middleware pipeline

The lifecycle client composes middleware in this order (innermost to outermost):

```
Wire → Priority → Retry → Cache → Batch → Dedup
```

Adaptive limiting lives in the wire client, before lifecycle middleware.
`makeDefaultHttpClient` can then wrap the lifecycle stack with response
compression and caller middleware; caller middleware is outermost.

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

The recommended `makeDefaultHttpClient` factory wires the default preset
for you and accepts extra middleware, so observability can be attached with
`middleware: [withHttpObservability(obs)]` without coupling HTTP to exporters.

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
npm test              # vitest suite
npm run test:types    # TypeScript type checking
npm run test:coverage # coverage with baseline gate
npm run benchmark     # runtime, HTTP lifecycle, and 100k local HTTP concurrency
npm run benchmark -- http-concurrent # HTTP compare mode variants
node --expose-gc --import tsx src/benchmarks/runner.ts http-concurrent # HTTP memory/limiter diagnostics
npm run benchmark:adaptive
npm run benchmark:adaptive:soak
npm run benchmark:http:budget
npm run benchmark:http:soak
npm run benchmark:observability
npm run benchmark:observability:budget
npm run smoke:observability:collector # requires local OTEL collector
```

Property-based tests use `fast-check` with 100+ iterations per property. Each HTTP middleware has dedicated property tests verifying correctness invariants.

---

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Cancellation & Interruption](./docs/cancellation.md)
- [Observability: Hooks & Tracing](./docs/observability.md)
- [Observability framework examples](./docs/observability-framework-examples.md)
- [Observability collector smoke](./docs/observability-collector-smoke.md)
- [HTTP module](./docs/http.md)
- [Production readiness](./docs/production-readiness.md)
- [Streams guide](./docs/guides/streams.md)
- [Testing guide](./docs/guides/testing.md)
- [WASM engine](./docs/wasm-fiber-engine.md)

---

## Features

### Runtime (core)

- [x] Sync effect values via `ZIO<R, E, A>` aliases
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
- [x] Schema-validated JSON helpers
- [x] Discoverable builder API
- [x] Test helper subpath
- [x] Lifecycle client with middleware composition
- [x] Response cache (LRU + TTL + SWR)
- [x] Request deduplication (ref-counted)
- [x] Priority scheduling
- [x] Retry with exponential backoff
- [x] Response compression (gzip, br, deflate)
- [x] Request batching (time-window coalesce/split)
- [x] Connection pre-warming (probes, auto-refresh)
- [x] Adaptive concurrency (gradient-based)
- [x] Adaptive limiter presets, diagnostics, observability gauges, and soak benchmark
- [x] Circuit breaker
- [x] Tracing & validation

### Schema

- [x] Dependency-free schema DSL
- [x] Type inference via `InferSchema`
- [x] Object, array, record, union, enum, literal, custom schemas
- [x] Optional, nullable, refine, transform
- [x] Path-rich validation issues

### Observability

- [x] Runtime metrics sink and Prometheus exporter
- [x] OTLP JSON/HTTP exporters for metrics, traces, and logs
- [x] Structured logging with context propagation and redaction
- [x] W3C trace-context extract/inject helpers
- [x] Client and server HTTP observability helpers
- [x] Adaptive limiter metrics on HTTP client spans and Prometheus gauges
- [x] Sampling, force-sample-on-error, and bounded trace retention
- [x] Bounded exporter queues with retry, timeout, drop policy, and single-flight flush
- [x] Fetch/Node/Express/Fastify/Nest-style examples and collector smoke script

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
