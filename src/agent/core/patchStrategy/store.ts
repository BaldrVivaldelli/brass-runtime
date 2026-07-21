// src/agent/core/patchStrategy/store.ts

import type { AgentPersistence } from "../types";
import { readAgentState, writeAgentState } from "../persistence";
import type { RewardEntry, StoredRewardData } from "./types";

const STORE_KEY = "agent.patch-strategy.v1" as const;

export const parseRewardStore = (raw: string): readonly RewardEntry[] => {
    try {
        const data: unknown = JSON.parse(raw);
        if (
            typeof data !== "object" || data === null ||
            (data as Record<string, unknown>).version !== 1
        ) return [];
        const stored = data as StoredRewardData;
        return Array.isArray(stored.entries) ? stored.entries : [];
    } catch {
        return [];
    }
};

export const serializeRewardStore = (entries: readonly RewardEntry[]): string =>
    JSON.stringify({ version: 1, entries } satisfies StoredRewardData, null, 2);

/**
 * Load reward history from .brass/patch-strategy.json.
 * Returns empty array on missing file, parse error, or invalid schema.
 * Performs exactly one file read.
 */
export const loadRewardStore = (persistence?: AgentPersistence): Promise<readonly RewardEntry[]> =>
    readAgentState(persistence, STORE_KEY, parseRewardStore, () => []);

/**
 * Flush reward history to .brass/patch-strategy.json.
 * Writes StoredRewardData with version: 1.
 * On write failure, logs a warning and does not throw.
 */
export const flushRewardStore = async (
    persistence: AgentPersistence | undefined,
    entries: readonly RewardEntry[],
): Promise<void> => {
    try {
        await writeAgentState(persistence, STORE_KEY, serializeRewardStore(entries), { maxBytes: 262_144 });
    } catch (err: unknown) {
        console.warn(
            "[patchStrategy] Failed to flush reward store:",
            err instanceof Error ? err.message : String(err),
        );
    }
};
