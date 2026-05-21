// src/agent/core/workspaceMemory/types.ts

/** Base fields shared by all memory entry types. */
export type MemoryEntryBase = {
  readonly key: string;
  readonly updatedAt: number; // Unix timestamp ms
};

/** Tracks how often a file path is modified across sessions. */
export type FileChangeEntry = MemoryEntryBase & {
  readonly count: number;
};

/** Tracks success/failure rates for shell commands. */
export type CommandFailureEntry = MemoryEntryBase & {
  readonly successes: number;
  readonly failures: number;
};

/** Tracks success/failure rates for goal text patterns. */
export type GoalPatternEntry = MemoryEntryBase & {
  readonly pattern: string;
  readonly successes: number;
  readonly failures: number;
};

/** Tracks groups of files that change together. */
export type CoChangeClusterEntry = MemoryEntryBase & {
  readonly files: readonly string[];
  readonly occurrences: number;
};

/** Complete persisted workspace memory structure. */
export type WorkspaceMemory = {
  readonly version: 1;
  readonly fileChangeFrequency: readonly FileChangeEntry[];
  readonly commandFailureRate: readonly CommandFailureEntry[];
  readonly goalPatternSuccessRate: readonly GoalPatternEntry[];
  readonly coChangeClusters: readonly CoChangeClusterEntry[];
};

/** Maximum entries per category. */
export const CATEGORY_CAP = 500;

/** All category field names on WorkspaceMemory. */
export const CATEGORY_NAMES = [
  "fileChangeFrequency",
  "commandFailureRate",
  "goalPatternSuccessRate",
  "coChangeClusters",
] as const;

/** Union of category field names. */
export type CategoryName = (typeof CATEGORY_NAMES)[number];

/** Factory for empty workspace memory. */
export const emptyWorkspaceMemory = (): WorkspaceMemory => ({
  version: 1,
  fileChangeFrequency: [],
  commandFailureRate: [],
  goalPatternSuccessRate: [],
  coChangeClusters: [],
});
