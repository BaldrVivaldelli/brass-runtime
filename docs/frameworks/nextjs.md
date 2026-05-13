# Next.js integration

Use Brass in Next.js with a server-only singleton for Route Handlers and a
same-origin OTLP proxy for browser telemetry.

## Server Singleton

```ts
// app/lib/brass.server.ts
import "server-only";
import { Runtime } from "brass-runtime/core";
import {
  defineHttpPolicyPresets,
  makeDefaultHttpClient,
} from "brass-runtime/http";
import {
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
  serviceName: process.env.OTEL_SERVICE_NAME ?? "shop-next",
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

export const brass = {
  observability,
  runtime: new Runtime({ env: observability.env, hooks: observability.hooks }),
  http: makeDefaultHttpClient({
    baseUrl: process.env.USERS_API_BASE_URL ?? "https://users-api.internal",
    preset: "production",
    timeoutMs: 5_000,
    policyPresets,
    middleware: [withHttpObservability(observability)],
  }),
};
```

## Route Handler

Use `makeFetchRequestObservabilityContext` for App Router route handlers.

```ts
// app/api/users/[id]/route.ts
import { makeFetchRequestObservabilityContext } from "brass-runtime/observability";
import { brass } from "@/app/lib/brass.server";

export async function GET(
  request: Request,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = makeFetchRequestObservabilityContext(brass.observability, request, {
    route: "/api/users/[id]",
  });

  const response = await ctx.run(
    ctx.withRequestSpan(
      brass.http.getJson(`/users/${id}`, {
        policy: "readModel",
        timeoutMs: 2_000,
      }),
    ),
  );

  return Response.json(response.body);
}
```

## Browser OTLP Proxy

Client Components should never hold collector credentials. Use a route handler
as a narrow same-origin proxy:

```ts
// app/api/otel/[...path]/route.ts
const allowedSignals = new Set(["v1/metrics", "v1/traces", "v1/logs"]);

export async function POST(
  request: Request,
  { params }: { params: { path: string[] } | Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const signalPath = path.join("/");

  if (!allowedSignals.has(signalPath)) {
    return new Response("unknown OTLP signal", { status: 404 });
  }

  const upstream = `${process.env.GRAFANA_OTLP_ENDPOINT}/${signalPath}`;
  const body = await request.text();

  const response = await fetch(upstream, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.GRAFANA_OTLP_AUTHORIZATION
        ? { Authorization: process.env.GRAFANA_OTLP_AUTHORIZATION }
        : {}),
    },
    body,
  });

  return new Response(await response.text(), { status: response.status });
}
```

For Client Components, reuse the React provider recipe and set
`otlpEndpoint: "/api/otel"`.

## Layer Variant

For Route Handlers, keep a server-only layer singleton and close it from your
process lifecycle when the platform exposes one:

```ts
// app/lib/brass.server.ts
import "server-only";
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
    serviceName: process.env.OTEL_SERVICE_NAME ?? "shop-next",
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

export const brass = {
  observability: built.service.unsafeGet(ObservabilityService),
  runtime: built.service.unsafeGet(RuntimeService),
  http: built.service.unsafeGet(HttpClientService),
  shutdown: () => Runtime.make({}).toPromise(built.close()),
};
```

## Runnable Example

A minimal runnable app lives at
[examples/nextjs](https://github.com/BaldrVivaldelli/brass-runtime/tree/main/examples/nextjs).
