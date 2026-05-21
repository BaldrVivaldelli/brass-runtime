// src/agent/core/errorRecovery/escalation.ts

import type { ErrorCategory, ErrorHistoryEntry } from "./types";

/**
 * Number of consecutive same-category errors that triggers strategy escalation.
 */
export const ESCALATION_THRESHOLD = 3;

/**
 * Count consecutive errors of the same category at the tail of the history.
 * Iterates from the end; stops on any entry with resolved: true or a different category.
 */
export const consecutiveCount = (
    entries: readonly ErrorHistoryEntry[],
    category: ErrorCategory
): number => {
    let count = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.resolved || entry.category !== category) {
            break;
        }
        count++;
    }
    return count;
};

/**
 * Determine if the escalation threshold has been reached for a category.
 */
export const shouldEscalate = (
    entries: readonly ErrorHistoryEntry[],
    category: ErrorCategory
): boolean => consecutiveCount(entries, category) >= ESCALATION_THRESHOLD;
