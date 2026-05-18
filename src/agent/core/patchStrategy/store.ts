// src/agent/core/patchStrategy/store.ts

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { RewardEntry, StoredRewardData } from "./types";

const STORE_PATH = ".brass/patch-strategy.json";

/**
 * Load reward history from .brass/patch-strategy.json.
 * Returns empty array on missing file, parse error, or invalid schema.
 * Performs exactly one file read.
 */
export const loadRewardStore = async (cwd: string): Promise<readonly RewardEntry[]> => {
    try {
        const filePath = join(cwd, STORE_PATH);
        const raw = await readFile(filePath, "utf-8");
        const data: unknown = JSON.parse(raw);

        // Validate schema version
        if (
            typeof data !== "object" ||
            data === null ||
            !("version" in data) ||
            (data as Record<string, unknown>).version !== 1
        ) {
            return [];
        }

        const stored = data as StoredRewardData;

        if (!Array.isArray(stored.entries)) {
            return [];
        }

        return stored.entries;
    } catch (err: unknown) {
        // ENOENT or parse error → return empty
        return [];
    }
};

/**
 * Flush reward history to .brass/patch-strategy.json.
 * Writes StoredRewardData with version: 1.
 * On write failure, logs a warning and does not throw.
 */
export const flushRewardStore = async (
    cwd: string,
    entries: readonly RewardEntry[],
): Promise<void> => {
    try {
        const filePath = join(cwd, STORE_PATH);
        const data: StoredRewardData = {
            version: 1,
            entries,
        };

        // Ensure directory exists
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err: unknown) {
        console.warn(
            "[patchStrategy] Failed to flush reward store:",
            err instanceof Error ? err.message : String(err),
        );
    }
};
