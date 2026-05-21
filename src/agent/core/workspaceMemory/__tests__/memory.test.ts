// src/agent/core/workspaceMemory/__tests__/memory.test.ts

import { describe, it, expect } from "vitest";
import {
  evictToCapacity,
  recordFileChanges,
  recordCommandOutcomes,
  recordGoalOutcome,
  recordCoChanges,
} from "../memory";
import { CATEGORY_CAP, emptyWorkspaceMemory } from "../types";
import type { FileChangeEntry, CommandFailureEntry, GoalPatternEntry, CoChangeClusterEntry } from "../types";

describe("evictToCapacity", () => {
  it("returns entries unchanged when below cap", () => {
    const entries: FileChangeEntry[] = [
      { key: "a.ts", updatedAt: 100, count: 1 },
      { key: "b.ts", updatedAt: 200, count: 2 },
    ];
    const result = evictToCapacity(entries, 5);
    expect(result).toHaveLength(2);
  });

  it("returns entries unchanged when at cap", () => {
    const entries: FileChangeEntry[] = Array.from({ length: 5 }, (_, i) => ({
      key: `file${i}.ts`,
      updatedAt: i * 100,
      count: 1,
    }));
    const result = evictToCapacity(entries, 5);
    expect(result).toHaveLength(5);
  });

  it("evicts oldest entries when above cap", () => {
    const entries: FileChangeEntry[] = [
      { key: "old.ts", updatedAt: 100, count: 1 },
      { key: "new.ts", updatedAt: 300, count: 1 },
      { key: "mid.ts", updatedAt: 200, count: 1 },
    ];
    const result = evictToCapacity(entries, 2);
    expect(result).toHaveLength(2);
    // Should keep the 2 most recently updated
    expect(result.map((e) => e.key)).toContain("new.ts");
    expect(result.map((e) => e.key)).toContain("mid.ts");
  });

  it("uses key as tiebreaker when updatedAt is equal", () => {
    const entries: FileChangeEntry[] = [
      { key: "b.ts", updatedAt: 100, count: 1 },
      { key: "a.ts", updatedAt: 100, count: 1 },
      { key: "c.ts", updatedAt: 100, count: 1 },
    ];
    const result = evictToCapacity(entries, 2);
    expect(result).toHaveLength(2);
    // With same updatedAt, sorted by key ascending, first 2 kept (a.ts, b.ts)
    expect(result.map((e) => e.key).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("uses default CATEGORY_CAP when no cap specified", () => {
    const entries: FileChangeEntry[] = Array.from({ length: CATEGORY_CAP + 10 }, (_, i) => ({
      key: `file${String(i).padStart(4, "0")}.ts`,
      updatedAt: i,
      count: 1,
    }));
    const result = evictToCapacity(entries);
    expect(result).toHaveLength(CATEGORY_CAP);
  });
});

describe("recordFileChanges", () => {
  it("creates new entries for new file paths", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordFileChanges(memory, ["src/a.ts", "src/b.ts"], 1000);

    expect(result.fileChangeFrequency).toHaveLength(2);
    expect(result.fileChangeFrequency.find((e) => e.key === "src/a.ts")).toEqual({
      key: "src/a.ts",
      count: 1,
      updatedAt: 1000,
    });
  });

  it("increments count for existing file paths", () => {
    const memory = recordFileChanges(emptyWorkspaceMemory(), ["src/a.ts"], 1000);
    const result = recordFileChanges(memory, ["src/a.ts"], 2000);

    const entry = result.fileChangeFrequency.find((e) => e.key === "src/a.ts");
    expect(entry!.count).toBe(2);
    expect(entry!.updatedAt).toBe(2000);
  });

  it("does not mutate the original memory", () => {
    const memory = emptyWorkspaceMemory();
    recordFileChanges(memory, ["src/a.ts"], 1000);
    expect(memory.fileChangeFrequency).toHaveLength(0);
  });

  it("enforces category cap", () => {
    let memory = emptyWorkspaceMemory();
    // Add more than CATEGORY_CAP unique files
    const files = Array.from({ length: CATEGORY_CAP + 10 }, (_, i) => `file${i}.ts`);
    memory = recordFileChanges(memory, files, 1000);
    expect(memory.fileChangeFrequency.length).toBeLessThanOrEqual(CATEGORY_CAP);
  });
});

describe("recordCommandOutcomes", () => {
  it("creates new entries for new commands", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordCommandOutcomes(
      memory,
      [{ command: "npm test", success: true }],
      1000,
    );

    expect(result.commandFailureRate).toHaveLength(1);
    expect(result.commandFailureRate[0]).toEqual({
      key: "npm test",
      successes: 1,
      failures: 0,
      updatedAt: 1000,
    });
  });

  it("updates existing entries", () => {
    let memory = emptyWorkspaceMemory();
    memory = recordCommandOutcomes(memory, [{ command: "npm test", success: true }], 1000);
    memory = recordCommandOutcomes(memory, [{ command: "npm test", success: false }], 2000);

    const entry = memory.commandFailureRate.find((e) => e.key === "npm test");
    expect(entry!.successes).toBe(1);
    expect(entry!.failures).toBe(1);
    expect(entry!.updatedAt).toBe(2000);
  });

  it("handles multiple commands in one call", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordCommandOutcomes(
      memory,
      [
        { command: "npm test", success: true },
        { command: "npm run lint", success: false },
      ],
      1000,
    );

    expect(result.commandFailureRate).toHaveLength(2);
  });
});

