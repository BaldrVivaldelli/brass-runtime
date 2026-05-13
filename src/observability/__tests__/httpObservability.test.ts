import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../../core/runtime/runtime";
import type { MetricsRegistry } from "../../core/runtime/metrics";
import { asyncFail, asyncSucceed } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../../http/client";
import type { AdaptiveLimiterStats } from "../../http/adaptiveLimiter";
import {
  formatPrometheusMetrics,
  makeObservability,
  withHttpObservability,
  type StructuredLogRecord,
} from "../index";

const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

const ok = (overrides: Partial<HttpWireResponse> = {}): HttpWireResponse => ({
  status: 200,
  statusText: "OK",
  headers: {},
  bodyText: "ok",
  ms: 12,
  ...overrides,
});

describe("HTTP observability middleware", () => {
  it("records success metrics, logs, spans, and injects traceparent", async () => {
    const logs: StructuredLogRecord[] = [];
    const obs = makeObservability({
      serviceName: "api",
      logs: { write: (record) => logs.push(record) },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    let captured: HttpRequest | undefined;

    const downstream: HttpClientFn = (req) => {
      captured = req;
      return asyncSucceed(ok({ status: 201, statusText: "Created" }));
    };

    const client = withHttpObservability({
      metrics: obs.metrics,
      logs: { requestLevel: "debug", responseLevel: "info" },
      route: "/users/:id",
      clock: (() => {
        let now = 100;
        return () => now += 7;
      })(),
    })(downstream);

    await expect(rt.toPromise(client({ method: "GET", url: "https://api.example.test/users/1?token=secret" }))).resolves.toMatchObject({
      status: 201,
    });
    await flushEvents();

    expect(captured?.headers?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(logs.map((record) => record.message)).toEqual(["http.client.request", "http.client.response"]);
    expect(logs[0].fields).toMatchObject({
      method: "GET",
      url: "https://api.example.test/users/1",
      host: "api.example.test",
      route: "/users/:id",
    });
    expect(logs[1].fields).toMatchObject({
      status: 201,
      outcome: "success",
      durationMs: 7,
    });

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_client_requests_total{host="api.example.test",method="GET",outcome="success",route="/users/:id",status="201"} 1');
    expect(metrics).toContain('brass_http_client_duration_ms_count{host="api.example.test",method="GET",outcome="success",route="/users/:id",status="201"} 1');
    expect(metrics).toContain('brass_http_client_in_flight{host="api.example.test",method="GET",route="/users/:id"} 0');

    const httpSpan = obs.tracer.exportFinished().find((span) => span.name === "HTTP GET");
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.attrs).toMatchObject({
      "http.method": "GET",
      "http.url": "https://api.example.test/users/1",
      "server.address": "api.example.test",
      "http.route": "/users/:id",
    });
    expect(httpSpan!.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "http.client.response",
          attrs: expect.objectContaining({ "http.status_code": 201, "http.outcome": "success" }),
        }),
      ])
    );
  });

  it("records tagged HTTP failures without throwing from instrumentation", async () => {
    const logs: StructuredLogRecord[] = [];
    const obs = makeObservability({
      logs: { write: (record) => logs.push(record) },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const error: HttpError = { _tag: "Timeout", timeoutMs: 50, message: "request timed out" };
    const downstream: HttpClientFn = () => asyncFail(error);
    const client = withHttpObservability(obs)(downstream);

    await expect(rt.toPromise(client({ method: "POST", url: "https://api.example.test/write" }))).rejects.toEqual(error);
    await flushEvents();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "error",
      message: "http.client.error",
      fields: {
        method: "POST",
        host: "api.example.test",
        outcome: "timeout",
        errorTag: "Timeout",
        message: "request timed out",
      },
    });

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_client_requests_total{host="api.example.test",method="POST",outcome="timeout",status="none"} 1');
    expect(metrics).toContain('brass_http_client_in_flight{host="api.example.test",method="POST"} 0');

    const httpSpan = obs.tracer.exportFinished().find((span) => span.name === "HTTP POST");
    expect(httpSpan?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "http.client.error",
          attrs: expect.objectContaining({ "error.type": "Timeout", "http.outcome": "timeout" }),
        }),
      ])
    );
  });

  it("projects request policy into logs, spans, and opt-in metric labels", async () => {
    const logs: StructuredLogRecord[] = [];
    const obs = makeObservability({
      logs: { write: (record) => logs.push(record) },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const downstream: HttpClientFn = () => asyncSucceed(ok());
    const client = withHttpObservability({
      metrics: obs.metrics,
      logs: { requestLevel: "debug", responseLevel: "info" },
      route: "/users",
      policy: { labelKeys: ["preset", "lane", "poolKey", "retry"] },
      clock: (() => {
        let now = 500;
        return () => now += 5;
      })(),
    })(downstream);

    await expect(rt.toPromise(client({
      method: "GET",
      url: "https://api.example.test/users?token=secret",
      policy: {
        preset: "readModel",
        lane: "read-model",
        poolKey: "crm-api",
        dedupKey: "users:list",
        priority: 4,
        retry: { maxRetries: 2, baseDelayMs: 20 },
      },
    }))).resolves.toMatchObject({ status: 200 });
    await flushEvents();

    expect(logs[0].fields).toMatchObject({
      method: "GET",
      policy: {
        preset: "readModel",
        lane: "read-model",
        poolKey: "crm-api",
        dedupKey: "users:list",
        priority: 4,
        retry: {
          mode: "override",
          maxRetries: 2,
          baseDelayMs: 20,
        },
      },
    });

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_client_requests_total{host="api.example.test",lane="read-model",method="GET",outcome="success",policy="readModel",pool_key="crm-api",retry="override",route="/users",status="200"} 1');
    expect(metrics).toContain('brass_http_client_in_flight{host="api.example.test",lane="read-model",method="GET",policy="readModel",pool_key="crm-api",retry="override",route="/users"} 0');

    const httpSpan = obs.tracer.exportFinished().find((span) => span.name === "HTTP GET");
    expect(httpSpan?.attrs).toMatchObject({
      "http.request.policy.preset": "readModel",
      "http.request.policy.lane": "read-model",
      "http.request.policy.pool_key": "crm-api",
      "http.request.policy.dedup_key": "users:list",
      "http.request.policy.priority": 4,
      "http.request.policy.retry": "override",
      "http.request.policy.retry.max_retries": 2,
      "http.request.policy.retry.base_delay_ms": 20,
    });
  });

  it("caches metric handles for repeated HTTP label sets", async () => {
    const counter = { increment: vi.fn(), value: vi.fn(() => 0) };
    const gauge = {
      set: vi.fn(),
      increment: vi.fn(),
      decrement: vi.fn(),
      value: vi.fn(() => 1),
    };
    const histogram = {
      observe: vi.fn(),
      buckets: vi.fn(() => ({
        boundaries: [],
        counts: [0],
        sum: 0,
        count: 0,
        min: Infinity,
        max: -Infinity,
      })),
      percentile: vi.fn(() => 0),
    };
    const metrics: MetricsRegistry = {
      counter: vi.fn(() => counter),
      gauge: vi.fn(() => gauge),
      histogram: vi.fn(() => histogram),
      snapshot: vi.fn(() => ({ counters: [], gauges: [], histograms: [] })),
      reset: vi.fn(),
    };
    const rt = Runtime.make({});
    const downstream: HttpClientFn = () => asyncSucceed(ok());
    const client = withHttpObservability({
      metrics,
      logs: false,
      spans: false,
      injectTraceHeaders: false,
      route: "/users/:id",
      clock: (() => {
        let now = 0;
        return () => now += 2;
      })(),
    })(downstream);

    await rt.toPromise(client({ method: "GET", url: "/users/1" }));
    await rt.toPromise(client({ method: "GET", url: "/users/2" }));

    expect(metrics.gauge).toHaveBeenCalledTimes(1);
    expect(metrics.counter).toHaveBeenCalledTimes(1);
    expect(metrics.histogram).toHaveBeenCalledTimes(1);
    expect(gauge.increment).toHaveBeenCalledTimes(2);
    expect(gauge.decrement).toHaveBeenCalledTimes(2);
    expect(counter.increment).toHaveBeenCalledTimes(2);
    expect(histogram.observe).toHaveBeenCalledTimes(2);

    metrics.reset();
    await rt.toPromise(client({ method: "GET", url: "/users/3" }));

    expect(metrics.gauge).toHaveBeenCalledTimes(2);
    expect(metrics.counter).toHaveBeenCalledTimes(2);
    expect(metrics.histogram).toHaveBeenCalledTimes(2);
  });

  it("can record HTTP spans without per-request span events", async () => {
    const obs = makeObservability({
      metrics: false,
      logs: false,
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const downstream: HttpClientFn = () => asyncSucceed(ok());
    const client = withHttpObservability({
      metrics: obs.metrics,
      logs: false,
      spans: { events: false },
      injectTraceHeaders: false,
      route: "/users/:id",
    })(downstream);

    await expect(rt.toPromise(client({ method: "GET", url: "https://api.example.test/users/1" }))).resolves.toMatchObject({
      status: 200,
    });
    await flushEvents();

    const httpSpan = obs.tracer.exportFinished().find((span) => span.name === "HTTP GET");
    expect(httpSpan).toBeDefined();
    expect(httpSpan?.events.some((event) => event.name === "http.client.response")).toBe(false);
  });

  it("uses HTTP error status metadata for metrics, logs, and retryability", async () => {
    const logs: StructuredLogRecord[] = [];
    const obs = makeObservability({
      logs: { write: (record) => logs.push(record) },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const error: HttpError = {
      _tag: "FetchError",
      message: "upstream unavailable",
      status: 503,
      statusText: "Service Unavailable",
    };
    const downstream: HttpClientFn = () => asyncFail(error);
    const client = withHttpObservability({
      metrics: obs.metrics,
      logs: { errorLevel: "warn" },
    })(downstream);

    await expect(rt.toPromise(client({ method: "GET", url: "https://api.example.test/down" }))).rejects.toEqual(error);
    await flushEvents();

    expect(logs[0]).toMatchObject({
      level: "warn",
      message: "http.client.error",
      fields: {
        outcome: "fetch_error",
        status: 503,
        statusText: "Service Unavailable",
        retryable: true,
        errorTag: "FetchError",
      },
    });

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_client_requests_total{host="api.example.test",method="GET",outcome="fetch_error",status="503"} 1');

    const httpSpan = obs.tracer.exportFinished().find((span) => span.name === "HTTP GET");
    expect(httpSpan?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "http.client.error",
          attrs: expect.objectContaining({
            "http.status_code": 503,
            "http.retryable": true,
            "error.type": "FetchError",
          }),
        }),
      ]),
    );
  });

  it("records adaptive limiter diagnostics when the downstream client exposes them", async () => {
    const obs = makeObservability();
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const limiterStats: AdaptiveLimiterStats = {
      limit: 7,
      inFlight: 2,
      queueDepth: 3,
      gradient: 0.8,
      latencyGradient: 0.9,
      errorRate: 0.1,
      smoothedLatency: 25,
      minLatency: 10,
      baselineLatency: 12,
      p5: 12,
      p50: 25,
      p99: 90,
      probeCount: 4,
      windowSize: 20,
      utilization: 2 / 7,
      requestsPerSecond: 120,
      completionsPerSecond: 118,
      rejectionRate: 0.02,
      stateCount: 1,
      keys: ["api"],
    };
    const downstream = Object.assign(
      (() => asyncSucceed(ok())) as HttpClientFn,
      { adaptiveLimiter: { stats: () => limiterStats } },
    );
    const client = withHttpObservability({
      metrics: obs.metrics,
      route: "/limited",
      adaptiveLimiter: { includeKeyLabel: true },
    })(downstream);

    await expect(rt.toPromise(client({ method: "GET", url: "https://api.example.test/limited" }))).resolves.toMatchObject({
      status: 200,
    });
    await flushEvents();

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_adaptive_limiter_limit{host="api.example.test",key="api.example.test",method="GET",route="/limited"} 7');
    expect(metrics).toContain('brass_http_adaptive_limiter_queue_depth{host="api.example.test",key="api.example.test",method="GET",route="/limited"} 3');
    expect(metrics).toContain('brass_http_adaptive_limiter_requests_per_second{host="api.example.test",key="api.example.test",method="GET",route="/limited"} 120');

    const httpSpan = obs.tracer.exportFinished().find((span) => span.name === "HTTP GET");
    expect(httpSpan?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "http.client.response",
          attrs: expect.objectContaining({
            "http.adaptive_limiter.limit": 7,
            "http.adaptive_limiter.queue_depth": 3,
            "http.adaptive_limiter.requests_per_second": 120,
          }),
        }),
      ]),
    );
  });

  it("prefers policy poolKey for adaptive limiter labels", async () => {
    const obs = makeObservability();
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const limiterStats: AdaptiveLimiterStats = {
      limit: 3,
      inFlight: 1,
      queueDepth: 0,
      gradient: 1,
      latencyGradient: 1,
      errorRate: 0,
      smoothedLatency: 20,
      minLatency: 10,
      baselineLatency: 10,
      p5: 10,
      p50: 20,
      p99: 60,
      probeCount: 0,
      windowSize: 10,
      utilization: 1 / 3,
      requestsPerSecond: 30,
      completionsPerSecond: 29,
      rejectionRate: 0,
      stateCount: 1,
      keys: ["fallback"],
    };
    const downstream = Object.assign(
      (() => asyncSucceed(ok())) as HttpClientFn,
      { adaptiveLimiter: { stats: () => limiterStats } },
    );
    const client = withHttpObservability({
      metrics: obs.metrics,
      adaptiveLimiter: { includeKeyLabel: true },
    })(downstream);

    await expect(rt.toPromise(client({
      method: "GET",
      url: "https://api.example.test/limited",
      policy: { poolKey: "crm-api" },
    }))).resolves.toMatchObject({ status: 200 });

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_adaptive_limiter_limit{host="api.example.test",key="crm-api",method="GET"} 3');
  });
});
