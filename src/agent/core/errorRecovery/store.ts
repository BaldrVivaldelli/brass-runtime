// src/agent/core/errorRecovery/store.ts

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ErrorHistoryEntry, StoredErrorPatterns } from "./types";

const STORE_PATH = ".brass/error-patterns.json";

/**
 * Load error patterns from .brass/error-patterns.json.
 * Returns empty array on missing file, parse error, or invalid schema.
 * Logs a warning only on permission denied errors.
 */
export const loadErrorPatterns = async (cwd: string): Promise<readonly ErrorHistoryEntry[]> => {
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

        const stored = data as StoredErrorPatterns;

        if (!Array.isArray(stored.entries)) {
            return [];
        }

        return stored.entries;
    } catch (err: unknown) {
        // Permission denied → log warning
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EACCES") {
            console.warn(
                "[errorRecovery] Permission denied reading error patterns:",
                err.message,
            );
        }
        // ENOENT, parse error, or other → return empty silently
        return [];
    }
};

/**
 * Flush error patterns to .brass/error-patterns.json.
 * Writes StoredErrorPatterns with version: 1.
 * On write failure, logs a warning and does not throw.
 */
export const flushErrorPatterns = async (
    cwd: string,
    entries: readonly ErrorHistoryEntry[],
): Promise<void> => {
    try {
        const filePath = join(cwd, STORE_PATH);
        const data: StoredErrorPatterns = {
            version: 1,
            entries,
        };

        // Ensure directory exists
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err: unknown) {
        console.warn(
            "[errorRecovery] Failed to flush error patterns:",
            err instanceof Error ? err.message : String(err),
        );
    }
};
