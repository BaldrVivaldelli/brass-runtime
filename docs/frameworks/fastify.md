# Fastify integration

Fastify has its own request shape, so use
`makeFastifyRequestObservabilityContext` for inbound spans and a shared Brass
HTTP client for downstream calls.

## App Setup

```ts
import Fastify from "fastify";
import { asyncFlatMap } from "brass-runtime/core";
import {
  defineHttpPolicyPresets,
  makeDefaultHttpClient,
} from "brass-runtime/http";
import {
  logEffect,
  makeFastifyRequestObservabilityContext,
  makeObservability,
  makeOtlpOptions,
  withHttpObservability,
} from "brass-runtime/observability";

const policyPresets = defineHttpPolicyPresets({
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

const observability = makeObservability({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "shop-fastify",
  serviceVersion: process.env.OTEL_SERVICE_VERSION,
  resource: {
    "deployment.environment": process.env.NODE_ENV ?? "development",
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
  baseUrl: process.env.USERS_API_BASE_URL ?? "https://users-api.internal",
  preset: "production",
  timeoutMs: 5_000,
  policyPresets,
  middleware: [withHttpObservability(observability)],
});

const app = Fastify({ logger: true });
```

## Routes

```ts
app.get("/users/:id", async (request, reply) => {
  const params = request.params as { id: string };
  const ctx = makeFastifyRequestObservabilityContext(observability, request, {
    route: "/users/:id",
  });

  const response = await ctx.run(
    ctx.withRequestSpan(
      asyncFlatMap(
        logEffect("info", "users.lookup", {
          userId: params.id,
          authorization: request.headers.authorization,
        }),
        () =>
          http.getJson(`/users/${params.id}`, {
            policy: "readModel",
            timeoutMs: 2_000,
          }),
      ),
    ),
  );

  return reply.send(response.body);
});

app.get("/metrics", async (_request, reply) => {
  return reply
    .type(observability.prometheus.contentType)
    .send(observability.prometheus.export());
});
```

## Shutdown

```ts
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

process.once("SIGTERM", async () => {
  await app.close();
  await http.shutdown();
  await observability.shutdown();
});
```

Runnable repo example: `src/examples/observabilityFastify.ts`.

## Layer Variant

Fastify can use the same app graph shape as Express. Build it once during
startup, read services from the produced `LayerContext`, and close the layer in
`onClose`/shutdown:

```ts
import { Layer, Runtime, RuntimeService, makeConfigLayer } from "brass-runtime/core";
import { s } from "brass-runtime/schema";
import { HttpClientService } from "brass-runtime/http";
import {
  ObservabilityService,
  makeObservabilityLayer,
  makeObservedRuntimeLayer,
  makeObservedHttpClientLayer,
  makeOtlpOptions,
} from "brass-runtime/observability";

const Config = Layer.tag<{ serviceName: string; apiBaseUrl: string; otlpEndpoint: string }>("Config");

const AppLayer = Layer.composeAll(
  makeConfigLayer(Config, s.object({
    serviceName: s.nonEmptyString(),
    apiBaseUrl: s.url(),
    otlpEndpoint: s.url(),
  }), {
    serviceName: process.env.OTEL_SERVICE_NAME ?? "shop-fastify",
    apiBaseUrl: process.env.USERS_API_BASE_URL ?? "https://users-api.internal",
    otlpEndpoint: process.env.GRAFANA_OTLP_ENDPOINT ?? "http://grafana-alloy:4318",
  }),
  makeObservabilityLayer((ctx) => {
    const config = ctx.unsafeGet(Config);
    return { serviceName: config.serviceName, otlp: makeOtlpOptions({ endpoint: config.otlpEndpoint }) };
  }),
  makeObservedRuntimeLayer(),
  makeObservedHttpClientLayer((ctx) => ({
    baseUrl: ctx.unsafeGet(Config).apiBaseUrl,
    preset: "production",
  })),
);

const built = await Runtime.make({}).toPromise(Layer.build(AppLayer));
app.decorate("brass", {
  observability: built.service.unsafeGet(ObservabilityService),
  runtime: built.service.unsafeGet(RuntimeService),
  http: built.service.unsafeGet(HttpClientService),
});
app.addHook("onClose", () => Runtime.make({}).toPromise(built.close()));
```
