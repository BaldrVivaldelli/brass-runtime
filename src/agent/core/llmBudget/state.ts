import type { BudgetConfig, BudgetState, BudgetStatus, TokenUsage, ModelTier } from "./types";

/**
 * Creates the initial zero-state for budget tracking.
 */
export const initBudgetState = (): BudgetState => ({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    callCount: 0,
    calls: [],
});

/**
 * Returns a new BudgetState with the given usage added to cumulative totals.
 * Does not mutate the input state.
 */
export const updateBudgetState = (
    state: BudgetState,
    usage: TokenUsage,
    tier: ModelTier,
    confidence: number,
    estimated: boolean,
): BudgetState => {
    const totalInputTokens = state.totalInputTokens + usage.inputTokens;
    const totalOutputTokens = state.totalOutputTokens + usage.outputTokens;
    return {
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        callCount: state.callCount + 1,
        calls: [
            ...state.calls,
            { usage, tier, confidence, estimated },
        ],
    };
};

/**
 * Classifies the current budget status based on totals vs config limits.
 *
 * Zones:
 * - "under": totalTokens <= tokenBudget
 * - "warning": totalTokens > tokenBudget AND totalTokens <= tokenBudget * (1 + overshootFraction)
 * - "exceeded": totalTokens > tokenBudget * (1 + overshootFraction)
 */
export const budgetStatus = (state: BudgetState, config: BudgetConfig): BudgetStatus => {
    const { totalTokens } = state;
    const { tokenBudget, overshootFraction } = config;
    const hardCap = tokenBudget * (1 + overshootFraction);

    if (totalTokens <= tokenBudget) {
        return { type: "under" };
    }

    if (totalTokens <= hardCap) {
        return { type: "warning", overage: totalTokens - tokenBudget };
    }

    return { type: "exceeded", overage: totalTokens - tokenBudget };
};

/**
 * Returns true if the budget allows another LLM call (status is not "exceeded").
 */
export const budgetAllowsCall = (state: BudgetState, config: BudgetConfig): boolean => {
    return budgetStatus(state, config).type !== "exceeded";
};
