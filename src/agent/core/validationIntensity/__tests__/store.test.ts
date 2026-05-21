import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ValidationHistory } from "../types";

vi.mock("node:fs/promises");

describe("Validation history store", () => {
    let readFile: ReturnType<typeof vi.fn>;
    let writeFile: ReturnType<typeof vi.fn>;
    let mkdir: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.resetModules();
        const fsMock = await import("node:fs/promises");
        readFile = fsMock.readFile as unknown as ReturnType<typeof vi.fn>;
        writeFile = fsMock.writeFile as unknown as ReturnType<typeof vi.fn>;
        mkdir = fsMock.mkdir as unknown as ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("loadValidationHistory", () => {
        it("loading valid JSON returns correct history", async () => {
            const validHistory: ValidationHistory = {
                version: 1,
                commands: {
                    "npm run test": {
                        totalRuns: 10,
                        failures: 2,
                        avgTimeToFailureMs: 3500,
                    },
                },
            };

            readFile.mockResolvedValue(JSON.stringify(validHistory));

            const { loadValidationHistory } = await import("../store");
            const result = await loadValidationHistory("/project");

            expect(result).toEqual(validHistory);
        });

        it("loading missing file returns empty history", async () => {
            const error = new Error("ENOENT: no such file or directory");
            (error as NodeJS.ErrnoException).code = "ENOENT";
            readFile.mockRejectedValue(error);

            const { loadValidationHistory } = await import("../store");
            const result = await loadValidationHistory("/project");

            expect(result).toEqual({ version: 1, commands: {} });
        });

        it("loading invalid JSON returns empty history", async () => {
            readFile.mockResolvedValue("not valid json {{{");

            const { loadValidationHistory } = await import("../store");
            const result = await loadValidationHistory("/project");

            expect(result).toEqual({ version: 1, commands: {} });
        });

        it("loading JSON with wrong version returns empty history", async () => {
            readFile.mockResolvedValue(JSON.stringify({ version: 99, commands: {} }));

            const { loadValidationHistory } = await import("../store");
            const result = await loadValidationHistory("/project");

            expect(result).toEqual({ version: 1, commands: {} });
        });

        it("loading JSON with missing commands field returns empty history", async () => {
            readFile.mockResolvedValue(JSON.stringify({ version: 1 }));

            const { loadValidationHistory } = await import("../store");
            const result = await loadValidationHistory("/project");

            expect(result).toEqual({ version: 1, commands: {} });
        });
    });

    describe("flushValidationHistory", () => {
        it("flush writes correct format", async () => {
            mkdir.mockResolvedValue(undefined);
            writeFile.mockResolvedValue(undefined);

            const history: ValidationHistory = {
                version: 1,
                commands: {
                    "npm test": {
                        totalRuns: 5,
                        failures: 1,
                        avgTimeToFailureMs: 2000,
                    },
                },
            };

            const { flushValidationHistory } = await import("../store");
            await flushValidationHistory("/project", history);

            expect(mkdir).toHaveBeenCalledWith(
                expect.stringContaining(".brass"),
                { recursive: true },
            );
            expect(writeFile).toHaveBeenCalledWith(
                expect.stringContaining("validation-history.json"),
                JSON.stringify(history, null, 2),
                "utf-8",
            );
        });

        it("flush warns on write error without throwing", async () => {
            mkdir.mockResolvedValue(undefined);
            writeFile.mockRejectedValue(new Error("EACCES: permission denied"));

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            const history: ValidationHistory = { version: 1, commands: {} };

            const { flushValidationHistory } = await import("../store");

            // Should not throw
            await expect(
                flushValidationHistory("/project", history),
            ).resolves.toBeUndefined();

            // Should have warned
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("[validationIntensity]"),
                expect.stringContaining("permission denied"),
            );

            warnSpy.mockRestore();
        });
    });
});
