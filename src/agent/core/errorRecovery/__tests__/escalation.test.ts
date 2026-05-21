import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { consecutiveCount, shouldEscalate, ESCALATION_THRESHOLD } from "../escalation";
import type { ErrorCategory, ErrorHistoryEntry } from "../types";

describe("escalation", () => {
    describe("ESCALATION_THRESHOLD", () => {
        it("should be 3", () => {
            expect(ESCALATION_THRESHOLD).toBe(3);
        });
    });

    describe("consecutiveCount", () => {
        it("returns 0 for empty entries", () => {
            expect(consecutiveCount([], "PatchError")).toBe(0);
        });

        it("counts consecutive same-category errors at tail", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "parse", timestamp: 2, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 3, resolved: false },
            ];
            expect(consecutiveCount(entries, "PatchError")).toBe(3);
        });

        it("stops counting on resolved entry", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: true },
                { category: "PatchError", subcategory: "apply", timestamp: 3, resolved: false },
            ];
            expect(consecutiveCount(entries, "PatchError")).toBe(1);
        });

        it("stops counting on different category", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 2, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 3, resolved: false },
            ];
            expect(consecutiveCount(entries, "PatchError")).toBe(1);
        });

        it("returns 0 when tail category does not match", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 3, resolved: false },
            ];
            expect(consecutiveCount(entries, "PatchError")).toBe(0);
        });

        it("matches the task example: consecutiveCount(entries, 'LLMError') → 1", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 3, resolved: false },
            ];
            expect(consecutiveCount(entries, "LLMError")).toBe(1);
        });

        it("matches the task example: consecutiveCount(entries, 'PatchError') → 0", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 3, resolved: false },
            ];
            expect(consecutiveCount(entries, "PatchError")).toBe(0);
        });
    });

    describe("shouldEscalate", () => {
        it("returns false when consecutive count is below threshold", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: false },
            ];
            expect(shouldEscalate(entries, "PatchError")).toBe(false);
        });

        it("returns true when consecutive count equals threshold", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 3, resolved: false },
            ];
            expect(shouldEscalate(entries, "PatchError")).toBe(true);
        });

        it("returns true when consecutive count exceeds threshold", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 2, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 3, resolved: false },
                { category: "PatchError", subcategory: "apply", timestamp: 4, resolved: false },
            ];
            expect(shouldEscalate(entries, "PatchError")).toBe(true);
        });

        it("returns false for empty entries", () => {
            expect(shouldEscalate([], "LLMError")).toBe(false);
        });

        it("respects resolved entries resetting the count", () => {
            const entries: readonly ErrorHistoryEntry[] = [
                { category: "LLMError", subcategory: "timeout", timestamp: 1, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 2, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 3, resolved: true },
                { category: "LLMError", subcategory: "timeout", timestamp: 4, resolved: false },
                { category: "LLMError", subcategory: "timeout", timestamp: 5, resolved: false },
            ];
            expect(shouldEscalate(entries, "LLMError")).toBe(false);
        });
    });

    /**
     * Property 10: Consecutive count resets on success
     * **Validates: Requirements 7.4**
     *
     * For any ErrorHistory where the last entry with resolved: true for a given category
     * is followed by fewer than 3 unresolved entries of that same category,
     * consecutiveCount SHALL return the count of unresolved entries after the last
     * resolved entry (not the total count of all entries of that category).
     */
    describe("Property 10: Consecutive count resets on success", () => {
        const categories: ErrorCategory[] = ["PatchError", "LLMError", "ShellError", "FsError", "unknown"];

        const subcategoryFor = (category: ErrorCategory): ErrorHistoryEntry["subcategory"] => {
            switch (category) {
                case "PatchError": return "apply";
                case "LLMError": return "timeout";
                default: return undefined;
            }
        };

        const arbCategory: fc.Arbitrary<ErrorCategory> = fc.constantFrom(...categories);

        const arbEntryForCategory = (category: ErrorCategory): fc.Arbitrary<ErrorHistoryEntry> =>
            fc.record({
                category: fc.constant(category) as fc.Arbitrary<ErrorCategory>,
                subcategory: fc.constant(subcategoryFor(category)),
                timestamp: fc.nat({ max: 1_000_000_000 }),
                resolved: fc.boolean(),
            });

        const arbEntry: fc.Arbitrary<ErrorHistoryEntry> =
            arbCategory.chain((cat) => arbEntryForCategory(cat));

        it("returns 0 when the last entry is resolved and matches the queried category", () => {
            fc.assert(
                fc.property(
                    fc.array(arbEntry, { minLength: 0, maxLength: 20 }),
                    arbCategory,
                    (prefix, category) => {
                        const resolvedTail: ErrorHistoryEntry = {
                            category,
                            subcategory: subcategoryFor(category),
                            timestamp: 999_999_999,
                            resolved: true,
                        };
                        const entries = [...prefix, resolvedTail];
                        expect(consecutiveCount(entries, category)).toBe(0);
                    }
                ),
                { numRuns: 200 }
            );
        });

        it("returns 0 when N unresolved entries of category C are followed by a resolved entry of category C", () => {
            fc.assert(
                fc.property(
                    fc.array(arbEntry, { minLength: 0, maxLength: 10 }),
                    arbCategory,
                    fc.integer({ min: 1, max: 10 }),
                    (prefix, category, n) => {
                        const unresolvedBlock: ErrorHistoryEntry[] = Array.from({ length: n }, (_, i) => ({
                            category,
                            subcategory: subcategoryFor(category),
                            timestamp: 1_000_000 + i,
                            resolved: false,
                        }));
                        const resolvedEntry: ErrorHistoryEntry = {
                            category,
                            subcategory: subcategoryFor(category),
                            timestamp: 2_000_000,
                            resolved: true,
                        };
                        const entries = [...prefix, ...unresolvedBlock, resolvedEntry];
                        expect(consecutiveCount(entries, category)).toBe(0);
                    }
                ),
                { numRuns: 200 }
            );
        });

        it("counts only unresolved entries after the last resolved entry of the same category", () => {
            fc.assert(
                fc.property(
                    fc.array(arbEntry, { minLength: 0, maxLength: 10 }),
                    arbCategory,
                    fc.integer({ min: 0, max: 10 }),
                    (prefix, category, tailCount) => {
                        const resolvedEntry: ErrorHistoryEntry = {
                            category,
                            subcategory: subcategoryFor(category),
                            timestamp: 1_000_000,
                            resolved: true,
                        };
                        const unresolvedTail: ErrorHistoryEntry[] = Array.from({ length: tailCount }, (_, i) => ({
                            category,
                            subcategory: subcategoryFor(category),
                            timestamp: 2_000_000 + i,
                            resolved: false,
                        }));
                        const entries = [...prefix, resolvedEntry, ...unresolvedTail];
                        expect(consecutiveCount(entries, category)).toBe(tailCount);
                    }
                ),
                { numRuns: 200 }
            );
        });
    });
});
