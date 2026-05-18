import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import type { BanditState, ArmStats, AttributionLogEntry } from "./types";
import { emptyBanditState } from "./types";

/** Path relative to cwd where bandit state is stored. */
export const BANDIT_STATE_PATH = ".brass/context-budget.json";

/**
 * Pure parser: validates and parses a JSON string into BanditState.
 * Returns empty state for any invalid input. Never throws.
 */
export const parseBanditState = (json: string): BanditState => {
    try {
        const parsed = JSON.parse(json);
        if (!isValidBanditState(parsed)) return emptyBanditState();
        return parsed as BanditState;
    } catch {
        return emptyBanditState();
    }
};

/**
 * Pure serializer: converts BanditState to a formatted JSON string.
 */
export const serializeBanditState = (state: BanditState): string =>
    JSON.stringify(state, null, 2);

/**
 * Reads and parses BanditState from disk.
 * Returns empty state if file is missing or contains invalid JSON.
 * Never throws — always returns a valid BanditState.
 */
export const readBanditState = async (cwd: string): Promise<BanditState> => {
    try {
        const path = join(cwd, BANDIT_STATE_PATH);
        const content = await readFile(path, "utf8");
        return parseBanditState(content);
    } catch {
        return emptyBanditState();
    }
};

/**
 * Serializes and writes BanditState to disk.
 * Creates .brass/ directory if it doesn't exist.
 */
export const writeBanditState = async (cwd: string, state: BanditState): Promise<void> => {
    const path = join(cwd, BANDIT_STATE_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeBanditState(state), "utf8");
};

// --- Validation helpers ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isValidArmStats = (value: unknown): value is ArmStats => {
    if (!isRecord(value)) return false;
    return (
        typeof value.alpha === "number" &&
        typeof value.beta === "number" &&
        typeof value.pulls === "number" &&
        typeof value.lastPulledAt === "number"
    );
};

const isValidLogEntry = (value: unknown): value is AttributionLogEntry => {
    if (!isRecord(value)) return false;
    if (typeof value.timestamp !== "number") return false;
    if (!Array.isArray(value.pulledArms)) return false;
    if (!value.pulledArms.every((a: unknown) => typeof a === "string")) return false;
    if (!isRecord(value.filesPerArm)) return false;
    if (typeof value.reward !== "number") return false;
    return true;
};

const isValidBanditState = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (value.version !== 1) return false;
    if (!isRecord(value.arms)) return false;
    for (const stats of Object.values(value.arms)) {
        if (!isValidArmStats(stats)) return false;
    }
    if (!Array.isArray(value.log)) return false;
    for (const entry of value.log) {
        if (!isValidLogEntry(entry)) return false;
    }
    return true;
};
