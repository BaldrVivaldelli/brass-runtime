// src/agent/core/workspaceMemory/__tests__/store.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  serializeWorkspaceMemory,
  parseWorkspaceMemory,
  loadWorkspaceMemory,
  persistWorkspaceMemory,
  WORKSPACE_MEMORY_PATH,
} from "../store";
import { emptyWorkspaceMemory } from "../types";
import type { WorkspaceMemory } from "../types";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Unit tests for workspace memory store persistence.
 * Feature: workspace-profile-evolution
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
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

  describe("serializeWorkspaceMemory", () => {
    it("produces valid JSON", () => {
      const memory = emptyWorkspaceMemory();
      const json = serializeWorkspaceMemory(memory);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it("produces deterministic output", () => {
      const memory: WorkspaceMemory = {
        version: 1,
        fileChangeFrequency: [{ key: "a.ts", updatedAt: 1000, count: 5 }],
        commandFailureRate: [{ key: "npm test", updatedAt: 2000, successes: 3, failures: 1 }],
        goalPatternSuccessRate: [],
        coChangeClusters: [],
      };

      const first = serializeWorkspaceMemory(memory);
      const second = serializeWorkspaceMemory(memory);
      expect(first).toBe(second);
    });
  });

  describe("parseWorkspaceMemory", () => {
    it("parses valid workspace memory JSON", () => {
      const memory: WorkspaceMemory = {
        version: 1,
        fileChangeFrequency: [{ key: "a.ts", updatedAt: 1000, count: 5 }],
        commandFailureRate: [],
        goalPatternSuccessRate: [],
        coChangeClusters: [],
      };

      const json = JSON.stringify(memory);
      const result = parseWorkspaceMemory(json);
      expect(result).toStrictEqual(memory);
    });

    it("returns emptyWorkspaceMemory for invalid JSON", () => {
      const result = parseWorkspaceMemory("not valid json {{{");
      expect(result).toStrictEqual(emptyWorkspaceMemory());
    });

    it("returns emptyWorkspaceMemory for version mismatch", () => {
      const json = JSON.stringify({
        version: 2,
        fileChangeFrequency: [],
        commandFailureRate: [],
        goalPatternSuccessRate: [],
        coChangeClusters: [],
      });
      const result = parseWorkspaceMemory(json);
      expect(result).toStrictEqual(emptyWorkspaceMemory());
    });

    it("returns emptyWorkspaceMemory for missing fields", () => {
      const json = JSON.stringify({ version: 1 });
      const result = parseWorkspaceMemory(json);
      expect(result).toStrictEqual(emptyWorkspaceMemory());
    });

    it("returns emptyWorkspaceMemory for invalid entry structure", () => {
      const json = JSON.stringify({
        version: 1,
        fileChangeFrequency: [{ key: 123, updatedAt: "not-a-number", count: "bad" }],
        commandFailureRate: [],
        goalPatternSuccessRate: [],
        coChangeClusters: [],
      });
      const result = parseWorkspaceMemory(json);
      expect(result).toStrictEqual(emptyWorkspaceMemory());
    });
  });

  describe("loadWorkspaceMemory", () => {
    it("returns emptyWorkspaceMemory when file does not exist", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockReadFile.mockRejectedValue(err);

      const result = await loadWorkspaceMemory("/tmp/test");
      expect(result).toStrictEqual(emptyWorkspaceMemory());
    });

    it("returns emptyWorkspaceMemory when file contains invalid JSON", async () => {
      mockReadFile.mockResolvedValue("not valid json");

      const result = await loadWorkspaceMemory("/tmp/test");
      expect(result).toStrictEqual(emptyWorkspaceMemory());
    });

    it("returns parsed memory when file is valid", async () => {
      const memory: WorkspaceMemory = {
        version: 1,
        fileChangeFrequency: [{ key: "a.ts", updatedAt: 1000, count: 3 }],
        commandFailureRate: [],
        goalPatternSuccessRate: [],
        coChangeClusters: [],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(memory));

      const result = await loadWorkspaceMemory("/tmp/test");
      expect(result).toStrictEqual(memory);
    });

    it("reads from the correct path", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      await loadWorkspaceMemory("/workspace");
      expect(mockReadFile).toHaveBeenCalledWith(
        path.join("/workspace", WORKSPACE_MEMORY_PATH),
        "utf-8",
      );
    });
  });

  describe("persistWorkspaceMemory", () => {
    it("creates .brass/ directory if needed", async () => {
      mockWriteFile.mockResolvedValue(undefined);

      await persistWorkspaceMemory("/workspace", emptyWorkspaceMemory());

      expect(mockMkdir).toHaveBeenCalledWith(
        path.dirname(path.join("/workspace", WORKSPACE_MEMORY_PATH)),
        { recursive: true },
      );
    });

    it("writes serialized memory to the correct path", async () => {
      mockWriteFile.mockResolvedValue(undefined);

      const memory: WorkspaceMemory = {
        version: 1,
        fileChangeFrequency: [{ key: "a.ts", updatedAt: 1000, count: 1 }],
        commandFailureRate: [],
        goalPatternSuccessRate: [],
        coChangeClusters: [],
      };

      await persistWorkspaceMemory("/workspace", memory);

      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join("/workspace", WORKSPACE_MEMORY_PATH),
        serializeWorkspaceMemory(memory),
        "utf-8",
      );
    });

    it("throws on write failure", async () => {
      mockWriteFile.mockRejectedValue(new Error("disk full"));

      await expect(
        persistWorkspaceMemory("/workspace", emptyWorkspaceMemory()),
      ).rejects.toThrow("disk full");
    });
  });
});
