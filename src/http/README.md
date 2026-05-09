# HTTP (brass-runtime)

Cliente HTTP minimalista construido encima del runtime `Async` de Brass. La idea es que **HTTP sea un effect lazy y cancelable**, y que la “DX” (helpers JSON, meta, optics) viva como capas finas arriba del *wire client*.

## Objetivos de diseño

- **Lazy**: no se ejecuta nada hasta “correr” el effect.
- **Cancelable**: la interrupción del fiber / effect cancela `fetch` vía `AbortController` (usando `fromPromiseAbortable`).
- **Componible**: un *wire client* simple (`makeHttp`) + helpers (`makeDefaultHttpClient`, `httpClient`, `makeHttpClient`, `httpClientWithMeta`, streaming).
- **Sin magia**: los tipos principales son chicos y fáciles de debuggear.

---

## Qué API usar

- `makeDefaultHttpClient`: opción recomendada para consumo normal. Integra helpers `getText`, `getJson`, `postJson` con lifecycle, retry, dedup, cache segura, prioridad, adaptive concurrency, compression, stats y `cancelAll`.
- `s` / `schema`: validación JSON sin dependencias externas, integrada con `getJson` y `postJson`.
- `httpClientBuilder`: builder discoverable para presets, headers, lifecycle, compression y middleware.
- `httpClient`: helper liviano para consumo normal cuando no necesitás lifecycle integrado.
- `makeHttpClient` / `makeLifecycleClient`: opción lower-level para componer cache, dedup, prioridad, retry, eventos, stats o `cancelAll` manualmente.
- `makeHttp` / `makeHttpStream`: wire layer para middlewares, tests y casos avanzados.
- `httpClientWithMeta`: helper de compatibilidad cuando querés respuesta + metadata.

---

## Instalación / import

Este módulo se exporta desde `src/http/index.ts`:

```ts
import { makeDefaultHttpClient, httpClient, makeHttpClient, makeLifecycleClient, makeHttp } from "../http";
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
import { makeDefaultHttpClient } from "../http";

type Post = { userId: number; id: number; title: string; body: string };

const http = makeDefaultHttpClient({
  baseUrl: "https://jsonplaceholder.typicode.com",
});

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

El preset por defecto (`default`) prende timeout, dedup, priority, retry,
adaptive limiter `aggressive`, cache para métodos seguros y response
compression. Si querés evitar cache por default, usá `preset: "balanced"`; si
querés solo wire + DX, usá `preset: "minimal"`.

El adaptive limiter mantiene estado por key con TTL (`stateTtlMs`), probe con
jitter (`probeJitterRatio`), warmup explícito (`warmupRequests`), slow-start
recovery y `headroomStrategy` fijo/proporcional/custom. También soporta
`baselineStrategy` (`"min"`, `"p5"`, `"ema-low"`), cooldown de decreases con
`decreaseCooldownSamples`, percentiles con decay (`windowDecayFactor`),
multi-signal gradient con `errorWeight`, queue interna por prioridad
(`queueStrategy`) con load shedding por eviction (`queueLoadShedding`),
backoff hints en `PoolRejected.retryAfterMs`, historial consultable con
`history(key)`, y diagnósticos de utilization/throughput/error rate en
`stats()`, `snapshot()` y `dump()`.
`makeHttp` expone `shutdown()` cuando el limiter está activo para limpiar
timers, rechazar waiters pendientes y liberar state en tests o shutdown
graceful.
Los presets públicos del limiter son `conservative`, `balanced` y
`aggressive`; podés usarlos con `{ preset: "balanced", maxLimit: 128 }`,
`makeAdaptiveLimiterConfig("balanced", overrides)` o desde el builder con
`.balancedLimiter(overrides)`.

### JSON con schema propio

No hay dependencia en Zod, Valibot ni similares. `brass-runtime/schema` trae
una DSL chica, y HTTP reexporta `s` por comodidad:

```ts
import { makeDefaultHttpClient, s } from "brass-runtime/http";

const User = s.object({
  id: s.int(),
  name: s.nonEmptyString(),
  email: s.email(),
  role: s.enum(["admin", "user"] as const).optional(),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
});

const res = await http.getJson("/users/1", { schema: User }).unsafeRunPromise();
console.log(res.body.name);
```

`postJson` también puede validar el body antes de tocar la red:

```ts
const CreateUser = s.object({
  name: s.nonEmptyString(),
  email: s.email(),
});

await http.postJson(
  "/users",
  { name: "Ada" },
  { bodySchema: CreateUser, schema: User }
).unsafeRunPromise();
```

Si `bodySchema` falla, el effect falla con `phase: "request"` y no llama a
`fetch`. El tipo del body también se infiere desde `bodySchema`.

Los errores comunes se pueden manejar con helpers:

```ts
import { formatHttpError, isValidationError, matchHttpError } from "brass-runtime/http";

try {
  await http.getJson("/users/1", { schema: User }).unsafeRunPromise();
} catch (error) {
  if (isValidationError(error)) console.error(error.issues);
  console.error(formatHttpError(error));
  matchHttpError(error, {
    Timeout: (err) => console.error(err.timeoutMs),
    PoolClosed: (err) => console.error(err.key),
  });
}
```

También podés usarla fuera de HTTP:

```ts
import { s } from "brass-runtime/schema";

