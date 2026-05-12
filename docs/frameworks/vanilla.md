# Vanilla integration

Use this when an app does not have a framework-level DI or lifecycle system.
The same shape works for plain browser TypeScript, Node HTTP handlers, CLIs,
and small services.

## Browser

Browser apps should send telemetry to a same-origin proxy. Do not ship Grafana
Cloud or collector credentials to the client.

```ts
// brass.browser.ts
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

export const brass = (() => {
  const observability = makeObservability({
    serviceName: "shop-web",
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
})();
```

Use it from ordinary browser code:

```ts
type User = {
  readonly id: string;
  readonly name: string;
};

export async function loadCurrentUser(): Promise<User> {
  const response = await brass.runtime.toPromise(
    brass.http.getJson<User>("/users/me", {
      policy: "readModel",
      timeoutMs: 2_000,
    }),
  );

  return response.body;
}

window.addEventListener("pagehide", () => {
  void brass.shutdown();
});
```

## Node

On the server, Brass can send directly to a collector because credentials stay
inside the trusted process.

```ts
// brass.node.ts
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

export const brass = (() => {
  const observability = makeObservability({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "vanilla-node",
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

  const runtime = new Runtime({
    env: observability.env,
    hooks: observability.hooks,
  });

  const http = makeDefaultHttpClient({
    baseUrl: process.env.API_BASE_URL ?? "https://api.internal",
    preset: "production",
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
})();
```

Use the Node request adapter when you receive `IncomingMessage`-like requests:

```ts
import { createServer } from "node:http";
import {
  makeNodeRequestObservabilityContext,
} from "brass-runtime/observability";
import { brass } from "./brass.node";

const server = createServer(async (req, res) => {
  const ctx = makeNodeRequestObservabilityContext(brass.observability, req, {
    route: req.url?.startsWith("/users/") ? "/users/:id" : req.url,
  });

  const response = await ctx.run(
    ctx.withRequestSpan(
      brass.http.getJson("/users/42", {
        policy: "readModel",
        timeoutMs: 2_000,
      }),
    ),
  );

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(response.body));
});

process.once("SIGTERM", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await brass.shutdown();
});

server.listen(process.env.PORT ?? 3000);
```

