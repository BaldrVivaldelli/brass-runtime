import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { estimateTokens } from "../estimation";

describe("Property 6: Character-based token estimation", () => {
    /**
     * Validates: Requirements 2.5, 8.3
     */

    it("inputTokens equals Math.ceil(n / 4) for all non-negative integers n", () => {
        fc.assert(
            fc.property(fc.nat(), fc.nat(), (n, m) => {
                const result = estimateTokens(n, m);
                expect(result.inputTokens).toBe(Math.ceil(n / 4));
            }),
            { numRuns: 100 },
        );
    });

    it("outputTokens equals Math.ceil(m / 4) for all non-negative integers m", () => {
        fc.assert(
            fc.property(fc.nat(), fc.nat(), (n, m) => {
                const result = estimateTokens(n, m);
                expect(result.outputTokens).toBe(Math.ceil(m / 4));
            }),
            { numRuns: 100 },
        );
    });

    it("result tokens are always >= 0", () => {
        fc.assert(
            fc.property(fc.nat(), fc.nat(), (n, m) => {
                const result = estimateTokens(n, m);
                expect(result.inputTokens).toBeGreaterThanOrEqual(0);
                expect(result.outputTokens).toBeGreaterThanOrEqual(0);
            }),
            { numRuns: 100 },
        );
    });

    it("result tokens are always integers (whole numbers)", () => {
        fc.assert(
            fc.property(fc.nat(), fc.nat(), (n, m) => {
                const result = estimateTokens(n, m);
                expect(Number.isInteger(result.inputTokens)).toBe(true);
                expect(Number.isInteger(result.outputTokens)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });
});
