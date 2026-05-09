# 🔭 Observability: Hooks, Events, and Tracing

`brass-runtime` exposes **RuntimeHooks** to emit runtime events (fibers,
scopes, supervisors, logs) and connect sinks (console, in-memory, exporters).

Public observability helpers are exported from `brass-runtime/core` and, for
root compatibility, from `brass-runtime`.

Production exporters live under `brass-runtime/observability`.

This doc covers:

- which events exist
- what `RuntimeEmitContext` is
- how to fan-out sinks without blocking the runtime
- practical patterns for tracing (`traceId`, `spanId`) and structured logging

---

## Mental model: “emit is a controlled side-effect”

In a ZIO-style runtime the computation core aims to stay pure, but we still need:

- logs
- tracing
- latency / spans / scope lifecycle visibility

So we route side-effects through a small interface:

```ts
export interface RuntimeHooks {
  emit(ev: RuntimeEvent, ctx: RuntimeEmitContext): void;
}
```

The runtime calls `hooks.emit(...)` at well-defined points: fiber start/end,
scope open/close, supervisor child start/end/restart/escalation, logs, and
spans.

---

## RuntimeEvent + RuntimeEmitContext

A good split is:

- `RuntimeEvent`: what happened (the “what”)
- `RuntimeEmitContext`: current contextual info (the “where/with what trace”)

Useful context fields:

- `fiberId`, `scopeId`
- `traceId`, `spanId`
- `parentSpanId`
- `traceState`

Most sinks want the **merged** view, so it’s convenient to define a record:

```ts
export type RuntimeEventRecord = RuntimeEvent & RuntimeEmitContext & {
  seq: number;
  wallTs: number;
  ts: number;
  contextFiberId?: number;
  contextScopeId?: number;
};
```

When an event has its own `fiberId` or `scopeId`, that event payload wins in
the merged record. `contextFiberId` and `contextScopeId` preserve the ambient
runtime context for sinks that need it.

---

## EventBus: fan-out without blocking

If you have multiple sinks (console, in-memory tracer, exporter), avoid calling each sink inline from the runtime—slow sinks can stall execution.

Recommended pattern:

1) `EventBus` implements `RuntimeHooks`
2) `emit()` enqueues events (ring buffer)
3) `flush()` drains with a budget (microtask) and calls subscribers

This decouples runtime execution from sink speed.

Runtime hook sinks can be attached directly:

```ts
import { EventBus, InMemoryTracer, RuntimeRegistry, consoleJsonLogger } from "brass-runtime/core";

const bus = new EventBus();
bus.subscribeHooks(consoleJsonLogger());
bus.subscribeHooks(new InMemoryTracer());
bus.subscribeHooks(new RuntimeRegistry());
```

---

## Observability Export

Use `brass-runtime/observability` when runtime signals need to leave the
process for dashboards, collectors, or log pipelines.

```ts
import { Runtime } from "brass-runtime/core";
import { makeDefaultHttpClient } from "brass-runtime/http";
import { logEffect, makeObservability, makeRequestObservabilityContext, withHttpObservability, withLogContext, withSpan } from "brass-runtime/observability";

const obs = makeObservability({
  serviceName: "api",
  serviceVersion: "1.2.3",
  logs: { minLevel: "info" },
  otlp: {
    metricsUrl: "http://collector:4318/v1/metrics",
    tracesUrl: "http://collector:4318/v1/traces",
    logsUrl: "http://collector:4318/v1/logs",
  },
  flushIntervalMs: 10_000,
});

const runtime = new Runtime({ env: obs.env, hooks: obs.hooks });
const http = makeDefaultHttpClient({
  baseUrl: "https://api.example.com",
  middleware: [withHttpObservability(obs)],
});

const program = withSpan(
  "request",
  withLogContext({ requestId: "req-1" }, logEffect("info", "accepted"))
);

await runtime.toPromise(program);
await runtime.toPromise(http.get("/users/1"));
await obs.flush();
await obs.shutdown();
```

For server/request adapters, derive the runtime environment from incoming W3C
trace headers and reuse the same observability hooks:

```ts
const ctx = makeRequestObservabilityContext(obs, {
  method: "GET",
  route: "/users/:id",
  headers: {
    traceparent: request.headers.get("traceparent") ?? undefined,
    tracestate: request.headers.get("tracestate") ?? undefined,
    baggage: request.headers.get("baggage") ?? undefined,
  },
});

const runtime = ctx.makeRuntime();
await runtime.toPromise(
  ctx.withRequestSpan(handleUserRequest)
);
```

For lower-level wiring, compose the same pieces directly:

