import { describe, expect, it } from "vitest";

import { EventBus } from "../../core/runtime/eventBus";
import { makeMetrics } from "../../core/runtime/metrics";
import { Runtime } from "../../core/runtime/runtime";
import { InMemoryTracer } from "../../core/runtime/tracingSink";
import type { CircuitBreakerStats } from "../../core/runtime/circuitBreaker";
import { asyncFlatMap, asyncSucceed, asyncSync } from "../../core/types/asyncEffect";
import type { AdaptiveLimiterStats } from "../../http/adaptiveLimiter";
import {
  currentBaggage,
  currentSpanLink,
  formatPrometheusMetrics,
  healthToHttpResponse,
  makeRuntimeHealth,
  makeRuntimeMetricsSink,
  metricsSnapshotToOtlp,
  readiness,
  spanLink,
  spansToOtlp,
  withBaggage,
  withSpan,
} from "../index";

const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("observability primitives", () => {
  it("merges baggage into the current trace context and restores it after the scope", async () => {
    const rt = new Runtime({
      env: {
        brass: {
          tracer: {
            newTraceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            newSpanId: () => "bbbbbbbbbbbbbbbb",
          },
          baggage: { tenant: "acme" },
        },
      },
    });
    let inside: ReturnType<typeof currentBaggage>;
    let after: ReturnType<typeof currentBaggage>;

    await rt.toPromise(
      withSpan(
        "request",
        asyncFlatMap(
          withBaggage(
            { "request.id": "req-1" },
            asyncSync(() => {
              inside = currentBaggage();
            }),
          ),
          () => asyncSync(() => {
            after = currentBaggage();
          }),
        ),
      ),
    );

    expect(inside!).toEqual({ tenant: "acme", "request.id": "req-1" });
    expect(after!).toEqual({ tenant: "acme" });
  });

  it("records span links and exports them to OTLP without changing parentage", async () => {
    const bus = new EventBus();
    const tracer = new InMemoryTracer();
    let nextSpan = 0;
    const rt = new Runtime({
      env: {
        brass: {
          tracer: {
            newTraceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            newSpanId: () => (++nextSpan).toString(16).padStart(16, "0"),
          },
        },
      },
      hooks: bus,
    });
    bus.subscribeHooks(tracer);

    let produced = spanLink({
      traceId: "cccccccccccccccccccccccccccccccc",
      spanId: "dddddddddddddddd",
      traceState: "vendor=value",
    }, { source: "queue" });

    await rt.toPromise(
      withSpan(
        "producer",
        asyncSync(() => {
          produced = currentSpanLink({ source: "producer" }) ?? produced;
        }),
      ),
    );
    await rt.toPromise(
      withSpan(
        "consumer",
        asyncSucceed("ok"),
        { links: [produced], attributes: { "span.kind": "consumer" } },
      ),
    );
    await flushEvents();

    const spans = tracer.exportFinished();
    const producer = spans.find((item) => item.name === "producer");
    const consumer = spans.find((item) => item.name === "consumer");

    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();
    expect(consumer!.parentSpanId).not.toBe(producer!.spanId);
    expect(consumer!.links).toEqual([
      expect.objectContaining({
        traceId: producer!.traceId,
        spanId: producer!.spanId,
        attributes: { source: "producer" },
      }),
    ]);

    const otlp = spansToOtlp([consumer!]);
    expect(otlp.resourceSpans[0].scopeSpans[0].spans[0].links).toEqual([
      expect.objectContaining({
        traceId: producer!.traceId,
        spanId: producer!.spanId,
        attributes: expect.arrayContaining([
          { key: "source", value: { stringValue: "producer" } },
        ]),
      }),
    ]);
  });

  it("keeps finished span pruning bounded and preserves newest spans", () => {
    const tracer = new InMemoryTracer({ maxFinishedSpans: 2 });

    for (let i = 0; i < 5; i++) {
      const spanId = `span-${i}`;
      tracer.emit({ type: "span.start", name: `operation-${i}` }, { traceId: "trace", spanId });
      tracer.emit({ type: "span.end", name: `operation-${i}`, status: "success" }, { traceId: "trace", spanId });
    }

    expect(tracer.stats()).toMatchObject({
      storedSpans: 2,
      finishedSpans: 2,
      prunedFinishedSpans: 3,
    });
    expect(tracer.exportFinished().map((span) => span.name)).toEqual(["operation-3", "operation-4"]);

    expect(tracer.pruneFinished(["span-4"])).toBe(1);
    expect(tracer.stats()).toMatchObject({
      storedSpans: 1,
      finishedSpans: 1,
      prunedFinishedSpans: 4,
    });
    expect(tracer.exportFinished().map((span) => span.name)).toEqual(["operation-3"]);
  });

  it("attaches trace/span exemplars to runtime histograms for Prometheus and OTLP", () => {
    const metrics = makeMetrics();
    const bus = new EventBus();
    bus.subscribeHooks(makeRuntimeMetricsSink(metrics, {
      clock: (() => {
        let now = 100;
        return () => now += 25;
      })(),
    }));

    bus.emit(
      { type: "fiber.start", fiberId: 1, name: "root" },
      {
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "bbbbbbbbbbbbbbbb",
      },
    );
    bus.emit(
      { type: "fiber.end", fiberId: 1, status: "success" },
      {
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "bbbbbbbbbbbbbbbb",
      },
    );
    bus.flush();

    const prometheus = formatPrometheusMetrics(metrics.snapshot(), { includeExemplars: true });
    expect(prometheus).toContain('trace_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(prometheus).toContain('span_id="bbbbbbbbbbbbbbbb"');

    const otlp = metricsSnapshotToOtlp(metrics.snapshot());
    const histogram = otlp.resourceMetrics[0].scopeMetrics[0].metrics.find((item: any) =>
      item.name === "brass_runtime_fiber_duration_ms"
    ) as any;
    expect(histogram.histogram.dataPoints[0].exemplars).toEqual([
      expect.objectContaining({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "bbbbbbbbbbbbbbbb",
      }),
    ]);
  });

  it("reports health/readiness across checks, circuit breakers, and adaptive limiters", async () => {
    const rt = new Runtime({ env: {} });
    const openBreakerStats: CircuitBreakerStats = {
      state: "open",
      failures: 3,
      successes: 0,
      totalRequests: 5,
      totalFailures: 3,
      totalSuccesses: 2,
      totalRejected: 7,
      lastFailureTime: 123,
      lastSuccessTime: 100,
    };
    const degradedLimiterStats: AdaptiveLimiterStats = {
      limit: 2,
      inFlight: 2,
      queueDepth: 3,
      gradient: 0.7,
      latencyGradient: 0.8,
      errorRate: 0.1,
      smoothedLatency: 40,
      minLatency: 10,
      baselineLatency: 12,
      p5: 12,
      p50: 40,
      p99: 120,
      probeCount: 1,
      windowSize: 20,
      utilization: 1,
      requestsPerSecond: 10,
      completionsPerSecond: 8,
      rejectionRate: 0.1,
      stateCount: 1,
      keys: ["api"],
    };

    const down = await rt.toPromise(makeRuntimeHealth({
      circuitBreakers: { database: { stats: () => openBreakerStats } },
      adaptiveLimiters: { api: { stats: () => degradedLimiterStats } },
      checks: {
        cache: () => ({ status: "ok" }),
      },
      clock: () => 0,
    }));

    expect(down).toMatchObject({
      status: "down",
      ready: false,
      checkedAt: "1970-01-01T00:00:00.000Z",
      circuitBreakers: {
        database: { state: "open", status: "down" },
      },
      adaptiveLimiters: {
        api: { status: "degraded", queueDepth: 3 },
      },
      checks: {
        cache: { status: "ok" },
      },
    });
    expect(healthToHttpResponse(down).status).toBe(503);

    await expect(rt.toPromise(readiness({
      adaptiveLimiters: { api: { stats: () => degradedLimiterStats } },
    }))).resolves.toBe(true);
    await expect(rt.toPromise(readiness({
      adaptiveLimiters: { api: { stats: () => degradedLimiterStats } },
      readiness: { failOnDegraded: true },
    }))).resolves.toBe(false);
  });
});
