// src/agent/core/errorRecovery/store.ts

import type { AgentPersistence } from "../types";
import { readAgentState, writeAgentState } from "../persistence";
import type { ErrorHistoryEntry, StoredErrorPatterns } from "./types";

const STORE_KEY = "agent.error-patterns.v1" as const;

/**
 * Load error patterns from .brass/error-patterns.json.
 * Returns empty array on missing file, parse error, or invalid schema.
 * Logs a warning only on permission denied errors.
 */
export const loadErrorPatterns = (persistence?: AgentPersistence): Promise<readonly ErrorHistoryEntry[]> =>
    readAgentState(persistence, STORE_KEY, parseErrorPatterns, () => []);

/**
 * Flush error patterns to .brass/error-patterns.json.
 * Writes StoredErrorPatterns with version: 1.
 * On write failure, logs a warning and does not throw.
 */
export const flushErrorPatterns = async (
    persistence: AgentPersistence | undefined,
    entries: readonly ErrorHistoryEntry[],
): Promise<void> => {
    try {
        await writeAgentState(persistence, STORE_KEY, serializeErrorPatterns(entries), { maxBytes: 262_144 });
    } catch (err: unknown) {
        console.warn(
            "[errorRecovery] Failed to flush error patterns:",
            err instanceof Error ? err.message : String(err),
        );
    }
};

export const parseErrorPatterns = (json: string): readonly ErrorHistoryEntry[] => {
    try {
        const data: unknown = JSON.parse(json);
        if (
            typeof data !== "object" ||
            data === null ||
            !("version" in data) ||
            (data as Record<string, unknown>).version !== 1
        ) {
            return [];
        }
        const stored = data as StoredErrorPatterns;
        return Array.isArray(stored.entries) ? stored.entries : [];
    } catch {
        return [];
    }
};

export const serializeErrorPatterns = (entries: readonly ErrorHistoryEntry[]): string =>
    JSON.stringify({ version: 1, entries } satisfies StoredErrorPatterns, null, 2);
