# NestJS integration

This recipe shows one way to wire Brass into a Nest application with:

- one shared `Observability` instance;
- OTLP HTTP export to Grafana Cloud, Grafana Alloy, or any collector;
- one shared production HTTP client with Brass retry, cache, policy,
  adaptive limiter, and HTTP observability;
- graceful shutdown for the HTTP client and exporter queues.

Brass stays vendor-neutral. The only Grafana-specific value is the endpoint and
authorization header supplied by the application.

## Install

```bash
npm install brass-runtime
npm install @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs
npm install --save-dev @types/express
```

Example environment:

```bash
OTEL_SERVICE_NAME=orders-api
OTEL_SERVICE_VERSION=1.2.3
GRAFANA_OTLP_ENDPOINT=http://grafana-alloy:4318
GRAFANA_OTLP_AUTHORIZATION='Basic <grafana-cloud-otlp-token>'
USERS_API_BASE_URL=https://users-api.internal
```

`GRAFANA_OTLP_ENDPOINT` can point to Grafana Alloy/OpenTelemetry Collector next
to the service, or to a direct Grafana Cloud OTLP HTTP endpoint. When you need
different URLs per signal, pass `otlp: { metricsUrl, tracesUrl, logsUrl }`
directly instead of `makeOtlpOptions`.

## Brass Module

Create one global module and inject Brass through Nest providers:

```ts
// brass.module.ts
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Runtime } from "brass-runtime/core";
import {
  defineHttpPolicyPresets,
  makeDefaultHttpClient,
  type DefaultHttpClient,
} from "brass-runtime/http";
import {
  makeObservability,
  makeOtlpOptions,
  withHttpObservability,
  type Observability,
} from "brass-runtime/observability";

export const BRASS_OBSERVABILITY = Symbol("BRASS_OBSERVABILITY");
export const BRASS_RUNTIME = Symbol("BRASS_RUNTIME");
export const BRASS_HTTP = Symbol("BRASS_HTTP");

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

function grafanaOtlp() {
  const authorization = process.env.GRAFANA_OTLP_AUTHORIZATION;

  return makeOtlpOptions({
    endpoint: process.env.GRAFANA_OTLP_ENDPOINT ?? "http://grafana-alloy:4318",
    headers: authorization ? { Authorization: authorization } : undefined,
    timeoutMs: 10_000,
    retry: { attempts: 3, initialDelayMs: 100, maxDelayMs: 2_000 },
    pipeline: {
      maxQueueSize: 10_000,
      batchSize: 512,
      dropPolicy: "drop-oldest",
      shutdownTimeoutMs: 10_000,
    },
  });
}

@Injectable()
class BrassShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(BRASS_OBSERVABILITY) private readonly observability: Observability,
    @Inject(BRASS_HTTP) private readonly http: DefaultHttpClient,
  ) {}

  async onApplicationShutdown() {
    await this.http.shutdown();
    await this.observability.shutdown();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: BRASS_OBSERVABILITY,
      useFactory: () =>
        makeObservability({
          serviceName: process.env.OTEL_SERVICE_NAME ?? "orders-api",
          serviceVersion: process.env.OTEL_SERVICE_VERSION,
          resource: {
            "service.namespace": "commerce",
            "deployment.environment": process.env.NODE_ENV ?? "development",
          },
          logs: { minLevel: "info" },
          sampling: { ratio: 0.25, respectRemoteSampled: true, forceSampleOnError: true },
          redaction: {},
          cardinality: { maxValuesPerLabel: 100 },
          otlp: grafanaOtlp(),
          flushIntervalMs: 10_000,
          autoStart: true,
        }),
    },
    {
      provide: BRASS_RUNTIME,
      useFactory: (observability: Observability) =>
        new Runtime({ env: observability.env, hooks: observability.hooks }),
      inject: [BRASS_OBSERVABILITY],
    },
    {
      provide: BRASS_HTTP,
      useFactory: (observability: Observability) =>
        makeDefaultHttpClient({
          baseUrl: process.env.USERS_API_BASE_URL,
          preset: "production",
          timeoutMs: 5_000,
          policyPresets,
          middleware: [withHttpObservability(observability)],
        }),
      inject: [BRASS_OBSERVABILITY],
    },
    BrassShutdown,
  ],
  exports: [BRASS_OBSERVABILITY, BRASS_RUNTIME, BRASS_HTTP],
})
export class BrassModule {}
```

