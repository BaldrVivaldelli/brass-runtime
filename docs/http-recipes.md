# HTTP Recipes

Practical recipes for the `brass-runtime/http` stack.

## Choose an operational profile

```ts
import { makeDefaultHttpClient } from "brass-runtime/http";

const editorHttp = makeDefaultHttpClient({ preset: "editor" });
const serviceHttp = makeDefaultHttpClient({ preset: "service" });
const proxyHttp = makeDefaultHttpClient({ preset: "highThroughputProxy" });

console.log(editorHttp.profile, editorHttp.effectiveConfig());
```

Use `editor` for bounded interactive work, `service` for the standard
production lifecycle stack, and `highThroughputProxy` only for a measured hot
proxy path. `effectiveConfig()` shows the resolved limits and enabled policies
without exposing request data. See [the compatibility contract](./http-middleware-contract.md)
for exact order, request mutation, key derivation, and cancellation ownership.

## Typed API Client

```ts
import { makeDefaultHttpClient, s, type InferSchema } from "brass-runtime/http";

const User = s.object({
  id: s.int(),
  email: s.email(),
  name: s.nonEmptyString(),
});

const CreateUser = s.object({
  email: s.email(),
  name: s.nonEmptyString(),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
});

export const usersApi = {
  get: (id: number) =>
    http.getJson(`/users/${id}`, { schema: User }),

  create: (body: InferSchema<typeof CreateUser>) =>
    http.postJson("/users", body, {
      bodySchema: CreateUser,
      schema: User,
    }),
};
```

`bodySchema` validates before the request is sent; `schema` validates the
response after JSON parsing.

## Axios Or Internal Transport

```ts
import { makeDefaultHttpClient, promiseHttpTransport } from "brass-runtime/http";

const transport = promiseHttpTransport()
  .requestConfig(({ request, url }) => ({
    url: url.toString(),
    method: request.method,
    headers: request.headers,
    data: request.body,
    responseType: "json",
  }))
  .send((config) => axiosInstance.request(config))
  .json();

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  transport,
});

await http.getJson("/users", {
  policy: {
    dedupKey: "users:list",
    priority: 1,
    poolKey: "users-api",
  },
}).unsafeRunPromise();
```

`requestConfig(...).send(...)` injects the runtime `AbortSignal` into object
configs automatically. `.json()` infers Axios/Fetch-shaped responses. Use
`.json((res) => res.payload, (res) => ({ status: res.code }))` when the
external client uses a different response shape.

## Node Proxy Transport

```ts
import { toPromise } from "brass-runtime";
import { makeNodeHttpProxyClient } from "brass-runtime/http";

const http = makeNodeHttpProxyClient({
  baseUrl: "https://api.example.com",
  nodeTransport: {
    maxSockets: 512,
    maxFreeSockets: 512,
  },
  pool: {
    key: "origin",
    concurrency: 512,
    maxQueue: 512,
  },
});

await http.getJson("/users/1").unsafeRunPromise();
await toPromise(http.shutdown(), {});
```

Use this in Node BFF/proxy services when benchmark evidence shows the default
`fetch` backend is the bottleneck. The factory uses
`preset: "highThroughputProxy"` and performs the final I/O through
`node:http` / `node:https` keep-alive agents while keeping Brass cancellation,
pooling, stats, policy, and observability.

## Named Policy Presets

```ts
import {
  defineHttpPolicyPresets,
  httpPolicy,
  makeDefaultHttpClient,
} from "brass-runtime/http";

const policies = defineHttpPolicyPresets({
  readModel: {
    lane: "read-model",
    poolKey: "users-api",
    priority: 2,
    retry: { maxRetries: 2, baseDelayMs: 50 },
  },
  writes: httpPolicy.lane("write-path", {
    poolKey: "users-api",
    priority: 1,
    retry: false,
  }),
});

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  policyPresets: policies,
});

await http.getJson("/users/1", {
  policy: "readModel",
}).unsafeRunPromise();

await http.postJson("/users", { name: "Ada" }, {
  policy: { preset: "writes", dedupKey: "users:create" },
}).unsafeRunPromise();
```

