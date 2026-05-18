import type { PatchQualitySummary, PatchValidationStatus } from "../patchQuality";

/**
 * Computes the graded reward signal from patch quality data.
 *
 * - Passed on first attempt (repairAttemptsUsed = 0): reward = 1.0
 * - Passed after repairs: reward = 1 / (1 + repairAttemptsUsed)
 * - Failed after budget exhausted: reward = 0.0
 * - Not run / pending: undefined (no reward to assign)
 */
export const computeReward = (
  qualitySummary: PatchQualitySummary,
  validationStatus: PatchValidationStatus
): number | undefined => {
  if (validationStatus.type === "not-run" || validationStatus.type === "pending") {
    return undefined;
  }

  if (validationStatus.type === "failed") {
    return 0.0;
  }

  // validationStatus.type === "passed"
  const { repairAttemptsUsed } = qualitySummary;
  if (repairAttemptsUsed === 0) {
    return 1.0;
  }

  return 1 / (1 + repairAttemptsUsed);
};
