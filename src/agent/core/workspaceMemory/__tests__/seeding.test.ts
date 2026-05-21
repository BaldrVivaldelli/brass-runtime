// src/agent/core/workspaceMemory/__tests__/seeding.test.ts

import { describe, it, expect } from "vitest";
import { computeAdjustedPriors, seedContextBanditPriors, seedPatchStrategyPriors } from "../seeding";
import { emptyWorkspaceMemory } from "../types";
import type { WorkspaceMemory } from "../types";
import { initialThompsonState } from "../../patchStrategy/thompson";

/**
 * Unit tests for workspace memory seeding functions.
 * Feature: workspace-profile-evolution
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */

describe("computeAdjustedPriors", () => {
  it("returns Beta(1,1) for zero observations", () => {
    const result = computeAdjustedPriors(0, 0);
    expect(result).toStrictEqual({ alpha: 1, beta: 1 });
  });

  it("returns Beta(1,1) for zero observations with custom scale factor", () => {
    const result = computeAdjustedPriors(0, 0, 5);
    expect(result).toStrictEqual({ alpha: 1, beta: 1 });
  });

  it("produces alpha > 1 for positive successes", () => {
    const result = computeAdjustedPriors(50, 50);
    expect(result.alpha).toBeGreaterThan(1);
  });

  it("produces beta > 1 for positive failures", () => {
    const result = computeAdjustedPriors(50, 50);
    expect(result.beta).toBeGreaterThan(1);
  });

  it("scales with observation count (more observations = stronger prior)", () => {
    const small = computeAdjustedPriors(5, 5);
    const large = computeAdjustedPriors(500, 500);

    // With more observations, the effective scale is higher
    expect(large.alpha).toBeGreaterThanOrEqual(small.alpha);
  });

  it("ensures alpha >= 1 and beta >= 1 always", () => {
    const result = computeAdjustedPriors(1, 0);
    expect(result.alpha).toBeGreaterThanOrEqual(1);
    expect(result.beta).toBeGreaterThanOrEqual(1);
  });
});

describe("seedContextBanditPriors", () => {
  it("returns default priors for empty memory", () => {
    const memory = emptyWorkspaceMemory();
    const arms = [
      { id: "arm-1", pattern: "src/" },
      { id: "arm-2", pattern: "test/" },
    ];

    const result = seedContextBanditPriors(memory, arms);

    expect(result["arm-1"]).toStrictEqual({ alpha: 1, beta: 1, pulls: 0, lastPulledAt: 0 });
    expect(result["arm-2"]).toStrictEqual({ alpha: 1, beta: 1, pulls: 0, lastPulledAt: 0 });
  });

  it("adjusts priors for arms with matching file change entries", () => {
    const memory: WorkspaceMemory = {
      version: 1,
      fileChangeFrequency: [
        { key: "src/agent/core/runAgent.ts", updatedAt: 1000, count: 50 },
        { key: "src/agent/core/types.ts", updatedAt: 1000, count: 30 },
      ],
      commandFailureRate: [],
      goalPatternSuccessRate: [],
      coChangeClusters: [],
    };

    const arms = [
      { id: "agent-arm", pattern: "src/agent/" },
      { id: "http-arm", pattern: "src/http/" },
    ];

    const result = seedContextBanditPriors(memory, arms);

    // Agent arm should have adjusted priors (matching entries)
    expect(result["agent-arm"].alpha).toBeGreaterThan(1);
    // HTTP arm should have default priors (no matching entries)
    expect(result["http-arm"]).toStrictEqual({ alpha: 1, beta: 1, pulls: 0, lastPulledAt: 0 });
  });

  it("uses co-change cluster data to boost priors", () => {
    const memory: WorkspaceMemory = {
      version: 1,
      fileChangeFrequency: [],
      commandFailureRate: [],
      goalPatternSuccessRate: [],
      coChangeClusters: [
        { key: "cluster-1", files: ["src/a.ts", "src/b.ts"], updatedAt: 1000, occurrences: 10 },
      ],
    };

    const arms = [
      { id: "src-arm", pattern: "src/" },
      { id: "test-arm", pattern: "test/" },
    ];

    const result = seedContextBanditPriors(memory, arms);

    // src-arm should have boosted priors from co-change cluster
    expect(result["src-arm"].alpha).toBeGreaterThan(1);
    // test-arm should have default priors
    expect(result["test-arm"]).toStrictEqual({ alpha: 1, beta: 1, pulls: 0, lastPulledAt: 0 });
  });

  it("always sets pulls to 0 and lastPulledAt to 0", () => {
    const memory: WorkspaceMemory = {
      version: 1,
      fileChangeFrequency: [{ key: "src/a.ts", updatedAt: 1000, count: 100 }],
      commandFailureRate: [],
      goalPatternSuccessRate: [],
      coChangeClusters: [],
    };

    const arms = [{ id: "arm-1", pattern: "src/" }];
    const result = seedContextBanditPriors(memory, arms);

    expect(result["arm-1"].pulls).toBe(0);
    expect(result["arm-1"].lastPulledAt).toBe(0);
  });
});

describe("seedPatchStrategyPriors", () => {
  it("returns initialThompsonState for empty memory", () => {
    const memory = emptyWorkspaceMemory();
    const result = seedPatchStrategyPriors(memory, "fix-bug");
    expect(result).toStrictEqual(initialThompsonState());
  });

  it("returns initialThompsonState for non-matching goal pattern", () => {
    const memory: WorkspaceMemory = {
      version: 1,
      fileChangeFrequency: [],
      commandFailureRate: [],
      goalPatternSuccessRate: [
        { key: "add-feature", pattern: "add-feature", updatedAt: 1000, successes: 10, failures: 2 },
      ],
      coChangeClusters: [],
    };

    const result = seedPatchStrategyPriors(memory, "fix-bug");
    expect(result).toStrictEqual(initialThompsonState());
  });

  it("adjusts priors for matching goal pattern", () => {
    const memory: WorkspaceMemory = {
      version: 1,
      fileChangeFrequency: [],
      commandFailureRate: [],
      goalPatternSuccessRate: [
        { key: "fix-bug", pattern: "fix-bug", updatedAt: 1000, successes: 80, failures: 20 },
      ],
      coChangeClusters: [],
    };

    const result = seedPatchStrategyPriors(memory, "fix-bug");

    // Should have adjusted priors
    expect(result.arms["direct-patch"].alpha).toBeGreaterThan(1);
    expect(result.arms["direct-patch"].beta).toBeGreaterThan(1);
  });

  it("matches when goal pattern includes stored pattern", () => {
    const memory: WorkspaceMemory = {
      version: 1,
      fileChangeFrequency: [],
      commandFailureRate: [],
      goalPatternSuccessRate: [
        { key: "fix", pattern: "fix", updatedAt: 1000, successes: 50, failures: 50 },
      ],
      coChangeClusters: [],
    };

    const result = seedPatchStrategyPriors(memory, "fix-bug-in-auth");

    // Should match because "fix-bug-in-auth".includes("fix")
    expect(result.arms["direct-patch"].alpha).toBeGreaterThan(1);
  });
});
