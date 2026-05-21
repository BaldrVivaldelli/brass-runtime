import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { decideRecoveryAction, calculateBackoff, BASE_TIMEOUT_MS, RATE_LIMIT_WAIT_MS } from "../strategies";
import type {
    CategorizedError,
    ErrorCategory,
    ErrorHistory,
    ErrorHistoryEntry,
    LLMErrorSubcategory,
    PatchErrorSubcategory,
    RecoveryAction,
    RecoveryState,
} from "../types";
import type { AgentError } from "../../types";

// --- Generators ---

const arbAgentError: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("PatchError" as const),
    operation: fc.string(),
    cause: fc.anything(),
    patch: fc.option(fc.string(), { nil: undefined }),
});

const arbPatchSubcategory: fc.Arbitrary<PatchErrorSubcategory> =
    fc.constantFrom("parse", "apply", "conflict");

const arbLLMSubcategory: fc.Arbitrary<LLMErrorSubcategory> =
    fc.constantFrom("timeout", "rate-limit");

const arbErrorCategory: fc.Arbitrary<ErrorCategory> =
    fc.constantFrom("PatchError", "LLMError", "ShellError", "FsError", "unknown");

const arbSubcategoryFor = (category: ErrorCategory): fc.Arbitrary<PatchErrorSubcategory | LLMErrorSubcategory | undefined> => {
    switch (category) {
        case "PatchError": return arbPatchSubcategory;
        case "LLMError": return arbLLMSubcategory;
        default: return fc.constant(undefined);
    }
};

const arbErrorHistoryEntry: fc.Arbitrary<ErrorHistoryEntry> =
    arbErrorCategory.chain((category) =>
        fc.record({
            category: fc.constant(category) as fc.Arbitrary<ErrorCategory>,
            subcategory: arbSubcategoryFor(category),
            timestamp: fc.nat({ max: 1_000_000_000 }),
            resolved: fc.boolean(),
        })
    );

const arbErrorHistory: fc.Arbitrary<ErrorHistory> =
    fc.record({
        entries: fc.array(arbErrorHistoryEntry, { minLength: 0, maxLength: 20 }),
    });

const arbRecoveryState: fc.Arbitrary<RecoveryState> =
    arbErrorCategory.chain((category) =>
        fc.record({
            consecutiveCount: fc.nat({ max: 10 }),
            category: fc.constant(category) as fc.Arbitrary<ErrorCategory>,
            subcategory: arbSubcategoryFor(category),
            repairBudgetRemaining: fc.nat({ max: 5 }),
        })
    );

const arbFsError: fc.Arbitrary<CategorizedError> =
    arbAgentError.map((raw) => ({
        category: "FsError" as const,
        subcategory: undefined,
        raw,
    }));

const arbShellError: fc.Arbitrary<CategorizedError> =
    arbAgentError.map((raw) => ({
        category: "ShellError" as const,
        subcategory: undefined,
        raw,
    }));

const arbPatchError: fc.Arbitrary<CategorizedError> =
    fc.tuple(arbPatchSubcategory, arbAgentError).map(([subcategory, raw]) => ({
        category: "PatchError" as const,
        subcategory,
        raw,
    }));

const arbLLMError: fc.Arbitrary<CategorizedError> =
    fc.tuple(arbLLMSubcategory, arbAgentError).map(([subcategory, raw]) => ({
        category: "LLMError" as const,
        subcategory,
        raw,
    }));

const arbLLMTimeoutError: fc.Arbitrary<CategorizedError> =
    arbAgentError.map((raw) => ({
        category: "LLMError" as const,
        subcategory: "timeout" as const,
        raw,
    }));

const arbLLMRateLimitError: fc.Arbitrary<CategorizedError> =
    arbAgentError.map((raw) => ({
        category: "LLMError" as const,
        subcategory: "rate-limit" as const,
        raw,
    }));

const arbUnknownError: fc.Arbitrary<CategorizedError> =
    arbAgentError.map((raw) => ({
        category: "unknown" as const,
        subcategory: undefined,
        raw,
    }));

