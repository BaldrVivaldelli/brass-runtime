import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { assignArm, deriveArmId } from "../armExtraction";

describe("Feature: adaptive-context-budget", () => {
  describe("Property 1: Arm assignment totality and uniqueness", () => {
    it("For any file path string, assignArm returns an Arm with non-empty id. No path is left unassigned.", () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const arm = assignArm(path);
          expect(arm).toBeDefined();
          expect(typeof arm.id).toBe("string");
          expect(arm.id.length).toBeGreaterThan(0);
          expect(typeof arm.pattern).toBe("string");
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 1.1, 1.3
     */
  });

  describe("Property 2: Arm assignment determinism", () => {
    it("For any file path string, deriveArmId(path) === deriveArmId(path) (deterministic).", () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const first = deriveArmId(path);
          const second = deriveArmId(path);
          expect(first).toBe(second);
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Validates: Requirements 1.2, 1.4
     */
  });
});
