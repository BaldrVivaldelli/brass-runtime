// src/agent/core/approvalLearning/__tests__/confidence.test.ts

import { describe, it, expect } from "vitest";
import { decayWeight, computeConfidence, shouldAutoApprove } from "../confidence";
import { DEFAULT_LEARNING_CONFIG } from "../types";
import type { ApprovalObservation, LearningConfig } from "../types";

const makeObs = (approved: boolean): ApprovalObservation => ({
  approved,
  timestamp: Date.now(),
});

describe("decayWeight", () => {
  it("returns 1 for position 0 (most recent)", () => {
    expect(decayWeight(0, 0.85)).toBe(1);
  });

  it("returns decayFactor for position 1", () => {
    expect(decayWeight(1, 0.85)).toBeCloseTo(0.85);
  });

  it("returns decayFactor^position for arbitrary positions", () => {
    expect(decayWeight(3, 0.85)).toBeCloseTo(0.85 ** 3);
    expect(decayWeight(5, 0.5)).toBeCloseTo(0.5 ** 5);
  });
});

describe("computeConfidence", () => {
  const config = { decayFactor: 0.85, observationWindow: 50 };

  it("returns 0 for empty observations", () => {
    expect(computeConfidence([], config)).toBe(0);
  });

  it("returns 1 for all-approved observations", () => {
    const obs = Array.from({ length: 10 }, () => makeObs(true));
    expect(computeConfidence(obs, config)).toBeCloseTo(1);
  });

  it("returns 0 for all-rejected observations", () => {
    const obs = Array.from({ length: 10 }, () => makeObs(false));
    expect(computeConfidence(obs, config)).toBe(0);
  });

  it("gives higher weight to more recent observations", () => {
    // All rejected except the most recent (approved)
    const obs = [
      makeObs(false),
      makeObs(false),
      makeObs(false),
      makeObs(true), // most recent
    ];
    const confidence = computeConfidence(obs, config);
    // Should be > 0.25 (unweighted) because most recent has highest weight
    expect(confidence).toBeGreaterThan(0.25);
  });

  it("respects observation window by taking only the most recent entries", () => {
    const smallWindow = { decayFactor: 0.85, observationWindow: 3 };
    // 5 observations: first 2 rejected, last 3 approved
    const obs = [
      makeObs(false),
      makeObs(false),
      makeObs(true),
      makeObs(true),
      makeObs(true),
    ];
    // With window=3, only the last 3 (all approved) are used
    expect(computeConfidence(obs, smallWindow)).toBeCloseTo(1);
  });

  it("returns value in [0, 1] for mixed observations", () => {
    const obs = [makeObs(true), makeObs(false), makeObs(true), makeObs(false)];
    const confidence = computeConfidence(obs, config);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });
});

describe("shouldAutoApprove", () => {
  it("returns false when observations count is below minSampleSize", () => {
    const obs = Array.from({ length: 4 }, () => makeObs(true));
    expect(shouldAutoApprove(obs, DEFAULT_LEARNING_CONFIG)).toBe(false);
  });

  it("returns false when confidence equals threshold exactly", () => {
    // All approved with enough samples → confidence = 1.0
    // But we need confidence = threshold exactly, which is hard to construct
    // Instead test that strictly greater is required
    const config: LearningConfig = {
      confidenceThreshold: 1.0, // impossible to exceed
      observationWindow: 50,
      decayFactor: 0.85,
      minSampleSize: 5,
    };
    const obs = Array.from({ length: 10 }, () => makeObs(true));
    // confidence = 1.0, threshold = 1.0, strictly greater required → false
    expect(shouldAutoApprove(obs, config)).toBe(false);
  });

  it("returns true when confidence strictly exceeds threshold with sufficient samples", () => {
    const config: LearningConfig = {
      confidenceThreshold: 0.5,
      observationWindow: 50,
      decayFactor: 0.85,
      minSampleSize: 5,
    };
    const obs = Array.from({ length: 10 }, () => makeObs(true));
    expect(shouldAutoApprove(obs, config)).toBe(true);
  });

  it("returns false when confidence is below threshold", () => {
    const config: LearningConfig = {
      confidenceThreshold: 0.95,
      observationWindow: 50,
      decayFactor: 0.85,
      minSampleSize: 5,
    };
    // Mix of approved and rejected → confidence < 0.95
    const obs = [
      ...Array.from({ length: 5 }, () => makeObs(true)),
      ...Array.from({ length: 5 }, () => makeObs(false)),
    ];
    expect(shouldAutoApprove(obs, config)).toBe(false);
  });
});
