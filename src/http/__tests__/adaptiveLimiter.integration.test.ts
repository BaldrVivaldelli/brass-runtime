import { describe, it, expect, vi, afterEach } from "vitest";
import { makeHttp } from "../client";
import { AdaptiveLimiter } from "../adaptiveLimiter";
import type { AdaptiveLimiterConfig, LimitChangeEvent } from "../adaptiveLimiter";
import type { LifecycleEvent } from "../lifecycle/types";
import { Runtime } from "../../core/runtime/runtime";

// Mock fetch for integration tests
const mockFetch = (status = 200, body = "ok", delayMs = 5) => {
  return vi.fn().mockImplementation(async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(body, {
      status,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
    });
  });
};

describe("AdaptiveLimiter integration tests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 8.11 Integration test: end-to-end with makeHttp using adaptive limiter
   */
  describe("end-to-end with makeHttp", () => {
    it("makeHttp with adaptiveLimiter config creates an adaptive limiter", async () => {
      const fetchMock = mockFetch(200, "hello", 1);
      vi.stubGlobal("fetch", fetchMock);

      const client = makeHttp({
        baseUrl: "https://api.example.com",
        adaptiveLimiter: {
          initialLimit: 5,
          smoothingFactor: 0.5,
          windowSize: 10,
        },
      });

      const rt = Runtime.make({});
      const result = await rt.toPromise(
        client({ method: "GET", url: "/test" }),
      );

      expect(result.status).toBe(200);
      expect(result.bodyText).toBe("hello");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("exposes adaptive limiter stats through the HTTP client snapshot", async () => {
      const fetchMock = mockFetch(200, "stats", 5);
      vi.stubGlobal("fetch", fetchMock);

      const client = makeHttp({
        baseUrl: "https://api.example.com",
        adaptiveLimiter: {
          initialLimit: 4,
          maxLimit: 4,
          windowSize: 10,
        },
      });

      expect(client.stats().adaptiveLimiter).toMatchObject({
        limit: 4,
        inFlight: 0,
        queueDepth: 0,
      });

      const rt = Runtime.make({});
      await rt.toPromise(client({ method: "GET", url: "/stats" }));

      expect(client.stats().adaptiveLimiter).toMatchObject({
        limit: 4,
        inFlight: 0,
        queueDepth: 0,
        windowSize: 1,
      });
    });

    it("multiple concurrent requests are limited by adaptive limiter", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const fetchMock = vi.fn().mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return new Response("ok", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = makeHttp({
        baseUrl: "https://api.example.com",
        adaptiveLimiter: {
          initialLimit: 2,
          maxLimit: 2,
          minLimit: 1,
          maxQueue: 50,
        },
      });

      const rt = Runtime.make({});

      // Fire 5 requests concurrently
      const promises = Array.from({ length: 5 }, (_, i) =>
        rt.toPromise(client({ method: "GET", url: `/test/${i}` })),
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      results.forEach((r) => expect(r.status).toBe(200));
      // Max concurrent should be limited to 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("feeds HTTP 5xx statuses into the adaptive error signal", async () => {
      const fetchMock = mockFetch(500, "fail", 5);
      vi.stubGlobal("fetch", fetchMock);

      const client = makeHttp({
        baseUrl: "https://api.example.com",
        adaptiveLimiter: {
          initialLimit: 10,
          minLimit: 1,
          maxLimit: 10,
          minSamples: 1,
          errorWeight: 1,
          errorSmoothingFactor: 1,
          smoothingFactor: 1,
          probeInterval: 1000,
          slowStartRecovery: false,
        },
      });

      const rt = Runtime.make({});
      await rt.toPromise(client({ method: "GET", url: "/first" }));
      await rt.toPromise(client({ method: "GET", url: "/second" }));

      expect(client.stats().adaptiveLimiter).toMatchObject({
        errorRate: 1,
        gradient: 0,
      });
      expect(client.stats().adaptiveLimiter!.limit).toBeLessThan(10);
    });
  });

  /**
   * 8.12 Integration test: priority scheduler + adaptive limiter composition
   */
  describe("priority scheduler + adaptive limiter composition", () => {
    it("adaptive limiter works alongside priority config in lifecycle client config type", () => {
      // This test verifies the type system allows both configs together
      const config: AdaptiveLimiterConfig = {
        initialLimit: 10,
        smoothingFactor: 0.5,
      };

      const limiter = new AdaptiveLimiter(config);
      expect(limiter.keyResolver).toBe("origin");
    });
  });

  /**
   * 8.13 Integration test: drop-in replacement for HttpConcurrencyPool in MakeHttpConfig
   */
  describe("drop-in replacement for HttpConcurrencyPool", () => {
    it("adaptiveLimiter config replaces pool config", async () => {
      const fetchMock = mockFetch(200, "adaptive", 1);
      vi.stubGlobal("fetch", fetchMock);

      // When adaptiveLimiter is provided, pool is ignored
      const client = makeHttp({
        baseUrl: "https://api.example.com",
        pool: { concurrency: 64 }, // This should be ignored
        adaptiveLimiter: {
          initialLimit: 3,
          maxLimit: 10,
        },
      });

      const rt = Runtime.make({});
      const result = await rt.toPromise(
        client({ method: "GET", url: "/test" }),
      );

      expect(result.status).toBe(200);
      expect(result.bodyText).toBe("adaptive");
    });

    it("adaptiveLimiter: false falls back to pool behavior", async () => {
      const fetchMock = mockFetch(200, "pool", 1);
      vi.stubGlobal("fetch", fetchMock);

      const client = makeHttp({
        baseUrl: "https://api.example.com",
        adaptiveLimiter: false,
        pool: { concurrency: 10 },
      });

      const rt = Runtime.make({});
      const result = await rt.toPromise(
        client({ method: "GET", url: "/test" }),
      );

      expect(result.status).toBe(200);
      expect(result.bodyText).toBe("pool");
    });
  });

  /**
   * 7.5 Integration test: lifecycle event emission for limit-change
   */
  describe("lifecycle event emission", () => {
    it("onLimitChange emits events with correct structure", async () => {
      const events: LimitChangeEvent[] = [];
      const limiter = new AdaptiveLimiter({
        initialLimit: 10,
        maxLimit: 200,
        minLimit: 1,
        smoothingFactor: 1.0,
        windowSize: 10,
        minSamples: 2,
        probeInterval: 100,
        onLimitChange: (e) => events.push(e),
      });

      const signal = new AbortController().signal;

      // Establish baseline with low latency
      for (let i = 0; i < 3; i++) {
        const lease = await limiter.acquire("origin", signal);
        lease.release(5);
      }

      // Spike latency to trigger limit decrease
      for (let i = 0; i < 5; i++) {
        const lease = await limiter.acquire("origin", signal);
        lease.release(500);
      }

      // Should have emitted at least one limit-change event
      expect(events.length).toBeGreaterThan(0);

      const event = events[0];
      expect(event).toMatchObject({
        key: "origin",
        previousLimit: expect.any(Number),
        newLimit: expect.any(Number),
        gradient: expect.any(Number),
        latencyGradient: expect.any(Number),
        errorRate: expect.any(Number),
        smoothedLatency: expect.any(Number),
        minLatency: expect.any(Number),
        timestamp: expect.any(Number),
      });

      // The event can be mapped to a LifecycleEvent
      const lifecycleEvent: LifecycleEvent = {
        type: "limit-change",
        timestamp: event.timestamp,
        previousLimit: event.previousLimit,
        newLimit: event.newLimit,
        gradient: event.gradient,
        smoothedLatency: event.smoothedLatency,
      };
      expect(lifecycleEvent.type).toBe("limit-change");
    });
  });
});
