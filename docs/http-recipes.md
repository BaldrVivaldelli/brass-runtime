# HTTP Recipes

Practical recipes for the `brass-runtime/http` stack.

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
    }),
  ],
});

await http.getJson("/users/1", { schema: User }).unsafeRunPromise();

console.log(obs.metrics.snapshot());
console.log(http.wire.adaptiveLimiter?.dump());
await toPromise(http.shutdown(), {});
await obs.shutdown();
```

`withHttpObservability` records adaptive limiter gauges when the wrapped client
owns a limiter. Keep `includeKeyLabel` disabled unless your limiter keys are
low-cardinality and stable.

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
    preset: "default",
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
