# 🌐 brass-http — ZIO-style HTTP client for brass-runtime

`brass-http` is a small, composable HTTP client built on top of **brass-runtime**.
It follows the same design principles as ZIO HTTP:

- **Lazy & declarative**: requests are values, nothing runs until executed.
- **Async without Promises as semantics**: async is modeled explicitly via the runtime.
- **Cancelable**: requests cooperate with fiber interruption (`AbortController`).
- **Layered**: wire / content / metadata are cleanly separated.
- **Middleware-friendly**: logging, metrics, retries can be added without touching core logic.

This is **not a wrapper around `fetch` promises** — it is an effectful HTTP client integrated with the fiber runtime.

---

## Design overview

The HTTP client is split into **three conceptual layers**:

Recommended entry points:

- `httpClient` is the default DX for most callers: text/JSON helpers, retry middleware, and `.toPromise`.
- `makeHttpClient` / `makeLifecycleClient` are the production-oriented clients when you need cache, deduplication, priority queues, retry, lifecycle events, stats, or `cancelAll`.
- `makeHttp` / `makeHttpStream` are low-level wire clients for middleware authors and tests.
- `httpClientWithMeta` is a compatibility/DX helper for responses that should carry request metadata.

### 1) Wire layer (transport)

Lowest level. Talks to an effect-based transport. The default transport uses
`fetch`, but callers can provide their own backend.

```
Async<R, HttpError, HttpWireResponse>
```

Includes:
- status
- headers
- raw body text
- timing (`ms`)
- status text

This layer knows **nothing** about JSON, parsing, or domain models.

---

### 2) Content layer (default DX)

Maps wire responses into typed content.

```
HttpResponse<A> = {
  status: number
  headers: Record<string, string>
  body: A
}
```

Helpers:
- `getText`
- `getJson<A>`

No metadata, no timing, no transport concerns.

---

### 3) Meta / observability layer (optional middleware)

Enriches content responses with metadata:

```
HttpResponseWithMeta<A> = HttpResponse<A> & {
  meta: {
    statusText: string
    ms: number
  }
}
```

Applied via `withMeta(client)` — never forced.

---

## Basic usage (no meta)

```ts
import { httpClient } from "brass-runtime/http";
import { toPromise } from "brass-runtime";

type Post = {
  id: number;
  title: string;
  body: string;
};

const http = httpClient({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

const effect = http.getJson<Post>("/posts/1");

// Nothing happens yet (lazy)

const result = await toPromise(effect, {});

console.log(result.status);
console.log(result.body.title);
```

## Dependency-free JSON schemas

`brass-runtime/schema` includes a small schema DSL so callers can validate JSON
responses without bringing Zod, Valibot, or any runtime dependency. HTTP
reexports `s` for convenience.

```ts
import { makeDefaultHttpClient, s } from "brass-runtime/http";

const Post = s.object({
  id: s.number({ int: true }),
  title: s.string({ minLength: 1 }),
  tags: s.array(s.string()).optional(),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
});

const result = await http.getJson("/posts/1", { schema: Post }).unsafeRunPromise();
console.log(result.body.title);
```

Validation failures reject with `{ _tag: "ValidationError", message, body,
issues }`, where each issue includes the schema path that failed.

This makes the HTTP layer more than a typed transport wrapper: response schemas,
request-body schemas, construction-time config validation, cancellation,
retry/cache/dedup/compression, and observability all stay in the same lazy
effect pipeline. Callers can adopt schema validation without adding a second
runtime validator dependency.

Request bodies can be validated before a request is sent:

```ts
const CreatePost = s.object({
  title: s.string({ minLength: 1 }),
});

await http.postJson(
  "/posts",
  { title: "Hello" },
  { bodySchema: CreatePost, schema: Post }
).unsafeRunPromise();
```

The body argument is inferred from `bodySchema`. If `bodySchema` fails, the
effect rejects with `phase: "request"` and the transport is never called.

HTTP also exports error helpers and normalizers:

