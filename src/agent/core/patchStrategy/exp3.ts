// src/agent/core/patchStrategy/exp3.ts

import type {
    PatchStrategy,
    EXP3State,
    EXP3Rng,
    RewardEntry,
} from "./types";
import { PATCH_STRATEGIES } from "./types";

/** Number of arms (strategies). */
const K = 3;

/**
 * Initialize EXP3 state with equal weights for all arms.
 * Default gamma is 0.3.
 */
export const initialEXP3State = (gamma: number = 0.3): EXP3State => ({
    algorithm: "exp3",
    arms: {
        "direct-patch": { weight: 1 },
        "multi-step-patch": { weight: 1 },
        "propose-then-refine": { weight: 1 },
    },
    gamma: Math.max(0, Math.min(1, gamma)) || 0.3,
    totalRounds: 0,
});

/**
 * Compute the mixed probability distribution:
 * p_i = (1 - gamma) * (w_i / sum(w)) + gamma / K
 *
 * Normalizes after mixing to handle floating-point drift.
 */
export const exp3Probabilities = (state: EXP3State): Record<PatchStrategy, number> => {
    const { arms, gamma } = state;

    // Compute weight sum
    let weightSum = 0;
    for (const arm of PATCH_STRATEGIES) {
        weightSum += arms[arm].weight;
    }

    // Compute mixed probabilities
    const probs: Record<string, number> = {};
    let probSum = 0;
    for (const arm of PATCH_STRATEGIES) {
        const p = (1 - gamma) * (arms[arm].weight / weightSum) + gamma / K;
        probs[arm] = p;
        probSum += p;
    }

    // Normalize to ensure sum = 1.0
    for (const arm of PATCH_STRATEGIES) {
        probs[arm] /= probSum;
    }

    return probs as Record<PatchStrategy, number>;
};

/**
 * Select an arm by sampling from the mixed probability distribution.
 * Uses cumulative probability walk with rng.random().
 */
export const exp3Select = (state: EXP3State, rng: EXP3Rng): PatchStrategy => {
    const probs = exp3Probabilities(state);
    const r = rng.random();

    let cumulative = 0;
    for (const arm of PATCH_STRATEGIES) {
        cumulative += probs[arm];
        if (r < cumulative) {
            return arm;
        }
    }

    // Fallback to last arm (handles floating-point edge case where r ≈ 1.0)
    return PATCH_STRATEGIES[PATCH_STRATEGIES.length - 1];
};

/**
 * Update the selected arm's weight using importance-weighted reward:
 * estimatedReward = reward / p_selected
 * w_selected *= exp(gamma * estimatedReward / K)
 *
 * Clamps weight to prevent overflow (max 1e100).
 * Increments totalRounds.
 */
export const exp3Update = (
    state: EXP3State,
    arm: PatchStrategy,
    reward: number,
): EXP3State => {
    const clampedReward = Math.max(0, Math.min(1, reward));
    const probs = exp3Probabilities(state);
    const pSelected = probs[arm];

    const estimatedReward = clampedReward / pSelected;
    const currentWeight = state.arms[arm].weight;
    const newWeight = Math.min(
        currentWeight * Math.exp((state.gamma * estimatedReward) / K),
        1e100,
    );

    return {
        ...state,
        arms: {
            ...state.arms,
            [arm]: { weight: newWeight },
        },
        totalRounds: state.totalRounds + 1,
    };
};

/**
 * Derive EXP3 state from a flat reward history.
 * Starts with initialEXP3State(gamma), then replays each entry.
 */
export const exp3StateFromHistory = (
    history: readonly RewardEntry[],
    gamma: number = 0.3,
): EXP3State => {
    let state = initialEXP3State(gamma);

    for (const entry of history) {
        state = exp3Update(state, entry.arm, entry.reward);
    }

    return state;
};
