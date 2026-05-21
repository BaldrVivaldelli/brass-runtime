// src/agent/core/workspaceMemory/__tests__/memory.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  evictToCapacity,
  recordFileChanges,
  recordCommandOutcomes,
  recordGoalOutcome,
  recordCoChanges,
} from "../memory";
import { CATEGORY_CAP, emptyWorkspaceMemory } from "../types";
import type { WorkspaceMemory } from "../types";

// --- Generators ---

const timestampArb = fc.nat({ max: 2_000_000_000_000 });
const filePathArb = fc.stringMatching(/^[a-z][a-z0-9/._\-]{0,29}$/);
const commandArb = fc.stringMatching(/^[a-z][a-z0-9 \-]{0,19}$/);

// --- Property 2: Category cap invariant ---

describe("Property 2: Category cap invariant", () => {
  /**
   * **Validates: Requirements 1.6, 4.6, 10.2**
   *
   * For any valid WorkspaceMemory and for any sequence of update operations,
   * the resulting WorkspaceMemory SHALL have at most 500 entries in each category.
   */
  it("all categories have length ≤ CATEGORY_CAP after any sequence of recordFileChanges", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(filePathArb, { minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 20 }),
        timestampArb,
        (fileGroups, baseTime) => {
          let memory: WorkspaceMemory = emptyWorkspaceMemory();

          for (let i = 0; i < fileGroups.length; i++) {
            memory = recordFileChanges(memory, fileGroups[i], baseTime + i);
          }

          expect(memory.fileChangeFrequency.length).toBeLessThanOrEqual(CATEGORY_CAP);
          expect(memory.commandFailureRate.length).toBeLessThanOrEqual(CATEGORY_CAP);
          expect(memory.goalPatternSuccessRate.length).toBeLessThanOrEqual(CATEGORY_CAP);
          expect(memory.coChangeClusters.length).toBeLessThanOrEqual(CATEGORY_CAP);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("all categories have length ≤ CATEGORY_CAP after any sequence of recordCommandOutcomes", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.record({ command: commandArb, success: fc.boolean() }), { minLength: 1, maxLength: 50 }),
          { minLength: 1, maxLength: 20 },
        ),
        timestampArb,
        (commandGroups, baseTime) => {
          let memory: WorkspaceMemory = emptyWorkspaceMemory();

          for (let i = 0; i < commandGroups.length; i++) {
            memory = recordCommandOutcomes(memory, commandGroups[i], baseTime + i);
          }

          expect(memory.commandFailureRate.length).toBeLessThanOrEqual(CATEGORY_CAP);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("all categories have length ≤ CATEGORY_CAP after any sequence of recordGoalOutcome", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ pattern: commandArb, success: fc.boolean() }), { minLength: 1, maxLength: 600 }),
        timestampArb,
        (goals, baseTime) => {
          let memory: WorkspaceMemory = emptyWorkspaceMemory();

          for (let i = 0; i < goals.length; i++) {
            memory = recordGoalOutcome(memory, goals[i].pattern, goals[i].success, baseTime + i);
          }

          expect(memory.goalPatternSuccessRate.length).toBeLessThanOrEqual(CATEGORY_CAP);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("all categories have length ≤ CATEGORY_CAP after any sequence of recordCoChanges", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.array(filePathArb, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 50 }),
          { minLength: 1, maxLength: 20 },
        ),
        timestampArb,
        (patchGroupSets, baseTime) => {
          let memory: WorkspaceMemory = emptyWorkspaceMemory();

          for (let i = 0; i < patchGroupSets.length; i++) {
            memory = recordCoChanges(memory, patchGroupSets[i], baseTime + i);
          }

          expect(memory.coChangeClusters.length).toBeLessThanOrEqual(CATEGORY_CAP);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("evictToCapacity never returns more than cap entries", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ key: filePathArb, updatedAt: timestampArb }),
          { minLength: 0, maxLength: 600 },
        ),
        fc.integer({ min: 1, max: 600 }),
        (entries, cap) => {
          const result = evictToCapacity(entries, cap);
          expect(result.length).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 9: Memory update preserves unrelated entries ---

describe("Property 9: Memory update preserves unrelated entries", () => {
  /**
   * **Validates: Requirements 4.2, 4.3, 4.4, 4.5**
   *
   * For any valid WorkspaceMemory and for any update operation targeting a specific key,
   * all entries in the memory with different keys SHALL remain unchanged after the update.
   */
  it("recordFileChanges preserves entries with different keys", () => {
    fc.assert(
      fc.property(
        filePathArb,
        filePathArb,
        timestampArb,
        timestampArb,
        (existingPath, newPath, existingTime, newTime) => {
          fc.pre(existingPath !== newPath);

          const memory = recordFileChanges(emptyWorkspaceMemory(), [existingPath], existingTime);
          const updated = recordFileChanges(memory, [newPath], newTime);

          // The existing entry should still be present and unchanged
          const existingEntry = updated.fileChangeFrequency.find((e) => e.key === existingPath);
          expect(existingEntry).toBeDefined();
          expect(existingEntry!.count).toBe(1);
          expect(existingEntry!.updatedAt).toBe(existingTime);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("recordCommandOutcomes preserves entries with different keys", () => {
    fc.assert(
      fc.property(
        commandArb,
        commandArb,
        fc.boolean(),
        fc.boolean(),
        timestampArb,
        timestampArb,
        (existingCmd, newCmd, existingSuccess, newSuccess, existingTime, newTime) => {
          fc.pre(existingCmd !== newCmd);

          const memory = recordCommandOutcomes(
            emptyWorkspaceMemory(),
            [{ command: existingCmd, success: existingSuccess }],
            existingTime,
          );
          const updated = recordCommandOutcomes(
            memory,
            [{ command: newCmd, success: newSuccess }],
            newTime,
          );

          const existingEntry = updated.commandFailureRate.find((e) => e.key === existingCmd);
          expect(existingEntry).toBeDefined();
          expect(existingEntry!.successes).toBe(existingSuccess ? 1 : 0);
          expect(existingEntry!.failures).toBe(existingSuccess ? 0 : 1);
          expect(existingEntry!.updatedAt).toBe(existingTime);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("recordGoalOutcome preserves entries with different keys", () => {
    fc.assert(
      fc.property(
        commandArb,
        commandArb,
        fc.boolean(),
        fc.boolean(),
        timestampArb,
        timestampArb,
        (existingPattern, newPattern, existingSuccess, newSuccess, existingTime, newTime) => {
          fc.pre(existingPattern !== newPattern);

          const memory = recordGoalOutcome(emptyWorkspaceMemory(), existingPattern, existingSuccess, existingTime);
          const updated = recordGoalOutcome(memory, newPattern, newSuccess, newTime);

          const existingEntry = updated.goalPatternSuccessRate.find((e) => e.key === existingPattern);
          expect(existingEntry).toBeDefined();
          expect(existingEntry!.successes).toBe(existingSuccess ? 1 : 0);
          expect(existingEntry!.failures).toBe(existingSuccess ? 0 : 1);
          expect(existingEntry!.updatedAt).toBe(existingTime);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("recordCoChanges preserves entries with different keys", () => {
    fc.assert(
      fc.property(
        fc.array(filePathArb, { minLength: 1, maxLength: 3 }),
        fc.array(filePathArb, { minLength: 1, maxLength: 3 }),
        timestampArb,
        timestampArb,
        (existingFiles, newFiles, existingTime, newTime) => {
          const existingKey = [...existingFiles].sort().join("\0");
          const newKey = [...newFiles].sort().join("\0");
          fc.pre(existingKey !== newKey);

          const memory = recordCoChanges(emptyWorkspaceMemory(), [existingFiles], existingTime);
          const updated = recordCoChanges(memory, [newFiles], newTime);

          const existingEntry = updated.coChangeClusters.find((e) => e.key === existingKey);
          expect(existingEntry).toBeDefined();
          expect(existingEntry!.occurrences).toBe(1);
          expect(existingEntry!.updatedAt).toBe(existingTime);
        },
      ),
      { numRuns: 200 },
    );
  });
});