```ts
import {
  formatHttpError,
  isRetryableHttpError,
  isTimeoutHttpError,
  isValidationError,
  matchHttpError,
  toHttpError,
} from "brass-runtime/http";

try {
  await http.getJson("/posts/1", { schema: Post }).unsafeRunPromise();
} catch (error) {
  if (isValidationError(error)) console.error(error.issues);
  if (isTimeoutHttpError(error)) console.error("timeout/backpressure timeout");
  if (isRetryableHttpError(error)) console.error("safe to retry later");
  console.error(formatHttpError(error));
  matchHttpError(error, {
    Timeout: (err) => console.error(err.timeoutMs),
    PoolClosed: (err) => console.error(err.key),
  });
}

const mapped = toHttpError(axiosError); // understands AbortError, timeout codes, Axios-like response.status
```

The same schema module can be used outside HTTP:

```ts
import { s } from "brass-runtime/schema";

const Config = s.object({ port: s.int({ min: 1 }), callbackUrl: s.url() });
const parsed = Config.parse({ port: 3000, callbackUrl: "https://example.com/cb" });
```

## Custom Transports

The wire client uses `fetch` by default, but the transport boundary is now an
effect. `makeHttp`, `httpClient`, `makeLifecycleClient`, and
`makeDefaultHttpClient` accept `transport`, a function from normalized
`HttpRequest` + resolved `URL` + `AbortSignal` to
`Async<unknown, HttpError, HttpWireResponse>`.

That keeps timeout, pool/adaptive limiter, stats, retry, cache, deduplication
and cancellation in Brass while letting the final I/O backend be `fetch`,
Axios, undici, a test double, or an internal client.

```ts
import {
  makeDefaultHttpClient,
  makePromiseHttpTransport,
  promiseHttpTransport,
  normalizeHttpHeaders,
} from "brass-runtime/http";

const transport = makePromiseHttpTransport({
  request: ({ request, url, signal }) =>
    myHttpLibrary.request({
      url: url.toString(),
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    }),
  response: (res) => ({
    status: res.status,
    statusText: res.statusText ?? "",
    headers: normalizeHttpHeaders(res.headers),
    bodyText: typeof res.data === "string" ? res.data : JSON.stringify(res.data),
  }),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  transport,
});
```

For Axios-style clients, the consuming app owns the dependency and only injects
the adapter. The fluent builder covers the common `status` / `statusText` /
`headers` / `data` response shape:

```ts
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
```

Brass injects the `AbortSignal` into object configs before `send`, so the
runtime still owns real cancellation without making callers spell out
`signal`. Promise transports use `toHttpError` by default, so Axios-like
timeouts, aborts, and `response.status` failures become typed `HttpError`
values.

If the external client has a different shape, keep the same fluent order and
map only the pieces that differ:

```ts
const transport = promiseHttpTransport()
  .requestConfig(({ request, url }) => ({ method: request.method, url }))
  .send((config) => internalClient.send(config))
  .json((res) => res.payload, (res) => ({
    status: res.code,
    statusText: res.message,
    headers: res.headerMap,
    transportMeta: { upstream: res.node },
  }));
```

Per-request execution knobs live under `policy`, so they compose with all
transports and lifecycle middleware:

```ts
await http.getJson("/users", {
  policy: {
    priority: 1,
    dedupKey: "users:list",
    poolKey: "users-api",
    retry: false,
  },
}).unsafeRunPromise();
```

For repeated intent, define named presets once and reference them per request:

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

`DefaultHttpClientConfig`, `LifecycleClientConfig`, and
`HttpObservabilityOptions` are validated at construction boundaries with
`ConfigValidationError`. Invalid policy preset fields, compression encodings,
and observability policy label keys fail before the first request.

## Adaptive Limiter

`adaptiveLimiter` keeps per-key state bounded with `stateTtlMs` and supports
explicit ramp-up controls:

