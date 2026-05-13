# Angular integration

Angular apps should expose Brass through `InjectionToken`s. Browser telemetry
should go to a same-origin proxy such as `/api/otel`; collector credentials
belong on the server side.

## Providers

```ts
// brass.providers.ts
import { inject, InjectionToken, type Provider } from "@angular/core";
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

function makeAngularBrass() {
  const observability = makeObservability({
    serviceName: "shop-angular",
    resource: { "deployment.environment": "browser" },
    logs: false,
    sampling: { ratio: 0.1, respectRemoteSampled: true, forceSampleOnError: true },
    redaction: {},
    cardinality: { maxValuesPerLabel: 100 },
    otlp: makeOtlpOptions({
      endpoint: "/api/otel",
      timeoutMs: 10_000,
      retry: { attempts: 2, initialDelayMs: 100, maxDelayMs: 1_000 },
      pipeline: { maxQueueSize: 2_000, batchSize: 128, dropPolicy: "drop-oldest" },
    }),
    flushIntervalMs: 15_000,
    autoStart: true,
  });

  const runtime = new Runtime({
    env: observability.env,
    hooks: observability.hooks,
  });

  const http = makeDefaultHttpClient({
    baseUrl: "/api",
    preset: "balanced",
    timeoutMs: 5_000,
    policyPresets,
    middleware: [withHttpObservability(observability)],
  });

  return {
    observability,
    runtime,
    http,
    shutdown: async () => {
      await http.shutdown();
      await observability.shutdown();
    },
  };
}

export const BRASS = new InjectionToken<ReturnType<typeof makeAngularBrass>>("BRASS");

export function provideBrass(): Provider[] {
  return [
    {
      provide: BRASS,
      useFactory: () => makeAngularBrass(),
    },
  ];
}

export function injectBrass() {
  return inject(BRASS);
}
```

Register the provider:

```ts
// app.config.ts
import { type ApplicationConfig } from "@angular/core";
import { provideBrass } from "./brass.providers";

export const appConfig: ApplicationConfig = {
  providers: [
    ...provideBrass(),
  ],
};
```

## Service Usage

```ts
// users.service.ts
import { Injectable } from "@angular/core";
import { injectBrass } from "./brass.providers";

type User = {
  readonly id: string;
  readonly name: string;
};

@Injectable({ providedIn: "root" })
export class UsersService {
  private readonly brass = injectBrass();

  getUser(id: string): Promise<User> {
    return this.brass.runtime
      .toPromise(
        this.brass.http.getJson<User>(`/users/${id}`, {
          policy: "readModel",
          timeoutMs: 2_000,
        }),
      )
      .then((response) => response.body);
  }
}
```

## Shutdown

Browser apps often do not have a reliable shutdown hook, but you can flush on
page lifecycle events:

```ts
import { injectBrass } from "./brass.providers";

export function installBrassBrowserShutdown() {
  const brass = injectBrass();

  window.addEventListener("pagehide", () => {
    void brass.shutdown();
  });
}
```

## Layer Variant

Angular `InjectionToken`s can receive services from one Brass layer graph:

```ts
import { InjectionToken, type Provider } from "@angular/core";
import { Layer, Runtime, RuntimeService, makeConfigLayer } from "brass-runtime/core";
import { s } from "brass-runtime/schema";
import { HttpClientService } from "brass-runtime/http";
import {
  makeObservabilityLayer,
  makeObservedRuntimeLayer,
  makeObservedHttpClientLayer,
  makeOtlpOptions,
} from "brass-runtime/observability";

const Config = Layer.tag<{ serviceName: string; apiBaseUrl: string; otlpEndpoint: string }>("Config");
const AppLayer = Layer.composeAll(
  makeConfigLayer(Config, s.object({
    serviceName: s.nonEmptyString(),
    apiBaseUrl: s.string(),
    otlpEndpoint: s.string(),
  }), { serviceName: "shop-angular", apiBaseUrl: "/api", otlpEndpoint: "/api/otel" }),
  makeObservabilityLayer((ctx) => {
    const config = ctx.unsafeGet(Config);
    return { serviceName: config.serviceName, otlp: makeOtlpOptions({ endpoint: config.otlpEndpoint }) };
  }),
  makeObservedRuntimeLayer(),
  makeObservedHttpClientLayer((ctx) => ({ baseUrl: ctx.unsafeGet(Config).apiBaseUrl, preset: "balanced" })),
);

export const BRASS_LAYER = new InjectionToken<Promise<Awaited<ReturnType<typeof buildBrassLayer>>>>("BRASS_LAYER");

async function buildBrassLayer() {
  const built = await Runtime.make({}).toPromise(Layer.build(AppLayer));
  return {
    runtime: built.service.unsafeGet(RuntimeService),
    http: built.service.unsafeGet(HttpClientService),
    shutdown: () => Runtime.make({}).toPromise(built.close()),
  };
}

export function provideBrassLayer(): Provider[] {
  return [{ provide: BRASS_LAYER, useFactory: () => buildBrassLayer() }];
}
```

## Runnable Example

A minimal runnable app lives at
[examples/angular](https://github.com/BaldrVivaldelli/brass-runtime/tree/main/examples/angular).
