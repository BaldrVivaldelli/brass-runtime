# brass-runtime

A ZIO-inspired effect runtime for TypeScript with structured concurrency,
runtime diagnostics, pull-based streams, and a production-grade HTTP client.

Built without `Promise`/`async`/`await` as the primary semantic primitive. Effects are values — lazy, composable, and cancelable by default.

```bash
npm i brass-runtime
```

Runnable framework examples live in the
[repository examples](https://github.com/BaldrVivaldelli/brass-runtime/tree/main/examples).
They are kept out of the npm package so installs stay small.

---

## What it does

**Runtime** — algebraic effects, fibers, scopes, scheduler, interruptibility
regions, fiber-local refs, typed layers, semaphores, circuit breakers, rich
`Cause<E>` failures, metrics, tracing, and an opt-in flight recorder.

**Streams** — pull-based streams with backpressure, bounded buffers, hubs,
pipelines, fusion optimization, and a small fluent DX facade.

**HTTP** — lazy/cancelable client and server primitives with typed routing,
schema validation, health/readiness probes, adaptive concurrency, compression,
batching, prewarm, cache, dedup, priority, retry, and observability.

**Production signals** — dependency-free schemas, Prometheus/OTLP exporters,
structured logs, W3C trace propagation, sampling, redaction, bounded exporters,
and explicit flush/shutdown.

**Performance profiler** — runtime primitives, HTTP layer comparison, memory
retention reports, observability overhead, CLI/JSON output, and actionable
recommendations.

**Optional engine and tools** — Rust/WASM-backed state machines, the
experimental Brass Agent CLI/VS Code workflow, and a versioned read-only Rust
index/search pilot with TypeScript fallback.

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
import { runPromise, succeed } from "brass-runtime";

const value = await runPromise(succeed(42));
```

Use `makeRuntime` when you want explicit runtime options, and `runExit` when
you want the full `Exit`/`Cause` instead of a rejected promise.

### Inspect failure causes

```ts
import { Cause, formatCause } from "brass-runtime";

const cause = Cause.then(
  Cause.fail("database unavailable"),
  Cause.both(Cause.interrupt(), Cause.die(new Error("release failed"))),
);

console.log(formatCause(cause));
```

`Cause<E>` preserves typed failures, defects, interruptions, and sequential or
parallel composition (`Then` / `Both`) so diagnostics can explain what happened
without flattening every failure into a single thrown value.

### Mask interruption

```ts
import { async, flatMap, succeed, uninterruptibleMask } from "brass-runtime";

const effect = uninterruptibleMask((restore) =>
  flatMap(succeed("acquired"), (resource) =>
    restore(async((_env, cb) => {
      setTimeout(() => cb({ _tag: "Success", value: `used:${resource}` }), 10);
    })),
  ),
);
```

Use `uninterruptible(effect)` for critical regions and
`uninterruptibleMask((restore) => ...)` when only part of the region should be
interruptible again. Pending interruption is deferred until the protected region
exits; restored sub-effects remain cancelable.

### Fiber-local context

```ts
import { Runtime, makeFiberRef } from "brass-runtime";

const requestId = makeFiberRef("anonymous");
const runtime = Runtime.make({});

const result = await runtime.toPromise(
  requestId.locally("req-123", requestId.get()),
);
```

`FiberRef` values are local to the running fiber, inherited by child fibers at
fork time, isolated from child mutations, and restored after `locally` regions
even when the region fails or is interrupted.

### Explain runtime behavior

```ts
import { Runtime, async, makeRuntimeRecorder } from "brass-runtime";

const recorder = makeRuntimeRecorder({ maxEvents: 5000 });
const runtime = new Runtime({ env: {}, hooks: recorder.hooks });

await runtime.toPromise(async((_env, cb) => {
  setTimeout(() => cb({ _tag: "Success", value: "ok" }), 10);
}));

console.log(recorder.explain());
```

The flight recorder is opt-in and keeps a bounded ring buffer of runtime events:
fiber start/end/suspend/resume, scopes, supervisor events, logs, spans, and
trace context when available.

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
`preset: "production"` when you want that production-ready shape explicitly,
`preset: "balanced"` to skip the default cache, `preset: "highThroughputProxy"`
for hot BFF/proxy paths without lifecycle queues or Brass timers by default,
`preset: "proxy"` as the shorter compatibility alias, or `preset: "minimal"`
for a cheap wire client with the same helper API. `preset: "default"` remains
the same full preset for compatibility.

On Node BFF/proxy services, pair the proxy preset with the first-party
`node:http` transport when the default `fetch` backend is the bottleneck.
The Node-only factory below wires that recommended shape directly:

```ts
import { toPromise } from "brass-runtime";
import { makeNodeHttpProxyClient } from "brass-runtime/http";

const http = makeNodeHttpProxyClient({
  baseUrl: "https://api.example.com",
  nodeTransport: {
    maxSockets: 512,
    maxFreeSockets: 512,
  },
});

await toPromise(http.shutdown(), {}); // also destroys owned Node agents
```

The HTTP stack is meant to replace the usual `fetch` wrapper plus Zod/Valibot
glue: schemas are dependency-free, responses and request bodies are validated in
the same effect, config validation fails at construction time, and the client
still owns cancellation, retries, compression, observability, and adaptive
limits as one pipeline.

Custom Promise clients such as Axios can be injected without making the
consumer manage `AbortSignal` or `Async` plumbing:

```ts
import {
  defineHttpPolicyPresets,
  formatHttpError,
  isRetryableHttpError,
  makeDefaultHttpClient,
  promiseHttpTransport,
} from "brass-runtime/http";

const transport = promiseHttpTransport()
  .requestConfig(({ request, url }) => ({
    url: url.toString(),
    method: request.method,
    headers: request.headers,
    data: request.body,
    responseType: "json",
  }))
  .send((config) => axiosInstance.request(config))
  .json();

const axiosHttp = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  transport,
});

