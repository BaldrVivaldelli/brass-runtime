# Brass Runtime: efectos, HTTP y observabilidad sin casarte con un proveedor

En las últimas iteraciones de `brass-runtime` trabajamos sobre una idea simple:
si el runtime quiere ser útil en proyectos reales, no alcanza con tener un
modelo de efectos prolijo. Tiene que integrarse bien con HTTP, con la
observabilidad de producción, con los frameworks que los equipos ya usan, y con
las herramientas que cada organización decide traer a la mesa.

La dirección fue clara: **Brass debe conocer contratos, no proveedores**.

Eso aparece en varias decisiones de diseño:

- HTTP no está atado a `fetch`.
- Observability no está atada a Grafana, AppDynamics ni OpenTelemetry SDKs.
- Las políticas de ejecución viajan con el request sin obligar al usuario a
  pensar en detalles internos.
- La integración con frameworks vive en recetas y ejemplos, no como
  dependencias duras del runtime.

Este artículo resume ese trabajo.

## El punto de partida

`brass-runtime` es un runtime de efectos para TypeScript, inspirado por ideas
tipo ZIO: efectos lazy, composición explícita, runtime controlado,
cancelación, recursos, capas y herramientas para modelar fallas.

Pero cuando un runtime sale del laboratorio y entra en una app real, aparecen
preguntas más prácticas:

- ¿Cómo llamo APIs HTTP sin perder retries, timeouts y cancelación?
- ¿Cómo observo lo que pasa sin meter un SDK gigante como dependencia dura?
- ¿Cómo conecto esto con Nest, Express, Next.js, React o Angular?
- ¿Cómo dejo que un proyecto use Axios, `fetch`, undici o un cliente propio?
- ¿Cómo evito que cada consumidor tenga que escribir plumbing de bajo nivel?

La respuesta fue fortalecer el módulo HTTP y la historia de observabilidad.

## HTTP como una capa de efectos

El primer movimiento importante fue tratar HTTP no como una función suelta que
hace `fetch`, sino como una capa de ejecución alrededor de efectos.

El cliente HTTP recomendado hoy es `makeDefaultHttpClient`, que compone:

- timeout;
- retry;
- cache;
- deduplicación;
- priority scheduling;
- adaptive concurrency;
- compression;
- middleware;
- observability;
- políticas por request.

Un ejemplo mínimo:

```ts
import { makeDefaultHttpClient } from "brass-runtime/http";
import { makeObservability, withHttpObservability } from "brass-runtime/observability";

const observability = makeObservability({
  serviceName: "orders-api",
});

const http = makeDefaultHttpClient({
  baseUrl: "https://users-api.internal",
  preset: "production",
  middleware: [withHttpObservability(observability)],
});

const user = await http.getJson<{ id: string; name: string }>("/users/42")
  .unsafeRunPromise();
```

La parte importante no es solo que el cliente llame una URL. Es que la llamada
viaja por una pipeline controlada por Brass.

## El transporte no tiene que ser `fetch`

Una pregunta clave fue: si hoy el runtime se apalanca mucho en `fetch`, ¿por qué
no hacer que la capa de transporte sea intercambiable?

Eso llevó a formalizar `HttpTransport`.

La idea es que Brass conserve la semántica que le importa:

- request normalizado;
- URL resuelta;
- `AbortSignal`;
- respuesta wire;
- errores normalizados;
- métricas y timings.

Pero el mecanismo concreto puede ser `fetch`, Axios, undici, un mock, un SDK
interno o cualquier cliente Promise-based.

Para que eso no obligue al usuario a escribir `Async.async` y `Cause.fail`, se
sumó un helper fluido:

```ts
import axios from "axios";
import {
  makeDefaultHttpClient,
  promiseHttpTransport,
} from "brass-runtime/http";

const axiosInstance = axios.create({
  timeout: 10_000,
  headers: { "x-client": "orders-api" },
});

const axiosTransport = promiseHttpTransport()
  .requestConfig(({ request, url }) => ({
    url: url.toString(),
    method: request.method,
    headers: request.headers,
    data: request.body,
  }))
  .send((config) => axiosInstance.request(config))
  .json(
    (response) => response.data,
    (response) => ({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  preset: "production",
  transport: axiosTransport,
});
```

El `AbortSignal` sigue viajando, pero el usuario no tiene que declararlo en cada
request. Brass lo inyecta en el borde correcto.

## DX: menos ceremonia, más intención

Durante el diseño apareció una mejora importante de DX: evitar APIs redundantes
como:

```ts
fromJson().response();
```

Terminamos con una forma más directa:

```ts
.json()
```

