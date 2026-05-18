import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { updateBanditState, selectArms } from "../banditEngine";
import { reorderCandidates } from "../integration";
import type { Arm, ArmStats, BanditState } from "../types";

/** Creates a seeded deterministic RNG (simple LCG). */
const makeDeterministicRng = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 0) / 0x100000000;
  };
};

/** Arbitrary for valid ArmStats. */
const arbArmStats: fc.Arbitrary<ArmStats> = fc.record({
  alpha: fc.double({ min: 0.001, max: 100, noNaN: true }),
  beta: fc.double({ min: 0.001, max: 100, noNaN: true }),
  pulls: fc.nat(1000),
  lastPulledAt: fc.nat(),
});

/** Arbitrary for a non-empty arm ID. */
const arbArmId = fc.stringMatching(/^[a-z][a-z0-9/.*_-]{0,30}$/);

/** Arbitrary for a valid BanditState with at least one arm. */
const arbBanditStateWithArms: fc.Arbitrary<BanditState> = fc
  .tuple(
    fc.array(fc.tuple(arbArmId, arbArmStats), { minLength: 1, maxLength: 10 }),
  )
  .map(([armEntries]) => ({
    version: 1 as const,
    arms: Object.fromEntries(armEntries),
    log: [],
  }));

/** Arbitrary for a valid Arm. */
const arbArm: fc.Arbitrary<Arm> = arbArmId.map((id) => ({ id, pattern: id }));

describe("Feature: adaptive-context-budget", () => {
  describe("Property 6: Reward update preserves and updates arm statistics", () => {
    it("For any valid BanditState, non-empty pulled arms, and reward r in [0,1], updateBanditState returns correct state", () => {
      fc.assert(
        fc.property(
          arbBanditStateWithArms,
          fc.array(arbArm, { minLength: 1, maxLength: 5 }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (state, pulledArms, reward) => {
            // Deep clone to check immutability
            const originalState = JSON.parse(JSON.stringify(state));

            const result = updateBanditState(state, pulledArms, reward);

            // Input not mutated
            expect(state).toEqual(originalState);

            // Check each pulled arm
            for (const arm of pulledArms) {
              const originalStats = state.arms[arm.id] ?? {
                alpha: 1,
                beta: 1,
                pulls: 0,
                lastPulledAt: 0,
              };
              const updatedStats = result.arms[arm.id];
              expect(updatedStats).toBeDefined();
              expect(updatedStats!.alpha).toBeCloseTo(
                originalStats.alpha + reward,
                10
              );
              expect(updatedStats!.beta).toBeCloseTo(
                originalStats.beta + (1 - reward),
                10
              );
              expect(updatedStats!.pulls).toBe(originalStats.pulls + 1);
            }

            // Non-pulled arms unchanged
            const pulledIds = new Set(pulledArms.map((a) => a.id));
            for (const [armId, stats] of Object.entries(state.arms)) {
              if (!pulledIds.has(armId)) {
                expect(result.arms[armId]).toEqual(stats);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 4.4, 7.2
     */
  });

  describe("Property 11: Arm selection purity and determinism", () => {
    it("For any BanditState, candidate arms, and deterministic RNG, calling selectArms twice with identical inputs produces identical output", () => {
      fc.assert(
        fc.property(
          arbBanditStateWithArms,
          fc.array(arbArm, { minLength: 1, maxLength: 10 }),
          fc.nat(),
          (state, candidateArms, seed) => {
            const rng1 = makeDeterministicRng(seed);
            const rng2 = makeDeterministicRng(seed);

            const result1 = selectArms(state, candidateArms, rng1);
            const result2 = selectArms(state, candidateArms, rng2);

            expect(result1).toEqual(result2);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 7.1, 7.3
     */
  });

  describe("Property 3: Priority-ordered selection respects arm value", () => {
    it("With a fixed RNG seed, candidates from higher-sampled-value arms appear before lower-sampled-value arms in reorderCandidates output", () => {
      fc.assert(
        fc.property(fc.nat(), (seed) => {
          // Create a state where one arm has very high alpha (strong arm)
          // and another has very high beta (weak arm)
          const state: BanditState = {
            version: 1,
            arms: {
              "src/strong/*.ts": { alpha: 100, beta: 1, pulls: 100, lastPulledAt: 0 },
              "src/weak/*.ts": { alpha: 1, beta: 100, pulls: 100, lastPulledAt: 0 },
            },
            log: [],
          };

          const candidates = [
            "src/weak/a.ts",
            "src/weak/b.ts",
            "src/strong/x.ts",
            "src/strong/y.ts",
          ];

          const rng = makeDeterministicRng(seed);
          const result = reorderCandidates(candidates, state, rng);

          // Find positions of strong and weak arm candidates
          const strongPositions = result
            .map((c, i) => (c.startsWith("src/strong/") ? i : -1))
            .filter((i) => i >= 0);
          const weakPositions = result
            .map((c, i) => (c.startsWith("src/weak/") ? i : -1))
            .filter((i) => i >= 0);

          // Strong arm candidates should appear before weak arm candidates
          if (strongPositions.length > 0 && weakPositions.length > 0) {
            const maxStrongPos = Math.max(...strongPositions);
            const minWeakPos = Math.min(...weakPositions);
            expect(maxStrongPos).toBeLessThan(minWeakPos);
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 2.1, 2.3, 8.1
     */
  });
});