const arbCategorizedError: fc.Arbitrary<CategorizedError> =
    fc.oneof(arbFsError, arbShellError, arbPatchError, arbLLMError, arbUnknownError);

/**
 * Helper: build an ErrorHistory with exactly N consecutive unresolved entries
 * of the given category at the tail.
 */
const buildHistoryWithConsecutive = (
    category: ErrorCategory,
    count: number,
    prefix: readonly ErrorHistoryEntry[] = [],
): ErrorHistory => {
    const subcategory = category === "PatchError" ? "apply"
        : category === "LLMError" ? "timeout"
        : undefined;
    const tail: ErrorHistoryEntry[] = Array.from({ length: count }, (_, i) => ({
        category,
        subcategory: subcategory as PatchErrorSubcategory | LLMErrorSubcategory | undefined,
        timestamp: 1_000_000 + i,
        resolved: false,
    }));
    return { entries: [...prefix, ...tail] };
};

/**
 * Helper: build an ErrorHistory that does NOT trigger escalation for the given category.
 * Ensures fewer than 3 consecutive unresolved entries of that category at the tail.
 */
const arbNonEscalatingHistory = (category: ErrorCategory): fc.Arbitrary<ErrorHistory> =>
    fc.integer({ min: 0, max: 2 }).map((count) => buildHistoryWithConsecutive(category, count));

// --- Valid action types ---
const validActionTypes = ["retry", "wait", "skip", "escalate", "terminate"] as const;

// --- Property Tests ---

/**
 * Property 2: FsError produces only terminate actions
 * **Validates: Requirements 6.1, 6.2, 11.3**
 *
 * For any RecoveryState and ErrorHistory, when error.category is "FsError",
 * result.type is always "terminate".
 */
