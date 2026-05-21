// src/agent/core/approvalLearning/confidence.ts

import type { ApprovalObservation, LearningConfig } from "./types";

/**
 * Compute the exponential decay weight for an observation at a given position.
 * Position 0 = most recent (highest weight), position n = oldest (lowest weight).
 * Weight = decayFactor ^ position
 */
export const decayWeight = (position: number, decayFactor: number): number =>
  Math.pow(decayFactor, position);

/**
 * Pure function: compute confidence score from an observation array.
 * Observations are ordered oldest-first (index 0 = oldest, last = most recent).
 * Uses exponential decay weighting where more recent observations have higher weight.
 *
 * Returns a value in [0, 1]. Returns 0 for empty arrays.
 */
export const computeConfidence = (
  observations: readonly ApprovalObservation[],
  config: Pick<LearningConfig, "decayFactor" | "observationWindow">
): number => {
  if (observations.length === 0) return 0;

  // Take only the most recent `observationWindow` entries
  const windowed = observations.slice(-config.observationWindow);
  const n = windowed.length;

  let weightedApprovals = 0;
  let totalWeight = 0;

  for (let i = 0; i < n; i++) {
    // Position from most recent: (n - 1 - i) means index n-1 is position 0 (most recent)
    const position = n - 1 - i;
    const weight = decayWeight(position, config.decayFactor);
    totalWeight += weight;
    if (windowed[i].approved) {
      weightedApprovals += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return weightedApprovals / totalWeight;
};

/**
 * Determine whether an action type should be auto-approved.
 * Requires: confidence strictly > threshold AND sample count >= minSampleSize.
 */
export const shouldAutoApprove = (
  observations: readonly ApprovalObservation[],
  config: LearningConfig
): boolean => {
  if (observations.length < config.minSampleSize) return false;
  const confidence = computeConfidence(observations, config);
  return confidence > config.confidenceThreshold;
};
