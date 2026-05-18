import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { reorderCandidates, shouldApplyBandit } from "../integration";
import { emptyBanditState } from "../types";
import type { ArmStats, BanditState } from "../types";

/** Creates a seeded deterministic RNG (simple LCG). */
const makeDeterministicRng = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 0) / 0x100000000;
  };
};

/** Arbitrary for file paths that will produce valid arm IDs. */
const arbFilePath = fc
  .tuple(
    fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/), { minLength: 0, maxLength: 3 }),
    fc.stringMatching(/^[a-z][a-z0-9_-]{1,10}$/),
    fc.constantFrom(".ts", ".js", ".json", ".md", ".tsx", ".css")
  )
  .map(([dirs, name, ext]) =>
    dirs.length > 0 ? `${dirs.join("/")}/${name}${ext}` : `${name}${ext}`
  );

/** Arbitrary for valid ArmStats. */
const arbArmStats: fc.Arbitrary<ArmStats> = fc.record({
  alpha: fc.double({ min: 0.001, max: 100, noNaN: true }),
  beta: fc.double({ min: 0.001, max: 100, noNaN: true }),
  pulls: fc.nat(1000),
  lastPulledAt: fc.nat(),
});

/** Arbitrary for a BanditState with at least one arm. */
const arbBanditStateWithArms: fc.Arbitrary<BanditState> = fc
  .array(
    fc.tuple(fc.stringMatching(/^[a-z][a-z0-9/.*_-]{0,20}$/), arbArmStats),
    { minLength: 1, maxLength: 5 }
  )
  .map((entries) => ({
    version: 1 as const,
    arms: Object.fromEntries(entries),
    log: [],
  }));

describe("Feature: adaptive-context-budget", () => {
  describe("Property 8: Empty state preserves original ordering", () => {
    it("For any candidate list and empty BanditState, reorderCandidates returns candidates in original order", () => {
      fc.assert(
        fc.property(
          fc.array(arbFilePath, { minLength: 0, maxLength: 20 }),
          fc.nat(),
          (candidates, seed) => {
            const state = emptyBanditState();
            const rng = makeDeterministicRng(seed);

            const result = reorderCandidates(candidates, state, rng);

            expect(result).toEqual(candidates);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 5.1
     */
  });

  describe("Property 9: Bypass when initialPatch present", () => {
    it("shouldApplyBandit returns false when hasInitialPatch is true", () => {
      fc.assert(
        fc.property(
          arbBanditStateWithArms,
          fc.boolean(),
          (state, contextEnabled) => {
            const result = shouldApplyBandit(state, contextEnabled, true);
            expect(result).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 5.3
     */
  });

  describe("Property 13: Disabled context discovery bypasses bandit", () => {
    it("shouldApplyBandit returns false when contextEnabled is false", () => {
      fc.assert(
        fc.property(
          arbBanditStateWithArms,
          fc.boolean(),
          (state, hasInitialPatch) => {
            const result = shouldApplyBandit(state, false, hasInitialPatch);
            expect(result).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 8.4
     */
  });

  describe("Property 4: Budget preservation invariant", () => {
    it("shouldApplyBandit correctly gates the bandit — reorderCandidates output is always a permutation of input", () => {
      fc.assert(
        fc.property(
          fc.array(arbFilePath, { minLength: 1, maxLength: 20 }),
          arbBanditStateWithArms,
          fc.nat(),
          (candidates, state, seed) => {
            const rng = makeDeterministicRng(seed);
            const result = reorderCandidates(candidates, state, rng);

            // Output is same length as input (budget preserved)
            expect(result.length).toBe(candidates.length);

            // Output is a permutation of input (no files added or removed)
            const sortedInput = [...candidates].sort();
            const sortedOutput = [...result].sort();
            expect(sortedOutput).toEqual(sortedInput);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 2.4
     */
  });
});
