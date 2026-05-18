// src/agent/core/patchStrategy/promptStrategy.ts

import type { PatchStrategy } from "./types";

/**
 * Returns strategy-specific instructions to inject into the planning prompt.
 * Each strategy produces a distinct non-empty string.
 */
export const strategyPromptFragment = (strategy: PatchStrategy): string => {
    switch (strategy) {
        case "direct-patch":
            return "Produce a single focused patch in one response. Do not plan multiple steps. Emit one unified diff that addresses the goal directly.";
        case "multi-step-patch":
            return "You may produce multiple incremental patches across responses. Start with the most critical change, then refine iteratively based on validation feedback.";
        case "propose-then-refine":
            return "First propose a plan describing what changes are needed and why. Do NOT include a patch in this response. After validation feedback, produce the refined patch in a follow-up.";
    }
};