`policy: "readModel"` is shorthand for a named lane.
`policy: { preset: "writes", ...overrides }` starts from the preset and lets
the request override fields such as `dedupKey`, `priority`, or `retry`.

## Mock HTTP In Tests

```ts
import { describe, expect, it } from "vitest";
import { makeJsonHttpResponse, makeMockHttpClient, runHttpEffect } from "brass-runtime/http/testing";

describe("usersApi", () => {
  it("reads typed JSON", async () => {
    const http = makeMockHttpClient(() =>
      makeJsonHttpResponse({
        id: 1,
        email: "ada@example.com",
        name: "Ada",
      }),
    );

    const res = await runHttpEffect(http({
      method: "GET",
      url: "https://api.example.com/users/1",
    }));

    expect(JSON.parse(res.bodyText).name).toBe("Ada");
  });
});
```

## Retry + Adaptive Limiter + Circuit Breaker

```ts
import { makeAdaptiveLimiterConfig, makeHttp, withCircuitBreaker } from "brass-runtime/http";

const http = makeHttp({
  baseUrl: "https://api.example.com",
  adaptiveLimiter: makeAdaptiveLimiterConfig("balanced", {
    maxLimit: 256,
    warmupRequests: 25,
    rejectionBackoffMs: 100,
  }),
});

const protectedHttp = http.with(withCircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
}));

const res = await protectedHttp({ method: "GET", url: "/health" }).unsafeRunPromise();

console.log(res.status);
console.log(http.adaptiveLimiter?.dump());
```

When the breaker opens, it can notify the adaptive limiter so the affected key
falls back to `minLimit` immediately.

## Default Client With Limiter Diagnostics

```ts
import { toPromise } from "brass-runtime";
import { makeDefaultHttpClient } from "brass-runtime/http";
import { makeObservability, withHttpObservability } from "brass-runtime/observability";

const obs = makeObservability({ serviceName: "users-api" });

const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  adaptiveLimiter: { preset: "conservative", maxLimit: 80 },
  middleware: [
    withHttpObservability({
      metrics: obs.metrics,
      route: "/users/:id",
      adaptiveLimiter: { includeKeyLabel: false },
      policy: { labelKeys: ["preset", "lane", "poolKey"] },
    }),
  ],
});

await http.getJson("/users/1", {
  schema: User,
  policy: { preset: "readModel", lane: "read-model", poolKey: "users-api" },
}).unsafeRunPromise();

console.log(obs.metrics.snapshot());
console.log(http.wire.adaptiveLimiter?.dump());
await toPromise(http.shutdown(), {});
await obs.shutdown();
```

`withHttpObservability` records adaptive limiter gauges when the wrapped client
owns a limiter. Keep `includeKeyLabel` disabled unless your limiter keys are
low-cardinality and stable.
Request policy is always available in logs and span attributes. Add
`policy.labelKeys` only for stable, low-cardinality policy fields you want in
Prometheus labels.

## Transport Error Mapping

```ts
import {
  formatHttpError,
  isRetryableHttpError,
  toHttpError,
} from "brass-runtime/http";

const mapped = toHttpError(axiosError);

if (isRetryableHttpError(mapped)) {
  console.warn("transient HTTP failure", formatHttpError(mapped));
}
```

`toHttpError` understands already-tagged `HttpError`s, `AbortError`,
common timeout codes such as `ECONNABORTED`, and Axios-like
`response.status` / `response.statusText`. Promise transports use it by
default.

## Observability + Schema Errors

```ts
import {
  formatHttpError,
  isValidationError,
  makeDefaultHttpClient,
  s,
} from "brass-runtime/http";

const Payload = s.object({ ok: s.boolean() });
const http = makeDefaultHttpClient({ baseUrl: "https://api.example.com" });

try {
  await http.getJson("/payload", { schema: Payload }).unsafeRunPromise();
} catch (error) {
  if (isValidationError(error)) {
    console.error(error.phase, error.issues);
  }
  console.error(formatHttpError(error));
}
```

## Config Validation On Startup

