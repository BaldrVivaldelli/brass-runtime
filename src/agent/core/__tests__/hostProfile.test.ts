import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { deepFreeze } from "../hostProfile";

/**
 * Property-based tests for deep freeze immutability.
 * Feature: agent-host-llm-refactor, Property 11: Deep freeze immutability
 *
 * **Validates: Requirements 11.2, 11.3, 11.4**
 */
describe("Deep freeze immutability", () => {
  /** Arbitrary for nested objects with objects and arrays at various depths. */
  const arbNestedObject = fc.letrec((tie) => ({
    leaf: fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    ),
    node: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      tie("leaf"),
      fc.array(tie("tree"), { maxLength: 4 }),
      fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("tree"), { maxKeys: 4 }),
    ),
    tree: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      tie("leaf"),
      tie("node"),
    ),
  }));

  /** Arbitrary that always produces a non-empty object (root must be an object for deepFreeze). */
  const arbRootObject = fc
    .dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      arbNestedObject.tree,
      { minKeys: 1, maxKeys: 6 },
    );

  /**
   * Helper: recursively checks that Object.isFrozen is true for the root
   * and every nested object and array.
   */
  function assertDeeplyFrozen(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    expect(Object.isFrozen(value)).toBe(true);
    if (Array.isArray(value)) {
      for (const item of value) {
        assertDeeplyFrozen(item);
      }
    } else {
      for (const key of Object.getOwnPropertyNames(value)) {
        assertDeeplyFrozen((value as Record<string, unknown>)[key]);
      }
    }
  }

  /**
   * Property 11: For any nested object, after deepFreeze, Object.isFrozen
   * returns true for the root and every nested object/array.
   *
   * **Validates: Requirements 11.2, 11.3, 11.4**
   */
  it("Object.isFrozen returns true for root and all nested objects/arrays", () => {
    fc.assert(
      fc.property(arbRootObject, (obj) => {
        const frozen = deepFreeze(obj);
        assertDeeplyFrozen(frozen);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 11: Attempting to assign a property on a frozen object throws TypeError.
   *
   * **Validates: Requirements 11.2, 11.3, 11.4**
   */
  it("assigning a property on the frozen object throws TypeError", () => {
    fc.assert(
      fc.property(arbRootObject, (obj) => {
        const frozen = deepFreeze(obj);
        const keys = Object.keys(frozen);
        if (keys.length > 0) {
          expect(() => {
            "use strict";
            (frozen as Record<string, unknown>)[keys[0]] = "mutated";
          }).toThrow(TypeError);
        }
        // Also try adding a new property
        expect(() => {
          "use strict";
          (frozen as Record<string, unknown>)["__new_prop__"] = "value";
        }).toThrow(TypeError);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 11: Attempting to push to a nested array throws TypeError.
   *
   * **Validates: Requirements 11.2, 11.3, 11.4**
   */
  it("pushing to a nested array throws TypeError", () => {
    /** Generate objects that always contain at least one array. */
    const arbObjectWithArray = fc
      .tuple(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { minLength: 0, maxLength: 5 }),
      )
      .map(([key, arr]) => ({ [key]: arr }));

    fc.assert(
      fc.property(arbObjectWithArray, (obj) => {
        const frozen = deepFreeze(obj);
        const key = Object.keys(frozen)[0];
        const arr = (frozen as Record<string, unknown>)[key] as unknown[];
        expect(() => {
          "use strict";
          arr.push("mutated");
        }).toThrow(TypeError);
      }),
      { numRuns: 100 },
    );
  });
});