La intención es más clara: “este transporte devuelve JSON”. Si hace falta
customizar cómo se extrae el body o cómo se leen status/headers, se puede pasar
un mapper. Pero el camino común queda corto.

Ese fue un patrón de diseño que se repitió varias veces: **hacer fácil el caso
común sin cerrar la puerta al caso avanzado**.

## Policies: la intención viaja con el request

Otro bloque importante fue la historia de policies.

En producción, no todos los requests son iguales. Un GET de lectura puede
aceptar retry y deduplicación. Un comando de escritura puede necesitar prioridad
alta y cero retry automático. Un request batch puede necesitar otro lane.

Para eso se agregó una forma estructurada de expresar intención:

```ts
import {
  defineHttpPolicyPresets,
  makeDefaultHttpClient,
} from "brass-runtime/http";

const policies = defineHttpPolicyPresets({
  readModel: {
    lane: "read-model",
    priority: 3,
    retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000 },
  },
  command: {
    lane: "command",
    priority: 1,
    retry: false,
  },
});

const http = makeDefaultHttpClient({
  baseUrl: "https://users-api.internal",
  preset: "production",
  policyPresets: policies,
});

await http.getJson("/users/42", {
  policy: "readModel",
}).unsafeRunPromise();

await http.postJson("/users", body, {
  policy: "command",
}).unsafeRunPromise();
```

La policy puede alimentar retry, dedup, priority, pool key, lanes y también
observability. El request no solo transporta datos; transporta intención
operativa.

## Observability sin dependencia dura

El otro gran bloque fue observability.

La meta no era “integrarnos con Grafana” o “integrarnos con AppDynamics” como
dependencia de runtime. Eso volvería a Brass más pesado y más frágil.

La meta fue otra: **emitir señales usando contratos estándar y permitir que la
aplicación decida dónde enviarlas**.

Brass expone:

- métricas;
- spans;
- logs estructurados;
- propagación W3C `traceparent`;
- contexto por request;
- middleware HTTP observado;
- exportadores OTLP HTTP;
- Prometheus text exporter;
- redacción;
- sampling;
- control de cardinalidad;
- pipelines de export con batch, retry, timeout y shutdown.

Un ejemplo de producción:

```ts
import {
  makeObservability,
  makeOtlpOptions,
  withHttpObservability,
} from "brass-runtime/observability";
import { makeDefaultHttpClient } from "brass-runtime/http";

const observability = makeObservability({
  serviceName: "orders-api",
  serviceVersion: "1.2.3",
  resource: {
    "service.namespace": "commerce",
    "deployment.environment": "production",
  },
  logs: { minLevel: "info" },
  sampling: { ratio: 0.25, respectRemoteSampled: true, forceSampleOnError: true },
  redaction: {},
  cardinality: { maxValuesPerLabel: 100 },
  otlp: makeOtlpOptions({
    endpoint: process.env.GRAFANA_OTLP_ENDPOINT ?? "http://grafana-alloy:4318",
    headers: process.env.GRAFANA_OTLP_AUTHORIZATION
      ? { Authorization: process.env.GRAFANA_OTLP_AUTHORIZATION }
      : undefined,
    timeoutMs: 10_000,
    retry: { attempts: 3, initialDelayMs: 100, maxDelayMs: 2_000 },
    pipeline: {
      maxQueueSize: 10_000,
      batchSize: 512,
      dropPolicy: "drop-oldest",
      shutdownTimeoutMs: 10_000,
    },
  }),
  flushIntervalMs: 10_000,
  autoStart: true,
});

const http = makeDefaultHttpClient({
  baseUrl: "https://users-api.internal",
  preset: "production",
  middleware: [withHttpObservability(observability)],
});
```

La aplicación puede mandar a Grafana Cloud, Grafana Alloy, AppDynamics
Collector, OpenTelemetry Collector o cualquier endpoint compatible con OTLP
HTTP. Brass solo necesita URLs, headers y tuning.

## `makeOtlpOptions`: helper genérico, no vendor-specific

Para reducir repetición, agregamos `makeOtlpOptions`.

En lugar de escribir:

```ts
otlp: {
  metricsUrl: "http://collector:4318/v1/metrics",
  tracesUrl: "http://collector:4318/v1/traces",
  logsUrl: "http://collector:4318/v1/logs",
}
```

Ahora se puede escribir:

```ts
otlp: makeOtlpOptions({
  endpoint: "http://collector:4318",
});
```

Esto mantiene la frontera limpia: Brass conoce OTLP HTTP, no conoce Grafana ni
AppDynamics como implementaciones.