describe("recordGoalOutcome", () => {
  it("creates new entry for new pattern", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordGoalOutcome(memory, "fix-bug", true, 1000);

    expect(result.goalPatternSuccessRate).toHaveLength(1);
    expect(result.goalPatternSuccessRate[0]).toEqual({
      key: "fix-bug",
      pattern: "fix-bug",
      successes: 1,
      failures: 0,
      updatedAt: 1000,
    });
  });

  it("updates existing pattern entry", () => {
    let memory = emptyWorkspaceMemory();
    memory = recordGoalOutcome(memory, "fix-bug", true, 1000);
    memory = recordGoalOutcome(memory, "fix-bug", false, 2000);

    const entry = memory.goalPatternSuccessRate.find((e) => e.key === "fix-bug");
    expect(entry!.successes).toBe(1);
    expect(entry!.failures).toBe(1);
    expect(entry!.updatedAt).toBe(2000);
  });
});

describe("recordCoChanges", () => {
  it("creates new cluster entry for new file group", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordCoChanges(memory, [["src/a.ts", "src/b.ts"]], 1000);

    expect(result.coChangeClusters).toHaveLength(1);
    expect(result.coChangeClusters[0].files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.coChangeClusters[0].occurrences).toBe(1);
  });

  it("increments occurrences for existing cluster", () => {
    let memory = emptyWorkspaceMemory();
    memory = recordCoChanges(memory, [["src/a.ts", "src/b.ts"]], 1000);
    memory = recordCoChanges(memory, [["src/b.ts", "src/a.ts"]], 2000); // Same files, different order

    expect(memory.coChangeClusters).toHaveLength(1);
    expect(memory.coChangeClusters[0].occurrences).toBe(2);
  });

  it("skips empty patch groups", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordCoChanges(memory, [[]], 1000);
    expect(result.coChangeClusters).toHaveLength(0);
  });

  it("handles multiple patch groups", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordCoChanges(
      memory,
      [
        ["src/a.ts", "src/b.ts"],
        ["src/c.ts", "src/d.ts"],
      ],
      1000,
    );
    expect(result.coChangeClusters).toHaveLength(2);
  });

  it("sorts files within cluster for consistent keys", () => {
    const memory = emptyWorkspaceMemory();
    const result = recordCoChanges(memory, [["z.ts", "a.ts", "m.ts"]], 1000);
    expect(result.coChangeClusters[0].files).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});