```ts
import { EventBus, InMemoryTracer, Runtime, makeMetrics } from "brass-runtime/core";
import {
  logEffect,
  makeOtlpHttpMetricsExporter,
  makeOtlpHttpSpanExporter,
  makePrometheusMetricsExporter,
  makeRuntimeMetricsSink,
  makeStructuredLogSink,
  spanEvent,
  withLogContext,
  withSpan,
} from "brass-runtime/observability";

const bus = new EventBus();
const metrics = makeMetrics();
const tracer = new InMemoryTracer();

bus.subscribeHooks(makeRuntimeMetricsSink(metrics));
bus.subscribeHooks(makeStructuredLogSink({ minLevel: "info" }));
bus.subscribeHooks(tracer);

const runtime = new Runtime({ env: {}, hooks: bus });

const program = withSpan(
  "request",
  withLogContext({ requestId: "req-1" }, logEffect("info", "accepted"))
);

await runtime.toPromise(program);

// Prometheus scrape body
const prometheusText = makePrometheusMetricsExporter(metrics).export();

// OTLP JSON/HTTP push
await makeOtlpHttpMetricsExporter(metrics, {
  url: "http://collector:4318/v1/metrics",
  resource: { "service.name": "api" },
}).export();

await makeOtlpHttpSpanExporter(tracer, {
  url: "http://collector:4318/v1/traces",
  resource: { "service.name": "api" },
}).export();
```

The exporters are dependency-free:

- Prometheus uses the text exposition format.
- OTLP exporters emit JSON and accept a custom `fetch` for tests or runtime
  adapters.
- Runtime metrics are derived from `RuntimeEvent`s and keep high-cardinality
  labels disabled by default.
- Supervisor events flow through the same sinks as fibers/scopes, so restart
  rates and escalation counts are visible through runtime event counters.
- `withHttpObservability` adds client request spans, `traceparent` propagation,
  request metrics, structured HTTP logs, and adaptive limiter gauges/span
  attributes when the wrapped client owns a limiter.
- `parseTraceparent`, `extractTraceContext`, `formatTraceparent`, and
  `injectTraceContext` provide backend-neutral W3C trace-context helpers.
- `baggage` is extracted, merged into the runtime trace seed, and propagated
  on outbound HTTP when Brass owns the outgoing trace headers.
- `makeRequestObservabilityContext` and `obs.envForRequest()` seed runtime
  tracing from incoming request headers.
- `withSpan` updates the current fiber trace context, so nested spans and child
  fibers inherit the right `traceId`, `spanId`, and `parentSpanId`.
- `withSpan(name, effect, { links })`, `spanLink(trace)`, and
  `currentSpanLink()` model fan-out/fan-in without inventing false parentage.
- Runtime and HTTP duration histograms attach exemplars when a sampled trace is
  active, so a slow bucket can point back to a concrete `traceId`/`spanId`.
- `makeRuntimeHealth`, `readiness`, and `healthToHttpResponse` expose
  runtime/fiber/scope/scheduler plus registered circuit breaker and adaptive
  limiter health.
- `makeObservability` returns `hooks`, `env`, `metrics`, `tracer`, exporters,
  plus `flush()`, `start()`, `stop()`, and `shutdown()`.

### Production hardening

`makeObservability` includes production-oriented controls without adding vendor
dependencies:

```ts
const obs = makeObservability({
  serviceName: "api",
  logs: { minLevel: "info" },
  sampling: {
    ratio: 0.25,
    respectRemoteSampled: true,
    forceSampleOnError: true,
  },
  redaction: {},
  cardinality: { maxValuesPerLabel: 100 },
  otlp: {
    metricsUrl: "http://collector:4318/v1/metrics",
    tracesUrl: "http://collector:4318/v1/traces",
    timeoutMs: 10_000,
    retry: { attempts: 3, initialDelayMs: 100, maxDelayMs: 2_000 },
    pipeline: {
      maxQueueSize: 10_000,
      batchSize: 512,
      dropPolicy: "drop-oldest",
      shutdownTimeoutMs: 10_000,
    },
  },
  traces: {
    maxFinishedSpans: 10_000,
    maxSpanAgeMs: 600_000,
  },
  flushIntervalMs: 10_000,
});
```

The export pipeline is bounded and non-blocking from the runtime perspective:
it batches spans, retries failed exports with backoff, applies export timeouts,
drops according to policy when the queue is full, exposes exporter metrics, and
drains on `shutdown()` with a deadline. Flushes are single-flight, so a slow
collector does not create overlapping exports.

Finished spans are pruned after successful export and can also be bounded with
`traces.maxFinishedSpans` / `traces.maxSpanAgeMs`.

Sampling can be configured globally, by ratio, or with rules:

```ts
const obs = makeObservability({
  sampling: {
    ratio: 0.1,
    rules: [
      { route: "/health", sampled: false },
      { name: /^checkout\./, ratio: 1 },
    ],
    respectRemoteSampled: true,
    forceSampleOnError: true,
  },
});
```

Redaction is enabled by passing `redaction: {}`. Default sensitive keys include
authorization headers, cookies, passwords, secrets, tokens, and API keys. You
can override the key/header patterns and replacement text.

Metric label cardinality can be bounded with `cardinality.maxValuesPerLabel`.
New label values past the limit are mapped to `__overflow__`.

Environment-based setup is available for deployment entry points:

```ts
import { makeObservabilityFromEnv } from "brass-runtime/observability";

const obs = makeObservabilityFromEnv(process.env);
```

