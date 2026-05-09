import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { makeConnectionStateMap } from "../connectionState";

/**
 * Property-based tests for connection state management.
 * Feature: http-connection-prewarm
 */
describe("Connection State Property Tests", () => {
  /** Arbitrary for valid origin strings */
  const arbOrigin = fc
    .tuple(
      fc.constantFrom("https", "http"),
      fc.stringMatching(/^[a-z][a-z0-9]{1,6}$/).filter((s) => s.length >= 2),
      fc.constantFrom(".com", ".org", ".io"),
    )
    .map(([scheme, name, tld]) => `${scheme}://${name}${tld}`);

  /** Arbitrary for a non-empty set of unique origins */
  const arbOrigins = fc
    .uniqueArray(arbOrigin, { minLength: 1, maxLength: 8 })
    .filter((arr) => arr.length >= 1);

  /** Arbitrary for keepAliveDurationMs */
  const arbKeepAlive = fc.integer({ min: 1000, max: 300000 });

  /**
   * Property 8: Connection State Machine Transitions
   *
   * For any origin, state transitions follow the defined state machine:
   * idle → probing → warm → expired (after keepAliveDuration elapses)
   * probing → idle (on failure/cancel)
   *
   * **Validates: Requirements 4.1, 4.2**
   */
  describe("Property 8: State Machine Transitions", () => {
    it("successful probe transitions: idle → probing → warm → expired", () => {
      fc.assert(
        fc.property(arbOrigins, arbKeepAlive, (origins, keepAlive) => {
          const stateMap = makeConnectionStateMap(origins, keepAlive);
          const origin = origins[0];
          const now = 1000000;

          // Initial state is idle
          const initial = stateMap.getState(origin);
          expect(initial?.status).toBe("idle");

          // Transition to probing
          stateMap.markProbing(origin);
          expect(stateMap.getState(origin)?.status).toBe("probing");

          // Transition to warm
          stateMap.markWarm(origin, now);
          expect(stateMap.getState(origin)?.status).toBe("warm");

          // After keepAlive elapses, isWarm returns false (auto-transitions to expired)
          const expired = stateMap.isWarm(origin, now + keepAlive);
          expect(expired).toBe(false);
          expect(stateMap.getState(origin)?.status).toBe("expired");
        }),
        { numRuns: 100 },
      );
    });

    it("failed/cancelled probe transitions: probing → idle", () => {
      fc.assert(
        fc.property(arbOrigins, arbKeepAlive, (origins, keepAlive) => {
          const stateMap = makeConnectionStateMap(origins, keepAlive);
          const origin = origins[0];

          // Transition to probing
          stateMap.markProbing(origin);
          expect(stateMap.getState(origin)?.status).toBe("probing");

          // Failure returns to idle
          stateMap.markIdle(origin);
          expect(stateMap.getState(origin)?.status).toBe("idle");
          expect(stateMap.getState(origin)?.lastProbeAt).toBeUndefined();
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 7: isWarm State Consistency
   *
   * For any origin, `isWarm` returns true iff lastProbeAt is set and
   * elapsed < keepAliveDurationMs.
   *
   * **Validates: Requirements 3.4**
   */
  describe("Property 7: isWarm Consistency", () => {
    it("isWarm returns true iff within keepAlive window", () => {
      fc.assert(
        fc.property(
          arbOrigins,
          arbKeepAlive,
          fc.integer({ min: 0, max: 500000 }),
          fc.integer({ min: 0, max: 500000 }),
          (origins, keepAlive, probeTime, elapsed) => {
            const stateMap = makeConnectionStateMap(origins, keepAlive);
            const origin = origins[0];
            const now = probeTime + elapsed;

            // Mark warm at probeTime
            stateMap.markWarm(origin, probeTime);

            const warm = stateMap.isWarm(origin, now);

            if (elapsed < keepAlive) {
              expect(warm).toBe(true);
            } else {
              expect(warm).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("isWarm returns false for origins that were never probed", () => {
      fc.assert(
        fc.property(arbOrigins, arbKeepAlive, (origins, keepAlive) => {
          const stateMap = makeConnectionStateMap(origins, keepAlive);
          const origin = origins[0];

          expect(stateMap.isWarm(origin)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 14: Status Snapshot Completeness
   *
   * For any set of origins, snapshot returns exactly one entry per origin.
   *
   * **Validates: Requirements 10.3**
   */
  describe("Property 14: Snapshot Completeness", () => {
    it("snapshot returns exactly one entry per managed origin", () => {
      fc.assert(
        fc.property(arbOrigins, arbKeepAlive, (origins, keepAlive) => {
          const stateMap = makeConnectionStateMap(origins, keepAlive);
          const snap = stateMap.snapshot();

          // Exactly one entry per origin
          expect(snap.origins.length).toBe(origins.length);

          // Each origin appears exactly once
          const snapshotOrigins = snap.origins.map((o) => o.origin).sort();
          const inputOrigins = [...origins].sort();
          expect(snapshotOrigins).toEqual(inputOrigins);

          // Each entry has required fields
          for (const entry of snap.origins) {
            expect(entry.origin).toBeDefined();
            expect(["idle", "probing", "warm", "expired"]).toContain(entry.status);
          }
        }),
        { numRuns: 100 },
      );
    });

    it("snapshot reflects state changes", () => {
      fc.assert(
        fc.property(arbOrigins, arbKeepAlive, (origins, keepAlive) => {
          const stateMap = makeConnectionStateMap(origins, keepAlive);
          const origin = origins[0];

          // Initially all idle
          let snap = stateMap.snapshot();
          for (const entry of snap.origins) {
            expect(entry.status).toBe("idle");
          }

          // Mark first origin warm
          stateMap.markWarm(origin, 1000);
          snap = stateMap.snapshot();
          const entry = snap.origins.find((o) => o.origin === origin);
          expect(entry?.status).toBe("warm");
          expect(entry?.lastProbeAt).toBe(1000);
        }),
        { numRuns: 100 },
      );
    });
  });
});
