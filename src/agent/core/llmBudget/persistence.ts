// src/agent/core/llmBudget/persistence.ts — Learning store persistence

import type { ModelTier } from "./types";

export type LearningRunRecord = {
    readonly goalId: string;
    readonly totalTokens: number;
    readonly callCount: number;
    readonly tier: ModelTier;
    readonly confidence: number;
    readonly timestamp: number;
};

export type LearningStore = {
    readonly records: readonly LearningRunRecord[];
};

const isValidRecord = (r: unknown): r is LearningRunRecord => {
    if (r === null || typeof r !== "object") return false;
    const rec = r as Record<string, unknown>;
    return (
        typeof rec.goalId === "string" &&
        typeof rec.totalTokens === "number" &&
        typeof rec.callCount === "number" &&
        (rec.tier === "small" || rec.tier === "large") &&
        typeof rec.confidence === "number" &&
        typeof rec.timestamp === "number"
    );
};

/**
 * Parses the learning store from a JSON string. Returns empty store
 * if the string is invalid JSON or has unexpected shape.
 */
export const parseLearningStore = (json: string): LearningStore => {
    try {
        const parsed = JSON.parse(json);
        if (parsed === null || typeof parsed !== "object") {
            return { records: [] };
        }
        if (!Array.isArray(parsed.records)) {
            return { records: [] };
        }
        const validRecords = parsed.records.filter(isValidRecord);
        return { records: validRecords };
    } catch {
        return { records: [] };
    }
};

/**
 * Appends a run record to the store, preserving existing history.
 * Trims oldest records (from the front) when exceeding maxRecords.
 */
export const appendRunRecord = (
    store: LearningStore,
    record: LearningRunRecord,
    maxRecords: number = 100,
): LearningStore => {
    const updated = [...store.records, record];
    if (updated.length > maxRecords) {
        return { records: updated.slice(updated.length - maxRecords) };
    }
    return { records: updated };
};

/**
 * Serializes the learning store to a JSON string.
 */
export const serializeLearningStore = (store: LearningStore): string =>
    JSON.stringify(store, null, 2);