try {
  await axiosHttp.getJson("/users/1").unsafeRunPromise();
} catch (error) {
  if (isRetryableHttpError(error)) {
    console.warn("transient upstream failure");
  }
  console.error(formatHttpError(error));
}
```

Brass injects the runtime `AbortSignal` into object configs before `send` and
normalizes external failures with `toHttpError`, including Axios-like
`response.status`, aborts, and common timeout codes.

Repeated execution intent can be named once with policy presets:

```ts
const policies = defineHttpPolicyPresets({
  readModel: {
    lane: "read-model",
    poolKey: "users-api",
    priority: 2,
    retry: { maxRetries: 2, baseDelayMs: 50 },
  },
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  policyPresets: policies,
});

await http.getJson("/users/1", {
  policy: { preset: "readModel", dedupKey: "users:1" },
}).unsafeRunPromise();
```

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

### HTTP server

```ts
import { asyncSucceed, asyncSync, runPromise, useResource } from "brass-runtime";
import { HttpServer, s } from "brass-runtime/http";

const User = s.object({
  id: s.nonEmptyString(),
  name: s.nonEmptyString(),
});

const router = HttpServer.router([
  HttpServer.route("GET", "/users/:id", {
    params: s.object({ id: s.nonEmptyString() }),
    response: User,
  }, (ctx) =>
    asyncSucceed(HttpServer.json({
      id: ctx.params.id,
      name: "Ada",
    })),
  ),
  HttpServer.healthRoute(),
  HttpServer.readinessRoute(),
]);

await runPromise(
  useResource(
    router.listen({ port: 3000 }),
    (server) => asyncSync(() => {
      console.log(server.url());
    }),
  ),
);
```

Routes infer `:params` from the path, optional schemas validate
params/query/body/response, middleware is effect-based, and the Node listener is
available as a managed resource for graceful shutdown.

### Discoverable HTTP builder

```ts
import { httpClientBuilder } from "brass-runtime/http";

declare const token: string;

const http = httpClientBuilder()
  .baseUrl("https://api.example.com")
  .production()
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
  makeOtlpOptions,
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
  otlp: makeOtlpOptions({ endpoint: "http://collector:4318" }),
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
It also reads `req.policy` automatically: logs and span attributes include
`preset`, `lane`, `poolKey`, `dedupKey`, `priority`, and retry overrides when present.
Metric labels stay conservative by default; opt into stable labels with
`withHttpObservability({ policy: { labelKeys: ["preset", "lane", "poolKey"] } })`.

For hot proxy paths, keep HTTP metrics separate from runtime hooks:
`makeObservability({ metrics: false, logs: false, traces: false })`,
`preset: "proxy"`, `withHttpObservability({ spans: false, logs: false,
injectTraceHeaders: false, includeHostLabel: false })`. For sampled spans on
the same path, avoid global runtime hooks and use
`withHttpObservability({ spans: { events: false, sampleRate: 0.001 },
spanSink: observability.tracer, injectTraceHeaders: false })`.

### Performance profiler

```bash
npm run perf
npm run perf:json
npm run benchmark:perf
npm run perf:runtime:ab
npm run perf:runtime:soak
npm run perf:runtime:budget
npm run perf:http:memory
npm run perf:history
```

```ts
import { runBrassPerformanceProfile } from "brass-runtime/perf";

const report = await runBrassPerformanceProfile({
  http: {
    calls: 20_000,
    concurrency: 512,
    delayMs: 2,
    forceGc: true,
    variants: ["default-json", "default-json-observed"],
  },
});

console.log(report.recommendations);
```

The profiler compares runtime primitives, runtime A/B variants, runtime-only
soak behavior, `node:http`, Brass wire/default HTTP clients, HTTP long-run
memory, observability overhead, history/baseline regressions, and memory deltas. Use
[`docs/performance-profiler.md`](docs/performance-profiler.md) for focused
commands and `node --expose-gc` runs.

Perf runs can be persisted and compared locally:

```bash
npm run perf -- --profile runtime-ab --record-history --save-baseline runtime-main
npm run perf -- --profile runtime-ab --compare-baseline runtime-main --fail-on-baseline-regression
```

### First-release recipes