Recognized environment variables include `BRASS_OBSERVABILITY_PRESET`,
`BRASS_OBSERVABILITY=disabled`, `OTEL_SERVICE_NAME`,
`OTEL_SERVICE_VERSION`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`BRASS_TRACE_SAMPLE_RATIO`,
`BRASS_OBSERVABILITY_FLUSH_INTERVAL_MS`, and
`BRASS_OBSERVABILITY_EXPORT_TIMEOUT_MS`.

Inbound adapters are available for common request shapes:

```ts
import {
  makeFetchRequestObservabilityContext,
  makeNodeRequestObservabilityContext,
  makeExpressRequestObservabilityContext,
  makeFastifyRequestObservabilityContext,
} from "brass-runtime/observability";
```

For server-side request metrics around an effect:

```ts
import { runObservedHttpServerEffect } from "brass-runtime/observability";

const result = await runObservedHttpServerEffect(
  obs,
  { method: "GET", route: "/users/:id", headers: request.headers },
  program,
  { statusCode: () => 200 }
);
```

This emits `brass_http_server_requests_total`,
`brass_http_server_duration_ms`, and `brass_http_server_in_flight`, and creates
server spans with OpenTelemetry-friendly attributes such as `span.kind`,
`http.request.method`, `http.route`, and `url.path`.

Runtime health can be reported as an effect or converted to an HTTP response:

```ts
import { healthToHttpResponse, makeRuntimeHealth } from "brass-runtime/observability";
import { makeRuntimeHealthRoute, makeRuntimeReadinessRoute, makeHttpRouter } from "brass-runtime/http";

const report = await runtime.toPromise(makeRuntimeHealth({
  runtime,
  registry: runtime.registry,
  adaptiveLimiters: { api: limiter },
}));

const response = healthToHttpResponse(report);

const router = makeHttpRouter([
  makeRuntimeHealthRoute({ runtime, registry: runtime.registry }),
  makeRuntimeReadinessRoute({
    runtime,
    registry: runtime.registry,
    adaptiveLimiters: { api: limiter },
    readiness: { failOnDegraded: true },
  }),
]);
```

Runnable framework examples live in
[`docs/observability-framework-examples.md`](./observability-framework-examples.md).

Collector smoke and performance budget helpers:

```bash
npm run smoke:observability:collector
npm run benchmark:observability
npm run benchmark:observability:budget
```

---

## Should hooks be centralized or split?

✅ Centralizing is a good idea when you want:

- a single configuration point
- fan-out to multiple sinks
- backpressure / dropping policies
- global correlation (`seq`, etc.)

This doesn’t conflict with ZIO. In ZIO you “compose” logging/tracing via the environment; here `RuntimeHooks` is the equivalent boundary.

---

## Structured JSON log sink

Example sink printing JSON:

```ts
import type { RuntimeEvent, RuntimeEmitContext } from "brass-runtime/core";

export const consoleJsonSink = () => (ev: RuntimeEvent, ctx: RuntimeEmitContext) => {
  if (ev.type !== "log") return;
  const level = ev.level ?? "info";
  const out = { level, message: ev.message, fields: ev.fields ?? {}, traceId: ctx.traceId, spanId: ctx.spanId };
  if (level === "error") console.error(JSON.stringify(out));
  else console.log(JSON.stringify(out));
};
```

Recommendations:
- include `traceId/spanId` if available in context
- prefer structured data over free-form strings

---

## Tracing: propagating traceId/spanId

### Recommended fiber context model

- `traceId`: stable for a “request / operation”
- `spanId`: changes per sub-operation (e.g. fork child or scope span)

Simple policy:

- when forking, if parent has trace:
  - `traceId` = same
  - `spanId` = new
  - `parentSpanId` = parent’s span

### Where to store it

- in a per-fiber `FiberContext`
- and when emitting events, copy into `RuntimeEmitContext`

---

## InMemoryTracer (for tests)

Very useful for tests:

- store spans in memory
- verify they close
- export only finished spans

Recommendation: choose one mapping strategy:
- span per `scope.open/close`
- or span per `fiber.start/end`

---

## Practical recipes

### 1) Enabling observability in a Runtime

- create an `EventBus`
- subscribe sinks
- pass `hooks: eventBus` to the Runtime constructor

```ts
import { EventBus, Runtime, consoleJsonLogger } from "brass-runtime/core";

const bus = new EventBus();
bus.subscribeHooks(consoleJsonLogger());

const runtime = new Runtime({
  env: {},
  hooks: bus
});
```

### 2) Drop policy / budget
To avoid memory blowups:

- ring buffer per sink
- `flush()` budget
- emit a periodic “bus.dropped” warning

---

## Checklist

- [ ] `Runtime` accepts optional `hooks`
- [ ] `emit` is non-blocking (enqueue + microtask flush)
- [ ] at least one “official” log sink exists
- [ ] tracing propagates through fiber/scope context
- [ ] tests cover “spans close” and “no leaks”
