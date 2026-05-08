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

Lowest level. Talks to `fetch`, returns raw HTTP data.

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
  fiber.interrupt(); // aborts underlying fetch
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

`timeoutMs` cubre espera de pool, `fetch` y lectura de body en respuestas no-streaming.

El pool permite rechazar temprano en vez de dejar requests vivos hasta un `504`:

```ts
pool: { concurrency: 16, maxQueue: 0 } // fail-fast
```

Errores nuevos:

```ts
{ _tag: "Timeout", timeoutMs, phase: "request", message }
{ _tag: "PoolRejected", key, limit, message }
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

El retry default reintenta `FetchError`, `Timeout` y `PoolTimeout`, pero no reintenta `Abort`, `BadUrl` ni `PoolRejected`.

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
