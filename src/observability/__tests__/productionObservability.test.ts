import { describe, expect, it } from "vitest";

import { Runtime } from "../../core/runtime/runtime";
import { makeMetrics } from "../../core/runtime/metrics";
import { asyncFail, asyncFlatMap, asyncSucceed } from "../../core/types/asyncEffect";
import {
  formatPrometheusMetrics,
  logEffect,
  makeExportPipeline,
  makeExpressRequestObservabilityContext,
  makeNoopObservability,
  makeObservability,
  makeObservabilityFromEnv,
  makeOtlpOptions,
  runObservedHttpServerEffect,
  spansToOtlp,
  withSpan,
  type StructuredLogRecord,
} from "../index";

const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("production observability hardening", () => {
  it("builds backend-neutral OTLP options from a collector endpoint", () => {
    const fetch = async () => ({ ok: true, status: 202 });
    const otlp = makeOtlpOptions({
      endpoint: " http://collector:4318/ ",
      headers: { Authorization: "Bearer token" },
      fetch,
      timeoutMs: 5_000,
      retry: { attempts: 2, initialDelayMs: 50 },
      pipeline: { batchSize: 128, maxQueueSize: 1_024 },
    });

    expect(otlp).toMatchObject({
      metricsUrl: "http://collector:4318/v1/metrics",
      tracesUrl: "http://collector:4318/v1/traces",
      logsUrl: "http://collector:4318/v1/logs",
      headers: { Authorization: "Bearer token" },
      timeoutMs: 5_000,
      retry: { attempts: 2, initialDelayMs: 50 },
      pipeline: { batchSize: 128, maxQueueSize: 1_024 },
    });
    expect(otlp.fetch).toBe(fetch);
  });

  it("can target only selected OTLP signals", () => {
    const otlp = makeOtlpOptions({
      endpoint: "http://collector:4318",
      signals: ["metrics", "logs"],
    });

    expect(otlp.metricsUrl).toBe("http://collector:4318/v1/metrics");
    expect(otlp.logsUrl).toBe("http://collector:4318/v1/logs");
    expect(otlp.tracesUrl).toBeUndefined();
  });

  it("rejects empty OTLP collector endpoints", () => {
    expect(() => makeOtlpOptions({ endpoint: "  " })).toThrow(
      "makeOtlpOptions endpoint must not be empty"
    );
    expect(() => makeOtlpOptions({ endpoint: "////" })).toThrow(
      "makeOtlpOptions endpoint must not be empty"
    );
  });

  it("exports through a bounded retrying pipeline with drop metrics", async () => {
    const metrics = makeMetrics();
    let attempts = 0;
    const exported: number[] = [];
    const pipeline = makeExportPipeline<number>({
      signal: "traces",
      metrics,
      maxQueueSize: 3,
      batchSize: 2,
      retry: { attempts: 2, sleep: async () => undefined },
      exportBatch: async (items) => {
        attempts++;
        if (attempts === 1) throw new Error("collector down");
        exported.push(...items);
        return { status: 202, body: JSON.stringify(items) };
      },
    });

    expect(pipeline.enqueue([1, 2, 3, 4])).toBe(3);
    const result = await pipeline.flush();

    expect(result).toMatchObject({
      exported: 3,
      dropped: 1,
      failed: 0,
      batchCount: 2,
      queueSize: 0,
      status: 202,
    });
    expect(result.attempts).toBe(3);
    expect(exported).toEqual([2, 3, 4]);

    const text = formatPrometheusMetrics(metrics.snapshot());
    expect(text).toContain('brass_export_dropped_total{signal="traces"} 1');
    expect(text).toContain('brass_export_retries_total{signal="traces"} 1');
    expect(text).toContain('brass_export_queue_size{signal="traces"} 0');
  });

  it("applies sampling decisions and can force sample failed spans", async () => {
    const sampledOut = makeObservability({ logs: false, sampling: 0 });
    const sampledOutRuntime = new Runtime({ env: sampledOut.env, hooks: sampledOut.hooks });

    await sampledOutRuntime.toPromise(withSpan("sampled-out", asyncSucceed("ok")));
    await flushEvents();

    expect(sampledOut.tracer.exportFinished().some((span) => span.name === "sampled-out")).toBe(false);

    const forceErrors = makeObservability({
      logs: false,
      sampling: { ratio: 0, forceSampleOnError: true },
    });
    const forceErrorsRuntime = new Runtime({ env: forceErrors.env, hooks: forceErrors.hooks });

    await expect(forceErrorsRuntime.toPromise(withSpan("failed", asyncFail("nope")))).rejects.toBe("nope");
    await flushEvents();

    expect(forceErrors.tracer.exportFinished().some((span) => span.name === "failed")).toBe(true);
  });

  it("redacts sensitive log fields and span attributes", async () => {
    const logs: StructuredLogRecord[] = [];
    const obs = makeObservability({
      logs: { write: (record) => logs.push(record) },
      redaction: {},
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });

    await rt.toPromise(
      withSpan(
        "redacted",
        asyncFlatMap(
          logEffect("info", "handled", {
            password: "plain-text",
            nested: { token: "abc" },
            user: "ada",
          }),
          () => asyncSucceed("ok")
        ),
        { authorization: "Bearer secret", component: "unit-test" }
      )
    );
    await flushEvents();

    expect(logs[0].fields).toMatchObject({
      password: "[REDACTED]",
      nested: { token: "[REDACTED]" },
      user: "ada",
    });
    expect(obs.tracer.exportFinished().find((span) => span.name === "redacted")?.attrs).toMatchObject({
      authorization: "[REDACTED]",
      component: "unit-test",
    });
  });

  it("prunes finished spans and exports logs through OTLP", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const obs = makeObservability({
      logs: { write: () => undefined },
      traces: { maxFinishedSpans: 2 },
      otlp: {
        logsUrl: "https://collector.example/v1/logs",
        fetch: async (url, init) => {
          requests.push({ url, body: init.body });
          return { ok: true, status: 202 };
        },
      },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });

    for (let i = 0; i < 4; i++) {
      await rt.toPromise(withSpan(`span-${i}`, logEffect("info", "log.export", { token: `secret-${i}` })));
      await flushEvents();
    }

    expect(obs.tracer.stats().finishedSpans).toBeLessThanOrEqual(2);

    const result = await obs.flush();
    expect(result.logs?.status).toBe(202);
    const logsRequest = requests.find((request) => request.url.endsWith("/v1/logs"));
    expect(logsRequest).toBeDefined();
    const payload = JSON.parse(logsRequest!.body);
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: { stringValue: "log.export" },
          attributes: expect.arrayContaining([
            { key: "token", value: { stringValue: "[REDACTED]" } },
          ]),
        }),
      ])
    );
  });

  it("uses single-flight flushes while an export is already running", async () => {
    let fetchCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const obs = makeObservability({
      logs: false,
      traces: false,
      otlp: {
        metricsUrl: "https://collector.example/v1/metrics",
        fetch: async () => {
          fetchCalls++;
          await gate;
          return { ok: true, status: 200 };
        },
      },
    });

    const first = obs.flush();
    const second = obs.flush();
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchCalls).toBe(1);
    expect(formatPrometheusMetrics(obs.metrics.snapshot())).toContain("brass_export_flush_singleflight_total 1");
  });

  it("records inbound HTTP server metrics and server span kind", async () => {
    const obs = makeObservability({ logs: false });

    const result = await runObservedHttpServerEffect(
      obs,
      {
        method: "POST",
        route: "/users/:id",
        target: "/users/123",
        headers: {
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        },
      },
      asyncSucceed({ status: 201 }),
      {
        statusCode: (value) => value.status,
        clock: (() => {
          let now = 100;
          return () => now += 11;
        })(),
      }
    );
    await flushEvents();

    expect(result.statusCode).toBe(201);
    const text = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(text).toContain('brass_http_server_requests_total{method="POST",outcome="success",route="/users/:id",status="201"} 1');
    expect(text).toContain('brass_http_server_duration_ms_count{method="POST",outcome="success",route="/users/:id",status="201"} 1');
    expect(text).toContain('brass_http_server_in_flight{method="POST",route="/users/:id"} 0');

    const span = obs.tracer.exportFinished().find((item) => item.name === "POST /users/:id");
    expect(span?.attrs).toMatchObject({
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/users/:id",
      "url.path": "/users/123",
    });
    expect(span?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "http.server.response",
        attrs: expect.objectContaining({ "http.response.status_code": 201 }),
      }),
    ]));
    expect(spansToOtlp([span!]).resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
      kind: 2,
    });
  });

  it("bounds metric label cardinality", () => {
    const obs = makeObservability({
      logs: false,
      traces: false,
      cardinality: { maxValuesPerLabel: 1 },
    });

    obs.metrics.counter("requests_total", { route: "/a" }).increment();
    obs.metrics.counter("requests_total", { route: "/b" }).increment();

    const text = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(text).toContain('requests_total{route="/a"} 1');
    expect(text).toContain('requests_total{route="__overflow__"} 1');
  });

  it("builds production config from env and adapts framework request shapes", () => {
    const obs = makeObservabilityFromEnv({
      BRASS_OBSERVABILITY_PRESET: "production",
      OTEL_SERVICE_NAME: "api",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      BRASS_TRACE_SAMPLE_RATIO: "0.5",
    });

    const ctx = makeExpressRequestObservabilityContext(obs, {
      method: "GET",
      originalUrl: "/users/123?token=secret",
      headers: {
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
      route: { path: "/users/:id" },
    });

    expect(obs.exporters.otlpMetrics).toBeDefined();
    expect(obs.exporters.otlpTraces).toBeDefined();
    expect(ctx.route).toBe("/users/:id");
    expect(ctx.attributes).toMatchObject({
      "http.method": "GET",
      "http.route": "/users/:id",
      "http.target": "/users/123?[REDACTED]",
    });
    expect(ctx.trace).toMatchObject({ traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    obs.stop();

    const noop = makeNoopObservability();
    expect(noop.exporters.otlpMetrics).toBeUndefined();
    expect(noop.exporters.otlpTraces).toBeUndefined();
  });
});
