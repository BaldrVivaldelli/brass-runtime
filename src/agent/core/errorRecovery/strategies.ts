// src/agent/core/errorRecovery/strategies.ts

import type { CategorizedError, ErrorHistory, RecoveryAction, RecoveryState } from "./types";
import { shouldEscalate } from "./escalation";

/**
 * Base timeout for exponential backoff calculation (milliseconds).
 */
export const BASE_TIMEOUT_MS = 1000;

/**
 * Fixed wait duration for LLM rate-limit errors (milliseconds).
 */
export const RATE_LIMIT_WAIT_MS = 30_000;

/**
 * Calculate exponential backoff duration for LLM timeout errors.
 * Formula: 1000 * 2^(consecutiveCount - 1)
 */
export const calculateBackoff = (consecutiveCount: number): number =>
    BASE_TIMEOUT_MS * Math.pow(2, consecutiveCount - 1);

/**
 * Refined prompt messages for PatchError retry, keyed by subcategory.
 */
const PATCH_RETRY_PROMPTS: Record<string, string> = {
    parse: "The previous patch had a parse error. Please generate a syntactically valid unified diff.",
    apply: "The previous patch failed to apply. Please regenerate the patch against the current file state.",
    conflict: "The previous patch had merge conflicts. Please resolve conflicts and regenerate.",
};

/**
 * Pure function that determines the recovery action for a given error.
 * No side effects, no I/O, deterministic output.
 *
 * Decision priority order:
 * 1. FsError → always terminate
 * 2. ShellError → always skip
 * 3. Escalation threshold reached for PatchError → escalate to propose mode
 * 4. Escalation threshold reached for LLMError → terminate
 * 5. PatchError with remaining budget → retry with refined prompt
 * 6. PatchError with exhausted budget → terminate
 * 7. LLMError.timeout → wait with exponential backoff
 * 8. LLMError.rate-limit → wait 30000ms
 * 9. unknown → terminate
 */
export const decideRecoveryAction = (
    error: CategorizedError,
    state: RecoveryState,
    history: ErrorHistory,
): RecoveryAction => {
    // 1. FsError → always terminate
    if (error.category === "FsError") {
        return {
            type: "terminate",
            summary: "Filesystem error encountered — terminating to prevent corrupted state.",
        };
    }

    // 2. ShellError → always skip
    if (error.category === "ShellError") {
        return {
            type: "skip",
            reason: "Shell command failed — skipping and continuing execution.",
        };
    }

    // 3. Escalation threshold reached for PatchError → escalate to propose mode
    if (error.category === "PatchError" && shouldEscalate(history.entries, "PatchError")) {
        return {
            type: "escalate",
            targetMode: "propose",
            reason: "Repeated patch failures — escalating to propose mode for manual review.",
        };
    }

    // 4. Escalation threshold reached for LLMError → terminate
    if (error.category === "LLMError" && shouldEscalate(history.entries, "LLMError")) {
        return {
            type: "terminate",
            summary: "Repeated LLM failures — terminating after reaching escalation threshold.",
        };
    }

    // 5. PatchError with remaining budget → retry with refined prompt
    if (error.category === "PatchError" && state.repairBudgetRemaining > 0) {
        const subcategory = error.subcategory;
        const prompt = PATCH_RETRY_PROMPTS[subcategory] ?? PATCH_RETRY_PROMPTS.apply;
        return {
            type: "retry",
            prompt,
            errorContext: subcategory,
        };
    }

    // 6. PatchError with exhausted budget → terminate
    if (error.category === "PatchError") {
        return {
            type: "terminate",
            summary: "Patch repair budget exhausted — terminating.",
        };
    }

    // 7. LLMError.timeout → wait with exponential backoff
    if (error.category === "LLMError" && error.subcategory === "timeout") {
        const count = state.consecutiveCount > 0 ? state.consecutiveCount : 1;
        return {
            type: "wait",
            durationMs: calculateBackoff(count),
            reason: `LLM timeout — waiting ${calculateBackoff(count)}ms before retry (attempt ${count}).`,
        };
    }

    // 8. LLMError.rate-limit → wait 30000ms
    if (error.category === "LLMError" && error.subcategory === "rate-limit") {
        return {
            type: "wait",
            durationMs: RATE_LIMIT_WAIT_MS,
            reason: "LLM rate-limited — waiting 30s before retry.",
        };
    }

    // 9. unknown → terminate
    return {
        type: "terminate",
        summary: "Unknown error category — terminating.",
    };
};
