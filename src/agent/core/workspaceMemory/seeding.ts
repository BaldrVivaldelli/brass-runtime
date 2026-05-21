// src/agent/core/workspaceMemory/seeding.ts

import type { WorkspaceMemory } from "./types";
import type { ArmStats } from "../contextBudget/types";
import type { ThompsonState } from "../patchStrategy/types";
import { initialThompsonState } from "../patchStrategy/thompson";

/**
 * Computes adjusted ArmStats from observation counts.
 * alpha = 1 + successes * scaleFactor
 * beta = 1 + failures * scaleFactor
 *
 * When observations are zero, returns Beta(1,1).
 * Ensures alpha >= 1 and beta >= 1 invariant.
 */
export const computeAdjustedPriors = (
  successes: number,
  failures: number,
  scaleFactor: number = 1,
): { readonly alpha: number; readonly beta: number } => {
  const total = successes + failures;
  if (total === 0) return { alpha: 1, beta: 1 };

  const effectiveScale = Math.min(total / 100, 1.0) * scaleFactor;
  const alpha = 1 + (successes / total) * effectiveScale * 10;
  const beta = 1 + (failures / total) * effectiveScale * 10;

  return {
    alpha: Math.max(1, alpha),
    beta: Math.max(1, beta),
  };
};

/**
 * Converts file change frequency and co-change cluster data into
 * adjusted alpha/beta priors for context budget bandit arms.
 *
 * For each arm pattern, looks up matching file change entries and
 * co-change clusters. Adjusts alpha proportional to change frequency
 * (more changes → higher alpha → more likely to be included).
 *
 * Returns default Beta(1,1) for arms with no matching memory data.
 * Pure function — no side effects.
 */
export const seedContextBanditPriors = (
  memory: WorkspaceMemory,
  armPatterns: readonly { readonly id: string; readonly pattern: string }[],
): Readonly<Record<string, ArmStats>> => {
  const result: Record<string, ArmStats> = {};

  for (const arm of armPatterns) {
    // Find matching file change entries by pattern prefix/glob match
    const matchingFiles = memory.fileChangeFrequency.filter((entry) =>
      matchesPattern(entry.key, arm.pattern),
    );

    // Find matching co-change clusters
    const matchingClusters = memory.coChangeClusters.filter((cluster) =>
      cluster.files.some((f) => matchesPattern(f, arm.pattern)),
    );

    const totalChanges = matchingFiles.reduce((sum, e) => sum + e.count, 0);
    const totalClusterOccurrences = matchingClusters.reduce(
      (sum, c) => sum + c.occurrences,
      0,
    );

    // Treat changes as "successes" (evidence the arm is useful)
    // and lack of changes as weak "failures"
    const successes = totalChanges + totalClusterOccurrences;
    const failures = 0; // No negative evidence from file changes

    const { alpha, beta } = computeAdjustedPriors(successes, failures);

    result[arm.id] = {
      alpha,
      beta,
      pulls: 0,
      lastPulledAt: 0,
    };
  }

  return result;
};

/**
 * Converts goal-pattern success rates into adjusted alpha/beta priors
 * for patch strategy Thompson arms.
 *
 * Matches the current goal signals against stored goal patterns.
 * Adjusts alpha/beta based on historical success/failure counts.
 *
 * Returns default Beta(1,1) for arms with no matching memory data.
 * Pure function — no side effects.
 */
export const seedPatchStrategyPriors = (
  memory: WorkspaceMemory,
  goalPattern: string,
): ThompsonState => {
  const base = initialThompsonState();

  // Find matching goal pattern entries
  const matching = memory.goalPatternSuccessRate.filter(
    (entry) => entry.pattern === goalPattern || goalPattern.includes(entry.pattern),
  );

  if (matching.length === 0) return base;

  // Aggregate successes and failures across matching patterns
  const totalSuccesses = matching.reduce((sum, e) => sum + e.successes, 0);
  const totalFailures = matching.reduce((sum, e) => sum + e.failures, 0);

  const { alpha, beta } = computeAdjustedPriors(totalSuccesses, totalFailures);

  // Apply the same adjusted priors to all Thompson arms
  return {
    ...base,
    arms: {
      "direct-patch": { alpha, beta },
      "multi-step-patch": { alpha, beta },
      "propose-then-refine": { alpha, beta },
    },
  };
};

/**
 * Simple pattern matching: checks if a file path matches a glob-like pattern.
 * Supports prefix matching and basic glob patterns.
 */
const matchesPattern = (filePath: string, pattern: string): boolean => {
  // Exact match
  if (filePath === pattern) return true;

  // Simple prefix match (pattern ends with *)
  if (pattern.endsWith("*")) {
    return filePath.startsWith(pattern.slice(0, -1));
  }

  // Directory prefix match (pattern ends with /)
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern);
  }

  // Contains match for simple patterns
  return filePath.includes(pattern);
};
