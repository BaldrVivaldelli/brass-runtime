import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { performance } from "perf_hooks";
import { TimerWheel } from "../timerWheel";

/**
 * Property-based tests for TimerWheel timing accuracy.
 * Feature: http-p99-optimization
 */
describe("TimerWheel property tests", () => {
  let currentTime: number;
  let perfSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    currentTime = 0;
    // Mock performance.now() so we can control time for deadline checks.
    // The timer wheel imports performance from perf_hooks, so we spy on that.
    perfSpy = vi.spyOn(performance, "now").mockImplementation(() => currentTime);
  });

  afterEach(() => {
    perfSpy.mockRestore();
    vi.useRealTimers();
  });

  /**
   * Helper: advance both fake timers and our mocked performance.now() clock.
   * This ensures setTimeout callbacks fire AND the deadline comparison
   * inside tick() sees the correct time.
   */
  function advanceTime(ms: number): void {
    currentTime += ms;
    vi.advanceTimersByTime(ms);
  }

  /**
   * Property P1: Timer wheel fires within 1 tick of deadline
   *
   * For any valid timeoutMs, the callback fires at a time t where:
   *   deadline <= t <= deadline + tickMs
   *
   * Where deadline = scheduleTime + timeoutMs.
   *
   * **Validates: Requirements 1.3, 1.4**
   */
  describe("Property P1: Timer wheel fires within 1 tick of deadline", () => {
    it("callback fires within [deadline, deadline + effectiveTick] for any valid timeoutMs", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5000 }),
          fc.integer({ min: 1, max: 16 }),
          (timeoutMs, tickMs) => {
            const fineTickMs = 4; // default fine tick
            const fineThresholdMs = 50; // default fine threshold
            const wheel = new TimerWheel({ tickMs, slots: 512 });

            let fireTime: number | undefined;
            const scheduleTime = currentTime;

            wheel.schedule(timeoutMs, () => {
              fireTime = currentTime;
            });

            const deadline = scheduleTime + timeoutMs;

            // Determine effective tick resolution for this entry
            const effectiveTick = timeoutMs <= fineThresholdMs ? fineTickMs : tickMs;

            // Advance time in the effective tick increments until the callback fires or we
            // exceed the maximum expected fire time.
            const maxTime = deadline + effectiveTick;
            while (fireTime === undefined && currentTime <= maxTime) {
              advanceTime(effectiveTick);
            }

            expect(fireTime).toBeDefined();

            // The callback must fire within [deadline, deadline + effectiveTick]
            expect(fireTime!).toBeGreaterThanOrEqual(deadline);
            expect(fireTime!).toBeLessThanOrEqual(deadline + effectiveTick);

            wheel.destroy();
          },
        ),
        { numRuns: 100 },
      );
    });

    it("callback fires within 1 tick of deadline with default tickMs (10ms)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 3000 }),
          (timeoutMs) => {
            const tickMs = 10;
            const fineTickMs = 4; // default fine tick
            const fineThresholdMs = 50; // default fine threshold
            const wheel = new TimerWheel({ tickMs, slots: 512 });

            let fireTime: number | undefined;
            const scheduleTime = currentTime;

            wheel.schedule(timeoutMs, () => {
              fireTime = currentTime;
            });

            const deadline = scheduleTime + timeoutMs;

            // Determine effective tick resolution for this entry
            const effectiveTick = timeoutMs <= fineThresholdMs ? fineTickMs : tickMs;

            // Advance time in effective tick increments until the callback fires
            const maxTime = deadline + effectiveTick;
            while (fireTime === undefined && currentTime <= maxTime) {
              advanceTime(effectiveTick);
            }

            expect(fireTime).toBeDefined();

            // The callback must fire within [deadline, deadline + effectiveTick]
            expect(fireTime!).toBeGreaterThanOrEqual(deadline);
            expect(fireTime!).toBeLessThanOrEqual(deadline + effectiveTick);

            wheel.destroy();
          },
        ),
        { numRuns: 100 },
      );
    });

    it("callback never fires before the deadline", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 20, max: 2000 }),
          fc.integer({ min: 1, max: 16 }),
          (timeoutMs, tickMs) => {
            const wheel = new TimerWheel({ tickMs, slots: 512 });

            let fired = false;

            wheel.schedule(timeoutMs, () => {
              fired = true;
            });

            // Advance time to just before the deadline (minus one tick to be safe)
            const advanceBefore = Math.max(0, timeoutMs - tickMs - 1);
            if (advanceBefore > 0) {
              // Advance in one step to just before deadline
              advanceTime(advanceBefore);
              expect(fired).toBe(false);
            }

            wheel.destroy();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
