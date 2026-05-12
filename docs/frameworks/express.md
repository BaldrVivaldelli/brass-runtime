# Express integration

Express can wire Brass directly at process startup: one observability instance,
one runtime, one HTTP client, and a shutdown handler.

## App Setup

```ts
import express from "express";
import { asyncFlatMap } from "brass-runtime/core";
import {
  defineHttpPolicyPresets,
  makeDefaultHttpClient,
} from "brass-runtime/http";
import {
  logEffect,
  makeExpressRequestObservabilityContext,
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
  serviceName: process.env.OTEL_SERVICE_NAME ?? "shop-express",
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

const app = express();
```

## Routes

```ts
app.get("/users/:id", async (req, res, next) => {
  const ctx = makeExpressRequestObservabilityContext(observability, req, {
    route: "/users/:id",
  });

  try {
    const response = await ctx.run(
      ctx.withRequestSpan(
        asyncFlatMap(
          logEffect("info", "users.lookup", {
            userId: req.params.id,
            authorization: req.headers.authorization,
          }),
          () =>
            http.getJson(`/users/${req.params.id}`, {
              policy: "readModel",
              timeoutMs: 2_000,
            }),
        ),
      ),
    );

    res.json(response.body);
  } catch (error) {
    next(error);
  }
});

app.get("/metrics", (_req, res) => {
  res
    .type(observability.prometheus.contentType)
    .send(observability.prometheus.export());
});
```

## Shutdown

```ts
const server = app.listen(process.env.PORT ?? 3000);

process.once("SIGTERM", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await http.shutdown();
  await observability.shutdown();
});
```

Runnable repo example: `src/examples/observabilityExpress.ts`.