describe("Property 2: FsError produces only terminate actions", () => {
    it("always returns terminate for FsError regardless of state and history", () => {
        fc.assert(
            fc.property(arbFsError, arbRecoveryState, arbErrorHistory, (error, state, history) => {
                const result = decideRecoveryAction(error, state, history);
                expect(result.type).toBe("terminate");
            }),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 3: ShellError produces only skip actions
 * **Validates: Requirements 5.1, 5.2, 5.3, 7.3, 11.4**
 *
 * For any RecoveryState and ErrorHistory (including histories with 3+ consecutive ShellErrors),
 * when error.category is "ShellError", result.type is always "skip".
 */
describe("Property 3: ShellError produces only skip actions", () => {
    it("always returns skip for ShellError regardless of state and history", () => {
        fc.assert(
            fc.property(arbShellError, arbRecoveryState, arbErrorHistory, (error, state, history) => {
                const result = decideRecoveryAction(error, state, history);
                expect(result.type).toBe("skip");
            }),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 4: PatchError retry includes subcategory context
 * **Validates: Requirements 2.1, 2.3**
 *
 * When PatchError with budget remaining and no escalation,
 * result.type is "retry" and result.errorContext matches the subcategory.
 */
describe("Property 4: PatchError retry includes subcategory context", () => {
    it("returns retry with errorContext matching subcategory when budget remains and no escalation", () => {
        fc.assert(
            fc.property(
                arbPatchError,
                fc.integer({ min: 1, max: 5 }),
                arbNonEscalatingHistory("PatchError"),
                (error, budget, history) => {
                    const state: RecoveryState = {
                        consecutiveCount: 0,
                        category: "PatchError",
                        subcategory: error.subcategory,
                        repairBudgetRemaining: budget,
                    };
                    const result = decideRecoveryAction(error, state, history);
                    expect(result.type).toBe("retry");
                    if (result.type === "retry") {
                        expect(result.errorContext).toBe(error.subcategory);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 5: PatchError budget exhaustion produces terminate
 * **Validates: Requirements 2.2**
 *
 * When PatchError with repairBudgetRemaining = 0 and no escalation,
 * result.type is "terminate".
 */
describe("Property 5: PatchError budget exhaustion produces terminate", () => {
    it("returns terminate when PatchError budget is exhausted and no escalation", () => {
        fc.assert(
            fc.property(
                arbPatchError,
                arbNonEscalatingHistory("PatchError"),
                (error, history) => {
                    const state: RecoveryState = {
                        consecutiveCount: 0,
                        category: "PatchError",
                        subcategory: error.subcategory,
                        repairBudgetRemaining: 0,
                    };
                    const result = decideRecoveryAction(error, state, history);
                    expect(result.type).toBe("terminate");
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 6: PatchError escalation to propose mode
 * **Validates: Requirements 7.1**
 *
 * When PatchError with >= 3 consecutive PatchErrors in history,
 * result.type is "escalate" and result.targetMode is "propose".
 */
describe("Property 6: PatchError escalation to propose mode", () => {
    it("returns escalate with targetMode 'propose' when escalation threshold is reached", () => {
        fc.assert(
            fc.property(
                arbPatchError,
                arbRecoveryState,
                fc.integer({ min: 3, max: 10 }),
                (error, state, consecutiveErrors) => {
                    const history = buildHistoryWithConsecutive("PatchError", consecutiveErrors);
                    const result = decideRecoveryAction(error, state, history);
                    expect(result.type).toBe("escalate");
                    if (result.type === "escalate") {
                        expect(result.targetMode).toBe("propose");
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 7: LLM timeout exponential backoff
 * **Validates: Requirements 3.1, 3.2, 3.3, 11.5**
 *
 * When LLMError.timeout with no escalation, result.type is "wait" and
 * result.durationMs equals 1000 * 2^(consecutiveCount-1).
 */
describe("Property 7: LLM timeout exponential backoff", () => {
    it("returns wait with correct exponential backoff duration", () => {
        fc.assert(
            fc.property(
                arbLLMTimeoutError,
                fc.integer({ min: 1, max: 2 }),
                (error, consecutiveErrors) => {
                    const history = buildHistoryWithConsecutive("LLMError", consecutiveErrors);
                    const state: RecoveryState = {
                        consecutiveCount: consecutiveErrors,
                        category: "LLMError",
                        subcategory: "timeout",
                        repairBudgetRemaining: 0,
                    };
                    const result = decideRecoveryAction(error, state, history);
                    expect(result.type).toBe("wait");
                    if (result.type === "wait") {
                        const expectedMs = BASE_TIMEOUT_MS * Math.pow(2, consecutiveErrors - 1);
                        expect(result.durationMs).toBe(expectedMs);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 8: LLM rate-limit fixed wait duration
 * **Validates: Requirements 4.1**
 *
 * When LLMError.rate-limit with no escalation, result.type is "wait" and
 * result.durationMs is always 30000.
 */
describe("Property 8: LLM rate-limit fixed wait duration", () => {
    it("returns wait with fixed 30000ms duration for rate-limit errors", () => {
        fc.assert(
            fc.property(
                arbLLMRateLimitError,
                arbRecoveryState,
                arbNonEscalatingHistory("LLMError"),
                (error, state, history) => {
                    const result = decideRecoveryAction(error, state, history);
                    expect(result.type).toBe("wait");
                    if (result.type === "wait") {
                        expect(result.durationMs).toBe(RATE_LIMIT_WAIT_MS);
                        expect(result.durationMs).toBe(30000);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 9: LLM escalation produces terminate
 * **Validates: Requirements 3.4, 4.2, 7.2**
 *
 * When LLMError with >= 3 consecutive LLMErrors in history,
 * result.type is "terminate".
 */
describe("Property 9: LLM escalation produces terminate", () => {
    it("returns terminate when LLMError escalation threshold is reached", () => {
        fc.assert(
            fc.property(
                arbLLMError,
                arbRecoveryState,
                fc.integer({ min: 3, max: 10 }),
                (error, state, consecutiveErrors) => {
                    const history = buildHistoryWithConsecutive("LLMError", consecutiveErrors);
                    const result = decideRecoveryAction(error, state, history);
                    expect(result.type).toBe("terminate");
                },
            ),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 11: Output is always a valid RecoveryAction
 * **Validates: Requirements 11.2**
 *
 * For any CategorizedError, RecoveryState, and ErrorHistory,
 * the result type is one of: "retry", "wait", "skip", "escalate", "terminate".
 */
describe("Property 11: Output is always a valid RecoveryAction", () => {
    it("always returns a valid RecoveryAction type for any inputs", () => {
        fc.assert(
            fc.property(arbCategorizedError, arbRecoveryState, arbErrorHistory, (error, state, history) => {
                const result = decideRecoveryAction(error, state, history);
                expect(result).toBeDefined();
                expect(result.type).toBeDefined();
                expect(validActionTypes).toContain(result.type);
            }),
            { numRuns: 200 },
        );
    });

    it("never throws an exception for any valid inputs", () => {
        fc.assert(
            fc.property(arbCategorizedError, arbRecoveryState, arbErrorHistory, (error, state, history) => {
                expect(() => decideRecoveryAction(error, state, history)).not.toThrow();
            }),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 12: Determinism
 * **Validates: Requirements 8.2, 10.3**
 *
 * Calling decideRecoveryAction twice with identical inputs produces identical outputs.
 */
describe("Property 12: Determinism", () => {
    it("produces identical outputs for identical inputs", () => {
        fc.assert(
            fc.property(arbCategorizedError, arbRecoveryState, arbErrorHistory, (error, state, history) => {
                const result1 = decideRecoveryAction(error, state, history);
                const result2 = decideRecoveryAction(error, state, history);
                expect(result1).toStrictEqual(result2);
            }),
            { numRuns: 200 },
        );
    });
});

/**
 * Property 13: Backward compatibility with empty history
 * **Validates: Requirements 8.4, 10.1**
 *
 * With empty ErrorHistory, the function still produces valid results
 * (no crashes, no escalation).
 */
describe("Property 13: Backward compatibility with empty history", () => {
    const emptyHistory: ErrorHistory = { entries: [] };

    it("PatchError with remaining budget returns retry with empty history", () => {
        fc.assert(
            fc.property(
                arbPatchError,
                fc.integer({ min: 1, max: 5 }),
                (error, budget) => {
                    const state: RecoveryState = {
                        consecutiveCount: 0,
                        category: "PatchError",
                        subcategory: error.subcategory,
                        repairBudgetRemaining: budget,
                    };
                    const result = decideRecoveryAction(error, state, emptyHistory);
                    expect(result.type).toBe("retry");
                },
            ),
            { numRuns: 200 },
        );
    });

    it("non-PatchError (except ShellError) returns terminate with empty history", () => {
        fc.assert(
            fc.property(
                fc.oneof(arbFsError, arbLLMTimeoutError, arbLLMRateLimitError, arbUnknownError),
                arbRecoveryState,
                (error, state) => {
                    const result = decideRecoveryAction(error, state, emptyHistory);
                    // FsError → terminate, LLMError → wait (not escalated), unknown → terminate
                    // With empty history, no escalation occurs
                    if (error.category === "FsError" || error.category === "unknown") {
                        expect(result.type).toBe("terminate");
                    }
                    // LLMError with empty history → wait (no escalation)
                    if (error.category === "LLMError") {
                        expect(result.type).toBe("wait");
                    }
                },
            ),
            { numRuns: 200 },
        );
    });

    it("ShellError returns skip with empty history", () => {
        fc.assert(
            fc.property(arbShellError, arbRecoveryState, (error, state) => {
                const result = decideRecoveryAction(error, state, emptyHistory);
                expect(result.type).toBe("skip");
            }),
            { numRuns: 200 },
        );
    });

    it("never returns escalate with empty history", () => {
        fc.assert(
            fc.property(arbCategorizedError, arbRecoveryState, (error, state) => {
                const result = decideRecoveryAction(error, state, emptyHistory);
                expect(result.type).not.toBe("escalate");
            }),
            { numRuns: 200 },
        );
    });
});
