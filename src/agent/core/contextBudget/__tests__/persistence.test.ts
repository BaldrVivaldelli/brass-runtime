import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseBanditState, serializeBanditState } from "../persistence";
import type { ArmStats, AttributionLogEntry, BanditState } from "../types";

/** Arbitrary for valid ArmStats. */
const arbArmStats: fc.Arbitrary<ArmStats> = fc.record({
  alpha: fc.double({ min: 0.001, max: 1000, noNaN: true, noDefaultInfinity: true }),
  beta: fc.double({ min: 0.001, max: 1000, noNaN: true, noDefaultInfinity: true }),
  pulls: fc.nat(10000),
  lastPulledAt: fc.nat(),
});

/** Arbitrary for a valid AttributionLogEntry. */
const arbLogEntry: fc.Arbitrary<AttributionLogEntry> = fc.record({
  timestamp: fc.nat(),
  pulledArms: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
  filesPerArm: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 0, maxLength: 3 })
  ),
  reward: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

/** Arbitrary for a valid BanditState. */
const arbBanditState: fc.Arbitrary<BanditState> = fc
  .tuple(
    fc.dictionary(
      fc.stringMatching(/^[a-z][a-z0-9/.*_-]{0,20}$/),
      arbArmStats
    ),
    fc.array(arbLogEntry, { minLength: 0, maxLength: 10 })
  )
  .map(([arms, log]) => ({
    version: 1 as const,
    arms,
    log,
  }));

describe("Feature: adaptive-context-budget", () => {
  describe("Property 7: State deserialization graceful degradation", () => {
    it("For any string (empty, invalid JSON, wrong schema), parseBanditState returns valid BanditState without throwing", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const result = parseBanditState(input);

          // Should never throw — always returns a valid BanditState
          expect(result).toBeDefined();
          expect(result.version).toBe(1);
          expect(typeof result.arms).toBe("object");
          expect(result.arms).not.toBeNull();
          expect(Array.isArray(result.log)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 4.3
     */
  });

  describe("Property 12: Serialization round-trip", () => {
    it("For any valid BanditState, parseBanditState(serializeBanditState(state)) deeply equals the original", () => {
      fc.assert(
        fc.property(arbBanditState, (state) => {
          const serialized = serializeBanditState(state);
          const deserialized = parseBanditState(serialized);

          expect(deserialized).toEqual(state);
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 4.1, 4.2
     */
  });
});
