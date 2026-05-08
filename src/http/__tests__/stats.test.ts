import { describe, expect, it, vi } from "vitest";
import { LifecycleStatsTracker } from "../lifecycle/stats";
import type { HttpClientStats } from "../client";
import type { LifecycleEvent } from "../lifecycle/types";

const emptyWireStats = (): HttpClientStats => ({
  inFlight: 0,
  started: 0,
  succeeded: 0,
  failed: 0,
  aborted: 0,
  timedOut: 0,
  poolRejected: 0,
  poolTimeouts: 0,
});

describe("LifecycleStatsTracker", () => {
  describe("initial state", () => {
    it("all counters start at zero", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      const stats = tracker.snapshot();
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.cacheEvictions).toBe(0);
      expect(stats.dedupHits).toBe(0);
      expect(stats.dedupActive).toBe(0);
      expect(stats.queueDepth).toBe(0);
      expect(stats.requestsStarted).toBe(0);
      expect(stats.requestsCompleted).toBe(0);
      expect(stats.requestsFailed).toBe(0);
    });
  });

  describe("increment methods", () => {
    it("increments cacheHits", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.cacheHit();
      tracker.cacheHit();
      expect(tracker.snapshot().cacheHits).toBe(2);
    });

    it("increments cacheMisses", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.cacheMiss();
      expect(tracker.snapshot().cacheMisses).toBe(1);
    });

    it("increments cacheEvictions", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.cacheEviction();
      tracker.cacheEviction();
      tracker.cacheEviction();
      expect(tracker.snapshot().cacheEvictions).toBe(3);
    });

    it("increments dedupHits", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.dedupHit();
      expect(tracker.snapshot().dedupHits).toBe(1);
    });

    it("sets dedupActive", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.setDedupActive(5);
      expect(tracker.snapshot().dedupActive).toBe(5);
      tracker.setDedupActive(3);
      expect(tracker.snapshot().dedupActive).toBe(3);
    });

    it("sets queueDepth", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.setQueueDepth(10);
      expect(tracker.snapshot().queueDepth).toBe(10);
      tracker.setQueueDepth(0);
      expect(tracker.snapshot().queueDepth).toBe(0);
    });

    it("increments requestsStarted", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.requestStarted();
      tracker.requestStarted();
      expect(tracker.snapshot().requestsStarted).toBe(2);
    });

    it("increments requestsCompleted", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.requestCompleted();
      expect(tracker.snapshot().requestsCompleted).toBe(1);
    });

    it("increments requestsFailed", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      tracker.requestFailed();
      tracker.requestFailed();
      expect(tracker.snapshot().requestsFailed).toBe(2);
    });
  });

  describe("snapshot", () => {
    it("returns a frozen object", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      const stats = tracker.snapshot();
      expect(Object.isFrozen(stats)).toBe(true);
    });

    it("exposes wire stats via stats().wire", () => {
      const wireStats: HttpClientStats = {
        inFlight: 3,
        started: 10,
        succeeded: 7,
        failed: 2,
        aborted: 1,
        timedOut: 0,
        poolRejected: 0,
        poolTimeouts: 0,
        lastDurationMs: 42,
      };
      const tracker = new LifecycleStatsTracker({ wireStats: () => wireStats });
      const stats = tracker.snapshot();
      expect(stats.wire).toEqual(wireStats);
    });

    it("calls wireStats function on each snapshot", () => {
      let callCount = 0;
      const wireStats = () => {
        callCount++;
        return emptyWireStats();
      };
      const tracker = new LifecycleStatsTracker({ wireStats });
      tracker.snapshot();
      tracker.snapshot();
      expect(callCount).toBe(2);
    });
  });

  describe("emit (onEvent callback)", () => {
    it("invokes onEvent with correct event structure", () => {
      const events: LifecycleEvent[] = [];
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: (e) => events.push(e),
      });

      tracker.emit("cache-hit", { cacheKey: "test-key" });

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("cache-hit");
      expect(events[0]!.cacheKey).toBe("test-key");
      expect(typeof events[0]!.timestamp).toBe("number");
    });

    it("invokes onEvent for each lifecycle event type", () => {
      const events: LifecycleEvent[] = [];
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: (e) => events.push(e),
      });

      const allEventTypes = [
        "request-start",
        "request-end",
        "cache-hit",
        "cache-miss",
        "dedup-hit",
        "dedup-miss",
        "queue-enqueue",
        "queue-dispatch",
      ] as const;

      for (const type of allEventTypes) {
        tracker.emit(type);
      }

      expect(events).toHaveLength(allEventTypes.length);
      for (let i = 0; i < allEventTypes.length; i++) {
        expect(events[i]!.type).toBe(allEventTypes[i]);
        expect(typeof events[i]!.timestamp).toBe("number");
      }
    });

    it("includes priority in event when provided", () => {
      const events: LifecycleEvent[] = [];
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: (e) => events.push(e),
      });

      tracker.emit("queue-enqueue", { priority: 3 });

      expect(events[0]!.priority).toBe(3);
    });

    it("does not throw when onEvent is not provided", () => {
      const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });
      expect(() => tracker.emit("request-start")).not.toThrow();
    });

    it("swallows errors thrown by onEvent callback", () => {
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: () => {
          throw new Error("callback error");
        },
      });

      // Should not throw
      expect(() => tracker.emit("request-start")).not.toThrow();
    });

    it("does not propagate onEvent errors to caller for any event type", () => {
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: () => {
          throw new TypeError("unexpected type error");
        },
      });

      // Verify no event type propagates the error
      expect(() => tracker.emit("request-start")).not.toThrow();
      expect(() => tracker.emit("request-end")).not.toThrow();
      expect(() => tracker.emit("cache-hit", { cacheKey: "k" })).not.toThrow();
      expect(() => tracker.emit("cache-miss", { cacheKey: "k" })).not.toThrow();
      expect(() => tracker.emit("dedup-hit")).not.toThrow();
      expect(() => tracker.emit("dedup-miss")).not.toThrow();
      expect(() => tracker.emit("queue-enqueue", { priority: 1 })).not.toThrow();
      expect(() => tracker.emit("queue-dispatch", { priority: 1 })).not.toThrow();
    });

    it("continues processing after onEvent throws", () => {
      let callCount = 0;
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: () => {
          callCount++;
          if (callCount === 1) throw new Error("first call fails");
        },
      });

      tracker.emit("request-start");
      tracker.emit("request-end");

      expect(callCount).toBe(2);
    });

    it("emits event without extras when none provided", () => {
      const events: LifecycleEvent[] = [];
      const tracker = new LifecycleStatsTracker({
        wireStats: emptyWireStats,
        onEvent: (e) => events.push(e),
      });

      tracker.emit("request-start");

      expect(events[0]!.type).toBe("request-start");
      expect(events[0]!.cacheKey).toBeUndefined();
      expect(events[0]!.priority).toBeUndefined();
    });
  });
});