Enable shutdown hooks once in `main.ts` so Nest calls `BrassShutdown`:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? 3000);
```

## Use The HTTP Client

Inject the Brass runtime and HTTP client where you call downstream services.
`withHttpObservability` records outbound metrics, logs, spans, policy context,
and W3C trace headers.

```ts
// users.client.ts
import { Inject, Injectable } from "@nestjs/common";
import { Runtime } from "brass-runtime/core";
import type { DefaultHttpClient } from "brass-runtime/http";
import { BRASS_HTTP, BRASS_RUNTIME } from "./brass.module";

type UserDto = {
  readonly id: string;
  readonly name: string;
};

@Injectable()
export class UsersClient {
  constructor(
    @Inject(BRASS_RUNTIME) private readonly runtime: Runtime<any>,
    @Inject(BRASS_HTTP) private readonly http: DefaultHttpClient,
  ) {}

  async getUser(id: string): Promise<UserDto> {
    const response = await this.runtime.toPromise(
      this.http.getJson<UserDto>(`/users/${id}`, {
        policy: "readModel",
        headers: { "x-client": "orders-api" },
        timeoutMs: 2_000,
      }),
    );

    return response.body;
  }
}
```

For command-style calls, choose a different policy:

```ts
await this.runtime.toPromise(
  this.http.postJson("/users", body, {
    policy: "command",
    timeoutMs: 3_000,
  }),
);
```

## Inbound Request Spans

For Express-backed Nest apps, reuse the Express request adapter. The request
context seeds the Brass runtime from inbound `traceparent` / `baggage` headers,
then wraps your effect in a server span.

```ts
import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { asyncFlatMap } from "brass-runtime/core";
import {
  logEffect,
  makeExpressRequestObservabilityContext,
  type Observability,
} from "brass-runtime/observability";
import type { DefaultHttpClient } from "brass-runtime/http";
import { BRASS_HTTP, BRASS_OBSERVABILITY } from "./brass.module";

@Controller()
export class UsersController {
  constructor(
    @Inject(BRASS_OBSERVABILITY) private readonly observability: Observability,
    @Inject(BRASS_HTTP) private readonly http: DefaultHttpClient,
  ) {}

  @Get("/users/:id")
  getUser(@Req() req: Request, @Param("id") id: string) {
    const ctx = makeExpressRequestObservabilityContext(this.observability, req, {
      route: "/users/:id",
    });

    return ctx.run(
      ctx.withRequestSpan(
        asyncFlatMap(
          logEffect("info", "users.lookup", {
            userId: id,
            authorization: req.headers.authorization,
          }),
          () => this.http.getJson(`/users/${id}`, { policy: "readModel" }),
        ),
      ),
    );
  }

  @Get("/metrics")
  metrics(@Res() res: Response) {
    return res
      .type(this.observability.prometheus.contentType)
      .send(this.observability.prometheus.export());
  }
}
```

The `authorization` field is redacted by the default observability redactor.

## Runnable Repo Example

The repo also includes a dependency-optional Nest example:

```bash
npm install --save-dev @nestjs/core @nestjs/common @nestjs/platform-express reflect-metadata rxjs
npm run example:observability:nest
```

## Layer Variant

Nest providers can also be backed by one Brass layer graph. This keeps
validation, runtime hooks, HTTP observability, and shutdown in one place:

```ts
import { Runtime, Layer, RuntimeService, makeConfigLayer } from "brass-runtime/core";
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
    serviceName: process.env.OTEL_SERVICE_NAME ?? "orders-api",
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

export const brassProviders = [
  { provide: BRASS_OBSERVABILITY, useValue: built.service.unsafeGet(ObservabilityService) },
  { provide: BRASS_RUNTIME, useValue: built.service.unsafeGet(RuntimeService) },
  { provide: BRASS_HTTP, useValue: built.service.unsafeGet(HttpClientService) },
  { provide: BRASS_LAYER_CLOSE, useValue: () => Runtime.make({}).toPromise(built.close()) },
];
```

It uses a fake OTLP `fetch` by default so it can run without a collector. To
send to Grafana/Alloy instead:

```bash
BRASS_EXAMPLE_REAL_OTLP=true \
GRAFANA_OTLP_ENDPOINT=http://grafana-alloy:4318 \
GRAFANA_OTLP_AUTHORIZATION='Basic <token>' \
npm run example:observability:nest
```

## Runnable Example

A minimal runnable app lives at
[examples/nestjs](https://github.com/BaldrVivaldelli/brass-runtime/tree/main/examples/nestjs).