```ts
import { makeAdaptiveLimiterConfig, makeHttp } from "brass-runtime/http";

const http = makeHttp({
  adaptiveLimiter: makeAdaptiveLimiterConfig("balanced", {
    maxLimit: 256,
    stateTtlMs: 300_000,
    warmupRequests: 25,
    decreaseCooldownSamples: 3,
    historySize: 64,
  }),
});

console.log(http.adaptiveLimiter?.dump());
console.log(http.adaptiveLimiter?.history("https://api.example.com"));
http.shutdown?.();
```

`destroy()`/`shutdown()` clears queue-timeout and TTL timers, rejects queued
waiters with `PoolClosed`, and drops limiter state. Circuit breaker feedback can
call `markCircuitOpen(key)` directly; `withCircuitBreaker` also forwards open
signals when it receives an `adaptiveLimiter` or wraps a `makeHttp` client that
owns one.
For changing latency floors, `baselineStrategy` can use the exact min, P5, or a
low-percentile EMA. Diagnostics expose per-key limit-change `history`, current
utilization, throughput, rejection rate, and monotonic activity timestamps plus
wall-clock timestamps for logs.
`windowDecayFactor` weights percentiles toward recent samples, while
`errorWeight` blends 5xx/failure rate into the gradient so fast-failing
downstreams can lower concurrency before latency rises. The internal limiter
queue can honor request priority and, when full, evict lower-priority waiters;
sustained `PoolRejected` errors may include `retryAfterMs` as a client-side
backoff hint.

Named presets are available as `conservative`, `balanced`, and `aggressive`.
The default HTTP client uses `balanced` for `preset: "balanced"` and
`aggressive` for `preset: "default"` / `preset: "production"`.
`production` is the explicit name for the full production-ready default stack;
`default` remains as the compatibility name. Use `adaptiveLimiterPresets` or
`makeAdaptiveLimiterConfig(preset, overrides)` when you want a documented
adaptive limiter baseline with a few local overrides.

When `withHttpObservability` wraps a client that owns an adaptive limiter, it
records limiter gauges such as limit, in-flight, queue depth, utilization,
error rate, request/completion rate, rejection rate, and state count. The same
snapshot is attached to HTTP client span events.
The middleware also reads structured per-request `policy`. Logs and span
attributes receive `preset`, `lane`, `poolKey`, `dedupKey`, `priority`, and retry
overrides automatically, while metric labels stay opt-in through
`policy.labelKeys` to avoid accidental high-cardinality metrics.

See [`http-recipes.md`](http-recipes.md) for typed API client, testing,
observability, retry, adaptive limiter, and config validation recipes.

## HTTP Server

`brass-runtime/http` includes a first server MVP for Node. It uses a simple
router, effect-based middleware, first-party schema validation for
`params`/`query`/`body`/`response`, and optional observability integration.

```ts
import {
  Async,
  Runtime,
} from "brass-runtime/core";
import {
  json,
  makeHttpRouter,
  makeNodeHttpServer,
  route,
  s,
} from "brass-runtime/http";
import { makeObservability } from "brass-runtime/observability";

const Params = s.object({ id: s.nonEmptyString() });
const Response = s.object({ id: s.string(), ok: s.boolean() });

const router = makeHttpRouter([
  route("GET", "/users/:id", {
    params: Params,
    response: Response,
  }, (ctx) => Async.succeed(json({ id: ctx.params.id, ok: true }))),
]);

const obs = makeObservability({ logs: false });
const runtime = new Runtime({ env: {} });
const server = await runtime.toPromise(makeNodeHttpServer({
  router,
  observability: obs,
  port: 3000,
}));

console.log(server.url());
await server.close();
```

Path params are inferred from the route string even without a params schema:

```ts
route("GET", "/users/:id/books/:bookId", (ctx) =>
  Async.succeed(json({
    userId: ctx.params.id,
    bookId: ctx.params.bookId,
  }))
);
```

`makeNodeHttpServerResource` exposes the same adapter as a `Resource` for
scoped lifecycle. Release uses a schedule-driven graceful shutdown poll and
can force-close remaining connections after `gracefulShutdownMs`.
For declarative server lifecycle, routers also expose `listen()`:

