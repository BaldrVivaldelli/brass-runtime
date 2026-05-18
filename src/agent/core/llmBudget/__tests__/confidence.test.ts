import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { estimateConfidence, extractConfidenceSignals } from "../confidence";

/**
 * Property 8: ConfidenceEstimator output bounds and determinism
 *
 * **Validates: Requirements 4.1, 4.7**
 *
 * For any response content string and any goal/readFiles inputs,
 * `estimateConfidence` SHALL return a score in the closed interval [0.0, 1.0].
 * Calling `estimateConfidence` twice with identical inputs SHALL produce
 * identical outputs. The signals object always has the expected shape
 * (all boolean fields + hedgingCount as number >= 0).
 */
describe("Property 8: ConfidenceEstimator output bounds and determinism", () => {
    it("estimateConfidence returns a score in [0.0, 1.0] for any inputs", () => {
        fc.assert(
            fc.property(
                fc.string(),
                fc.string(),
                fc.array(fc.string()),
                (response, goal, readFiles) => {
                    const { score } = estimateConfidence(response, goal, readFiles);
                    expect(score).toBeGreaterThanOrEqual(0.0);
                    expect(score).toBeLessThanOrEqual(1.0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("estimateConfidence is deterministic: same inputs produce same score", () => {
        fc.assert(
            fc.property(
                fc.string(),
                fc.string(),
                fc.array(fc.string()),
                (response, goal, readFiles) => {
                    const result1 = estimateConfidence(response, goal, readFiles);
                    const result2 = estimateConfidence(response, goal, readFiles);
                    expect(result1.score).toBe(result2.score);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("signals object has the expected shape with correct field types", () => {
        fc.assert(
            fc.property(
                fc.string(),
                fc.string(),
                fc.array(fc.string()),
                (response, goal, readFiles) => {
                    const signals = extractConfidenceSignals(response, goal, readFiles);
                    expect(typeof signals.hasDiffBlock).toBe("boolean");
                    expect(typeof signals.isConcise).toBe("boolean");
                    expect(typeof signals.referencesGoal).toBe("boolean");
                    expect(typeof signals.referencesReadFiles).toBe("boolean");
                    expect(typeof signals.hedgingCount).toBe("number");
                    expect(signals.hedgingCount).toBeGreaterThanOrEqual(0);
                    expect(Number.isInteger(signals.hedgingCount)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });
});

/**
 * Property 9: ConfidenceEstimator diff block signal increases confidence
 *
 * **Validates: Requirements 4.2**
 *
 * For any response content string without a fenced diff block and any goal/readFiles,
 * appending a valid fenced diff block to the response SHALL result in
 * `estimateConfidence` returning a score greater than or equal to the score
 * without the diff block.
 */
describe("Property 9: ConfidenceEstimator diff block signal increases confidence", () => {
    const diffBlock = [
        "```diff",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,3 +1,3 @@",
        "-old line",
        "+new line",
        "```",
    ].join("\n");

    it("appending a diff block to any response produces a score >= the score without it", () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 0, maxLength: 500 }),
                fc.string({ minLength: 0, maxLength: 100 }),
                fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 5 }),
                (baseResponse, goal, readFiles) => {
                    // Ensure the base response does NOT already contain a diff block
                    const cleanResponse = baseResponse
                        .replace(/```diff/g, "")
                        .replace(/^---\s/gm, "")
                        .replace(/^\+\+\+\s/gm, "");

                    const withoutDiff = estimateConfidence(cleanResponse, goal, readFiles);
                    const withDiff = estimateConfidence(cleanResponse + "\n" + diffBlock, goal, readFiles);

                    expect(withDiff.score).toBeGreaterThanOrEqual(withoutDiff.score);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("a response with a diff block always has hasDiffBlock signal set to true", () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 0, maxLength: 500 }),
                (baseResponse) => {
                    const response = baseResponse + "\n" + diffBlock;
                    const result = estimateConfidence(response, "some goal", []);
                    expect(result.signals.hasDiffBlock).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("the diff bonus contributes at least 0.20 to the score when conciseness is unchanged", () => {
        fc.assert(
            fc.property(
                // Keep base response short enough that adding diff block won't cross 2000 char threshold
                fc.string({ minLength: 0, maxLength: 200 }),
                (baseResponse) => {
                    // Remove anything that could trigger diff detection in the base
                    const cleanResponse = baseResponse
                        .replace(/```diff/g, "")
                        .replace(/^---\s/gm, "")
                        .replace(/^\+\+\+\s/gm, "");

                    const withoutDiff = estimateConfidence(cleanResponse, "", []);
                    const withDiff = estimateConfidence(cleanResponse + "\n" + diffBlock, "", []);

                    // Both responses are short enough to be concise, so the only
                    // signal difference is the diff block (+0.20)
                    if (withoutDiff.signals.isConcise && withDiff.signals.isConcise) {
                        expect(withDiff.score - withoutDiff.score).toBeCloseTo(0.20, 10);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});

/**
 * Property 10: ConfidenceEstimator hedging language decreases confidence
 *
 * **Validates: Requirements 4.5**
 *
 * For any response content string without hedging phrases and any AgentState,
 * inserting one or more hedging phrases ("I think", "maybe", "perhaps",
 * "not sure", "might be", "could be") into the response SHALL result in
 * `estimateConfidence` returning a score less than or equal to the score
 * without hedging phrases. The penalty is -0.10 per phrase, capped at -0.30.
 * More hedging phrases = lower or equal score (monotonically non-increasing
 * with hedging count).
 */
describe("Property 10: ConfidenceEstimator hedging language decreases confidence", () => {
    const HEDGING_PHRASES = [
        "I think",
        "maybe",
        "perhaps",
        "not sure",
        "might be",
        "could be",
    ] as const;

    /**
     * Generates a base response string that does NOT contain any hedging phrases.
     * Uses word-based generation to avoid accidental matches with hedging phrases.
     */
    const safeWords = [
        "the", "code", "function", "returns", "value", "data",
        "output", "result", "file", "module", "class", "method",
        "array", "object", "string", "number", "boolean", "type",
        "import", "export", "const", "let", "var", "async", "await",
        "loop", "condition", "parameter", "argument", "callback",
    ];

    const arbBaseResponse: fc.Arbitrary<string> = fc
        .array(fc.constantFrom(...safeWords), { minLength: 5, maxLength: 50 })
        .map((words) => words.join(" "));

    /**
     * Generates a goal string for the confidence estimator context.
     */
    const arbGoal: fc.Arbitrary<string> = fc.string({ minLength: 5, maxLength: 100 });

    /**
     * Generates a list of read file paths for context.
     */
    const arbReadFiles: fc.Arbitrary<readonly string[]> = fc.array(
        fc.string({ minLength: 3, maxLength: 30 }),
        { minLength: 0, maxLength: 5 },
    );

    /**
     * Generates a count of hedging phrases to inject (1 to 6).
     */
    const arbHedgingCount: fc.Arbitrary<number> = fc.integer({ min: 1, max: 6 });

    it("adding hedging phrases decreases or maintains confidence score", () => {
        fc.assert(
            fc.property(
                arbBaseResponse,
                arbGoal,
                arbReadFiles,
                arbHedgingCount,
                (baseResponse, goal, readFiles, hedgingCount) => {
                    // Score without hedging
                    const { score: baseScore } = estimateConfidence(
                        baseResponse,
                        goal,
                        readFiles,
                    );

                    // Inject hedging phrases into the response
                    const phrasesToInject = Array.from(
                        { length: hedgingCount },
                        (_, i) => HEDGING_PHRASES[i % HEDGING_PHRASES.length],
                    );
                    const hedgedResponse =
                        baseResponse + " " + phrasesToInject.join(". ") + ".";

                    const { score: hedgedScore } = estimateConfidence(
                        hedgedResponse,
                        goal,
                        readFiles,
                    );

                    // Hedging should decrease or maintain score (due to clamping at 0)
                    expect(hedgedScore).toBeLessThanOrEqual(baseScore);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("more hedging phrases result in monotonically non-increasing scores", () => {
        fc.assert(
            fc.property(
                arbBaseResponse,
                arbGoal,
                arbReadFiles,
                (baseResponse, goal, readFiles) => {
                    // Compute scores for 0, 1, 2, 3, 4 hedging phrases
                    const scores: number[] = [];

                    for (let count = 0; count <= 4; count++) {
                        const phrasesToInject = Array.from(
                            { length: count },
                            (_, i) => HEDGING_PHRASES[i % HEDGING_PHRASES.length],
                        );
                        const response =
                            count === 0
                                ? baseResponse
                                : baseResponse +
                                  " " +
                                  phrasesToInject.join(". ") +
                                  ".";

                        const { score } = estimateConfidence(
                            response,
                            goal,
                            readFiles,
                        );
                        scores.push(score);
                    }

                    // Each successive score should be <= the previous one
                    for (let i = 1; i < scores.length; i++) {
                        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
                    }
                },
            ),
            { numRuns: 200 },
        );
    });

    it("hedging penalty is -0.10 per phrase, capped at -0.30 total", () => {
        fc.assert(
            fc.property(
                arbBaseResponse,
                arbGoal,
                arbReadFiles,
                fc.integer({ min: 1, max: 6 }),
                (baseResponse, goal, readFiles, hedgingCount) => {
                    const { score: baseScore } = estimateConfidence(
                        baseResponse,
                        goal,
                        readFiles,
                    );

                    // Inject distinct hedging phrases
                    const phrasesToInject = Array.from(
                        { length: hedgingCount },
                        (_, i) => HEDGING_PHRASES[i % HEDGING_PHRASES.length],
                    );
                    const hedgedResponse =
                        baseResponse + " " + phrasesToInject.join(". ") + ".";

                    const { score: hedgedScore } = estimateConfidence(
                        hedgedResponse,
                        goal,
                        readFiles,
                    );

                    // Expected penalty: min(count * 0.10, 0.30)
                    const expectedPenalty = Math.min(hedgingCount * 0.10, 0.30);

                    // The actual difference should be at most the expected penalty
                    // (could be less due to clamping at 0.0)
                    const actualDifference = baseScore - hedgedScore;

                    // The difference should equal the expected penalty OR
                    // the hedged score is clamped at 0.0
                    if (hedgedScore > 0.0) {
                        expect(actualDifference).toBeCloseTo(expectedPenalty, 10);
                    } else {
                        // When clamped at 0, the actual difference is <= expected penalty
                        expect(actualDifference).toBeLessThanOrEqual(
                            expectedPenalty + 1e-10,
                        );
                    }
                },
            ),
            { numRuns: 200 },
        );
    });
});
