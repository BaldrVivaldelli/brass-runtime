# agent.md — brass-runtime

This document describes the **current architecture, invariants, and mental model**
of brass-runtime. It is intended for contributors and for future maintainers.

brass-runtime is intentionally small, explicit, and opinionated.

---

## Core Philosophy

- **Effects are values**
- **Async is explicit**
- **Cancellation is mandatory**
- **Concurrency is structured**
- **Resources are scoped**
- **Streams are first‑class**
- **Streaming should be boring and safe**

If an async operation cannot be cancelled, it is considered a bug.

---

## Execution Model

### Package Entry Points

The package has several public surfaces:

- `brass-runtime`: broad compatibility root export.
- `brass-runtime/core`: preferred stable core/runtime surface for new code.
- `brass-runtime/http`: HTTP clients, middleware, lifecycle utilities.
- `brass-runtime/observability`: Prometheus/OTLP exporters, structured logs,
  spans, W3C trace propagation, request adapters, and production export
  controls.
- `brass-runtime/agent`: agent library API.
- `brass-agent`: CLI binary.

Root exports are compatibility-first. Do not widen `src/index.ts` by default.
Prefer a focused subpath when adding a public API.

If package shape changes, update:

- `package.json`
- `tsup.config.ts`
- `docs/ai/PUBLIC_API.md`
- relevant README/docs examples

Then run:

```bash
npm run build
npm run validate:cjs
```

### Effects

The core abstraction is `Async<R, E, A>` (and `ZIO` aliases):

- `R`: required environment
- `E`: typed failure
- `A`: success value

Effects are:
- lazy
- composable
- cancelable
- interpretable by a runtime

Typing rules:

- Preserve `R`, `E`, and `A` in public helpers.
- `flatMap` composes environments as `R & R2`.
- `flatMap` composes failures as `E | E2`.
- `fold/catchAll` should preserve typed recovery rather than collapse to
  `unknown`.
- Keep `as any` out of public helper signatures. If unavoidable, hide it inside
  a constructor or interpreter boundary.

Execution happens via:

```ts
toPromise(effect, env)
```

The runtime schedules fibers using the global scheduler.

---

## Fibers

Fibers are lightweight concurrent processes.

Properties:
- interruptible
- forkable
- joinable
- parent/child structured relationship

Rules:
- Child fibers are owned by a parent scope
- Interrupting a scope interrupts all children
- No detached background work by default

---

## Scheduler

The scheduler:
- drives async callbacks
- ensures fairness
- prevents runaway recursion

All async boundaries must go through the scheduler.

Lane/caller scheduling is observability and fairness metadata. It must not
change the semantic result of user effects.

The default TS scheduler uses fair lane rotation. `laneMode: "single"` is an
explicit throughput fast path for callers that provide their own isolation or do
not need per-lane fairness.

Fair mode should keep per-task queue entries compact: lane membership belongs to
the lane queue itself, so enqueue the task function directly and avoid retaining
per-task `{ task, tag }` wrappers unless a feature truly needs them.

Semaphore hot paths must not fork a child fiber for every permit. `withPermit`
runs the protected effect in the current fiber and installs an idempotent
release finalizer so success, failure, and interruption all return the permit.

HTTP concurrency benchmarks must use the local delayed dummy server in
`src/benchmarks/http-concurrent.bench.ts`. The daily benchmark path uses
100,000 local calls; million-call runs are soak-only/opt-in via
`BRASS_HTTP_BENCH_MODE=soak` or `BRASS_HTTP_BENCH_CALLS=1000000`. Do not point
default benchmark runs at public demo APIs; use external services only for
small opt-in smoke checks.

When investigating HTTP benchmark regressions, run the focused benchmark with
`node --expose-gc --import tsx src/benchmarks/runner.ts http-concurrent` and
inspect `heapDeltaMb`, `rssDeltaMb`, `gcAvailable`, and the adaptive limiter
fields. Treat sustained positive heap-after-GC as leak evidence; RSS alone can
reflect allocator retention.

---

## Scope

`Scope<R>` is responsible for **resource lifetime**.

A scope:
- owns finalizers
- owns child fibers
- defines cancellation boundaries

### Invariants

- Finalizers are run **exactly once**
- Finalizers run in **reverse registration order**
- Scope interruption propagates to all children
- Scope closure must eventually complete

### Important Notes

- `scope.close()` is fire‑and‑forget
- `scope.closeAsync(exit)` returns an `Async` that can be awaited
- If something “hangs on cancel”, it is almost always a finalizer bug

---

## Streams (`ZStream`)

A `ZStream<R, E, A>` represents a pull‑based stream.

Characteristics:
- backpressure aware
- cancelable
- resource‑safe
- lazy

Streams are built from **pulls**:

```ts
pull: ZIO<R, Option<E>, [A, ZStream<R, E, A>]>
```

