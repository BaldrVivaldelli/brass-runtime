import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { makeRunDurationTracker } from "../tracker";
import type { VerbosityLevel } from "../types";
import { ESCALATION_THRESHOLD_MS } from "../types";
import type { HostProfile } from "../../hostProfile";

const arbHostProfile: fc.Arbitrary<HostProfile> = fc.record({
    transport: fc.constantFrom("stdio", "terminal", "mcp", "extension", "ci", "unknown"),
    capabilities: fc.record({
        hasOwnLLM: fc.boolean(),
        wantsJson: fc.boolean(),
        supportsStreamingEvents: fc.boolean(),
        supportsMcp: fc.boolean(),
        canAskApproval: fc.boolean(),
        canRenderDiff: fc.boolean(),
        canApplyPatch: fc.boolean(),
        interactiveTty: fc.boolean(),
    }),
    constraints: fc.record({
        readOnlyByDefault: fc.boolean(),
        patchPreviewRequired: fc.boolean(),
        requireNoNetwork: fc.boolean(),
    }),
    identity: fc.option(fc.record({ name: fc.string(), confidence: fc.double({ min: 0, max: 1, noNaN: true }) }), { nil: undefined }),
    evidence: fc.constant([]),
});

describe("Feature: adaptive-output-verbosity", () => {
    describe("Property 9: Mid-run escalation correctness", () => {
        /**
         * Validates: Requirements 7.1, 7.2, 7.3
         */
        it("escalation only fires when level is 'minimal', duration > 30s, and transport is not 'ci'; fires at most once", () => {
            fc.assert(
                fc.property(
                    arbHostProfile,
                    fc.constantFrom("minimal" as const, "normal" as const, "verbose" as const),
                    fc.nat(120_000), // elapsed time in ms
                    fc.nat(5), // number of ticks
                    (hp, initialLevel, elapsed, tickCount) => {
                        let currentLevel: VerbosityLevel = initialLevel;

                        const filter = {
                            getLevel: () => currentLevel,
                            setLevel: (level: VerbosityLevel) => { currentLevel = level; },
                        };

                        let time = 0;
                        const tracker = makeRunDurationTracker({
                            filter,
                            hostProfile: hp,
                            now: () => time,
                            thresholdMs: ESCALATION_THRESHOLD_MS,
                        });

                        tracker.start();

                        // Advance time and tick multiple times
                        time = elapsed;
                        for (let i = 0; i < tickCount + 1; i++) {
                            tracker.tick();
                        }

                        const escalated = tracker.hasEscalated();

                        // Escalation should only fire when:
                        // 1. Initial level was "minimal"
                        // 2. Duration > threshold (30s)
                        // 3. Transport is not "ci"
                        const shouldEscalate =
                            initialLevel === "minimal" &&
                            elapsed > ESCALATION_THRESHOLD_MS &&
                            hp.transport !== "ci";

                        if (shouldEscalate) {
                            expect(escalated).toBe(true);
                            expect(currentLevel).toBe("normal");
                        } else {
                            expect(escalated).toBe(false);
                        }

                        // Verify at-most-once: tick again and level should not change further
                        const levelAfterEscalation = currentLevel;
                        time = elapsed + 60_000; // add more time
                        tracker.tick();
                        // If it escalated, level stays at "normal" (not "verbose")
                        if (escalated) {
                            expect(currentLevel).toBe(levelAfterEscalation);
                        }
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