```ts
import { toPromise } from "brass-runtime";
import { makeDefaultHttpClient } from "brass-runtime/http";
import { ConfigValidationError } from "brass-runtime/schema";

try {
  const http = makeDefaultHttpClient({
    preset: "production",
    adaptiveLimiter: {
      minLimit: 4,
      probeJitterRatio: 0.2,
    },
  });

  await toPromise(http.shutdown(), {});
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(error.configName, error.issues);
  }
  throw error;
}
```

## Production Adoption Story

```ts
import { toPromise } from "brass-runtime";
import {
  defineHttpPolicyPresets,
  formatHttpError,
  isRetryableHttpError,
  makeDefaultHttpClient,
  promiseHttpTransport,
  s,
} from "brass-runtime/http";
import { makeObservability, withHttpObservability } from "brass-runtime/observability";

const User = s.object({
  id: s.int(),
  email: s.email(),
  name: s.nonEmptyString(),
});

const transport = promiseHttpTransport()
  .requestConfig(({ request, url }) => ({
    url: url.toString(),
    method: request.method,
    headers: request.headers,
    data: request.body,
    responseType: "json",
  }))
  .send((config) => axiosInstance.request(config))
  .json();

const policies = defineHttpPolicyPresets({
  readModel: {
    lane: "read-model",
    poolKey: "users-api",
    priority: 2,
    retry: { maxRetries: 2, baseDelayMs: 50 },
  },
  writes: {
    lane: "write-path",
    poolKey: "users-api",
    priority: 1,
    retry: false,
  },
});

const obs = makeObservability({
  serviceName: "users-bff",
  logs: { minLevel: "info" },
  cardinality: { maxValuesPerLabel: 100 },
});

const http = makeDefaultHttpClient({
  preset: "production",
  baseUrl: "https://api.example.com",
  transport,
  policyPresets: policies,
  middleware: [
    withHttpObservability({
      metrics: obs.metrics,
      route: "/users/:id",
      policy: { labelKeys: ["preset", "lane", "poolKey"] },
    }),
  ],
});

try {
  const user = await http.getJson("/users/1", {
    schema: User,
    policy: { preset: "readModel", dedupKey: "users:1" },
  }).unsafeRunPromise();

  console.log(user.body.email);
} catch (error) {
  if (isRetryableHttpError(error)) {
    console.warn("transient upstream failure", formatHttpError(error));
  }
  throw error;
} finally {
  await toPromise(http.shutdown(), {});
  await obs.shutdown();
}
```

`preset: "production"` is the explicit name for the full default stack:
timeout, priority, retry, dedup, adaptive limiter, safe-method response cache,
response compression, stats, and shutdown. `preset: "default"` is the same
stack kept for compatibility. `preset: "highThroughputProxy"` is the explicit
hot BFF/proxy preset, and `preset: "proxy"` is its shorter compatibility alias.

Construction-time validation catches invalid setup before traffic starts:

```ts
makeDefaultHttpClient({
  preset: "production",
  policyPresets: {
    readModel: { priority: 99 },
  },
});
// throws ConfigValidationError at path: policyPresets.readModel.priority
```

### Operational Checklist

- Use `preset: "production"` for the full managed HTTP stack.
- Define `policyPresets` for stable business intent: read paths, writes,
  partner APIs, search, or backoffice calls.
- Set `poolKey` per downstream isolation boundary, not per URL.
- Keep `dedupKey` only for safe/idempotent reads where coalescing is correct.
- Use `retry: false` for non-idempotent writes unless the operation has an
  idempotency key.
- Keep metric labels low-cardinality: usually `preset`, `lane`, and `poolKey`.
- Leave `dedupKey` out of labels unless the key space is tiny and bounded.
- Watch `brass_http_client_requests_total`,
  `brass_http_client_duration_ms`, `brass_http_client_in_flight`, and
  `brass_http_adaptive_limiter_*`.
- Use `HTTP_OBSERVABILITY_CONTRACT` for dashboard names instead of copying
  strings by hand.
- Call `shutdown()` on the HTTP client and observability setup during process
  shutdown.
- Before release, run `npm run test:types`, focused HTTP/observability tests,
  `npm run build`, and `npm run validate:cjs`.
