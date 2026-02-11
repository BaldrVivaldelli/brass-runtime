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
