# HTTP (brass-runtime)

Cliente HTTP minimalista construido encima del runtime `Async` de Brass. La idea es que **HTTP sea un effect lazy y cancelable**, y que la “DX” (helpers JSON, meta, optics) viva como capas finas arriba del *wire client*.

## Objetivos de diseño

- **Lazy**: no se ejecuta nada hasta “correr” el effect.
- **Cancelable**: la interrupción del fiber / effect cancela `fetch` vía `AbortController` (usando `fromPromiseAbortable`).
- **Componible**: un *wire client* simple (`makeHttp`) + helpers (`httpClient`, `httpClientWithMeta`, streaming).
- **Sin magia**: los tipos principales son chicos y fáciles de debuggear.

---

## Instalación / import

Este módulo se exporta desde `src/http/index.ts`:

```ts
import { httpClient, httpClientWithMeta, httpClientStream } from "../http";
```

> En Node necesitás una versión con `fetch` global (Node 18+), o un polyfill.

---

## Tipos principales

### Wire layer (`makeHttp` / `makeHttpStream`)

- **`HttpRequest`**
    - `method`, `url`
    - `headers?: Record<string,string>`
    - `body?: string`
    - `init?: HttpInit` (`RequestInit` sin `method/body/headers`)

- **`HttpWireResponse`**
    - `status`, `statusText`
    - `headers: Record<string,string>`
    - `bodyText: string`
    - `ms: number`

- **`HttpError`**
    - `{ _tag: "Abort" }`
    - `{ _tag: "BadUrl"; message: string }`
    - `{ _tag: "FetchError"; message: string }`

### DX layer (`httpClient`)

- `getText(url, init?)` → `HttpResponse<string>`
- `getJson<A>(url, init?)` → `HttpResponse<A>`
- `post(url, body?, init?)` → `HttpWireResponse`
- `postJson(url, bodyObj, init?)` → `HttpWireResponse`
- `request(req)` → `HttpWireResponse` (raw)

---

## Ejecutar un effect (`toPromise`)

Según cómo tengas configurada la DX, podés correr effects de dos maneras:

### A) Runner explícito

```ts
import { toPromise } from "../core/runtime/runtime";

const r = await toPromise(http.getJson<Post>("/posts/1"), {});
```

### B) Método `.toPromise(env)`

Si en tu `httpClient` estás “decorando” los effects para agregar `.toPromise(env)`:

```ts
const r = await http.getJson<Post>("/posts/1").toPromise({});
```

---

## Uso rápido (JSONPlaceholder)

```ts
import { httpClient } from "../http";

type Post = { userId: number; id: number; title: string; body: string };

const http = httpClient({ baseUrl: "https://jsonplaceholder.typicode.com" });

// GET JSON
const r1 = await http.getJson<Post>("/posts/1").toPromise({});
console.log(r1.status, r1.body.title);

// POST JSON (wire)
const wire = await http
  .postJson(
    "/posts",
    { userId: 1, title: "Hola Brass", body: "Probando POST" },
    { headers: { accept: "application/json" } }
  )
  .toPromise({});

console.log(wire.status, wire.bodyText);
```

---

## `httpClientWithMeta`

Versión que devuelve **meta** adicional (útil para logs/metrics/debug). Un shape típico:

```ts
type HttpMeta = {
  request: HttpRequest;
  urlFinal: string;
  startedAt: number;
  durationMs: number; // normalmente w.ms
};
```

Ejemplo:

```ts
import { httpClientWithMeta } from "../http";

const http = httpClientWithMeta({ baseUrl: "https://jsonplaceholder.typicode.com" });

const r = await http.getJson<Post>("/posts/1").toPromise({});
console.log(r.meta.durationMs, r.meta.urlFinal, r.response.body.title);
```

> Nota: el “shape” exacto depende de tu implementación actual en `httpClient.ts`.

---

## Streaming (`httpClientStream`)

Cliente streaming basado en `makeHttpStream`. La respuesta trae un `ZStream` de bytes:

```ts
import { httpClientStream } from "../http";

const http = httpClientStream({ baseUrl: "https://example.com" });

const res = await http.get("/big-file").toPromise({});
// res.body es ZStream<unknown, HttpError, Uint8Array>
```

Consumí el stream con los combinators disponibles en tu implementación de `ZStream`.

---

## Optics (Lens) para `HttpRequest`

El módulo incluye una Lens mínima y helpers para modificar requests de forma componible (principalmente headers).

### Helpers disponibles

- `Request.headers` (Lens)
- `setHeader(k,v)`
- `removeHeader(k)`
- `mergeHeaders(record)`
- `setHeaderIfMissing(k,v)`
- `atKey(key)` (Lens para `Record`)

### Ejemplo: agregar headers con optics y usar `request(req)`

```ts
import { httpClient } from "../http";
import { setHeader, setHeaderIfMissing, mergeHeaders } from "../http/optics/request";

const http = httpClient({ baseUrl: "https://jsonplaceholder.typicode.com" });

const req = mergeHeaders({ accept: "application/json" })(
  setHeaderIfMissing("content-type", "application/json")(
    setHeader("authorization", "Bearer abc123")({
      method: "POST",
      url: "/posts",
      body: JSON.stringify({ userId: 1, title: "x", body: "y" }),
    })
  )
);

const wire = await http.request(req).toPromise({});
console.log(wire.status);
```

---

## Notas y convenciones

- `baseUrl` + `url` se resuelven con `new URL(req.url, baseUrl)`.
- `headers` “por request” viven en `req.headers`.
- `init` está pensado para opciones de `fetch` (credentials, cache, redirect, etc.). El `signal` lo maneja el runtime.

---

## Próximos pasos (ideas)

- Middleware: `timeout`, `retry`, `logging`, `metrics`
- Mejor modelado de errores: `StatusError`, `JsonDecodeError`
- Bodies streaming para requests (upload)
- Normalización de headers / case-insensitive
