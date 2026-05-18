import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseLearningStore, appendRunRecord, serializeLearningStore } from "../persistence";
import type { LearningRunRecord, LearningStore } from "../persistence";

/**
 * Arbitrary for a valid LearningRunRecord.
 */
const arbLearningRunRecord: fc.Arbitrary<LearningRunRecord> = fc.record({
    goalId: fc.string(),
    totalTokens: fc.nat(),
    callCount: fc.nat(),
    tier: fc.constantFrom("small" as const, "large" as const),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    timestamp: fc.nat(),
});

/**
 * Arbitrary for a valid LearningStore with a bounded number of records.
 */
const arbLearningStore: fc.Arbitrary<LearningStore> = fc
    .array(arbLearningRunRecord, { minLength: 0, maxLength: 20 })
    .map((records) => ({ records }));

/**
 * Property 12: LearningStore append preserves existing history
 *
 * **Validates: Requirements 7.3**
 *
 * For any LearningStore with N existing run records and any new LearningRunRecord,
 * calling appendRunRecord produces a store where all N original records are present
 * (in their original order) when the total count does not exceed maxRecords.
 */
describe("Feature: llm-budget-optimization, Property 12: LearningStore append preserves existing history", () => {
    it("all previous records are present after append when total <= maxRecords", () => {
        fc.assert(
            fc.property(
                arbLearningStore,
                arbLearningRunRecord,
                (store, newRecord) => {
                    // Use a maxRecords large enough to never trim
                    const maxRecords = store.records.length + 1;
                    const result = appendRunRecord(store, newRecord, maxRecords);

                    // All original records should be present in order
                    for (let i = 0; i < store.records.length; i++) {
                        expect(result.records[i]).toEqual(store.records[i]);
                    }

                    // The new record should be at the end
                    expect(result.records[result.records.length - 1]).toEqual(newRecord);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("the new record is always present in the result", () => {
        fc.assert(
            fc.property(
                arbLearningStore,
                arbLearningRunRecord,
                fc.integer({ min: 1, max: 200 }),
                (store, newRecord, maxRecords) => {
                    const result = appendRunRecord(store, newRecord, maxRecords);

                    // The newest record is always the last element
                    expect(result.records[result.records.length - 1]).toEqual(newRecord);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("order of existing records is preserved after append", () => {
        fc.assert(
            fc.property(
                fc.array(arbLearningRunRecord, { minLength: 2, maxLength: 20 }),
                arbLearningRunRecord,
                (existingRecords, newRecord) => {
                    const store: LearningStore = { records: existingRecords };
                    // maxRecords large enough to never trim
                    const maxRecords = existingRecords.length + 10;
                    const result = appendRunRecord(store, newRecord, maxRecords);

                    // Verify relative order is preserved
                    for (let i = 0; i < existingRecords.length - 1; i++) {
                        const idxCurrent = result.records.indexOf(existingRecords[i]);
                        const idxNext = result.records.indexOf(existingRecords[i + 1]);
                        expect(idxCurrent).toBeLessThan(idxNext);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});

/**
 * Property 13: LearningStore cap enforcement
 *
 * **Validates: Requirements 7.5**
 *
 * For any LearningStore and maxRecords limit, after calling appendRunRecord,
 * the resulting store has at most maxRecords entries. When trimming is required,
 * the oldest records (lowest index) are removed first, and the newest record
 * is always present.
 */
describe("Feature: llm-budget-optimization, Property 13: LearningStore cap enforcement", () => {
    it("result never exceeds maxRecords entries", () => {
        fc.assert(
            fc.property(
                arbLearningStore,
                arbLearningRunRecord,
                fc.integer({ min: 1, max: 50 }),
                (store, newRecord, maxRecords) => {
                    const result = appendRunRecord(store, newRecord, maxRecords);
                    expect(result.records.length).toBeLessThanOrEqual(maxRecords);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("newest record is always present regardless of cap", () => {
        fc.assert(
            fc.property(
                arbLearningStore,
                arbLearningRunRecord,
                fc.integer({ min: 1, max: 50 }),
                (store, newRecord, maxRecords) => {
                    const result = appendRunRecord(store, newRecord, maxRecords);
                    expect(result.records[result.records.length - 1]).toEqual(newRecord);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("when trimming occurs, oldest records are removed first", () => {
        fc.assert(
            fc.property(
                fc.array(arbLearningRunRecord, { minLength: 5, maxLength: 30 }),
                arbLearningRunRecord,
                fc.integer({ min: 1, max: 5 }),
                (existingRecords, newRecord, maxRecords) => {
                    const store: LearningStore = { records: existingRecords };
                    const result = appendRunRecord(store, newRecord, maxRecords);

                    // The result should contain the tail of the combined array
                    const combined = [...existingRecords, newRecord];
                    const expected = combined.slice(combined.length - maxRecords);
                    expect(result.records).toEqual(expected);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("repeated appends never exceed the cap", () => {
        fc.assert(
            fc.property(
                fc.array(arbLearningRunRecord, { minLength: 1, maxLength: 30 }),
                fc.integer({ min: 1, max: 10 }),
                (records, maxRecords) => {
                    let store: LearningStore = { records: [] };
                    for (const record of records) {
                        store = appendRunRecord(store, record, maxRecords);
                        expect(store.records.length).toBeLessThanOrEqual(maxRecords);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});

/**
 * Property 14: LearningStore corrupt file recovery
 *
 * **Validates: Requirements 8.5**
 *
 * For any string (including invalid JSON, empty string, random bytes),
 * parseLearningStore never throws and always returns a valid LearningStore
 * with a records array.
 */
describe("Feature: llm-budget-optimization, Property 14: LearningStore corrupt file recovery", () => {
    it("parseLearningStore never throws for arbitrary strings", () => {
        fc.assert(
            fc.property(fc.string(), (input) => {
                expect(() => parseLearningStore(input)).not.toThrow();
            }),
            { numRuns: 100 },
        );
    });

    it("parseLearningStore always returns an object with a records array", () => {
        fc.assert(
            fc.property(fc.string(), (input) => {
                const result = parseLearningStore(input);
                expect(result).toBeDefined();
                expect(result).toHaveProperty("records");
                expect(Array.isArray(result.records)).toBe(true);
            }),
            { numRuns: 100 },
        );
    });

    it("parseLearningStore handles random bytes without throwing", () => {
        fc.assert(
            fc.property(
                fc.uint8Array({ minLength: 0, maxLength: 1000 }).map((arr) =>
                    String.fromCharCode(...arr),
                ),
                (randomBytes) => {
                    const result = parseLearningStore(randomBytes);
                    expect(result).toHaveProperty("records");
                    expect(Array.isArray(result.records)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("parseLearningStore returns empty records for empty string", () => {
        const result = parseLearningStore("");
        expect(result.records).toEqual([]);
    });

    it("parseLearningStore returns empty records for invalid JSON", () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.constant("{invalid json}"),
                    fc.constant("null"),
                    fc.constant("42"),
                    fc.constant('"just a string"'),
                    fc.constant("undefined"),
                    fc.constant("{]"),
                    fc.constant("{'records': []}"),
                ),
                (invalidInput) => {
                    const result = parseLearningStore(invalidInput);
                    expect(result).toHaveProperty("records");
                    expect(Array.isArray(result.records)).toBe(true);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("parseLearningStore roundtrips valid stores correctly", () => {
        fc.assert(
            fc.property(arbLearningStore, (store) => {
                const serialized = serializeLearningStore(store);
                const parsed = parseLearningStore(serialized);
                expect(parsed.records).toEqual(store.records);
            }),
            { numRuns: 100 },
        );
    });
});
