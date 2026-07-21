// src/agent/core/workspaceMemory/store.ts

import type { AgentPersistence } from "../types";
import { readAgentState, writeAgentState } from "../persistence";
import type {
  WorkspaceMemory,
  FileChangeEntry,
  CommandFailureEntry,
  GoalPatternEntry,
  CoChangeClusterEntry,
} from "./types";
import { emptyWorkspaceMemory } from "./types";

/** Path relative to cwd where workspace memory is stored. */
export const WORKSPACE_MEMORY_PATH = ".brass/workspace-memory.json";

// --- Validation helpers ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidMemoryEntryBase = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return typeof value.key === "string" && typeof value.updatedAt === "number";
};

const isValidFileChangeEntry = (value: unknown): value is FileChangeEntry => {
  if (!isValidMemoryEntryBase(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.count === "number";
};

const isValidCommandFailureEntry = (value: unknown): value is CommandFailureEntry => {
  if (!isValidMemoryEntryBase(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.successes === "number" && typeof v.failures === "number";
};

const isValidGoalPatternEntry = (value: unknown): value is GoalPatternEntry => {
  if (!isValidMemoryEntryBase(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pattern === "string" &&
    typeof v.successes === "number" &&
    typeof v.failures === "number"
  );
};

const isValidCoChangeClusterEntry = (value: unknown): value is CoChangeClusterEntry => {
  if (!isValidMemoryEntryBase(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.files) &&
    v.files.every((f: unknown) => typeof f === "string") &&
    typeof v.occurrences === "number"
  );
};

const isValidWorkspaceMemory = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.fileChangeFrequency)) return false;
  if (!Array.isArray(value.commandFailureRate)) return false;
  if (!Array.isArray(value.goalPatternSuccessRate)) return false;
  if (!Array.isArray(value.coChangeClusters)) return false;
  if (!value.fileChangeFrequency.every(isValidFileChangeEntry)) return false;
  if (!value.commandFailureRate.every(isValidCommandFailureEntry)) return false;
  if (!value.goalPatternSuccessRate.every(isValidGoalPatternEntry)) return false;
  if (!value.coChangeClusters.every(isValidCoChangeClusterEntry)) return false;
  return true;
};

/**
 * Serializes WorkspaceMemory to deterministic JSON.
 * Keys are sorted to ensure identical output for identical logical states.
 * Pure function.
 */
export const serializeWorkspaceMemory = (memory: WorkspaceMemory): string =>
  JSON.stringify(memory, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  }, 2);

/**
 * Parses a JSON string into WorkspaceMemory.
 * Returns emptyWorkspaceMemory() for:
 * - Invalid JSON
 * - Missing required fields
 * - Version mismatch (version !== 1)
 * - Any structural validation failure
 *
 * Never throws. Pure function.
 */
export const parseWorkspaceMemory = (json: string): WorkspaceMemory => {
  try {
    const parsed = JSON.parse(json);
    if (!isValidWorkspaceMemory(parsed)) return emptyWorkspaceMemory();
    return parsed as WorkspaceMemory;
  } catch {
    return emptyWorkspaceMemory();
  }
};

/**
 * Reads WorkspaceMemory from disk.
 * Returns emptyWorkspaceMemory() if file is missing or unreadable.
 */
export const loadWorkspaceMemory = (persistence?: AgentPersistence): Promise<WorkspaceMemory> =>
  readAgentState(persistence, "agent.workspace-memory.v1", parseWorkspaceMemory, emptyWorkspaceMemory);

/**
 * Writes WorkspaceMemory to disk.
 * Creates .brass/ directory if it does not exist.
 * Throws on write failure (caller handles).
 */
export const persistWorkspaceMemory = async (
  persistence: AgentPersistence | undefined,
  memory: WorkspaceMemory,
): Promise<void> => writeAgentState(
  persistence,
  "agent.workspace-memory.v1",
  serializeWorkspaceMemory(memory),
  { maxBytes: 524_288 },
);
