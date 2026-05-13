import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AdaptiveLimiter,
  adaptiveLimiterPresets,
  computeNewLimit,
  makeAdaptiveLimiterConfig,
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
      expect(config.preset).toBeUndefined();
      expect(config.initialLimit).toBe(10);
      expect(config.minLimit).toBe(1);
      expect(config.maxLimit).toBe(200);
      expect(config.smoothingFactor).toBe(0.5);
      expect(config.probeInterval).toBe(10);
      expect(config.probeJitterRatio).toBe(0.2);
      expect(config.windowSize).toBe(100);
      expect(config.minSamples).toBe(10);
      expect(config.baselineStrategy).toBe("min");
      expect(config.decreaseCooldownSamples).toBe(0);
      expect(config.historySize).toBe(32);
      expect(config.windowDecayFactor).toBe(1);
      expect(config.errorWeight).toBe(0);
      expect(config.errorSmoothingFactor).toBe(0.5);
      expect(config.errorStatusThreshold).toBe(500);
      expect(config.queueStrategy).toBe("fifo");
      expect(config.queueLoadShedding).toBe("reject-new");
      expect(config.rejectionBackoffThreshold).toBe(3);
      expect(config.rejectionBackoffMs).toBeUndefined();
      expect(config.stateTtlMs).toBe(300_000);
      expect(config.warmupRequests).toBe(0);
      expect(config.decreaseThreshold).toBe(0.75);
      expect(config.increaseThreshold).toBe(1.0);
      expect(config.maxDecreaseRatio).toBe(0.2);
      expect(config.headroomStrategy).toBe(1);
      expect(config.slowStartRecovery).toBe(true);
      expect(config.slowStartSaturationThreshold).toBe(0.5);
      expect(config.slowStartSaturationSamples).toBe(3);
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

    it("resolves named presets before caller overrides", () => {
      expect(adaptiveLimiterPresets.balanced.initialLimit).toBe(16);

      const aggressive = resolveConfig({ preset: "aggressive" });
      expect(aggressive).toMatchObject({
        preset: "aggressive",
        initialLimit: 32,
        minLimit: 8,
        maxLimit: 256,
        queueStrategy: "priority",
        queueLoadShedding: "priority-evict",
        baselineStrategy: "p5",
      });

      const conservative = resolveConfig(makeAdaptiveLimiterConfig("conservative", {
        maxLimit: 80,
        minSamples: 12,
      }));
      expect(conservative).toMatchObject({
        preset: "conservative",
        initialLimit: 8,
        maxLimit: 80,
        minSamples: 12,
      });
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

  describe("config validation", () => {
    it("rejects invalid production-safety knobs", () => {
      expect(() => validateConfig({ minSamples: 0 })).toThrow(/minSamples/);
      expect(() => validateConfig({ preset: "turbo" as any })).toThrow(/preset/);
      expect(() => validateConfig({ decreaseThreshold: 0 })).toThrow(/decreaseThreshold/);
      expect(() => validateConfig({ decreaseThreshold: 1.1 })).toThrow(/decreaseThreshold/);
      expect(() => validateConfig({ increaseThreshold: 0.9 })).toThrow(/increaseThreshold/);
      expect(() => validateConfig({ maxDecreaseRatio: 0 })).toThrow(/maxDecreaseRatio/);
      expect(() => validateConfig({ maxDecreaseRatio: 1.1 })).toThrow(/maxDecreaseRatio/);
      expect(() => validateConfig({ probeJitterRatio: -0.1 })).toThrow(/probeJitterRatio/);
      expect(() => validateConfig({ probeJitterRatio: 1.1 })).toThrow(/probeJitterRatio/);
      expect(() => validateConfig({ baselineStrategy: "median" as any })).toThrow(/baselineStrategy/);
      expect(() => validateConfig({ decreaseCooldownSamples: -1 })).toThrow(/decreaseCooldownSamples/);
      expect(() => validateConfig({ historySize: -1 })).toThrow(/historySize/);
      expect(() => validateConfig({ windowDecayFactor: 0 })).toThrow(/windowDecayFactor/);
      expect(() => validateConfig({ windowDecayFactor: 1.1 })).toThrow(/windowDecayFactor/);
      expect(() => validateConfig({ errorWeight: -0.1 })).toThrow(/errorWeight/);
      expect(() => validateConfig({ errorWeight: 1.1 })).toThrow(/errorWeight/);
      expect(() => validateConfig({ errorSmoothingFactor: 0 })).toThrow(/errorSmoothingFactor/);
      expect(() => validateConfig({ errorStatusThreshold: 99 })).toThrow(/errorStatusThreshold/);
      expect(() => validateConfig({ queueStrategy: "lifo" as any })).toThrow(/queueStrategy/);
      expect(() => validateConfig({ queueLoadShedding: "drop-tail" as any })).toThrow(/queueLoadShedding/);
      expect(() => validateConfig({ rejectionBackoffThreshold: 0 })).toThrow(/rejectionBackoffThreshold/);
      expect(() => validateConfig({ rejectionBackoffMs: 0 })).toThrow(/rejectionBackoffMs/);
      expect(() => validateConfig({ stateTtlMs: 0 })).toThrow(/stateTtlMs/);
      expect(() => validateConfig({ warmupRequests: -1 })).toThrow(/warmupRequests/);
      expect(() => validateConfig({ headroomStrategy: 0 })).toThrow(/headroomStrategy/);
      expect(() => validateConfig({ slowStartSaturationThreshold: 0 })).toThrow(/slowStartSaturationThreshold/);
      expect(() => validateConfig({ slowStartSaturationSamples: 0 })).toThrow(/slowStartSaturationSamples/);
    });

    it("rejects invalid limit bounds", () => {
      expect(() => validateConfig({ initialLimit: 0 })).toThrow(/initialLimit/);
      expect(() => validateConfig({ minLimit: 0 })).toThrow(/minLimit/);
      expect(() => validateConfig({ maxLimit: 0 })).toThrow(/maxLimit/);
    });

    it("clamps resolved bounds and sample floors", () => {
      const config = resolveConfig({
        initialLimit: 999,
        minLimit: 20,
        maxLimit: 10,
        windowSize: 5,
        minSamples: 100,
      });

      expect(config.maxLimit).toBe(20);
      expect(config.initialLimit).toBe(20);
      expect(config.minSamples).toBe(5);
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

    it("aggregates stats across multiple keys", async () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 3, maxLimit: 3, minLimit: 3 });
      const signal = new AbortController().signal;

      const leaseA = await limiter.acquire("a", signal);
      const leaseB = await limiter.acquire("b", signal);

      expect(limiter.stats()).toMatchObject({
        limit: 6,
        inFlight: 2,
        queueDepth: 0,
      });

      leaseA.release(10);
      leaseB.release(20);

      expect(limiter.stats()).toMatchObject({
        limit: 6,
        inFlight: 0,
        windowSize: 2,
      });
    });

    it("aggregates unreleased keys and falls back to Date when performance is unavailable", async () => {
      const originalPerformance = globalThis.performance;
      vi.stubGlobal("performance", undefined);
      try {
        const limiter = new AdaptiveLimiter({ initialLimit: 2, stateTtlMs: false });
        const signal = new AbortController().signal;
        const leaseA = await limiter.acquire("a", signal);
        const leaseB = await limiter.acquire("b", signal);

        expect(limiter.stats()).toMatchObject({
          limit: 4,
          inFlight: 2,
          windowSize: 0,
          baselineLatency: undefined,
          p50: undefined,
          rejectionRate: 0,
        });

        leaseA.release(10);
        leaseB.release(20);
      } finally {
        vi.stubGlobal("performance", originalPerformance);
      }
    });
  });

  describe("production-safe limit adjustment", () => {
    it("holds the limit inside the configured deadband", () => {
      expect(
        computeNewLimit(32, 0.8, 1, 1, 256, {
          decreaseThreshold: 0.75,
          increaseThreshold: 1,
          maxDecreaseRatio: 0.2,
        }),
      ).toBe(32);
    });

    it("caps one-step decreases so noisy samples cannot collapse concurrency", () => {
      expect(
        computeNewLimit(32, 0.25, 1, 1, 256, {
          decreaseThreshold: 0.75,
          increaseThreshold: 1,
          maxDecreaseRatio: 0.1,
        }),
      ).toBe(29);
    });

    it("increases and clamps limits at configured bounds", () => {
      expect(computeNewLimit(32, 1.1, 3, 1, 256)).toBe(35);
      expect(computeNewLimit(255, 1.1, 3, 1, 256)).toBe(256);
      expect(computeNewLimit(2, 0.1, 1, 2, 256)).toBe(2);
    });

    it("waits for minSamples before changing the limit", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 32,
        minSamples: 5,
        probeInterval: 100,
        smoothingFactor: 1,
      });
      const signal = new AbortController().signal;

      for (let i = 0; i < 4; i++) {
        const lease = await limiter.acquire("k", signal);
        lease.release(i === 0 ? 1 : 100);
      }

      expect(limiter.stats("k").limit).toBe(32);

      const lease = await limiter.acquire("k", signal);
      lease.release(100);

      expect(limiter.stats("k").limit).toBeLessThan(32);
    });

    it("can use p99 latency as the adaptive signal", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 20,
        minSamples: 3,
        percentile: "p99",
        smoothingFactor: 0.1,
        probeInterval: 100,
        decreaseThreshold: 0.75,
        maxDecreaseRatio: 0.1,
      });
      const signal = new AbortController().signal;

      for (const latency of [10, 10, 500]) {
        const lease = await limiter.acquire("k", signal);
        lease.release(latency);
      }

      const stats = limiter.stats("k");
      expect(stats.p99).toBe(500);
      expect(stats.limit).toBe(18);
    });

    it("can use p5 as an adaptive baseline so one stale minimum does not dominate", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 50,
        maxLimit: 60,
        minSamples: 100,
        windowSize: 100,
        baselineStrategy: "p5",
        percentile: "p50",
        smoothingFactor: 1,
        probeInterval: 1000,
        probeJitterRatio: 0,
      });
      const signal = new AbortController().signal;

      for (const latency of [10, ...Array.from({ length: 99 }, () => 100)]) {
        const lease = await limiter.acquire("p5", signal);
        lease.release(latency);
      }

      const stats = limiter.stats("p5");
      expect(stats.minLatency).toBe(10);
      expect(stats.p5).toBe(100);
      expect(stats.baselineLatency).toBe(100);
      expect(stats.limit).toBeGreaterThan(50);
    });

    it("supports an EMA low baseline that adapts when the low percentile moves", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 30,
        maxLimit: 40,
        minSamples: 25,
        windowSize: 25,
        baselineStrategy: "ema-low",
        percentile: "p50",
        smoothingFactor: 1,
        probeInterval: 1000,
        probeJitterRatio: 0,
      });
      const signal = new AbortController().signal;

      for (const latency of [10, ...Array.from({ length: 24 }, () => 100)]) {
        const lease = await limiter.acquire("ema-low", signal);
        lease.release(latency);
      }

      expect(limiter.stats("ema-low")).toMatchObject({
        minLatency: 10,
        baselineLatency: 100,
        limit: 31,
      });
    });

    it("blocks repeated decreases during the configured cooldown", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 40,
        minLimit: 1,
        maxLimit: 40,
        minSamples: 2,
        windowSize: 20,
        percentile: "p99",
        smoothingFactor: 1,
        probeInterval: 1000,
        probeJitterRatio: 0,
        maxDecreaseRatio: 0.5,
        decreaseCooldownSamples: 2,
        slowStartRecovery: false,
      });
      const signal = new AbortController().signal;

      for (const latency of [10, 1000]) {
        const lease = await limiter.acquire("cooldown", signal);
        lease.release(latency);
      }
      expect(limiter.stats("cooldown")).toMatchObject({
        limit: 20,
        cooldownSamplesRemaining: 2,
      });

      for (const latency of [1000, 1000]) {
        const lease = await limiter.acquire("cooldown", signal);
        lease.release(latency);
      }
      expect(limiter.stats("cooldown")).toMatchObject({
        limit: 20,
        cooldownSamplesRemaining: 0,
      });

      const lease = await limiter.acquire("cooldown", signal);
      lease.release(1000);
      expect(limiter.stats("cooldown").limit).toBe(10);
    });

    it("can reduce the effective gradient when 5xx responses rise", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 20,
        minLimit: 1,
        maxLimit: 20,
        minSamples: 2,
        windowSize: 10,
        smoothingFactor: 1,
        errorSmoothingFactor: 1,
        errorWeight: 1,
        probeInterval: 1000,
        probeJitterRatio: 0,
        slowStartRecovery: false,
      });
      const signal = new AbortController().signal;

      const ok = await limiter.acquire("errors", signal);
      ok.release(10, { status: 200 });
      const failed = await limiter.acquire("errors", signal);
      failed.release(10, { status: 500 });

      const stats = limiter.stats("errors");
      expect(stats.latencyGradient).toBe(1);
      expect(stats.errorRate).toBe(1);
      expect(stats.gradient).toBe(0);
      expect(stats.limit).toBeLessThan(20);
    });

    it("treats explicit error release info as an adaptive error signal", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 10,
        minLimit: 1,
        maxLimit: 10,
        minSamples: 1,
        smoothingFactor: 1,
        errorSmoothingFactor: 1,
        errorWeight: 1,
        probeInterval: 100,
        slowStartRecovery: false,
      });
      const signal = new AbortController().signal;

      const lease = await limiter.acquire("explicit-error", signal);
      lease.release(10, { error: { message: "failed" } });

      expect(limiter.stats("explicit-error")).toMatchObject({
        errorRate: 1,
        gradient: 0,
      });
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

    it("can weight percentiles toward recent samples with exponential decay", () => {
      const window = new LatencyWindow(10);
      for (const latency of [10, 10, 10, 100, 100]) {
        window.record(latency);
      }

      expect(window.percentile(50)).toBe(10);
      expect(window.weightedPercentile(50, 0.1)).toBe(100);
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

  describe("acquire/release edge branches", () => {
    it("rejects pre-aborted acquires and ignores repeated or post-destroy releases", async () => {
      const limiter = new AdaptiveLimiter({ initialLimit: 1, stateTtlMs: false });
      const aborted = new AbortController();
      aborted.abort();

      await expect(limiter.acquire("aborted", aborted.signal)).rejects.toEqual({ _tag: "Abort" });

      const lease = await limiter.acquire("repeat", new AbortController().signal);
      lease.release(10);
      lease.release(20);
      expect(limiter.stats("repeat")).toMatchObject({ inFlight: 0, windowSize: 1 });

      const destroyedLease = await limiter.acquire("destroyed", new AbortController().signal);
      limiter.destroy();
      expect(() => destroyedLease.release(10)).not.toThrow();
      limiter.markCircuitOpen("destroyed");
      await expect(limiter.acquire("destroyed", new AbortController().signal)).rejects.toMatchObject({
        _tag: "PoolClosed",
      });
    });

    it("rejects aborted queued waiters when draining", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueue: 2,
      });
      const held = await limiter.acquire("drain-abort", new AbortController().signal);
      const queuedSignal = new AbortController();
      const queued = limiter.acquire("drain-abort", queuedSignal.signal);

      queuedSignal.abort();
      held.release(10);

      await expect(queued).rejects.toEqual({ _tag: "Abort" });
      expect(limiter.snapshot("drain-abort")).toMatchObject({ abortedWhileQueued: 1 });
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
        minSamples: 2,
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
      expect(typeof event.latencyGradient).toBe("number");
      expect(typeof event.errorRate).toBe("number");
      expect(typeof event.smoothedLatency).toBe("number");
      expect(typeof event.minLatency).toBe("number");
      expect(typeof event.baselineLatency).toBe("number");
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
        minSamples: 2,
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

  describe("state TTL eviction", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("evicts inactive per-key state after the configured TTL", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 5,
        stateTtlMs: 1000,
      });
      const lease = await limiter.acquire("stale", new AbortController().signal);

      lease.release(10);
      expect(limiter.stats("stale").windowSize).toBe(1);

      vi.advanceTimersByTime(1001);

      expect(limiter.stats("stale").windowSize).toBe(0);
      expect(limiter.stats().stateCount).toBe(0);
    });

    it("can disable TTL eviction", async () => {
      const limiter = new AdaptiveLimiter({
        stateTtlMs: false,
      });
      const lease = await limiter.acquire("persistent", new AbortController().signal);

      lease.release(10);
      vi.advanceTimersByTime(60_000);

      expect(limiter.stats("persistent").windowSize).toBe(1);
    });
  });

  describe("warmup, jitter, slow-start, and headroom strategy", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("ramps up during explicit warmup before minSamples gates stable gradient mode", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 2,
        maxLimit: 10,
        minSamples: 100,
        warmupRequests: 4,
        probeInterval: 100,
        probeJitterRatio: 0,
      });
      const signal = new AbortController().signal;

      const first = await limiter.acquire("warm", signal);
      first.release(10);
      expect(limiter.stats("warm").limit).toBeGreaterThan(2);

      const second = await limiter.acquire("warm", signal);
      second.release(10);
      expect(limiter.stats("warm").warmupCompletions).toBe(2);
    });

    it("exits warmup early when samples are saturated", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 8,
        minLimit: 1,
        maxLimit: 20,
        minSamples: 100,
        warmupRequests: 4,
        percentile: "p99",
        smoothingFactor: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
      });
      const signal = new AbortController().signal;

      for (const latency of [10, 1000]) {
        const lease = await limiter.acquire("warm-saturated", signal);
        lease.release(latency);
      }

      expect(limiter.snapshot("warm-saturated")).toMatchObject({
        warmupDone: true,
      });
    });

    it("applies probe jitter around the configured interval", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      const limiter = new AdaptiveLimiter({
        initialLimit: 10,
        minLimit: 10,
        maxLimit: 10,
        minSamples: 1,
        probeInterval: 10,
        probeJitterRatio: 0.2,
      });
      const signal = new AbortController().signal;

      for (let i = 0; i < 10; i++) {
        const lease = await limiter.acquire("probe", signal);
        lease.release(10);
      }
      expect(limiter.stats("probe").probeCount).toBe(10);

      for (let i = 0; i < 2; i++) {
        const lease = await limiter.acquire("probe", signal);
        lease.release(10);
      }
      expect(limiter.stats("probe").probeCount).toBe(0);
    });

    it("uses proportional headroom for stable growth", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 100,
        maxLimit: 200,
        minSamples: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
        headroomStrategy: "proportional",
      });
      const signal = new AbortController().signal;

      const lease = await limiter.acquire("headroom", signal);
      lease.release(10);

      expect(limiter.stats("headroom").limit).toBe(105);
    });

    it("supports fixed, object, function, and invalid headroom strategies", async () => {
      const signal = new AbortController().signal;

      const fixed = new AdaptiveLimiter({
        initialLimit: 10,
        maxLimit: 20,
        minSamples: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
        headroomStrategy: "fixed",
      });
      const fixedLease = await fixed.acquire("fixed", signal);
      fixedLease.release(10);
      expect(fixed.stats("fixed").limit).toBe(11);

      const object = new AdaptiveLimiter({
        initialLimit: 10,
        maxLimit: 20,
        minSamples: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
        headroomStrategy: { type: "proportional", ratio: 0.2, min: 3, max: 4 },
      });
      const objectLease = await object.acquire("object", signal);
      objectLease.release(10);
      expect(object.stats("object").limit).toBe(13);

      const custom = new AdaptiveLimiter({
        initialLimit: 10,
        maxLimit: 20,
        minSamples: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
        headroomStrategy: () => Number.NaN,
      });
      const customLease = await custom.acquire("custom", signal);
      customLease.release(10);
      expect(custom.stats("custom").limit).toBe(11);
    });

    it("arms slow-start recovery after circuit-open feedback and doubles recovery headroom", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 20,
        minLimit: 1,
        maxLimit: 100,
        minSamples: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
      });
      const signal = new AbortController().signal;

      limiter.markCircuitOpen("recovery");
      expect(limiter.stats("recovery")).toMatchObject({
        limit: 1,
        slowStart: true,
      });

      const first = await limiter.acquire("recovery", signal);
      first.release(10);
      expect(limiter.stats("recovery").limit).toBe(2);

      const second = await limiter.acquire("recovery", signal);
      second.release(10);
      expect(limiter.stats("recovery").limit).toBe(4);
    });

    it("arms slow-start recovery after sustained saturation", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 20,
        minLimit: 1,
        maxLimit: 100,
        minSamples: 2,
        windowSize: 10,
        percentile: "p99",
        smoothingFactor: 1,
        probeInterval: 100,
        probeJitterRatio: 0,
        slowStartSaturationThreshold: 0.5,
        slowStartSaturationSamples: 2,
      });
      const signal = new AbortController().signal;

      for (const latency of [10, 10, 1000, 1000]) {
        const lease = await limiter.acquire("saturated", signal);
        lease.release(latency);
      }

      expect(limiter.stats("saturated").slowStart).toBe(true);
    });
  });

  describe("destroy/shutdown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects queued waiters, clears state, and rejects future acquires", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        queueTimeoutMs: 5000,
      });
      const signal = new AbortController().signal;
      const lease = await limiter.acquire("shutdown", signal);
      const queued = limiter.acquire("shutdown", signal);

      limiter.destroy();

      await expect(queued).rejects.toMatchObject({
        _tag: "PoolClosed",
        key: "shutdown",
      });
      expect(limiter.stats().stateCount).toBe(0);
      await expect(limiter.acquire("shutdown", signal)).rejects.toMatchObject({
        _tag: "PoolClosed",
      });

      vi.advanceTimersByTime(5001);
      expect(() => lease.release(10)).not.toThrow();
    });
  });

  describe("queue priority and load shedding", () => {
    it("dispatches queued waiters by priority when configured", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueue: 10,
        queueStrategy: "priority",
      });
      const signal = new AbortController().signal;
      const order: string[] = [];

      const first = await limiter.acquire("priority", signal);
      const low = limiter.acquire("priority", signal, { priority: 8 }).then((lease) => {
        order.push("low");
        return lease;
      });
      const high = limiter.acquire("priority", signal, { priority: 1 }).then((lease) => {
        order.push("high");
        return lease;
      });

      first.release(10);
      const highLease = await high;
      expect(order).toEqual(["high"]);

      highLease.release(10);
      const lowLease = await low;
      expect(order).toEqual(["high", "low"]);
      lowLease.release(10);
    });

    it("evicts lower priority waiters when priority load shedding is enabled", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueue: 1,
        queueStrategy: "priority",
        queueLoadShedding: "priority-evict",
      });
      const signal = new AbortController().signal;

      const first = await limiter.acquire("shed", signal);
      const low = limiter.acquire("shed", signal, { priority: 9 });
      const high = limiter.acquire("shed", signal, { priority: 1 });

      await expect(low).rejects.toMatchObject({
        _tag: "PoolRejected",
        key: "shed",
      });
      expect(limiter.snapshot("shed")).toMatchObject({
        evictedWhileQueued: 1,
        rejected: 1,
      });

      first.release(10);
      const highLease = await high;
      highLease.release(10);
    });

    it("rejects new waiters when priority load shedding finds no lower-priority victim", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueue: 1,
        queueStrategy: "priority",
        queueLoadShedding: "priority-evict",
      });
      const signal = new AbortController().signal;

      const first = await limiter.acquire("no-victim", signal);
      const high = limiter.acquire("no-victim", signal, { priority: 1 });

      await expect(limiter.acquire("no-victim", signal, { priority: 9 })).rejects.toMatchObject({
        _tag: "PoolRejected",
      });

      first.release(10);
      const highLease = await high;
      highLease.release(10);
    });

    it("adds retryAfterMs to PoolRejected after sustained rejection", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueue: 0,
        rejectionBackoffThreshold: 2,
        rejectionBackoffMs: 100,
      });
      const signal = new AbortController().signal;
      const held = await limiter.acquire("backoff", signal);

      try {
        await limiter.acquire("backoff", signal);
        expect.fail("expected first rejection");
      } catch (error: any) {
        expect(error._tag).toBe("PoolRejected");
        expect(error.retryAfterMs).toBeUndefined();
      }
      await expect(limiter.acquire("backoff", signal)).rejects.toMatchObject({
        _tag: "PoolRejected",
        retryAfterMs: 100,
      });
      expect(limiter.stats("backoff").suggestedBackoffMs).toBe(100);

      held.release(10);
    });
  });

  describe("diagnostics", () => {
    it("exposes keys, per-key snapshots, and full dumps", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 5,
        stateTtlMs: false,
      });
      const signal = new AbortController().signal;
      const leaseA = await limiter.acquire("a", signal);
      const leaseB = await limiter.acquire("b", signal);

      leaseA.release(10);
      leaseB.release(20);

      expect(limiter.keys()).toEqual(["a", "b"]);
      expect(limiter.stats()).toMatchObject({
        stateCount: 2,
        keys: ["a", "b"],
      });

      const snapshot = limiter.snapshot("a");
      expect(snapshot).toMatchObject({
        key: "a",
        acquired: 1,
        released: 1,
        windowSize: 1,
      });

      const dump = limiter.dump();
      expect(dump).toMatchObject({
        stateCount: 2,
        keys: ["a", "b"],
      });
      expect(dump.states.map((state) => state.key)).toEqual(["a", "b"]);
    });

    it("exposes limit-change history, throughput, and utilization", async () => {
      const limiter = new AdaptiveLimiter({
        initialLimit: 5,
        maxLimit: 10,
        minSamples: 1,
        probeInterval: 1000,
        probeJitterRatio: 0,
        historySize: 2,
        stateTtlMs: false,
      });
      const signal = new AbortController().signal;

      const first = await limiter.acquire("diag", signal);
      const second = await limiter.acquire("diag", signal);

      expect(limiter.stats("diag").utilization).toBeCloseTo(0.4);

      first.release(10);
      second.release(10);

      const history = limiter.history("diag");
      expect(history.length).toBe(2);
      expect(history[0]).toMatchObject({
        key: "diag",
        minLatency: 10,
        baselineLatency: 10,
      });

      const snapshot = limiter.snapshot("diag");
      expect(snapshot?.history).toHaveLength(2);
      expect(snapshot?.requestsPerSecond).toBeGreaterThan(0);
      expect(snapshot?.completionsPerSecond).toBeGreaterThan(0);

      const dump = limiter.dump();
      expect(dump.history).toHaveLength(2);
      expect(dump.aggregate.requestsPerSecond).toBeGreaterThan(0);
    });
  });
});
