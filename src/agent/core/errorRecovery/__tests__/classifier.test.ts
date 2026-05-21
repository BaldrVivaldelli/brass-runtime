import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { classifyError } from "../classifier";
import type { AgentError } from "../../types";
import type { CategorizedError, PatchErrorSubcategory, LLMErrorSubcategory } from "../types";

/**
 * Property-based tests for classifyError.
 * Feature: adaptive-error-recovery, Property 1: Classification validity
 *
 * For any AgentError value with _tag in the set {PatchError, LLMError, ShellError, FsError},
 * classifyError SHALL return a CategorizedError whose category matches the _tag and whose
 * subcategory is a valid value for that category. For any AgentError with a _tag not in that
 * set, the category SHALL be "unknown" with subcategory undefined.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
 */

// --- Generators ---

const arbPatchError: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("PatchError" as const),
    operation: fc.string(),
    cause: fc.anything(),
    patch: fc.option(fc.string(), { nil: undefined }),
});

const arbLLMError: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("LLMError" as const),
    cause: fc.anything(),
});

const arbShellError: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("ShellError" as const),
    operation: fc.string(),
    command: fc.option(fc.array(fc.string(), { minLength: 1, maxLength: 5 }), { nil: undefined }),
    cause: fc.anything(),
});

const arbFsError: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("FsError" as const),
    operation: fc.string(),
    cause: fc.anything(),
});

const arbAgentAction = fc.oneof(
    fc.record({ type: fc.constant("fs.readFile" as const), path: fc.string() }),
    fc.record({ type: fc.constant("agent.finish" as const), summary: fc.string() }),
);

const arbPermissionDenied: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("PermissionDenied" as const),
    action: arbAgentAction,
    reason: fc.string(),
});

const arbApprovalRejected: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("ApprovalRejected" as const),
    action: arbAgentAction,
    reason: fc.string(),
});

const arbToolTimeout: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("ToolTimeout" as const),
    timeoutMs: fc.nat(),
});

const arbAgentLoopError: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("AgentLoopError" as const),
    message: fc.string(),
});

const arbPathOutsideWorkspace: fc.Arbitrary<AgentError> = fc.record({
    _tag: fc.constant("PathOutsideWorkspace" as const),
    path: fc.string(),
    cwd: fc.string(),
});

/** Generator for "unknown" category errors (tags not in the known set) */
const arbUnknownError: fc.Arbitrary<AgentError> = fc.oneof(
    arbPermissionDenied,
    arbApprovalRejected,
    arbToolTimeout,
    arbAgentLoopError,
    arbPathOutsideWorkspace,
);

/** Generator for any AgentError variant */
const arbAgentError: fc.Arbitrary<AgentError> = fc.oneof(
    arbPatchError,
    arbLLMError,
    arbShellError,
    arbFsError,
    arbUnknownError,
);

// --- Valid value sets ---

const validPatchSubcategories: readonly PatchErrorSubcategory[] = ["parse", "apply", "conflict"];
const validLLMSubcategories: readonly LLMErrorSubcategory[] = ["timeout", "rate-limit"];
const validCategories = ["PatchError", "LLMError", "ShellError", "FsError", "unknown"] as const;

// --- Property Tests ---

describe("classifyError - Property 1: Classification validity", () => {
    it("returns a valid CategorizedError with a category from the defined set for any AgentError", () => {
        fc.assert(
            fc.property(arbAgentError, (error) => {
                const result = classifyError(error);

                // Result must have a valid category
                expect(validCategories).toContain(result.category);
                // Result must preserve the raw error
                expect(result.raw).toBe(error);
            }),
            { numRuns: 200 },
        );
    });

    it("PatchError always maps to category 'PatchError' with subcategory in ['parse', 'apply', 'conflict']", () => {
        fc.assert(
            fc.property(arbPatchError, (error) => {
                const result = classifyError(error);

                expect(result.category).toBe("PatchError");
                expect(validPatchSubcategories).toContain(result.subcategory);
                expect(result.raw).toBe(error);
            }),
            { numRuns: 200 },
        );
    });

    it("LLMError always maps to category 'LLMError' with subcategory in ['timeout', 'rate-limit']", () => {
        fc.assert(
            fc.property(arbLLMError, (error) => {
                const result = classifyError(error);

                expect(result.category).toBe("LLMError");
                expect(validLLMSubcategories).toContain(result.subcategory);
                expect(result.raw).toBe(error);
            }),
            { numRuns: 200 },
        );
    });

    it("ShellError always maps to category 'ShellError' with subcategory undefined", () => {
        fc.assert(
            fc.property(arbShellError, (error) => {
                const result = classifyError(error);

                expect(result.category).toBe("ShellError");
                expect(result.subcategory).toBeUndefined();
                expect(result.raw).toBe(error);
            }),
            { numRuns: 200 },
        );
    });

    it("FsError always maps to category 'FsError' with subcategory undefined", () => {
        fc.assert(
            fc.property(arbFsError, (error) => {
                const result = classifyError(error);

                expect(result.category).toBe("FsError");
                expect(result.subcategory).toBeUndefined();
                expect(result.raw).toBe(error);
            }),
            { numRuns: 200 },
        );
    });

    it("other error tags map to category 'unknown' with subcategory undefined", () => {
        fc.assert(
            fc.property(arbUnknownError, (error) => {
                const result = classifyError(error);

                expect(result.category).toBe("unknown");
                expect(result.subcategory).toBeUndefined();
                expect(result.raw).toBe(error);
            }),
            { numRuns: 200 },
        );
    });

    it("classifyError is deterministic (same input → same output)", () => {
        fc.assert(
            fc.property(arbAgentError, (error) => {
                const result1 = classifyError(error);
                const result2 = classifyError(error);

                expect(result1.category).toBe(result2.category);
                expect(result1.subcategory).toBe(result2.subcategory);
                expect(result1.raw).toBe(result2.raw);
            }),
            { numRuns: 200 },
        );
    });
});
