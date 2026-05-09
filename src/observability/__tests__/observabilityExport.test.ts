import { describe, expect, it } from "vitest";

import { EventBus } from "../../core/runtime/eventBus";
import { InMemoryTracer } from "../../core/runtime/tracingSink";
import { makeMetrics } from "../../core/runtime/metrics";
import { Runtime } from "../../core/runtime/runtime";
import { asyncFlatMap, asyncSucceed } from "../../core/types/asyncEffect";
import {
  formatPrometheusMetrics,
  logEffect,
  makeOtlpHttpMetricsExporter,
  makeOtlpHttpSpanExporter,
  makeObservability,
  makeRuntimeMetricsSink,
  makeStructuredLogSink,
  metricsSnapshotToOtlp,
  spanEvent,
  spansToOtlp,
  withLogContext,
  withSpan,
  type StructuredLogRecord,
} from "../index";

const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("observability export", () => {
  it("formats counters, gauges, and histograms as Prometheus text", () => {
    const metrics = makeMetrics();
    metrics.counter("requests_total", { method: "GET" }).increment(3);
    metrics.gauge("active_fibers").set(2);
    metrics.histogram("latency_ms", [10], { route: "/users" }).observe(3);
    metrics.histogram("latency_ms", [10], { route: "/users" }).observe(12);

    const text = formatPrometheusMetrics(metrics.snapshot(), {
      includeTimestamp: true,
      now: () => 1234,
      help: { requests_total: "Total requests" },
    });

    expect(text).toContain("# HELP requests_total Total requests");
    expect(text).toContain("# TYPE requests_total counter");
    expect(text).toContain('requests_total{method="GET"} 3 1234');
    expect(text).toContain("# TYPE active_fibers gauge");
    expect(text).toContain("active_fibers 2 1234");
    expect(text).toContain("# TYPE latency_ms histogram");
    expect(text).toContain('latency_ms_bucket{le="10",route="/users"} 1 1234');
    expect(text).toContain('latency_ms_bucket{le="+Inf",route="/users"} 2 1234');
    expect(text).toContain('latency_ms_sum{route="/users"} 15 1234');
    expect(text).toContain('latency_ms_count{route="/users"} 2 1234');
  });

  it("converts metrics snapshots to OTLP JSON and posts them", async () => {
    const metrics = makeMetrics();
    metrics.counter("jobs_total", { queue: "main" }).increment(7);

    const payload = metricsSnapshotToOtlp(metrics.snapshot(), {
      now: () => 1000,
      resource: { "service.name": "worker" },
      scopeName: "brass-test",
    });

    expect(payload.resourceMetrics[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "worker" },
    });
    expect(payload.resourceMetrics[0].scopeMetrics[0].scope).toMatchObject({ name: "brass-test" });
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics[0]).toMatchObject({
      name: "jobs_total",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [expect.objectContaining({ asDouble: 7, timeUnixNano: "1000000000" })],
      },
    });

    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const exporter = makeOtlpHttpMetricsExporter(metrics, {
      url: "https://collector.example/v1/metrics",
      fetch: async (url, init) => {
        calls.push({ url, body: init.body, headers: init.headers });
        return { ok: true, status: 202 };
      },
    });

    const result = await exporter.export();
    expect(result.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body).resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe("jobs_total");
  });

  it("records runtime events into metrics that can be scraped", () => {
    const metrics = makeMetrics();
    const bus = new EventBus();
    let now = 100;

    bus.subscribeHooks(makeRuntimeMetricsSink(metrics, { clock: () => ++now }));
    bus.emit({ type: "fiber.start", fiberId: 1, name: "root" }, { traceId: "trace", spanId: "span" });
    bus.emit({ type: "log", level: "warn", message: "careful" }, { traceId: "trace", spanId: "span" });
    bus.emit({ type: "fiber.end", fiberId: 1, status: "success" }, { traceId: "trace", spanId: "span" });
    bus.flush();

    const text = formatPrometheusMetrics(metrics.snapshot());
    expect(text).toContain("brass_runtime_events_total");
    expect(text).toContain("brass_runtime_fibers_started_total 1");
    expect(text).toContain('brass_runtime_fibers_finished_total{status="success"} 1');
    expect(text).toContain('brass_runtime_logs_total{level="warn"} 1');
    expect(text).toContain("brass_runtime_fibers_active 0");
    expect(text).toContain('brass_runtime_fiber_duration_ms_count{status="success"} 1');
  });

  it("writes structured logs with fiber context and propagated log fields", async () => {
    const records: StructuredLogRecord[] = [];
    const bus = new EventBus();
    const rt = new Runtime({
      env: {},
      hooks: bus,
    });

    bus.subscribeHooks(makeStructuredLogSink({
      minLevel: "info",
      clock: () => 0,
      write: (record) => records.push(record),
    }));

    await rt.toPromise(
      withLogContext(
        { requestId: "req-1", tenant: "acme" },
        logEffect("info", "request.accepted", { route: "/users" })
      )
    );
    await flushEvents();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ts: "1970-01-01T00:00:00.000Z",
      level: "info",
      message: "request.accepted",
      fields: { requestId: "req-1", tenant: "acme", route: "/users" },
      traceId: expect.any(String),
      spanId: expect.any(String),
    });

    expect(() => makeStructuredLogSink({
      write: () => { throw new Error("sink down"); },
    }).emit({ type: "log", level: "info", message: "safe" }, {})).not.toThrow();
  });

  it("creates nested spans across effect composition and exports them to OTLP", async () => {
    const bus = new EventBus();
    const tracer = new InMemoryTracer();
    let spanId = 0;
    const rt = new Runtime({
      env: {
        brass: {
          tracer: {
            newTraceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            newSpanId: () => (++spanId).toString(16).padStart(16, "0"),
          },
          childName: () => "root",
        },
      },
      hooks: bus,
    });

    bus.subscribeHooks(tracer);

    await rt.toPromise(
      withSpan(
        "outer",
        asyncFlatMap(spanEvent("checkpoint", { ok: true }), () =>
          withSpan("inner", asyncSucceed("done"), { component: "unit-test" })
        ),
        { operation: "test" }
      )
    );
    await flushEvents();

    const spans = tracer.exportFinished();
    const outer = spans.find((span) => span.name === "outer");
    const inner = spans.find((span) => span.name === "inner");

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(inner!.parentSpanId).toBe(outer!.spanId);
    expect(outer!.events.some((event) => event.name === "checkpoint")).toBe(true);

    const otlp = spansToOtlp([outer!, inner!], {
      resource: { "service.name": "brass-test" },
      scopeName: "brass-runtime-test",
    });

    expect(otlp.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "brass-test" },
    });
    expect(otlp.resourceSpans[0].scopeSpans[0].spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "outer", traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
        expect.objectContaining({ name: "inner", parentSpanId: outer!.spanId }),
      ])
    );

    const calls: string[] = [];
    const exporter = makeOtlpHttpSpanExporter(() => [outer!, inner!], {
      url: "https://collector.example/v1/traces",
      fetch: async (_url, init) => {
        calls.push(init.body);
        return { ok: true, status: 200 };
      },
    });
    await expect(exporter.export()).resolves.toMatchObject({ status: 200 });
    expect(JSON.parse(calls[0]).resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it("makeObservability wires runtime signals and flushes OTLP without duplicating spans", async () => {
    const logs: StructuredLogRecord[] = [];
    const requests: Array<{ url: string; body: string }> = [];
    const obs = makeObservability({
      serviceName: "api",
      serviceVersion: "1.2.3",
      logs: { write: (record) => logs.push(record) },
      otlp: {
        metricsUrl: "https://collector.example/v1/metrics",
        tracesUrl: "https://collector.example/v1/traces",
        fetch: async (url, init) => {
          requests.push({ url, body: init.body });
          return { ok: true, status: 200 };
        },
      },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });

    await rt.toPromise(
      withSpan(
        "request",
        asyncFlatMap(logEffect("info", "handled", { route: "/users" }), () => asyncSucceed("ok")),
        { route: "/users" }
      )
    );
    await flushEvents();

    const first = await obs.flush();
    expect(first.errors).toEqual([]);
    expect(first.metrics?.status).toBe(200);
    expect(first.traces?.status).toBe(200);
    expect(first.traces!.spanCount).toBeGreaterThanOrEqual(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "info",
      message: "handled",
      fields: { route: "/users" },
    });

    const metricsRequest = requests.find((request) => request.url.endsWith("/v1/metrics"));
    const tracesRequest = requests.find((request) => request.url.endsWith("/v1/traces"));
    expect(metricsRequest).toBeDefined();
    expect(tracesRequest).toBeDefined();
    expect(JSON.parse(metricsRequest!.body).resourceMetrics[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "api" },
    });
    const tracePayload = JSON.parse(tracesRequest!.body);
    expect(tracePayload.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.version",
      value: { stringValue: "1.2.3" },
    });
    expect(tracePayload.resourceSpans[0].scopeSpans[0].spans).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "request" })])
    );

    const requestCountAfterFirstFlush = requests.length;
    const second = await obs.flush();
    expect(second.traces?.spanCount).toBe(0);
    expect(requests).toHaveLength(requestCountAfterFirstFlush + 1);
    expect(requests.at(-1)!.url).toBe("https://collector.example/v1/metrics");

    await expect(obs.shutdown()).resolves.toMatchObject({ errors: [] });
  });

  it("makeObservability reports flush errors instead of throwing", async () => {
    const errors: Array<{ signal: string; error: unknown }> = [];
    const obs = makeObservability({
      logs: false,
      traces: false,
      otlp: {
        metricsUrl: "https://collector.example/v1/metrics",
        fetch: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
      },
      onFlushError: (error, signal) => errors.push({ signal, error }),
    });

    const result = await obs.flush();
    expect(result.metrics).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].signal).toBe("metrics");
    expect(errors).toHaveLength(1);
    expect(errors[0].signal).toBe("metrics");
  });
});
