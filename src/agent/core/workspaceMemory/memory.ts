// src/agent/core/workspaceMemory/memory.ts

import type {
  WorkspaceMemory,
  FileChangeEntry,
  CommandFailureEntry,
  GoalPatternEntry,
  CoChangeClusterEntry,
} from "./types";
import { CATEGORY_CAP } from "./types";

/**
 * Evicts least-recently-updated entries from a category to restore the cap.
 * Pure function — returns a new array without mutation.
 * Entries are sorted by updatedAt ascending; ties broken by key ascending.
 * The oldest entries are removed first.
 */
export const evictToCapacity = <T extends { readonly updatedAt: number; readonly key: string }>(
  entries: readonly T[],
  cap: number = CATEGORY_CAP,
): readonly T[] => {
  if (entries.length <= cap) return entries;
  const sorted = [...entries].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return sorted.slice(0, cap);
};

/**
 * Records file change frequency for a set of modified file paths.
 * Increments existing entries or creates new ones. Enforces category cap.
 */
export const recordFileChanges = (
  memory: WorkspaceMemory,
  modifiedFiles: readonly string[],
  now: number,
): WorkspaceMemory => {
  const map = new Map<string, FileChangeEntry>(
    memory.fileChangeFrequency.map((e) => [e.key, e]),
  );

  for (const path of modifiedFiles) {
    const existing = map.get(path);
    if (existing) {
      map.set(path, { ...existing, count: existing.count + 1, updatedAt: now });
    } else {
      map.set(path, { key: path, count: 1, updatedAt: now });
    }
  }

  return {
    ...memory,
    fileChangeFrequency: evictToCapacity([...map.values()]),
  };
};

/**
 * Records command execution outcomes (success/failure) for shell commands.
 * Updates existing entries or creates new ones. Enforces category cap.
 */
export const recordCommandOutcomes = (
  memory: WorkspaceMemory,
  commands: readonly { readonly command: string; readonly success: boolean }[],
  now: number,
): WorkspaceMemory => {
  const map = new Map<string, CommandFailureEntry>(
    memory.commandFailureRate.map((e) => [e.key, e]),
  );

  for (const { command, success } of commands) {
    const existing = map.get(command);
    if (existing) {
      map.set(command, {
        ...existing,
        successes: existing.successes + (success ? 1 : 0),
        failures: existing.failures + (success ? 0 : 1),
        updatedAt: now,
      });
    } else {
      map.set(command, {
        key: command,
        successes: success ? 1 : 0,
        failures: success ? 0 : 1,
        updatedAt: now,
      });
    }
  }

  return {
    ...memory,
    commandFailureRate: evictToCapacity([...map.values()]),
  };
};

/**
 * Records goal-pattern success/failure for the completed run.
 * Updates existing pattern entry or creates a new one. Enforces category cap.
 */
export const recordGoalOutcome = (
  memory: WorkspaceMemory,
  pattern: string,
  success: boolean,
  now: number,
): WorkspaceMemory => {
  const map = new Map<string, GoalPatternEntry>(
    memory.goalPatternSuccessRate.map((e) => [e.key, e]),
  );

  const existing = map.get(pattern);
  if (existing) {
    map.set(pattern, {
      ...existing,
      successes: existing.successes + (success ? 1 : 0),
      failures: existing.failures + (success ? 0 : 1),
      updatedAt: now,
    });
  } else {
    map.set(pattern, {
      key: pattern,
      pattern,
      successes: success ? 1 : 0,
      failures: success ? 0 : 1,
      updatedAt: now,
    });
  }

  return {
    ...memory,
    goalPatternSuccessRate: evictToCapacity([...map.values()]),
  };
};

/**
 * Records co-change clusters from patch applications.
 * Groups files modified in the same patch. Enforces category cap.
 */
export const recordCoChanges = (
  memory: WorkspaceMemory,
  patchGroups: readonly (readonly string[])[],
  now: number,
): WorkspaceMemory => {
  const map = new Map<string, CoChangeClusterEntry>(
    memory.coChangeClusters.map((e) => [e.key, e]),
  );

  for (const files of patchGroups) {
    if (files.length === 0) continue;
    const sortedFiles = [...files].sort();
    const key = sortedFiles.join("\0");
    const existing = map.get(key);
    if (existing) {
      map.set(key, { ...existing, occurrences: existing.occurrences + 1, updatedAt: now });
    } else {
      map.set(key, { key, files: sortedFiles, occurrences: 1, updatedAt: now });
    }
  }

  return {
    ...memory,
    coChangeClusters: evictToCapacity([...map.values()]),
  };
};
