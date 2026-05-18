import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeReward } from "../reward";
import type { PatchQualitySummary, PatchValidationStatus } from "../../patchQuality";

describe("Feature: adaptive-context-budget", () => {
  describe("Property 5: Reward computation correctness", () => {
    it("For any PatchQualitySummary with repairAttemptsUsed >= 0 and any PatchValidationStatus: correct reward values", () => {
      const arbRepairAttempts = fc.nat(100);
      const arbStatus = fc.oneof(
        fc.constant("passed" as const),
        fc.constant("failed" as const),
        fc.constant("not-run" as const),
        fc.constant("pending" as const)
      );

      fc.assert(
        fc.property(arbRepairAttempts, arbStatus, (repairAttemptsUsed, statusType) => {
          const qualitySummary: PatchQualitySummary = {
            enabled: true,
            maxRepairAttempts: 3,
            repairAttemptsUsed,
            repairsRemaining: Math.max(0, 3 - repairAttemptsUsed),
            exactSuppliedPatch: false,
          };

          let validationStatus: PatchValidationStatus;
          if (statusType === "not-run") {
            validationStatus = { type: "not-run" };
          } else if (statusType === "pending") {
            validationStatus = { type: "pending", completed: 0, total: 1 };
          } else {
            validationStatus = { type: statusType, results: [] };
          }

          const reward = computeReward(qualitySummary, validationStatus);

          if (statusType === "not-run" || statusType === "pending") {
            expect(reward).toBeUndefined();
          } else if (statusType === "failed") {
            expect(reward).toBe(0.0);
          } else if (statusType === "passed" && repairAttemptsUsed === 0) {
            expect(reward).toBe(1.0);
          } else if (statusType === "passed" && repairAttemptsUsed > 0) {
            expect(reward).toBe(1 / (1 + repairAttemptsUsed));
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 3.1, 3.2, 3.3
     */
  });
});
