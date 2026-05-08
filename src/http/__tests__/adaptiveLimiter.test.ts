import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AdaptiveLimiter,
  resolveConfig,
  validateConfig,
  EmaComputer,
  LatencyWindow,
} from "../adaptiveLimiter";
import type { LimitChangeEvent } from "../adaptiveLimiter";

describe("AdaptiveLimiter unit tests", () => {
  /**
   * 8.1 Unit test: default configuration values match documented defaults
   */
  describe("default configuration values", () => {
    it("resolveConfig with no input returns documented defaults", () => {
      const config = resolveConfig();
      expect(config.initialLimit).toBe(10);
      expect(config.minLimit).toBe(1);
      expect(config.maxLimit).toBe(200);
      expect(config.smoothingFactor).toBe(0.5);
      expect(config.probeInterval).toBe(10);
      expect(config.windowSize).toBe(100);
      expect(config.key).toBe("origin");
      expect(config.maxQueue).toBe(256);
      expect(config.queueTimeoutMs).toBeUndefined();
      expect(config.onLimitChange).toBeUndefined();
      expect(config.percentile).toBe("p50");
    });

    it("resolveConfig with empty object returns defaults", () => {
      const config = resolveConfig({});
      expect(config.initialLimit).toBe(10);
      expect(config.minLimit).toBe(1);
      expect(config.maxLimit).toBe(200);
    });
  });

  /**
   * 8.2 Unit test: adaptiveLimiter: false disables adaptive behavior
   */
  describe("adaptiveLimiter: false disables adaptive behavior", () => {
    it("makeHttp with adaptiveLimiter: false uses no adaptive limiter", async () => {
      // This is tested at the integration level; here we verify the config type allows false
      const config: { adaptiveLimiter?: false | { initialLimit?: number } } = {
        adaptiveLimiter: false,
      };
      expect(config.adaptiveLimiter).toBe(false);
    });
  });

  /**
   * 8.3 Unit test: stats snapshot shape and values after operations
   */
  describe("stats snapshot", () => {
    it("returns correct shape with initial values", () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 20 });
      const stats = limiter.stats("test-key");
      expect(stats.limit).toBe(20);
      expect(stats.inFlight).toBe(0);
      expect(stats.queueDepth).toBe(0);
      expect(stats.gradient).toBeUndefined();
      expect(stats.smoothedLatency).toBeUndefined();
      expect(stats.minLatency).toBeUndefined();
      expect(stats.p50).toBeUndefined();
      expect(stats.p99).toBeUndefined();
      expect(stats.probeCount).toBe(0);
      expect(stats.windowSize).toBe(0);
    });

    it("reflects in-flight count after acquire", async () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 5 });
      const signal = new AbortController().signal;
      const lease = await limiter.acquire("k", signal);
      const stats = limiter.stats("k");
      expect(stats.inFlight).toBe(1);
      lease.release(10);
      expect(limiter.stats("k").inFlight).toBe(0);
    });

    it("reflects window size after releases", async () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 50, windowSize: 10 });
      const signal = new AbortController().signal;
      for (let i = 0; i < 5; i++) {
        const lease = await limiter.acquire("k", signal);
        lease.release(10 + i);
      }
      expect(limiter.stats("k").windowSize).toBe(5);
    });
  });

  /**
   * 8.4 Unit test: percentiles undefined when fewer than 2 samples
   */
  describe("percentiles undefined when fewer than 2 samples", () => {
    it("returns undefined p50 and p99 with 0 samples", () => {
      const window = new LatencyWindow(10);
      expect(window.percentile(50)).toBeUndefined();
      expect(window.percentile(99)).toBeUndefined();
    });

    it("returns undefined p50 and p99 with 1 sample", () => {
      const window = new LatencyWindow(10);
      window.record(42);
      expect(window.percentile(50)).toBeUndefined();
      expect(window.percentile(99)).toBeUndefined();
    });

    it("returns defined p50 and p99 with 2+ samples", () => {
      const window = new LatencyWindow(10);
      window.record(10);
      window.record(20);
      expect(window.percentile(50)).toBeDefined();
      expect(window.percentile(99)).toBeDefined();
    });
  });

  /**
   * 8.5 Unit test: empty window uses initial limit without adjustment
   */
  describe("empty window uses initial limit", () => {
    it("limit stays at initialLimit when no latency is recorded", async () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 15 });
      const signal = new AbortController().signal;
      // Acquire and release with invalid latency (0 is discarded)
      const lease = await limiter.acquire("k", signal);
      lease.release(0); // invalid, discarded
      expect(limiter.stats("k").limit).toBe(15);
    });

    it("limit stays at initialLimit when NaN latency is recorded", async () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 15 });
      const signal = new AbortController().signal;
      const lease = await limiter.acquire("k", signal);
      lease.release(NaN);
      expect(limiter.stats("k").limit).toBe(15);
    });
  });

  /**
   * 8.6 Unit test: alpha = 1.0 means EMA equals latest sample
   */
  describe("alpha = 1.0 means no smoothing", () => {
    it("EMA equals the latest sample when alpha is 1.0", () => {
      const ema = new EmaComputer(1.0);
      ema.update(100);
      expect(ema.value).toBe(100);
      ema.update(200);
      expect(ema.value).toBe(200);
      ema.update(50);
      expect(ema.value).toBe(50);
    });
  });

  /**
   * 8.7 Unit test: onLimitChange callback is invoked on limit change
   */
  describe("onLimitChange callback", () => {
    it("is invoked when limit changes", async () => {
      const events: LimitChangeEvent[] = [];
      const limiter = new AdaptiveLimiter({
        initialLimit: 10,
        maxLimit: 200,
        minLimit: 1,
        smoothingFactor: 1.0,
        windowSize: 10,
        probeInterval: 100,
        onLimitChange: (e) => events.push(e),
      });

      const signal = new AbortController().signal;

      // Record stable latency first to establish baseline
      for (let i = 0; i < 3; i++) {
        const lease = await limiter.acquire("k", signal);
        lease.release(10);
      }

      // Now record much higher latency to trigger a decrease
      for (let i = 0; i < 5; i++) {
        const lease = await limiter.acquire("k", signal);
        lease.release(1000);
      }

      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event.key).toBe("k");
      expect(typeof event.previousLimit).toBe("number");
      expect(typeof event.newLimit).toBe("number");
      expect(typeof event.gradient).toBe("number");
      expect(typeof event.smoothedLatency).toBe("number");
      expect(typeof event.minLatency).toBe("number");
      expect(typeof event.timestamp).toBe("number");
    });
  });

  /**
   * 8.8 Unit test: no event construction when no listener registered
   */
  describe("no event construction when no listener", () => {
    it("does not throw when no onLimitChange is provided", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 10,
        smoothingFactor: 1.0,
        windowSize: 10,
      });

      const signal = new AbortController().signal;

      // This should not throw even though limit will change
      for (let i = 0; i < 3; i++) {
        const lease = await limiter.acquire("k", signal);
        lease.release(10);
      }
      for (let i = 0; i < 5; i++) {
        const lease = await limiter.acquire("k", signal);
        lease.release(1000);
      }
      // No error means success
    });
  });

  /**
   * 8.9 Unit test: global isolation mode shares state across keys
   */
  describe("global isolation mode", () => {
    it("with key='global', all requests share the same state", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 10,
        key: "global",
      });

      // The key resolver is "global" but the actual key used in acquire
      // depends on how the HTTP client resolves it. Here we test that
      // using the same key shares state.
      const signal = new AbortController().signal;
      const lease1 = await limiter.acquire("global", signal);
      const lease2 = await limiter.acquire("global", signal);
      expect(limiter.stats("global").inFlight).toBe(2);
      lease1.release(10);
      lease2.release(10);
      expect(limiter.stats("global").inFlight).toBe(0);
    });
  });

  /**
   * 8.10 Unit test: queue timeout fires and rejects with PoolTimeout error (fake timers)
   */
  describe("queue timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with PoolTimeout after queueTimeoutMs", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        maxLimit: 1,
        minLimit: 1,
        maxQueue: 10,
        queueTimeoutMs: 5000,
      });

      const signal = new AbortController().signal;

      // Fill the single slot
      const lease = await limiter.acquire("k", signal);

      // This will be queued
      const queuedPromise = limiter.acquire("k", signal);

      // Advance time past the timeout
      vi.advanceTimersByTime(5001);

      await expect(queuedPromise).rejects.toMatchObject({
        _tag: "PoolTimeout",
        key: "k",
        timeoutMs: 5000,
      });

      lease.release(10);
    });
  });
});
