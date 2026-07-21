# HTTP profiles and middleware compatibility contract

This document is the compatibility contract for the public HTTP lifecycle
stack. Changes to the order, cancellation ownership, or key derivation below
are public behavioral changes and require focused composition tests.

## Operational profiles

`makeDefaultHttpClient` exposes three explicit profiles. Caller overrides are
applied after the profile baseline.

| Preset | Intended path | Timeout | Priority | Retry | Cache | Adaptive limit |
| --- | --- | ---: | --- | --- | --- | --- |
| `editor` | interactive extension/editor work | 15 s | 8 concurrent, 5 s queue | 1 retry, 1.5 s total | safe methods, 15 s, 256 entries | conservative, 8 initial / 64 max |
| `service` | standard long-lived service | 30 s | 64 concurrent, 30 s queue | 3 retries, 10 s total | safe methods, 60 s, 1024 entries | aggressive, 32 initial / 256 max |
| `highThroughputProxy` | measured hot proxy/BFF path | host transport owns it | disabled | disabled | disabled | disabled |

`production` and `default` remain service aliases; `proxy` remains the short
proxy alias. `balanced`, `minimal`, and `bareMetal` remain available for
compatibility or custom tuning.

Read `client.profile` and the frozen `client.effectiveConfig()` snapshot to
observe the actual timeout, priority, retry, cache, adaptive-limit and
observability knobs after overrides. The snapshot contains no URLs, headers,
bodies, keys, or credentials. Observability is explicit: it reports whether a
lifecycle event observer is installed and how many user middleware and policy
presets are active; the profile never invents a telemetry sink.

## Stable order

The lifecycle request path is:

```text
policy preset resolution
  -> last user middleware ... first user middleware
  -> compression
  -> dedup -> batch -> cache -> retry -> priority -> wire transport
```

The response path is the reverse. Disabled layers disappear without a wrapper.
Each later `.with(middleware)` call is outermost. Policy resolution runs before
user middleware so observability and policy-aware middleware see the resolved
request policy.

## Mutation and keys

- Treat `HttpRequest`, `headers`, responses, and policy objects as immutable.
  Middleware that changes them must create shallow copies. A body is opaque;
  replace it rather than mutating or consuming it.
- Cache and default dedup keys are derived inside user middleware. Therefore,
  outer middleware header/URL/method changes are reflected in both keys.
- `accept`, `authorization`, and `content-type` are cache-relevant by default.
  Use `cacheRelevantHeaders` deliberately; never add volatile trace IDs to a
  key unless isolation is intended.
- Per-request `policy.dedupKey` is execution intent, not a secret-bearing log
  label. Custom key functions must be deterministic for the request snapshot.

## Cancellation ownership

Every middleware must return an idempotent canceler that cancels only work it
owns and propagates cancellation inward when its last dependent is gone.
Dedup is reference-counted, batch isolates callers until the last member,
retry cancels pending sleep and the current attempt, priority removes queued
work, and the transport aborts the runtime `AbortSignal`. `cancelAll()` and
`shutdown()` retain the same ownership through `.with()` wrappers.

## Pairwise regression matrix

| Shared-state pair | Required invariant | Test evidence |
| --- | --- | --- |
| cache + dedup | one in-flight request and stable cached result | `lifecycleClient.test.ts`, `batch.integration.test.ts` |
| batch + dedup/cache | grouping does not corrupt caller identity or cache result | `batch.integration.test.ts` |
| retry + priority | each retry re-enters the bounded scheduler; cancellation stops sleep/queue | `lifecycleClient.test.ts` |
| user middleware + cache/dedup | final mutated request determines keys | `middleware.property.test.ts` |
| dedup/batch + cancellation | one caller cannot abort remaining dependents | `dedup.test.ts`, `batch.property.test.ts` |

External promise transports are covered by `transport.test.ts`,
`promiseTransportDirect.test.ts`, and `promiseTransportDirect.property.test.ts`:
the adapter injects the runtime signal into Axios/undici-style object configs,
normalizes Axios response errors and common abort/timeout codes, and preserves
equivalent direct/effect-path results.
