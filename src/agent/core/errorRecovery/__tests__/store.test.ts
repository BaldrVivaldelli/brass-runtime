import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadErrorPatterns, flushErrorPatterns } from "../store";
import type { ErrorHistoryEntry } from "../types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Unit tests for error pattern store persistence.
 * Feature: adaptive-error-recovery
 * Validates: Requirements 9.3, 9.4
 */

vi.mock("node:fs/promises");

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);

describe("store unit tests", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockMkdir.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("loadErrorPatterns", () => {
        it("returns empty array when file does not exist (ENOENT)", async () => {
            const err = new Error("ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            mockReadFile.mockRejectedValue(err);

            const result = await loadErrorPatterns("/tmp/test");
            expect(result).toStrictEqual([]);
        });

        it("returns empty array when file contains invalid JSON", async () => {
            mockReadFile.mockResolvedValue("not valid json {{{");

            const result = await loadErrorPatterns("/tmp/test");
            expect(result).toStrictEqual([]);
        });

        it("returns empty array when version is not 1", async () => {
            mockReadFile.mockResolvedValue(JSON.stringify({ version: 2, entries: [] }));

            const result = await loadErrorPatterns("/tmp/test");
            expect(result).toStrictEqual([]);
        });

        it("returns entries when file contains valid StoredErrorPatterns", async () => {
            const entries: ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1700000000000, resolved: true },
                { category: "LLMError", subcategory: "timeout", timestamp: 1700000001000, resolved: false },
            ];
            mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, entries }));

            const result = await loadErrorPatterns("/tmp/test");
            expect(result).toStrictEqual(entries);
        });

        it("returns empty array when entries field is not an array", async () => {
            mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, entries: "not-array" }));

            const result = await loadErrorPatterns("/tmp/test");
            expect(result).toStrictEqual([]);
        });
    });

    describe("flushErrorPatterns", () => {
        it("writes correct format to the expected path", async () => {
            mockWriteFile.mockResolvedValue(undefined);

            const entries: ErrorHistoryEntry[] = [
                { category: "PatchError", subcategory: "apply", timestamp: 1700000000000, resolved: true },
            ];

            await flushErrorPatterns("/tmp/test", entries);

            expect(mockMkdir).toHaveBeenCalledWith(
                path.dirname(path.join("/tmp/test", ".brass/error-patterns.json")),
                { recursive: true },
            );
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join("/tmp/test", ".brass/error-patterns.json"),
                JSON.stringify({ version: 1, entries }, null, 2),
                "utf-8",
            );
        });

        it("logs warning without throwing on write failure", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            mockWriteFile.mockRejectedValue(new Error("disk full"));

            await expect(
                flushErrorPatterns("/tmp/test", []),
            ).resolves.toBeUndefined();

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("[errorRecovery]"),
                expect.stringContaining("disk full"),
            );

            warnSpy.mockRestore();
        });
    });
});