const Config = s.object({ port: s.int({ min: 1 }), callbackUrl: s.url() });
const parsed = Config.parse({ port: 3000, callbackUrl: "https://example.com/cb" });
```

Si el JSON no parsea o no matchea el schema, el effect falla con:

```ts
{ _tag: "ValidationError", message, body, issues }
```

Esto evita tener un wrapper de `fetch` más un validador externo pegado a mano:
schemas de response, schemas de request body, config validation, retry,
compression, cancelación y observability corren en el mismo pipeline lazy.

## HTTP server MVP

El subpath HTTP también incluye un server pequeño para Node. El router ejecuta
handlers como `Async`, valida `params`, `query`, `body` y `response` con el
schema first-party, compone middleware effect-based, y el adapter puede registrar
metrics/spans/logs con `makeObservability`.

```ts
import {
  json,
  makeHttpRouter,
  makeNodeHttpServer,
  route,
  s,
} from "brass-runtime/http";
import { makeObservability } from "brass-runtime/observability";
import { Async, Runtime } from "brass-runtime/core";

const UserParams = s.object({ id: s.nonEmptyString() });
const UserResponse = s.object({ id: s.string(), ok: s.boolean() });

const router = makeHttpRouter([
  route("GET", "/users/:id", {
    params: UserParams,
    response: UserResponse,
  }, (ctx) =>
    Async.succeed(json({ id: ctx.params.id, ok: true }))),
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

Los params también se infieren desde el path aunque no declares schema:

```ts
route("GET", "/users/:id/books/:bookId", (ctx) =>
  Async.succeed(json({
    userId: ctx.params.id,
    bookId: ctx.params.bookId,
  }))
);
```

`makeNodeHttpServer` starts the Node server as an effect. The resource variant
`makeNodeHttpServerResource` closes it during release with a schedule-driven
graceful shutdown poll, and will force-close connections after the configured
deadline.
Para un lifecycle más declarativo, el router expone `.listen()` como
`Resource`:

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

Los probes de runtime/readiness se montan como rutas normales y reutilizan el
modelo de observability health:

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

### Builder pattern

```ts
import { httpClientBuilder } from "brass-runtime/http";

const http = httpClientBuilder()
  .baseUrl("https://api.example.com")
  .balanced()
  .balancedLimiter({ maxLimit: 128 })
  .header("authorization", `Bearer ${token}`)
  .cache({ ttlSeconds: 30, maxEntries: 256 })
  .retry({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000 })
  .build();
```

### Helpers de testing

```ts
import {
  makeJsonHttpResponse,
  makeMockHttpClient,
  runHttpEffect,
} from "brass-runtime/http/testing";

const mock = makeMockHttpClient((req) => makeJsonHttpResponse({ url: req.url }));
const res = await runHttpEffect(mock({ method: "GET", url: "/users/1" }));
```

Observability, auth u otros cross-cutting concerns entran por el mismo punto:

```ts
import { makeDefaultHttpClient } from "../http";
import { withHttpObservability } from "../observability";

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  middleware: [withHttpObservability(obs)],
});
```

Si el cliente tiene adaptive limiter, `withHttpObservability` emite gauges de
limit, in-flight, queue depth, utilization, error rate, throughput y rejection
rate, y agrega el mismo snapshot a los eventos del span HTTP.

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

---

## Phase 2: timeout, pool y stats

El wire client ahora puede cortar requests antes de que se transformen en `504` tardíos:

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

Errores nuevos:

- `{ _tag: "Timeout" }`
- `{ _tag: "PoolRejected" }`
- `{ _tag: "PoolTimeout" }`

`http.stats()` y `http.wire.stats()` exponen presión actual de transporte: `inFlight`, `timedOut`, `poolRejected`, `poolTimeouts` y métricas por key del pool.

También podés mirar promesas abortables activas desde el runtime:

```ts
import { abortablePromiseStats } from "brass-runtime";

console.log(abortablePromiseStats());
```

---

## Feature middlewares

La capa HTTP tambien expone features componibles:

- `makeResponseCompressionMiddleware` — agrega `Accept-Encoding` y descomprime responses.
- `makeRequestCompressionMiddleware` — comprime bodies salientes opt-in.
- `withRequestBatching` — agrupa requests usando un encoder/decoder definido por el servidor.
- `prewarmConnections` / `withConnectionPrewarming` — calienta conexiones con requests livianos.

Ejemplo:

```ts
import {
  httpClient,
  makeResponseCompressionMiddleware,
  makeRequestCompressionMiddleware,
  withRequestBatching,
  prewarmConnections,
} from "brass-runtime/http";
import { toPromise } from "brass-runtime";

const responseCompression = makeResponseCompressionMiddleware();
const requestCompression = makeRequestCompressionMiddleware({ minBytes: 1024 });

await toPromise(
  prewarmConnections({
    baseUrl: "https://api.example.com",
    urls: ["/health"],
  }),
  {}
);

const http = httpClient({ baseUrl: "https://api.example.com" })
  .with(responseCompression.middleware)
  .with(requestCompression.middleware)
  .with(withRequestBatching({
    key: () => "default",
    encode: (requests) => ({
      method: "POST",
      url: "/batch",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requests.map((req) => ({ method: req.method, url: req.url }))),
    }),
    decode: (res) => {
      const bodies = JSON.parse(res.bodyText) as unknown[];
      return bodies.map((body) => ({ ...res, bodyText: JSON.stringify(body) }));
    },
  }));
```
