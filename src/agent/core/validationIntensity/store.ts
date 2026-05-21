// src/agent/core/validationIntensity/store.ts

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ValidationHistory } from "./types";

const STORE_PATH = ".brass/validation-history.json";

/** Empty history used as the default/fallback. */
export const emptyHistory = (): ValidationHistory => ({
    version: 1,
    commands: {},
});

/**
 * Load validation history from .brass/validation-history.json.
 * Returns empty history on missing file, parse error, or invalid schema.
 * Performs exactly one file read.
 */
export const loadValidationHistory = async (cwd: string): Promise<ValidationHistory> => {
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
            return emptyHistory();
        }

        const stored = data as ValidationHistory;

        if (typeof stored.commands !== "object" || stored.commands === null) {
            return emptyHistory();
        }

        return stored;
    } catch {
        // ENOENT, parse error, or other → return empty
        return emptyHistory();
    }
};

/**
 * Flush validation history to .brass/validation-history.json.
 * Creates .brass/ directory if needed.
 * On write failure, logs a warning and does not throw.
 * Performs exactly one file write.
 */
export const flushValidationHistory = async (
    cwd: string,
    history: ValidationHistory,
): Promise<void> => {
    try {
        const filePath = join(cwd, STORE_PATH);

        // Ensure directory exists
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(history, null, 2), "utf-8");
    } catch (err: unknown) {
        console.warn(
            "[validationIntensity] Failed to flush validation history:",
            err instanceof Error ? err.message : String(err),
        );
    }
};