```ts
await runtime.toPromise(
  router.listen({
    host: "127.0.0.1",
    port: 3000,
    observability: obs,
  }).use((server) =>
    Async.succeed(console.log(server.url()))
  )
);
```

Runtime health/readiness probes can be mounted as ordinary routes. They reuse
the observability health model and return `200` when ready or `503` when not:

```ts
import {
  makeHttpRouter,
  makeRuntimeHealthRoute,
  makeRuntimeReadinessRoute,
} from "brass-runtime/http";

const router = makeHttpRouter([
  makeRuntimeHealthRoute({ runtime, registry: runtime.registry }),
  makeRuntimeReadinessRoute({
    runtime,
    registry: runtime.registry,
    adaptiveLimiters: { api: limiter },
    readiness: { failOnDegraded: true },
  }),
]);
```

## Builder API

For discoverability, the default client also has a fluent builder:

```ts
import { httpClientBuilder } from "brass-runtime/http";

const http = httpClientBuilder()
  .baseUrl("https://api.example.com")
  .production()
  .balancedLimiter({ maxLimit: 128 })
  .header("authorization", `Bearer ${token}`)
  .cache({ ttlSeconds: 30, maxEntries: 512 })
  .retry({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000 })
  .build();
```

## Test helpers subpath

The `brass-runtime/http/testing` subpath exposes dependency-free helpers for
adopters' tests:

```ts
import {
  makeJsonHttpResponse,
  makeMockHttpClient,
  runHttpEffect,
  withMockFetch,
} from "brass-runtime/http/testing";

const mock = makeMockHttpClient((req) => makeJsonHttpResponse({ url: req.url }));
const wire = await runHttpEffect(mock({ method: "GET", url: "/users/1" }));
```

---

## With metadata (observability)

```ts
import { httpClientWithMeta } from "../http/httpClient";

const http = httpClientWithMeta({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

const res = await toPromise(http.getJson<Post>("/posts/1"), {});

console.log(res.status);
console.log(res.meta.ms);
console.log(res.body.title);
```

Metadata is **opt-in**, not baked into the core.

---

## Lifecycle client

Use `makeHttpClient` (alias of `makeLifecycleClient`) when request lifecycle behavior is part of the contract:

```ts
import { makeHttpClient } from "brass-runtime/http";
import { toPromise } from "brass-runtime";

const http = makeHttpClient({
  baseUrl: "https://api.example.com",
  dedup: {},
  cache: { ttlSeconds: 60, maxEntries: 512 },
  priority: { concurrency: 8 },
  retry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 500 },
  onEvent: (event) => {
    console.log(event.type, event.cacheKey ?? event.priority ?? event.attempt ?? "");
  },
});

const res = await toPromise(http({ method: "GET", url: "/users/1" }), {});
console.log(res.status, http.stats().cacheHits);
```

`stats()` reports wire counters plus lifecycle counters for cache hits/misses,
dedup hits/active groups, queue depth, retry attempts, and request
success/failure totals.
`cancelAll()` aborts active requests through the same `AbortController` path used
by fiber interruption.

The stable composition order is:

```txt
wire -> priority -> retry -> cache -> dedup -> lifecycle tracking
```

---

## Raw wire access (escape hatch)

```ts
const wire = await toPromise(http.get("/posts/1"), {});

console.log(wire.status);
console.log(wire.bodyText);
console.log(wire.ms);
```

---

## Cancellation & interruption

All requests are **cooperatively cancelable**.

```ts
const fiber = fork(http.getJson<Post>("/posts/1"), {});

setTimeout(() => {
  fiber.interrupt(); // aborts the underlying transport
}, 50);
```

---

## Middleware model (ZIO-style)

Clients are **just functions**:

```
type HttpClient = (req: HttpRequest) =>
  Async<unknown, HttpError, HttpWireResponse>;
```

---

## Status

Experimental but stable enough to use and evolve.

---

## Timeout, pool y retry budget

