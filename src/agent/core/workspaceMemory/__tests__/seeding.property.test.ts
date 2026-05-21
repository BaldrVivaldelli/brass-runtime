// src/agent/core/workspaceMemory/__tests__/seeding.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeAdjustedPriors, seedContextBanditPriors, seedPatchStrategyPriors } from "../seeding";
import { emptyWorkspaceMemory } from "../types";
import type {
  WorkspaceMemory,
  FileChangeEntry,
  CommandFailureEntry,
  GoalPatternEntry,
  CoChangeClusterEntry,
} from "../types";
import { initialThompsonState } from "../../patchStrategy/thompson";

// --- Generators ---

const timestampArb = fc.nat({ max: 2_000_000_000_000 });
const keyArb = fc.stringMatching(/^[a-z][a-z0-9/._\-]{0,29}$/);

const fileChangeEntryArb: fc.Arbitrary<FileChangeEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  count: fc.nat({ max: 10000 }),
});

const commandFailureEntryArb: fc.Arbitrary<CommandFailureEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  successes: fc.nat({ max: 10000 }),
  failures: fc.nat({ max: 10000 }),
});

const goalPatternEntryArb: fc.Arbitrary<GoalPatternEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  pattern: keyArb,
  successes: fc.nat({ max: 10000 }),
  failures: fc.nat({ max: 10000 }),
});

const coChangeClusterEntryArb: fc.Arbitrary<CoChangeClusterEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  files: fc.array(keyArb, { minLength: 1, maxLength: 5 }),
  occurrences: fc.nat({ max: 10000 }),
});

const workspaceMemoryArb: fc.Arbitrary<WorkspaceMemory> = fc.record({
  version: fc.constant(1 as const),
  fileChangeFrequency: fc.array(fileChangeEntryArb, { minLength: 0, maxLength: 20 }),
  commandFailureRate: fc.array(commandFailureEntryArb, { minLength: 0, maxLength: 20 }),
  goalPatternSuccessRate: fc.array(goalPatternEntryArb, { minLength: 0, maxLength: 20 }),
  coChangeClusters: fc.array(coChangeClusterEntryArb, { minLength: 0, maxLength: 20 }),
});

const armPatternArb = fc.record({
  id: fc.stringMatching(/^[a-z][a-z0-9\-]{0,14}$/),
  pattern: keyArb,
});

// --- Property 3: Bandit seeding produces valid distributions ---

describe("Property 3: Bandit seeding produces valid distributions", () => {
  /**
   * **Validates: Requirements 8.1, 8.2, 8.3, 10.3**
   *
   * For any valid WorkspaceMemory (including empty memory and memory with entries at the cap),
   * seedContextBanditPriors SHALL produce ArmStats where alpha >= 1 and beta >= 1 for every arm,
   * and seedPatchStrategyPriors SHALL produce a ThompsonState where alpha >= 1 and beta >= 1
   * for every strategy arm.
   */
  it("seedContextBanditPriors produces alpha >= 1 and beta >= 1 for all arms", () => {
    fc.assert(
      fc.property(
        workspaceMemoryArb,
        fc.array(armPatternArb, { minLength: 1, maxLength: 10 }),
        (memory, armPatterns) => {
          const result = seedContextBanditPriors(memory, armPatterns);

          for (const arm of armPatterns) {
            const stats = result[arm.id];
            expect(stats).toBeDefined();
            expect(stats.alpha).toBeGreaterThanOrEqual(1);
            expect(stats.beta).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("seedPatchStrategyPriors produces alpha >= 1 and beta >= 1 for all arms", () => {
    fc.assert(
      fc.property(
        workspaceMemoryArb,
        keyArb,
        (memory, goalPattern) => {
          const result = seedPatchStrategyPriors(memory, goalPattern);

          for (const arm of Object.values(result.arms)) {
            expect(arm.alpha).toBeGreaterThanOrEqual(1);
            expect(arm.beta).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("computeAdjustedPriors always produces alpha >= 1 and beta >= 1", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100000 }),
        fc.nat({ max: 100000 }),
        fc.double({ min: 0.01, max: 10, noNaN: true }),
        (successes, failures, scaleFactor) => {
          const { alpha, beta } = computeAdjustedPriors(successes, failures, scaleFactor);
          expect(alpha).toBeGreaterThanOrEqual(1);
          expect(beta).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 4: Zero-observation convergence to default priors ---

describe("Property 4: Zero-observation convergence to default priors", () => {
  /**
   * **Validates: Requirements 8.4, 7.2, 7.3**
   *
   * For any WorkspaceMemory where all entries have zero observations,
   * seedContextBanditPriors SHALL produce ArmStats equal to { alpha: 1, beta: 1, pulls: 0, lastPulledAt: 0 }
   * for all arms, and seedPatchStrategyPriors SHALL produce a ThompsonState identical to initialThompsonState().
   */
  it("seedContextBanditPriors returns default priors for empty memory", () => {
    fc.assert(
      fc.property(
        fc.array(armPatternArb, { minLength: 1, maxLength: 10 }),
        (armPatterns) => {
          const memory = emptyWorkspaceMemory();
          const result = seedContextBanditPriors(memory, armPatterns);

          for (const arm of armPatterns) {
            const stats = result[arm.id];
            expect(stats).toStrictEqual({ alpha: 1, beta: 1, pulls: 0, lastPulledAt: 0 });
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("seedPatchStrategyPriors returns initialThompsonState for empty memory", () => {
    fc.assert(
      fc.property(keyArb, (goalPattern) => {
        const memory = emptyWorkspaceMemory();
        const result = seedPatchStrategyPriors(memory, goalPattern);
        expect(result).toStrictEqual(initialThompsonState());
      }),
      { numRuns: 200 },
    );
  });

  it("computeAdjustedPriors returns Beta(1,1) for zero observations", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 10, noNaN: true }),
        (scaleFactor) => {
          const { alpha, beta } = computeAdjustedPriors(0, 0, scaleFactor);
          expect(alpha).toBe(1);
          expect(beta).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("seedContextBanditPriors returns default priors for memory with zero-count entries", () => {
    fc.assert(
      fc.property(
        fc.array(armPatternArb, { minLength: 1, maxLength: 5 }),
        (armPatterns) => {
          // Memory with entries that have zero counts
          const memory: WorkspaceMemory = {
            version: 1,
            fileChangeFrequency: [{ key: "src/a.ts", updatedAt: 1000, count: 0 }],
            commandFailureRate: [{ key: "npm test", updatedAt: 1000, successes: 0, failures: 0 }],
            goalPatternSuccessRate: [{ key: "fix-*", pattern: "fix-*", updatedAt: 1000, successes: 0, failures: 0 }],
            coChangeClusters: [{ key: "cluster-1", files: ["a.ts"], updatedAt: 1000, occurrences: 0 }],
          };

          const result = seedContextBanditPriors(memory, armPatterns);

          for (const arm of armPatterns) {
            const stats = result[arm.id];
            expect(stats.alpha).toBe(1);
            expect(stats.beta).toBe(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
