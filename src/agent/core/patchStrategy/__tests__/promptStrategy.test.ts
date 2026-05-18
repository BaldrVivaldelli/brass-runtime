import { describe, it, expect } from "vitest";
import { strategyPromptFragment } from "../promptStrategy";
import type { PatchStrategy } from "../types";
import { PATCH_STRATEGIES } from "../types";

/**
 * Property-based tests for strategy-specific prompt differentiation.
 * Feature: adaptive-patch-strategy
 */

describe("promptStrategy property tests", () => {
    /**
     * Property 12: Strategy-specific prompt differentiation
     *
     * For each of the three PatchStrategy values, strategyPromptFragment returns
     * a non-empty string, and the strings for distinct strategies are non-equal.
     *
     * Feature: adaptive-patch-strategy, Property 12: Strategy-specific prompt differentiation
     * **Validates: Requirements 8.1, 8.2, 8.3**
     */
    describe("Property 12: Strategy-specific prompt differentiation", () => {
        it("each strategy returns a non-empty string", () => {
            for (const strategy of PATCH_STRATEGIES) {
                const fragment = strategyPromptFragment(strategy);
                expect(typeof fragment).toBe("string");
                expect(fragment.length).toBeGreaterThan(0);
            }
        });

        it("distinct strategies produce distinct prompt fragments", () => {
            const fragments = new Map<PatchStrategy, string>();
            for (const strategy of PATCH_STRATEGIES) {
                fragments.set(strategy, strategyPromptFragment(strategy));
            }

            // All pairs are distinct
            const strategies = [...PATCH_STRATEGIES];
            for (let i = 0; i < strategies.length; i++) {
                for (let j = i + 1; j < strategies.length; j++) {
                    expect(fragments.get(strategies[i]!)).not.toBe(fragments.get(strategies[j]!));
                }
            }
        });

        it("fragments are stable across repeated calls", () => {
            for (const strategy of PATCH_STRATEGIES) {
                const first = strategyPromptFragment(strategy);
                const second = strategyPromptFragment(strategy);
                expect(first).toBe(second);
            }
        });
    });
});
