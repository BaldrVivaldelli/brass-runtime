// src/agent/core/patchStrategy/thompson.ts

import type {
    PatchStrategy,
    ThompsonState,
    ThompsonArmState,
    ThompsonRng,
    RewardEntry,
} from "./types";
import { PATCH_STRATEGIES } from "./types";

/**
 * Initialize Thompson state with uniform priors (alpha=1, beta=1) for all arms.
 */
export const initialThompsonState = (): ThompsonState => ({
    algorithm: "thompson",
    arms: {
        "direct-patch": { alpha: 1, beta: 1 },
        "multi-step-patch": { alpha: 1, beta: 1 },
        "propose-then-refine": { alpha: 1, beta: 1 },
    },
});

/**
 * Select an arm by sampling from each arm's Beta distribution
 * and returning the arm with the highest sample.
 */
export const thompsonSelect = (state: ThompsonState, rng: ThompsonRng): PatchStrategy => {
    let bestArm: PatchStrategy = PATCH_STRATEGIES[0];
    let bestSample = -Infinity;

    for (const arm of PATCH_STRATEGIES) {
        const { alpha, beta } = state.arms[arm];
        const sample = rng.sampleBeta(alpha, beta);
        if (sample > bestSample) {
            bestSample = sample;
            bestArm = arm;
        }
    }

    return bestArm;
};

/**
 * Update the selected arm's parameters after observing a reward.
 * alpha += reward, beta += (1 - reward)
 * Ensures alpha >= 1 and beta >= 1 invariant at all times.
 */
export const thompsonUpdate = (
    state: ThompsonState,
    arm: PatchStrategy,
    reward: number,
): ThompsonState => {
    const clampedReward = Math.max(0, Math.min(1, reward));
    const current = state.arms[arm];
    const newAlpha = Math.max(1, current.alpha + clampedReward);
    const newBeta = Math.max(1, current.beta + (1 - clampedReward));

    return {
        ...state,
        arms: {
            ...state.arms,
            [arm]: { alpha: newAlpha, beta: newBeta },
        },
    };
};

/**
 * Derive Thompson state from a flat reward history.
 * Starts with initialThompsonState(), then for each entry, updates the corresponding arm.
 */
export const thompsonStateFromHistory = (
    history: readonly RewardEntry[],
): ThompsonState => {
    let state = initialThompsonState();

    for (const entry of history) {
        state = thompsonUpdate(state, entry.arm, entry.reward);
    }

    return state;
};
