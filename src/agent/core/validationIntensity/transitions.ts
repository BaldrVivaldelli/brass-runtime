// src/agent/core/validationIntensity/transitions.ts

import type { IntensityLevel, TransitionInput, TransitionOutput, CommandStats, StatsUpdateInput } from "./types";
import { FULL_TO_REDUCED_THRESHOLD, REDUCED_TO_SKIP_THRESHOLD } from "./types";

/**
 * Compute the next intensity level and consecutive pass count.
 * Pure function — no side effects.
 *
 * Rules:
 * - Any failure → "full", passCount = 0
 * - "full" + 3 consecutive passes → "reduced"
 * - "reduced" + 6 consecutive passes → "skip"
 * - Otherwise: same level, passCount + 1
 */
export const computeNextIntensity = (input: TransitionInput): TransitionOutput => {
    if (input.outcome === "fail") {
        return { nextLevel: "full", consecutivePassCount: 0 };
    }

    const newPassCount = input.consecutivePassCount + 1;

    switch (input.currentLevel) {
        case "full":
            if (newPassCount >= FULL_TO_REDUCED_THRESHOLD) {
                return { nextLevel: "reduced", consecutivePassCount: 0 };
            }
            return { nextLevel: "full", consecutivePassCount: newPassCount };

        case "reduced":
            if (newPassCount >= REDUCED_TO_SKIP_THRESHOLD) {
                return { nextLevel: "skip", consecutivePassCount: 0 };
            }
            return { nextLevel: "reduced", consecutivePassCount: newPassCount };

        case "skip":
            return { nextLevel: "skip", consecutivePassCount: newPassCount };
    }
};

/**
 * Update command stats after a validation run completes.
 * Pure function — returns new stats record.
 *
 * - Always increments totalRuns
 * - Increments failures if exitCode is non-zero
 * - Updates avgTimeToFailureMs with rolling average on failure
 */
export const updateCommandStats = (input: StatsUpdateInput): CommandStats => {
    const { current, exitCode, durationMs } = input;
    const totalRuns = current.totalRuns + 1;

    if (exitCode === 0) {
        return { ...current, totalRuns };
    }

    const failures = current.failures + 1;
    // Rolling average: ((old_avg * old_failures) + new_duration) / new_failures
    const avgTimeToFailureMs =
        (current.avgTimeToFailureMs * current.failures + durationMs) / failures;

    return { totalRuns, failures, avgTimeToFailureMs };
};

/**
 * Initial intensity state for the start of an agent run.
 */
export const initialIntensityState = (): { level: IntensityLevel; consecutivePassCount: number } => ({
    level: "full",
    consecutivePassCount: 0,
});