Conventions:
- `Failure(None)` → end of stream
- `Failure(Some(e))` → stream failure

---

## Pipelines (ZPipeline‑style)

Pipelines are **reusable stream transformers**.

```ts
type ZPipeline<Rp, Ep, In, Out> =
  <R, E>(stream: ZStream<R, E, In>) =>
    ZStream<R & Rp, E | Ep, Out>;
```

Why pipelines exist:
- reuse
- separation of concerns
- stateful transforms
- better ergonomics than `map/flatMap` chains

### Composition

- `andThen(p1, p2)` / `>>>`
- `compose(p2, p1)` / `<<<`
- `via(stream, pipeline)`

### Design Rules

- Pipelines must not break backpressure
- Pipelines must respect cancellation
- Pipelines must not leak resources

---

## HTTP Client

HTTP is built on top of core effects. Core must never import HTTP.

brass-runtime exposes several HTTP layers:

### 1) DX client: `httpClient`

- `getText`
- `getJson`
- `post`
- `postJson`

This client eagerly consumes the body via `fetch().text()` for non-streaming
helpers.

It is intended for:
- small payloads
- simple DX
- classic REST usage

### 2) Wire client: `makeHttp`

Low-level client that returns `HttpWireResponse`.

Use it for:
- middleware authorship
- tests
- custom DX layers

It should stay ignorant of JSON/domain parsing.

### 3) Streaming HTTP client: `makeHttpStream` / `httpClientStream`

- body is a `ZStream<Uint8Array>`

This client:
- does NOT eagerly read the body
- supports backpressure
- supports cancellation
- works in Browser and Node 18+

### 4) Default HTTP client: `makeDefaultHttpClient`

Recommended user-facing entrypoint for HTTP is `makeDefaultHttpClient` from
`brass-runtime/http`. It returns the JSON/text helper API (`getJson`, `postJson`,
`request`) backed by the lifecycle stack, adaptive concurrency, response
compression, stats, cache controls, and `cancelAll`.

Preset defaults:

- `default`: timeout, dedup, priority, retry, adaptive limiter, safe-method
  response cache, response compression.
- `balanced`: production shape without default response cache.
- `minimal`: wire client + helper API; opt into layers explicitly.

Default adaptive limiter configs must be conservative: require warmup samples,
use a deadband, cap one-step decreases, and avoid `minLimit: 1` in user-facing
presets unless the caller explicitly asks for that behavior. If benchmarks show
`serverMaxInFlight` far below requested concurrency, inspect `adaptiveFinalLimit`
and `adaptiveMaxQueueDepth` before assuming a memory leak.

Observability is attached through `middleware: [withHttpObservability(obs)]`.
Do not import observability exporters from `src/http`; keep observability as an
outer integration layer.

### 5) Lifecycle client: `makeHttpClient` / `makeLifecycleClient`

Production-oriented client with optional:

- deduplication
- response cache
- priority queueing
- retry
- request batching
- lifecycle events
- lifecycle stats
- `cancelAll`

Canonical composition order:

```txt
wire -> priority -> retry -> cache -> batch -> dedup -> lifecycle tracking
```

The default client may wrap that lifecycle stack with response compression and
caller middleware. User middleware is outermost; compression is outside the
lifecycle stack but inside caller middleware.

`LifecycleStatsTracker` owns lifecycle counters. The client should report real
request/cache/dedup/queue/retry stats, not placeholder zeros.

`cancelAll` must abort active requests through `AbortController`, using the same
cancellation path as fiber interruption.

---

## Observability Export

Observability is a library layer on top of runtime hooks, metrics, tracing, and
fiber context. Core may expose hook/event primitives, but core must not depend
on HTTP, framework adapters, OTLP, or exporter code.

Public production surface lives in `brass-runtime/observability`:

- `makeObservability` wires metrics, structured logs, tracer, Prometheus, and
  OTLP exporters.
- `withSpan`, `spanEvent`, `logEffect`, and `withLogContext` operate through
  current fiber context.
- `withHttpObservability` instruments outbound HTTP client calls.
- `runObservedHttpServerEffect` and request adapters instrument inbound server
  work.
- `parseTraceparent`, `extractTraceContext`, `injectTraceContext`, and
  `formatTraceparent` provide W3C trace-context interop.

Production invariants:

- Exporters must be backend-neutral and dependency-free.
- Exporter failures must not change user effect semantics.
- Flush is single-flight; overlapping flush calls return the in-flight result.
- Queues are bounded and must expose drop/retry/queue metrics.
- `shutdown()` drains with a deadline.
- Finished spans must be pruned after export and bounded by retention options.
- Logs and spans must support redaction before leaving the process.
- High-cardinality labels should be opt-in or bounded.

Useful validation:

```bash
npm run test:types
npm test -- src/observability/__tests__
npm run benchmark:observability
npm run benchmark:observability:budget
npm run smoke:observability:collector
```

