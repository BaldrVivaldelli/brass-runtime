// src/agent/core/approvalLearning/store.ts

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ApprovalHistory, ApprovalObservation, ActionTypeHistory } from "./types";
import { emptyApprovalHistory } from "./types";

/** Path relative to cwd where approval history is stored. */
export const APPROVAL_HISTORY_PATH = ".brass/approval-history.json";

/** Abstract store interface for dependency injection. */
export type HistoryStore = {
  readonly load: () => Promise<ApprovalHistory>;
  readonly save: (history: ApprovalHistory) => Promise<void>;
};

// --- Validation helpers ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidObservation = (value: unknown): value is ApprovalObservation => {
  if (!isRecord(value)) return false;
  return typeof value.approved === "boolean" && typeof value.timestamp === "number";
};

const isValidActionTypeHistory = (value: unknown): value is ActionTypeHistory => {
  if (!isRecord(value)) return false;
  if (typeof value.actionType !== "string") return false;
  if (!Array.isArray(value.observations)) return false;
  return value.observations.every(isValidObservation);
};

const isValidApprovalHistory = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isRecord(value.actions)) return false;
  for (const entry of Object.values(value.actions)) {
    if (!isValidActionTypeHistory(entry)) return false;
  }
  return true;
};

/**
 * Pure parser: validates and parses a JSON string into ApprovalHistory.
 * Returns empty history for any invalid input. Never throws.
 */
export const parseApprovalHistory = (json: string): ApprovalHistory => {
  try {
    const parsed = JSON.parse(json);
    if (!isValidApprovalHistory(parsed)) return emptyApprovalHistory();
    return parsed as ApprovalHistory;
  } catch {
    return emptyApprovalHistory();
  }
};

/**
 * Pure serializer: converts ApprovalHistory to a formatted JSON string.
 */
export const serializeApprovalHistory = (history: ApprovalHistory): string =>
  JSON.stringify(history, null, 2);

/**
 * File-based HistoryStore implementation.
 * Gracefully degrades: load returns empty on failure, save logs warning on failure.
 */
export const makeFileHistoryStore = (cwd: string): HistoryStore => ({
  load: async (): Promise<ApprovalHistory> => {
    try {
      const path = join(cwd, APPROVAL_HISTORY_PATH);
      const content = await readFile(path, "utf-8");
      return parseApprovalHistory(content);
    } catch {
      return emptyApprovalHistory();
    }
  },
  save: async (history: ApprovalHistory): Promise<void> => {
    try {
      const path = join(cwd, APPROVAL_HISTORY_PATH);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, serializeApprovalHistory(history), "utf-8");
    } catch (err: unknown) {
      console.warn(
        "[approvalLearning] Failed to persist history:",
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

/**
 * In-memory HistoryStore for testing.
 * Provides a `getState()` accessor to inspect current state.
 */
export const makeInMemoryHistoryStore = (
  initial: ApprovalHistory = emptyApprovalHistory(),
): HistoryStore & { readonly getState: () => ApprovalHistory } => {
  let state = initial;
  return {
    load: async () => state,
    save: async (history: ApprovalHistory) => { state = history; },
    getState: () => state,
  };
};

// --- Pure history mutation helpers ---

/**
 * Add an observation to the history for a given action type,
 * enforcing the observation window size.
 *
 * 1. Get existing observations for the action type (or empty array)
 * 2. Append the new observation
 * 3. If length > windowSize, trim from the front (oldest first)
 * 4. Return new ApprovalHistory with updated action type entry
 */
export const addObservation = (
  history: ApprovalHistory,
  actionType: string,
  observation: ApprovalObservation,
  windowSize: number,
): ApprovalHistory => {
  const existing = Object.hasOwn(history.actions, actionType)
    ? history.actions[actionType]
    : undefined;
  const observations = existing ? [...existing.observations, observation] : [observation];
  const trimmed = observations.length > windowSize
    ? observations.slice(observations.length - windowSize)
    : observations;

  return {
    ...history,
    actions: {
      ...history.actions,
      [actionType]: { actionType: actionType as any, observations: trimmed },
    },
  };
};
