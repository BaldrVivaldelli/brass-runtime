// src/agent/core/workspaceMemory/__tests__/store.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { serializeWorkspaceMemory, parseWorkspaceMemory } from "../store";
import { emptyWorkspaceMemory, CATEGORY_CAP } from "../types";
import type {
  WorkspaceMemory,
  FileChangeEntry,
  CommandFailureEntry,
  GoalPatternEntry,
  CoChangeClusterEntry,
} from "../types";

// --- Generators ---

const timestampArb = fc.nat({ max: 2_000_000_000_000 });
const keyArb = fc.stringMatching(/^[a-z][a-z0-9/._\-]{0,29}$/);

const fileChangeEntryArb: fc.Arbitrary<FileChangeEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  count: fc.nat({ max: 10000 }),
});

const commandFailureEntryArb: fc.Arbitrary<CommandFailureEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  successes: fc.nat({ max: 10000 }),
  failures: fc.nat({ max: 10000 }),
});

const goalPatternEntryArb: fc.Arbitrary<GoalPatternEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  pattern: keyArb,
  successes: fc.nat({ max: 10000 }),
  failures: fc.nat({ max: 10000 }),
});

const coChangeClusterEntryArb: fc.Arbitrary<CoChangeClusterEntry> = fc.record({
  key: keyArb,
  updatedAt: timestampArb,
  files: fc.array(keyArb, { minLength: 1, maxLength: 5 }),
  occurrences: fc.nat({ max: 10000 }),
});

const workspaceMemoryArb: fc.Arbitrary<WorkspaceMemory> = fc.record({
  version: fc.constant(1 as const),
  fileChangeFrequency: fc.array(fileChangeEntryArb, { minLength: 0, maxLength: 20 }),
  commandFailureRate: fc.array(commandFailureEntryArb, { minLength: 0, maxLength: 20 }),
  goalPatternSuccessRate: fc.array(goalPatternEntryArb, { minLength: 0, maxLength: 20 }),
  coChangeClusters: fc.array(coChangeClusterEntryArb, { minLength: 0, maxLength: 20 }),
});

// --- Property 1: Serialization round-trip ---

describe("Property 1: Serialization round-trip", () => {
  /**
   * **Validates: Requirements 1.7, 10.1**
   *
   * For any valid WorkspaceMemory value, serializing to JSON via serializeWorkspaceMemory
   * and then parsing via parseWorkspaceMemory SHALL produce a WorkspaceMemory that is
   * deeply equal to the original.
   */
  it("parseWorkspaceMemory(serializeWorkspaceMemory(m)) deeply equals m", () => {
    fc.assert(
      fc.property(workspaceMemoryArb, (memory) => {
        const serialized = serializeWorkspaceMemory(memory);
        const parsed = parseWorkspaceMemory(serialized);
        // Use toEqual (not toStrictEqual) because fc.record may produce null-prototype objects
        // but JSON round-trip normalizes to standard prototypes
        expect(parsed).toEqual(memory);
      }),
      { numRuns: 200 },
    );
  });

  it("round-trip preserves empty memory", () => {
    const empty = emptyWorkspaceMemory();
    const serialized = serializeWorkspaceMemory(empty);
    const parsed = parseWorkspaceMemory(serialized);
    expect(parsed).toStrictEqual(empty);
  });
});

// --- Property 10: Deterministic serialization ---

describe("Property 10: Deterministic serialization", () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * For any valid WorkspaceMemory, calling serializeWorkspaceMemory twice on the same
   * value SHALL produce identical strings.
   */
  it("serializeWorkspaceMemory(m) === serializeWorkspaceMemory(m) for any valid memory", () => {
    fc.assert(
      fc.property(workspaceMemoryArb, (memory) => {
        const first = serializeWorkspaceMemory(memory);
        const second = serializeWorkspaceMemory(memory);
        expect(first).toBe(second);
      }),
      { numRuns: 200 },
    );
  });

  it("deeply equal memories produce identical strings", () => {
    fc.assert(
      fc.property(workspaceMemoryArb, (memory) => {
        // Create a deep copy
        const copy: WorkspaceMemory = JSON.parse(JSON.stringify(memory));
        const original = serializeWorkspaceMemory(memory);
        const fromCopy = serializeWorkspaceMemory(copy);
        expect(original).toBe(fromCopy);
      }),
      { numRuns: 200 },
    );
  });
});

// --- Property 5: Graceful degradation for invalid inputs ---

describe("Property 5: Graceful degradation for invalid inputs", () => {
  /**
   * **Validates: Requirements 2.4, 3.4, 5.3, 7.1, 7.2, 7.3, 10.5**
   *
   * For any string that is not valid JSON, or is valid JSON but does not conform to
   * the WorkspaceMemory schema, or has a version field not equal to 1,
   * parseWorkspaceMemory SHALL return a value deeply equal to emptyWorkspaceMemory()
   * and SHALL NOT throw an exception.
   */
  it("returns emptyWorkspaceMemory() for arbitrary invalid strings", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        const result = parseWorkspaceMemory(input);
        expect(result).toStrictEqual(emptyWorkspaceMemory());
      }),
      { numRuns: 200 },
    );
  });

  it("returns emptyWorkspaceMemory() for valid JSON with wrong schema", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ version: fc.integer({ min: 2, max: 100 }) }),
          fc.record({ version: fc.constant(1), fileChangeFrequency: fc.constant("not-array") }),
          fc.record({ version: fc.constant(1), fileChangeFrequency: fc.constant(null) }),
          fc.array(fc.anything()),
          fc.nat(),
          fc.boolean(),
        ),
        (value) => {
          const json = JSON.stringify(value);
          const result = parseWorkspaceMemory(json);
          expect(result).toStrictEqual(emptyWorkspaceMemory());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns emptyWorkspaceMemory() for version mismatch", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 1000 }),
        (version) => {
          const json = JSON.stringify({
            version,
            fileChangeFrequency: [],
            commandFailureRate: [],
            goalPatternSuccessRate: [],
            coChangeClusters: [],
          });
          const result = parseWorkspaceMemory(json);
          expect(result).toStrictEqual(emptyWorkspaceMemory());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never throws for any input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        expect(() => parseWorkspaceMemory(input)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});