También hubo un detalle interesante: GitHub Advanced Security marcó una regex
en la normalización del endpoint. Aunque el riesgo práctico era bajo, lo
resolvimos reemplazando la regex por un loop simple. Es una buena muestra del
criterio de la librería: si algo puede ser más claro y más seguro sin costo, se
hace.

## Observability en HTTP

El middleware `withHttpObservability` conecta la historia HTTP con la historia
de observability.

Registra:

- métricas de requests;
- duración;
- outcome;
- status;
- spans de cliente;
- logs de request/response/error;
- headers de trace;
- policy context;
- señales del adaptive limiter cuando el cliente lo posee.

Eso permite responder preguntas de producción:

- ¿qué endpoint está fallando?
- ¿qué lane está saturado?
- ¿los retries están aumentando?
- ¿qué policy genera más latencia?
- ¿el adaptive limiter está bajando concurrencia?
- ¿qué requests viajan con prioridad alta?

La observabilidad deja de ser solo “métricas por endpoint” y empieza a reflejar
decisiones operativas del runtime.

## Frameworks: integración sin acoplamiento

Una librería de runtime no vive aislada. Los equipos usan frameworks.

Por eso sumamos documentación y ejemplos para:

- Vanilla browser/Node;
- React;
- Next.js;
- Angular;
- Express;
- Fastify;
- NestJS.

El patrón cambia por framework, pero la idea se mantiene:

- browser: no exponer tokens, usar proxy `/api/otel`;
- server: crear una instancia compartida de observability;
- HTTP client: usar `makeDefaultHttpClient` observado;
- inbound requests: crear contexto desde headers;
- shutdown: drenar HTTP y exporters.

En Nest, por ejemplo, el diseño natural es un módulo global con tokens:

```ts
export const BRASS_OBSERVABILITY = Symbol("BRASS_OBSERVABILITY");
export const BRASS_RUNTIME = Symbol("BRASS_RUNTIME");
export const BRASS_HTTP = Symbol("BRASS_HTTP");
```

En React, el diseño natural es un provider:

```tsx
<BrassProvider>
  <App />
</BrassProvider>
```

En Express/Fastify, el diseño natural es crear Brass en startup y cerrar en
`SIGTERM`.

El runtime no necesita depender de ninguno de esos frameworks. Solo tiene que
dar buenas piezas para integrarse.

## Tests, coverage y deuda técnica

Además del diseño de API, se trabajó en sostener la calidad:

- tests para transporte Promise;
- tests para normalización de errores;
- tests de policies;
- tests de observability HTTP;
- tests de `makeOtlpOptions`;
- coverage sobre paths de runtime y HTTP;
- documentación actualizada en README, docs de HTTP, observability y contexto
  para agentes.

También apareció una señal interesante: perseguir branch coverage al 95% a
nivel global no es trivial cuando el runtime tiene muchos caminos internos de
fallas, engines, schedulers y puentes. Aun así, el trabajo mejoró la cobertura
de zonas críticas como HTTP transport y errors.

La conclusión ahí es práctica: la cobertura sirve cuando protege decisiones de
comportamiento, no cuando se vuelve un número decorativo.

## Qué cambió en la forma de usar Brass

Antes, un consumidor avanzado podía terminar escribiendo demasiado plumbing:

- adaptar Axios a `Async`;
- normalizar errores;
- propagar aborts;
- mapear respuestas;
- conectar retry y dedup;
- emitir métricas;
- agregar spans;
- documentar cómo integrarlo en cada framework.

Después de este trabajo, el consumidor puede moverse en un nivel más cercano a
la intención:

```ts
const http = makeDefaultHttpClient({
  preset: "production",
  transport: axiosTransport,
  middleware: [withHttpObservability(observability)],
  policyPresets,
});
```

Y luego:

```ts
await http.getJson("/users/42", {
  policy: "readModel",
}).unsafeRunPromise();
```

Menos ceremonia. Más semántica.

## Cierre

Lo interesante de este recorrido es que Brass no creció agregando magia.
Creció aclarando fronteras.

El core sigue siendo un runtime de efectos.

HTTP es una capa de ejecución observable y configurable.

El transporte es intercambiable.

La observabilidad usa contratos estándar.

Los proveedores viven afuera.

Los frameworks se integran por recetas, no por dependencias obligatorias.

Ese equilibrio es lo que hace que una librería chica pueda escalar en uso sin
volverse pesada. Brass no intenta ser todo. Intenta ser una base sólida para que
cada proyecto exprese sus decisiones de ejecución, resiliencia y observabilidad
sin reescribir el mismo plumbing una y otra vez.