Framework examples are documented in
`docs/observability-framework-examples.md`; collector smoke setup is in
`docs/observability-collector-smoke.md`.

---

## HTTP Streaming Internals

### Web Streams → ZStream

`ReadableStream<Uint8Array>` is adapted via:

```ts
streamFromReadableStream(body, normalizeError)
```

This helper:
- builds a pull‑based `ZStream`
- registers `reader.cancel()` as a finalizer
- propagates fetch abort on interruption

### Cancellation Flow

1. Fiber interrupted
2. Scope closes
3. `AbortController.abort()` is called
4. Reader is cancelled
5. Stream ends

If cancellation hangs, the bug is:
- a finalizer that never completes
- or misuse of `scope.close()` instead of `closeAsync`

### Cancellation Checklist

Before changing async, HTTP, streams, scheduler, or resources, answer:

- What owns this operation?
- What cancels it?
- Does cancellation reach the host primitive (`AbortSignal`, reader, timer,
  child process, worker, etc.)?
- Is the canceler detached when the operation completes?
- Which scope/fiber owns the finalizer?
- Is interruption idempotent?
- Is there a regression test for cancellation?

---

## HTTP Request Model

`HttpRequest` intentionally separates:

- `headers`
- `init` (RequestInit without headers/body/method)
- `body`

This avoids implicit mutation of `RequestInit`
and makes header handling explicit.

Client helpers (`post`, `postJson`) accept
a convenient `init + headers` shape and adapt it internally.

---

## Error Handling

- All errors are typed
- Stream end is NOT an error
- Cancellation is modeled explicitly

If you see `unknown` creeping into stream errors,
it usually means a constructor was not typed strictly enough.

## Module Rules

### Core

- Semantics first, performance second.
- Keep effects lazy.
- Keep Promise usage at host interop boundaries.
- Avoid expanding root exports unless compatibility requires it.
- Prefer `brass-runtime/core` for new stable core APIs.

### Streams

- Preserve ordering.
- Preserve backpressure.
- Preserve end-of-stream as `None`, not as a thrown/failing error.
- Fusion optimizations must be behavior-preserving.

### HTTP

- Keep wire/content/meta/lifecycle concerns separate.
- Middleware composition must stay lazy.
- Retry must respect method safety, retry budgets, aborts, pool rejection, and
  per-request overrides.
- Compression must keep body/header semantics explicit.

### Agent

- `src/agent` may depend on runtime primitives.
- Core runtime must not depend on agent code.
- Workspace reads/writes go through services and permission policies.
- Prompt/context helpers must be bounded and redaction-aware.

### WASM

- WASM mode is strict.
- If WASM is requested and unavailable, fail clearly.
- Do not silently fall back to TypeScript.
- Source changes live in `crates/` and TypeScript bridge files.
- `wasm/pkg` is generated output.

If WASM-specific tests fail in a way that suggests stale bindings, run:

```bash
npm run build:wasm
```

---

## Common Failure Modes

### Scope never finishes cancelling

Almost always:
- a finalizer returns a non‑terminating effect
- `unit` was returned instead of `unit()`
- `scope.close()` was used instead of awaiting `closeAsync()`

### HTTP streaming hangs

Usually:
- reader was not cancelled
- fetch was not wired to `AbortSignal`
- stream adapter leaked

### Lifecycle stats stay at zero

Usually:
- `makeLifecycleClient` is bypassing `LifecycleStatsTracker`
- a layer emits local events but not lifecycle events
- stats are being read from the wire client only

### CJS build validates tests but fails package validation

Usually:
- a TS module is named like a native addon, e.g. `*.node.ts`
- a public export is represented internally by a binding name that confuses the
  CJS transform
- package exports changed without updating `tsup.config.ts`

Run:

```bash
npm run build:ts
npm run validate:cjs
```

### WASM scheduler/fiber tests fail unexpectedly

Usually:
- `wasm/pkg` is stale relative to `crates/brass-runtime-wasm-engine`
- bindings were regenerated in another checkout

Run:

```bash
npm run build:wasm
npm test -- src/core/runtime/__tests__/scheduler-lanes.test.ts
```

## Validation

Baseline before handing off changes:

```bash
npm run test:types
npm test
```

For core type/runtime changes:

```bash
npm run test:types
npm test -- src/core/types src/core/runtime/__tests__
```

For HTTP changes:

```bash
npm run test:types
npm test -- src/http/__tests__
```

For public exports, build config, CJS/ESM, or release work:

```bash
npm run build
npm run validate:cjs
```

`npm run build` requires `wasm-pack` and a valid WASM toolchain.

---

## Non‑Goals

brass-runtime intentionally does NOT try to be:

- a framework
- a Promise wrapper
- RxJS
- a magic abstraction

Everything is explicit by design.

---

## Design North Star

> Make effects explicit.  
> Make cancellation correct.  
> Make streaming boring and safe.
