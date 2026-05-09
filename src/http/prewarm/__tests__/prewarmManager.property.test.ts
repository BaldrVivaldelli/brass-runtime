import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { makePrewarmManager } from "../prewarmManager";
import type { PrewarmEvent } from "../types";

/**
 * Property-based tests for the PrewarmManager.
 * Feature: http-connection-prewarm
 */
describe("PrewarmManager Property Tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  /** Generator for valid origin strings. */
  const hostLabelArb = fc
    .stringMatching(/^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])$/)
    .filter((label) => !label.startsWith("xn--"));
  const validOriginArb = fc.tuple(
    fc.constantFrom("https", "http"),
    hostLabelArb,
    fc.stringMatching(/^[a-z]{2,6}$/),
  ).map(([scheme, label, tld]) => `${scheme}://${label}.${tld}`);

  /** Generator for a set of unique valid origins. */
  const originsArb = fc.uniqueArray(validOriginArb, { minLength: 1, maxLength: 8 });

  function mockFetchAlwaysSuccess() {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any;
  }

  function mockFetchWithOutcomes(outcomes: Map<string, "success" | "fail">) {
    globalThis.fetch = vi.fn(async (url: any) => {
      const origin = new URL(url.toString()).origin;
      const outcome = outcomes.get(origin) ?? "success";
      if (outcome === "fail") {
        throw new Error("Network error");
      }
      return new Response(null, { status: 200 });
    }) as any;
  }

  /**
   * Property 6: Conditional Probing (Idempotence of Warm State)
   *
   * For any warm origin, warm() skips probe; for expired/idle, it probes.
   *
   * **Validates: Requirements 3.1, 3.2, 3.3**
   */
  it("Property 6: warm origin skips probe, idle/expired origin probes", async () => {
    await fc.assert(
      fc.asyncProperty(validOriginArb, async (origin) => {
        mockFetchAlwaysSuccess();
        const manager = makePrewarmManager({ origins: [origin] });

        // First warm should probe
        const r1 = await manager.warm(origin);
        expect(r1.status).toBe("warmed");

        // Second warm should skip (already warm)
        const r2 = await manager.warm(origin);
        expect(r2.status).toBe("already-warm");
        expect(r2.durationMs).toBe(0);

        manager.dispose();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 5: warmAll Result Completeness
   *
   * For any N configured origins, warmAll() returns exactly N results.
   *
   * **Validates: Requirements 2.3**
   */
  it("Property 5: warmAll returns exactly N results for N origins", async () => {
    await fc.assert(
      fc.asyncProperty(originsArb, async (origins) => {
        mockFetchAlwaysSuccess();
        const manager = makePrewarmManager({ origins });

        const results = await manager.warmAll();
        expect(results).toHaveLength(origins.length);

        // Each origin should appear exactly once
        const resultOrigins = results.map((r) => r.origin).sort();
        const expectedOrigins = origins.map((o) => new URL(o).origin).sort();
        expect(resultOrigins).toEqual(expectedOrigins);

        manager.dispose();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 11: Cancellation Prevents Warm State
   *
   * For any cancelled probe, origin is not marked warm.
   *
   * **Validates: Requirements 6.1, 6.2, 6.4**
   */
  it("Property 11: cancelled probe does not mark origin warm", async () => {
    await fc.assert(
      fc.asyncProperty(validOriginArb, async (origin) => {
        // Use a slow fetch that signals when it starts
        let fetchStarted: (() => void) | undefined;
        const fetchStartedPromise = new Promise<void>((r) => { fetchStarted = r; });

        globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
          fetchStarted!();
          return new Promise<Response>((_, reject) => {
            const onAbort = () => {
              reject(new DOMException("Aborted", "AbortError"));
            };
            if (init?.signal?.aborted) {
              onAbort();
              return;
            }
            init?.signal?.addEventListener("abort", onAbort);
          });
        }) as any;

        const manager = makePrewarmManager({ origins: [origin] });

        const warmPromise = manager.warm(origin);
        await fetchStartedPromise;
        manager.cancel(origin);
        const result = await warmPromise;

        expect(result.status).toBe("cancelled");
        expect(manager.isWarm(origin)).toBe(false);

        manager.dispose();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 13: PrewarmResult Completeness and Error Capture
   *
   * For any probe outcome, result contains origin, valid status, and non-negative durationMs;
   * failures capture error without effect failure.
   *
   * **Validates: Requirements 10.1, 10.2**
   */
  it("Property 13: PrewarmResult always has origin, valid status, non-negative durationMs", async () => {
    await fc.assert(
      fc.asyncProperty(
        validOriginArb,
        fc.constantFrom("success", "fail") as fc.Arbitrary<"success" | "fail">,
        async (origin, outcome) => {
          const outcomes = new Map<string, "success" | "fail">();
          outcomes.set(new URL(origin).origin, outcome);
          mockFetchWithOutcomes(outcomes);

          const manager = makePrewarmManager({ origins: [origin] });
          const result = await manager.warm(origin);

          // Always has origin
          expect(result.origin).toBe(new URL(origin).origin);
          // Always has valid status
          expect(["warmed", "already-warm", "failed", "cancelled"]).toContain(result.status);
          // Always has non-negative durationMs
          expect(result.durationMs).toBeGreaterThanOrEqual(0);

          // Failed probes capture error
          if (result.status === "failed") {
            expect(result.error).toBeDefined();
            expect(typeof result.error).toBe("string");
          }

          manager.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 10: Event Emission Completeness
   *
   * For any state transition, exactly one corresponding event is emitted
   * with correct type, origin, and timestamp.
   *
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
   */
  it("Property 10: each state transition emits exactly one event with correct fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        validOriginArb,
        fc.constantFrom("success", "fail") as fc.Arbitrary<"success" | "fail">,
        async (origin, outcome) => {
          const outcomes = new Map<string, "success" | "fail">();
          outcomes.set(new URL(origin).origin, outcome);
          mockFetchWithOutcomes(outcomes);

          const events: PrewarmEvent[] = [];
          const manager = makePrewarmManager({
            origins: [origin],
            onEvent: (e) => events.push(e),
          });

          await manager.warm(origin);

          // Exactly one event should be emitted per warm call
          expect(events).toHaveLength(1);

          const event = events[0];
          expect(event.origin).toBe(new URL(origin).origin);
          expect(event.timestamp).toBeGreaterThan(0);

          if (outcome === "success") {
            expect(event.type).toBe("connection-warmed");
          } else {
            expect(event.type).toBe("connection-failed");
            expect(event.error).toBeDefined();
          }

          manager.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 9: Auto-Refresh Scheduling
   *
   * For any keepAliveDurationMs K, re-probe is scheduled at 0.8*K after successful probe.
   *
   * **Validates: Requirements 4.3**
   */
  it("Property 9: auto-refresh schedules re-probe at 0.8*K", async () => {
    await fc.assert(
      fc.asyncProperty(
        validOriginArb,
        fc.integer({ min: 1000, max: 60000 }),
        async (origin, keepAliveDurationMs) => {
          vi.useFakeTimers();
          mockFetchAlwaysSuccess();

          const events: PrewarmEvent[] = [];
          const manager = makePrewarmManager({
            origins: [origin],
            keepAliveDurationMs,
            autoRefresh: true,
            onEvent: (e) => events.push(e),
          });

          await manager.warm(origin);
          const warmedCountAfterFirst = events.filter((e) => e.type === "connection-warmed").length;
          expect(warmedCountAfterFirst).toBe(1);

          // Advance to 0.8*K — auto-refresh should trigger
          const refreshDelay = Math.floor(0.8 * keepAliveDurationMs);
          await vi.advanceTimersByTimeAsync(refreshDelay + 1);

          // After auto-refresh fires, it calls warm() which is async.
          // The expired event should have been emitted, and a new warmed event after re-probe.
          const expiredEvents = events.filter((e) => e.type === "connection-expired");
          expect(expiredEvents.length).toBeGreaterThanOrEqual(1);

          manager.dispose();
          vi.useRealTimers();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property 2: Configuration Propagation
   *
   * For any valid keepAliveDurationMs, the manager uses exactly that value as expiry threshold.
   *
   * **Validates: Requirements 1.3**
   */
  it("Property 2: keepAliveDurationMs is used as expiry threshold", async () => {
    await fc.assert(
      fc.asyncProperty(
        validOriginArb,
        fc.integer({ min: 1000, max: 120000 }),
        async (origin, keepAliveDurationMs) => {
          vi.useFakeTimers();
          mockFetchAlwaysSuccess();

          const manager = makePrewarmManager({
            origins: [origin],
            keepAliveDurationMs,
          });

          await manager.warm(origin);
          expect(manager.isWarm(origin)).toBe(true);

          // Just before expiry — still warm
          vi.advanceTimersByTime(keepAliveDurationMs - 1);
          expect(manager.isWarm(origin)).toBe(true);

          // At expiry — expired
          vi.advanceTimersByTime(2);
          expect(manager.isWarm(origin)).toBe(false);

          manager.dispose();
          vi.useRealTimers();
        },
      ),
      { numRuns: 100 },
    );
  });
});
