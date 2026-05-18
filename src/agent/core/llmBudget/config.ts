import type { BudgetConfig, BudgetConfigInput } from "./types";

/**
 * Default values applied when fields are absent from both goal and config inputs.
 */
const DEFAULTS = {
    overshootFraction: 0.10,
    enabled: true,
} as const;

/**
 * Merges AgentGoal budget (overrides) with AgentConfig budget (defaults).
 * Returns undefined when neither source provides a `tokenBudget`.
 *
 * Resolution order: goalBudget fields > configBudget fields > hardcoded defaults.
 */
export const resolveBudgetConfig = (
    goalBudget: BudgetConfigInput | undefined,
    configBudget: BudgetConfigInput | undefined,
): BudgetConfig | undefined => {
    // When neither source provides any budget input, return undefined
    if (goalBudget === undefined && configBudget === undefined) {
        return undefined;
    }

    // Merge: goal overrides config, config overrides defaults
    const merged: BudgetConfigInput = {
        ...configBudget,
        ...goalBudget,
    };

    // If no tokenBudget is present after merging, budget is not actionable
    if (merged.tokenBudget === undefined) {
        return undefined;
    }

    return {
        tokenBudget: merged.tokenBudget,
        overshootFraction: merged.overshootFraction ?? DEFAULTS.overshootFraction,
        enabled: merged.enabled ?? DEFAULTS.enabled,
        modelTiers: merged.modelTiers,
    };
};

/**
 * Validates a resolved BudgetConfig. Returns a descriptive error string
 * if invalid, or undefined if valid.
 */
export const validateBudgetConfig = (config: BudgetConfig): string | undefined => {
    // tokenBudget must be a positive finite number
    if (!Number.isFinite(config.tokenBudget) || config.tokenBudget <= 0) {
        return `tokenBudget must be a positive finite number, got ${config.tokenBudget}`;
    }

    // overshootFraction must be in [0, 1]
    if (
        !Number.isFinite(config.overshootFraction) ||
        config.overshootFraction < 0 ||
        config.overshootFraction > 1
    ) {
        return `overshootFraction must be between 0 and 1 inclusive, got ${config.overshootFraction}`;
    }

    return undefined;
};
