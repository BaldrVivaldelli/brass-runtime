#!/usr/bin/env node

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/+$/, "");
const [{ Runtime, asyncFlatMap, asyncSucceed }, observability] = await Promise.all([
  import(new URL("../dist/core/index.mjs", import.meta.url)),
  import(new URL("../dist/observability/index.mjs", import.meta.url)),
]);

const obs = observability.makeObservability({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "brass-observability-smoke",
  serviceVersion: process.env.OTEL_SERVICE_VERSION ?? "local",
  logs: { minLevel: "info" },
  redaction: {},
  otlp: {
    metricsUrl: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? `${endpoint}/v1/metrics`,
    tracesUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? `${endpoint}/v1/traces`,
    logsUrl: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? `${endpoint}/v1/logs`,
    timeoutMs: Number(process.env.BRASS_OBSERVABILITY_EXPORT_TIMEOUT_MS ?? 5000),
    retry: { attempts: 2, initialDelayMs: 100, maxDelayMs: 500 },
  },
});

const runtime = new Runtime({ env: obs.env, hooks: obs.hooks });

await runtime.toPromise(
  observability.withSpan(
    "collector.smoke",
    asyncFlatMap(
      observability.logEffect("info", "collector.smoke", {
        route: "/smoke",
        token: "should-be-redacted",
      }),
      () => asyncSucceed("ok")
    ),
    { "span.kind": "internal", component: "observability-smoke" }
  )
);

const result = await obs.shutdown();
if (result.errors.length > 0) {
  console.error("observability collector smoke failed");
  for (const error of result.errors) {
    console.error(`${error.signal}:`, error.error);
  }
  process.exit(1);
}

console.log("observability collector smoke ok");
console.log(JSON.stringify({
  metrics: result.metrics?.status,
  traces: result.traces?.status,
  logs: result.logs?.status,
}, null, 2));
