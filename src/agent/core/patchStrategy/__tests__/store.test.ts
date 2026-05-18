import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadRewardStore, flushRewardStore } from "../store";
import type { RewardEntry } from "../types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Unit tests for store persistence.
 * Feature: adaptive-patch-strategy
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

    describe("loadRewardStore", () => {
        it("returns empty array when file does not exist (ENOENT)", async () => {
            const err = new Error("ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            mockReadFile.mockRejectedValue(err);

            const result = await loadRewardStore("/tmp/test");
            expect(result).toStrictEqual([]);
        });

        it("returns empty array when file contains corrupt JSON", async () => {
            mockReadFile.mockResolvedValue("not valid json {{{");

            const result = await loadRewardStore("/tmp/test");
            expect(result).toStrictEqual([]);
        });

        it("returns empty array when version is not 1", async () => {
            mockReadFile.mockResolvedValue(JSON.stringify({ version: 2, entries: [] }));

            const result = await loadRewardStore("/tmp/test");
            expect(result).toStrictEqual([]);
        });

        it("returns entries when file contains valid data", async () => {
            const entries: RewardEntry[] = [
                { arm: "direct-patch", reward: 1.0, timestamp: 1718000000000 },
                { arm: "multi-step-patch", reward: 0.5, timestamp: 1718000100000 },
            ];
            mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, entries }));

            const result = await loadRewardStore("/tmp/test");
            expect(result).toStrictEqual(entries);
        });

        it("returns empty array when entries field is not an array", async () => {
            mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, entries: "not-array" }));

            const result = await loadRewardStore("/tmp/test");
            expect(result).toStrictEqual([]);
        });
    });

    describe("flushRewardStore", () => {
        it("writes correct format to the expected path", async () => {
            mockWriteFile.mockResolvedValue(undefined);

            const entries: RewardEntry[] = [
                { arm: "direct-patch", reward: 1.0, timestamp: 1718000000000 },
            ];

            await flushRewardStore("/tmp/test", entries);

            expect(mockMkdir).toHaveBeenCalledWith(
                path.dirname(path.join("/tmp/test", ".brass/patch-strategy.json")),
                { recursive: true },
            );
            expect(mockWriteFile).toHaveBeenCalledWith(
                path.join("/tmp/test", ".brass/patch-strategy.json"),
                JSON.stringify({ version: 1, entries }, null, 2),
                "utf-8",
            );
        });

        it("logs warning without throwing on write failure", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            mockWriteFile.mockRejectedValue(new Error("disk full"));

            await expect(
                flushRewardStore("/tmp/test", []),
            ).resolves.toBeUndefined();

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("[patchStrategy]"),
                expect.stringContaining("disk full"),
            );

            warnSpy.mockRestore();
        });
    });
});
