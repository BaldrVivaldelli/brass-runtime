import type { AgentState } from "../types";
import type { BudgetState, ComplexitySignals, ModelTier } from "./types";

export type ComplexityThresholds = {
    readonly goalLength: number;
    readonly filesRead: number;
    readonly searchMatches: number;
    readonly repairAttempts: number;
};

const DEFAULT_THRESHOLDS: ComplexityThresholds = {
    goalLength: 500,
    filesRead: 5,
    searchMatches: 30,
    repairAttempts: 1,
};

/**
 * Extracts complexity signals from the current agent state for event reporting.
 *
 * - goalLength: length of the goal text
 * - filesRead: count of fs.fileRead observations
 * - searchMatches: sum of all match counts across fs.searchResult observations
 * - hasValidationErrors: whether any shell.result observations have non-zero exit codes
 * - repairAttempts: count of llm.response observations with purpose "patch"
 */
export const extractComplexitySignals = (state: AgentState): ComplexitySignals => {
    const observations = state.observations;

    const goalLength = state.goal.text.length;

    let filesRead = 0;
    let searchMatches = 0;
    let hasValidationErrors = false;
    let repairAttempts = 0;

    for (const obs of observations) {
        switch (obs.type) {
            case "fs.fileRead":
                filesRead++;
                break;
            case "fs.searchResult":
                searchMatches += obs.matches.length;
                break;
            case "shell.result":
                if (obs.exitCode !== 0) {
                    hasValidationErrors = true;
                }
                break;
            case "llm.response":
                if (obs.purpose === "patch") {
                    repairAttempts++;
                }
                break;
        }
    }

    return {
        goalLength,
        filesRead,
        searchMatches,
        hasValidationErrors,
        repairAttempts,
    };
};

/**
 * Pure function that selects a model tier based on pre-call complexity signals.
 * Returns "small" when all signals are below thresholds, "large" otherwise.
 *
 * A signal exceeds its threshold when:
 * - goalLength >= thresholds.goalLength
 * - filesRead >= thresholds.filesRead
 * - searchMatches >= thresholds.searchMatches
 * - hasValidationErrors is true (any validation error present)
 * - repairAttempts >= thresholds.repairAttempts
 */
export const routeModel = (
    state: AgentState,
    _budgetState: BudgetState,
    thresholds?: ComplexityThresholds,
): ModelTier => {
    const t = thresholds ?? DEFAULT_THRESHOLDS;
    const signals = extractComplexitySignals(state);

    if (
        signals.goalLength >= t.goalLength ||
        signals.filesRead >= t.filesRead ||
        signals.searchMatches >= t.searchMatches ||
        signals.hasValidationErrors ||
        signals.repairAttempts >= t.repairAttempts
    ) {
        return "large";
    }

    return "small";
};
