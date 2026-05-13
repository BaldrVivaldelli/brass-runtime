import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
    recordAbortablePromiseStart,
    recordAbortablePromiseFinish,
    abortablePromiseStats,
    resetAbortablePromiseStats,
    setAbortablePromisePerLabelTracking,
    type AbortablePromiseOutcome,
} from "../runtime";

// Feature: http-p99-consolidation, Property 7: Diagnostics hot path — global-only tracking

/**
 * **Validates: Requirements 5.1, 5.4**
 *
 * Property 7: Diagnostics hot path — global-only tracking
 *
 * For any sequence of recordAbortablePromiseStart and recordAbortablePromiseFinish
 * calls with arbitrary labels and outcomes, when per-label tracking is disabled,
 * the per-label Map SHALL remain empty (size 0) AND the global totals SHALL
 * correctly reflect the sum of all starts, finishes, and outcome categories.
 */

const outcomes: AbortablePromiseOutcome[] = ["success", "failure", "interrupt", "timeout"];

const arbOutcome = fc.constantFrom(...outcomes);

const arbLabelOutcomePair = fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }),
    arbOutcome,
);

describe("Diagnostics hot path — global-only tracking (Property 7)", () => {
    beforeEach(() => {
        resetAbortablePromiseStats();
        setAbortablePromisePerLabelTracking(false);
    });

    afterEach(() => {
        resetAbortablePromiseStats();
        setAbortablePromisePerLabelTracking(false);
    });

    it("per-label Map remains empty and global totals match expected counts when per-label tracking is disabled", () => {
        fc.assert(
            fc.property(
                fc.array(arbLabelOutcomePair, { minLength: 1, maxLength: 200 }),
                (pairs) => {
                    // Reset state for each run
                    resetAbortablePromiseStats();
                    setAbortablePromisePerLabelTracking(false);

                    // Expected counters
                    let expectedStarted = 0;
                    let expectedSucceeded = 0;
                    let expectedFailed = 0;
                    let expectedInterrupted = 0;
                    let expectedTimedOut = 0;

                    // Record start and finish for each pair
                    for (const [label, outcome] of pairs) {
                        recordAbortablePromiseStart(label);
                        expectedStarted++;

                        recordAbortablePromiseFinish(label, outcome);
                        switch (outcome) {
                            case "success":
                                expectedSucceeded++;
                                break;
                            case "failure":
                                expectedFailed++;
                                break;
                            case "interrupt":
                                expectedInterrupted++;
                                break;
                            case "timeout":
                                expectedTimedOut++;
                                break;
                        }
                    }

                    const stats = abortablePromiseStats();

                    // Assert per-label Map is empty (Requirement 5.1)
                    expect(stats.byLabel).toHaveLength(0);

                    // Assert global totals correctly reflect all operations (Requirement 5.4)
                    // active should be 0 since every start has a matching finish
                    expect(stats.active).toBe(0);
                    expect(stats.started).toBe(expectedStarted);
                    expect(stats.succeeded).toBe(expectedSucceeded);
                    expect(stats.failed).toBe(expectedFailed);
                    expect(stats.interrupted).toBe(expectedInterrupted);
                    expect(stats.timedOut).toBe(expectedTimedOut);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("global totals track active count correctly with interleaved starts and finishes", () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.tuple(
                        fc.string({ minLength: 1, maxLength: 20 }),
                        arbOutcome,
                        fc.boolean(), // whether to finish immediately or defer
                    ),
                    { minLength: 1, maxLength: 100 },
                ),
                (entries) => {
                    resetAbortablePromiseStats();
                    setAbortablePromisePerLabelTracking(false);

                    const pending: Array<{ label: string; outcome: AbortablePromiseOutcome }> = [];
                    let expectedStarted = 0;
                    let expectedSucceeded = 0;
                    let expectedFailed = 0;
                    let expectedInterrupted = 0;
                    let expectedTimedOut = 0;

                    for (const [label, outcome, finishNow] of entries) {
                        recordAbortablePromiseStart(label);
                        expectedStarted++;

                        if (finishNow) {
                            recordAbortablePromiseFinish(label, outcome);
                            switch (outcome) {
                                case "success": expectedSucceeded++; break;
                                case "failure": expectedFailed++; break;
                                case "interrupt": expectedInterrupted++; break;
                                case "timeout": expectedTimedOut++; break;
                            }
                        } else {
                            pending.push({ label, outcome });
                        }
                    }

                    // Check intermediate state — byLabel still empty
                    const midStats = abortablePromiseStats();
                    expect(midStats.byLabel).toHaveLength(0);
                    expect(midStats.active).toBe(pending.length);

                    // Finish all pending
                    for (const { label, outcome } of pending) {
                        recordAbortablePromiseFinish(label, outcome);
                        switch (outcome) {
                            case "success": expectedSucceeded++; break;
                            case "failure": expectedFailed++; break;
                            case "interrupt": expectedInterrupted++; break;
                            case "timeout": expectedTimedOut++; break;
                        }
                    }

                    const stats = abortablePromiseStats();

                    // Per-label remains empty
                    expect(stats.byLabel).toHaveLength(0);

                    // Global totals are correct
                    expect(stats.active).toBe(0);
                    expect(stats.started).toBe(expectedStarted);
                    expect(stats.succeeded).toBe(expectedSucceeded);
                    expect(stats.failed).toBe(expectedFailed);
                    expect(stats.interrupted).toBe(expectedInterrupted);
                    expect(stats.timedOut).toBe(expectedTimedOut);
                },
            ),
            { numRuns: 100 },
        );
    });
});