`makeHttp`, `httpClient` y `httpClientStream` aceptan controles de fase 2:

```ts
const http = httpClient({
  baseUrl: "https://api.example.com",
  timeoutMs: 2_000,
  pool: {
    concurrency: 32,
    maxQueue: 128,
    queueTimeoutMs: 100,
    key: "origin",
  },
});
```

`timeoutMs` cubre espera de pool, transporte y lectura de body en respuestas no-streaming.

El pool permite rechazar temprano en vez de dejar requests vivos hasta un `504`:

```ts
pool: { concurrency: 16, maxQueue: 0 } // fail-fast
```

Errores nuevos:

```ts
{ _tag: "Timeout", timeoutMs, phase: "request", message }
{ _tag: "PoolRejected", key, limit, message, retryAfterMs? }
{ _tag: "PoolTimeout", key, timeoutMs, message }
```

Retry ahora puede tener budget total:

```ts
http.withRetry({
  maxRetries: 2,
  baseDelayMs: 25,
  maxDelayMs: 250,
  maxElapsedMs: 800,
});
```

El retry default reintenta `Timeout`, `PoolTimeout` y `FetchError` sin status o
con status retriable (`408`, `429`, `5xx` relevantes). No reintenta `Abort`,
`BadUrl`, `PoolRejected` ni `FetchError` con status no retriable como `404`.

Stats:

```ts
console.log(http.stats());
console.log(http.wire.stats());
```

Y desde runtime:

```ts
import { abortablePromiseStats } from "../core/runtime/runtime";
console.log(abortablePromiseStats());
```

---

## HTTP feature middlewares

Estas features viven en la capa HTTP y se componen como middleware sobre el wire client.

### Response compression

`makeResponseCompressionMiddleware` agrega `Accept-Encoding` cuando falta y descomprime respuestas con `Content-Encoding` soportado.

```ts
import { httpClient, makeResponseCompressionMiddleware } from "brass-runtime/http";

const compression = makeResponseCompressionMiddleware({
  encodings: ["br", "gzip", "deflate"],
});

const http = httpClient({ baseUrl: "https://api.example.com" })
  .with(compression.middleware);

const res = await http.getText("/data").toPromise({});
console.log(res.body);
console.log(compression.stats());
```

### Request compression

`makeRequestCompressionMiddleware` comprime bodies salientes de `POST`, `PUT` y `PATCH` cuando superan `minBytes`.

```ts
import { httpClient, makeRequestCompressionMiddleware } from "brass-runtime/http";

const requestCompression = makeRequestCompressionMiddleware({
  encoding: "gzip",
  minBytes: 1024,
});

const http = httpClient({ baseUrl: "https://api.example.com" })
  .with(requestCompression.middleware);

await http.post("/upload", largeBody).toPromise({});
```

### Request batching

El batching es server-specific: Brass agrupa requests y vos definis como se encodea el batch y como se divide la respuesta.

```ts
import { httpClient, withRequestBatching } from "brass-runtime/http";

const http = httpClient({ baseUrl: "https://api.example.com" })
  .with(withRequestBatching({
    key: () => "users",
    maxBatchSize: 16,
    maxWaitMs: 5,
    encode: (requests) => ({
      method: "POST",
      url: "/batch",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requests.map((req) => ({ method: req.method, url: req.url }))),
    }),
    decode: (response) => {
      const bodies = JSON.parse(response.bodyText) as unknown[];
      return bodies.map((body) => ({ ...response, bodyText: JSON.stringify(body) }));
    },
  }));
```

### Connection pre-warming

`prewarmConnections` ejecuta requests livianos, por defecto `HEAD`, para preparar conexiones antes del trafico real. Tambien existe `withConnectionPrewarming` para calentar el origen en el primer request.

```ts
import { toPromise } from "brass-runtime";
import { prewarmConnections } from "brass-runtime/http";

await toPromise(
  prewarmConnections({
    baseUrl: "https://api.example.com",
    urls: ["/health"],
  }),
  {}
);
```
