import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { makePreferencesStore } from "../store";
import { MAX_RUN_HISTORY_ENTRIES, emptyOutputPreferences } from "../types";
import type { OutputPreferences } from "../types";

describe("Feature: adaptive-output-verbosity", () => {
    describe("Property 11: Bounded history buffer", () => {
        /**
         * Validates: Requirements 9.2
         */
        it("recordRunDuration always produces runHistory.length <= 20 and oldest entries are discarded first", () => {
            const store = makePreferencesStore({
                path: "/tmp/test-prefs.json",
                fs: {
                    readFile: async () => "{}",
                    writeFile: async () => {},
                    mkdir: async () => {},
                },
            });

            fc.assert(
                fc.property(
                    fc.array(fc.nat(120_000), { minLength: 0, maxLength: 30 }),
                    fc.array(fc.nat(120_000), { minLength: 1, maxLength: 30 }),
                    (initialHistory, newDurations) => {
                        // Start with a preferences object that has some initial history (capped to 20)
                        const trimmedInitial = initialHistory.slice(-MAX_RUN_HISTORY_ENTRIES);
                        let prefs: OutputPreferences = {
                            ...emptyOutputPreferences(),
                            runHistory: trimmedInitial,
                        };

                        // Apply each new duration sequentially
                        for (const duration of newDurations) {
                            prefs = store.recordRunDuration(duration, prefs);

                            // Invariant: length never exceeds MAX_RUN_HISTORY_ENTRIES
                            expect(prefs.runHistory.length).toBeLessThanOrEqual(MAX_RUN_HISTORY_ENTRIES);
                        }

                        // Verify oldest entries are discarded first:
                        // The last entry should always be the most recently added duration
                        const lastAdded = newDurations[newDurations.length - 1];
                        expect(prefs.runHistory[prefs.runHistory.length - 1]).toBe(lastAdded);

                        // If we added more than MAX entries total, verify the retained entries
                        // are the most recent ones (oldest discarded first)
                        const allEntries = [...trimmedInitial, ...newDurations];
                        const expectedRetained = allEntries.slice(-MAX_RUN_HISTORY_ENTRIES);
                        expect([...prefs.runHistory]).toEqual(expectedRetained);
                    },
                ),
                { numRuns: 200 },
            );
        });
    });
});