Copyable happy paths live in [`docs/recipes`](docs/recipes/README.md):

- runtime execution
- typed layers
- HTTP server
- testing
- performance baselines

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
import { Runtime, Stream } from "brass-runtime";

const runtime = Runtime.make({});
const result = await Stream
  .from([1, 2, 3, 4, 5])
  .map((n) => n * 2)
  .collect(runtime);
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
| `brass-runtime/perf` | Runtime, HTTP, observability, memory, and baseline performance profiler |
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
Per-request `policy` travels through that stack and is visible to observability
without being forwarded to the host transport.

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

`engine: "wasm"` never falls back. `engine: "auto"` is the explicit opt-in to a
TypeScript fallback and emits a redacted `runtime.boundary` event plus stable
diagnostic code when WASM cannot initialize.

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

The fork-oriented native search backend uses private authenticated IPC,
rechecks workspace trust in TypeScript, and owns no filesystem/write/secret
capability. The editor composition defaults to native-first `auto` with a
deterministic TypeScript fallback after two final-worktree runs passed every
promotion gate:
[protocol](./docs/native-service-protocol.md) ·
[adoption decision](./docs/native-search-pilot-decision.md).

---

## Testing

```bash
npm test              # vitest suite
npm run test:types    # TypeScript type checking
npm run test:coverage # coverage with baseline gate
npm run release:check # full release gate: types, tests, build, CJS, perf budgets
npm run benchmark     # runtime, HTTP lifecycle, and 100k local HTTP concurrency
npm run benchmark:runtime        # Runtime Performance Track
npm run benchmark:runtime:budget # Runtime Performance Track regression budget
npm run benchmark:runtime:primitives:budget # versioned fork/suspend/heap/fairness gates
npm run benchmark:native:pilot   # isolated TS vs native search promotion report
npm run perf:runtime:ab          # Runtime A/B Performance Lab
npm run perf:runtime:soak        # Runtime-only soak profile
npm run perf:runtime:budget      # Runtime profiler budget
npm run perf:http:memory         # HTTP long-run memory lab
npm run benchmark -- http-concurrent # HTTP compare mode variants
node --expose-gc --import tsx src/benchmarks/runner.ts http-concurrent # HTTP memory/limiter diagnostics
npm run benchmark:adaptive
npm run benchmark:adaptive:soak
npm run benchmark:http:budget
npm run benchmark:http:soak
npm run benchmark:observability
npm run benchmark:observability:budget
npm run smoke:observability:collector # requires local OTEL collector
npm run release:artifacts        # SPDX SBOM, licenses, and SHA-256 checksums
```

Property-based tests use `fast-check` with 100+ iterations per property. Each HTTP middleware has dedicated property tests verifying correctness invariants.

---

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Cancellation & Interruption](./docs/cancellation.md)
- [Observability: Hooks & Tracing](./docs/observability.md)
- [Observability framework examples](./docs/observability-framework-examples.md)
- [Framework integrations](./docs/framework-integrations.md)
- [NestJS integration](./docs/frameworks/nestjs.md)
- [Observability collector smoke](./docs/observability-collector-smoke.md)
- [HTTP module](./docs/http.md)
- [Production readiness](./docs/production-readiness.md)
- [Streams guide](./docs/guides/streams.md)
- [Testing guide](./docs/guides/testing.md)
- [WASM engine](./docs/wasm-fiber-engine.md)
- [Native service protocol](./docs/native-service-protocol.md)
- [Native compatibility changelog](./docs/native-compatibility-changelog.md)
- [Native adoption decision](./docs/native-search-pilot-decision.md)

---

## Features

### Runtime (core)

- [x] Sync effect values via `ZIO<R, E, A>` aliases
- [x] Algebraic async: `Async<R, E, A>`
- [x] Rich `Cause<E>` failure trees with pretty printing
- [x] Interruptibility regions with `uninterruptible` / `uninterruptibleMask`
- [x] Fiber-local refs with fork inheritance and scoped restoration
- [x] TS TestRuntime with deterministic scheduler and virtual clock
- [x] Schedule 2.0 with drivers, runtime-clock budgets, observability, and HTTP integration
- [x] Cooperative scheduler (observable, testable)
- [x] Fibers with interruption & finalizers
- [x] Structured scopes & resource safety
- [x] Runtime flight recorder for bounded execution traces
- [x] Layer 2.0 typed contexts, semaphores, circuit breakers
- [x] Metrics, tracing, runtime hooks
- [x] Worker pools
- [x] WASM engine (optional)

### Streams

- [x] Pull-based streams with backpressure
- [x] Fluent `Stream` / `Pipeline` DX facade
- [x] Bounded buffers, queues, hubs
- [x] Pipelines with fusion optimization
- [x] Stream merge, zip, broadcast
- [x] Chunks & batch operators

### HTTP

- [x] Lazy, cancelable HTTP client
- [x] Effect-based Node HTTP server listener with resource lifecycle
- [x] Declarative typed routing with params/query/body/response schemas
- [x] Health/readiness routes backed by runtime health reports
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
