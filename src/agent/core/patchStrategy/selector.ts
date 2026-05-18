// src/agent/core/patchStrategy/selector.ts

import type {
    PatchStrategy,
    PatchStrategyConfig,
    GoalSignals,
    RewardEntry,
    StrategyRng,
} from "./types";
import { DEFAULT_STRATEGY } from "./types";
import { thompsonStateFromHistory, thompsonSelect } from "./thompson";
import { exp3StateFromHistory, exp3Select } from "./exp3";

/**
 * Pure function: selects a patch strategy given signals, config, history, and RNG.
 * Does not mutate any input. Returns one of the three valid PatchStrategy values.
 *
 * When history is empty or config.enabled is false, returns DEFAULT_STRATEGY.
 */
export const selectStrategy = (
    _signals: GoalSignals,
    config: PatchStrategyConfig | undefined,
    history: readonly RewardEntry[],
    rng: StrategyRng,
): PatchStrategy => {
    // Disabled → default
    if (config?.enabled === false) {
        return DEFAULT_STRATEGY;
    }

    // Empty history → default (graceful degradation)
    if (history.length === 0) {
        return DEFAULT_STRATEGY;
    }

    // Determine algorithm (default: "thompson")
    const algorithm = config?.algorithm ?? "thompson";

    switch (algorithm) {
        case "thompson": {
            const state = thompsonStateFromHistory(history);
            return thompsonSelect(state, rng);
        }
        case "exp3": {
            // Clamp gamma to (0, 1], default 0.3
            const rawGamma = config?.gamma ?? 0.3;
            const gamma = Math.max(Number.EPSILON, Math.min(1, rawGamma)) || 0.3;
            const state = exp3StateFromHistory(history, gamma);
            return exp3Select(state, rng);
        }
        default: {
            // Unknown algorithm → fall back to thompson
            const state = thompsonStateFromHistory(history);
            return thompsonSelect(state, rng);
        }
    }
};
