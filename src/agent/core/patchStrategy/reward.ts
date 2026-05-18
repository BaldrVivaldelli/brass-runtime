// src/agent/core/patchStrategy/reward.ts

import type { AgentState } from "../types";
import { patchQualitySummary, patchValidationStatus } from "../patchQuality";
import { discoverValidationCommands } from "../projectCommands";

/**
 * Helper to get observations after the last patch was applied.
 * Mirrors the logic in decide.ts.
 */
const observationsAfterPatch = (state: AgentState): readonly AgentState["observations"][number][] => {
    const patchIndex = [...state.observations]
        .map((obs) => obs.type)
        .lastIndexOf("patch.applied");
    return patchIndex < 0 ? [] : state.observations.slice(patchIndex + 1);
};

/**
 * Determine whether a patch was produced during the agent run.
 * A patch is considered produced if there is at least one "patch.applied" observation.
 */
const hasPatchProduced = (state: AgentState): boolean =>
    state.observations.some((obs) => obs.type === "patch.applied");

/**
 * Compute the reward signal from the final agent state.
 *
 * - All validations pass → 1.0
 * - Validation failed, repair succeeded → 1 - (repairAttempts / maxRepairAttempts) clamped to (0, 1)
 * - Patch failed to apply or validation failed with no repair → 0.0
 * - No patch produced → 0.0
 *
 * Output is always clamped to [0, 1].
 */
export const computeReward = (state: AgentState): number => {
    // No patch produced → 0.0
    if (!hasPatchProduced(state)) {
        return 0.0;
    }

    const commands = discoverValidationCommands(state).validationCommands;
    const status = patchValidationStatus(commands, observationsAfterPatch(state));
    const quality = patchQualitySummary(state);

    // If validation was not run (no commands), treat as passed
    if (status.type === "not-run") {
        return 1.0;
    }

    // Validation still pending — treat as incomplete, no reward
    if (status.type === "pending") {
        return 0.0;
    }

    // All validations pass → 1.0
    if (status.type === "passed") {
        // If repairs were used, reward is reduced
        if (quality.repairAttemptsUsed > 0 && quality.maxRepairAttempts > 0) {
            const reward = 1 - (quality.repairAttemptsUsed / quality.maxRepairAttempts);
            return Math.max(0, Math.min(1, reward));
        }
        return 1.0;
    }

    // Validation failed with no repair remaining → 0.0
    // (status.type === "failed")
    return 0.0;
};
