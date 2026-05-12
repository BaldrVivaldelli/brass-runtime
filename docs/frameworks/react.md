# React integration

React apps should create Brass once, expose it through context, and send
browser telemetry to a same-origin backend/proxy. Do not put Grafana Cloud or
collector credentials in client bundles.

## Provider

```tsx
// BrassProvider.tsx
import React, { createContext, useContext, useEffect, useMemo } from "react";
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

function makeReactBrass() {
  const observability = makeObservability({
    serviceName: "shop-react",
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

type ReactBrass = ReturnType<typeof makeReactBrass>;

const BrassContext = createContext<ReactBrass | undefined>(undefined);

export function BrassProvider({ children }: { children: React.ReactNode }) {
  const brass = useMemo(() => makeReactBrass(), []);

  useEffect(() => {
    return () => {
      void brass.shutdown();
    };
  }, [brass]);

  return <BrassContext.Provider value={brass}>{children}</BrassContext.Provider>;
}

export function useBrass() {
  const brass = useContext(BrassContext);
  if (!brass) throw new Error("BrassProvider is missing");
  return brass;
}
```

## Component Usage

```tsx
// Profile.tsx
import { useEffect, useState } from "react";
import { useBrass } from "./BrassProvider";

type User = {
  readonly id: string;
  readonly name: string;
};

export function Profile() {
  const { runtime, http } = useBrass();
  const [user, setUser] = useState<User | undefined>();

  useEffect(() => {
    let alive = true;

    void runtime
      .toPromise(http.getJson<User>("/users/me", { policy: "readModel" }))
      .then((response) => {
        if (alive) setUser(response.body);
      });

    return () => {
      alive = false;
    };
  }, [runtime, http]);

  return <span>{user?.name ?? "Loading..."}</span>;
}
```

## Collector Proxy

Point `/api/otel` to a server route that owns the collector credentials. The
Next.js recipe includes one proxy example; the same idea works in any BFF.

