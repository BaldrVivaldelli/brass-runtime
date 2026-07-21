import { describe, expect, it, vi } from "vitest";
import { makeInMemoryAgentPersistence } from "../../persistence";
import { flushErrorPatterns, loadErrorPatterns, parseErrorPatterns, serializeErrorPatterns } from "../store";
import type { ErrorHistoryEntry } from "../types";

const entries: ErrorHistoryEntry[] = [
  { category: "PatchError", subcategory: "apply", timestamp: 1_700_000_000_000, resolved: true },
  { category: "LLMError", subcategory: "timeout", timestamp: 1_700_000_001_000, resolved: false },
];

describe("error recovery persistence", () => {
  it("parses only the versioned error history", () => {
    expect(parseErrorPatterns(serializeErrorPatterns(entries))).toEqual(entries);
    expect(parseErrorPatterns("bad json")).toEqual([]);
    expect(parseErrorPatterns(JSON.stringify({ version: 2, entries }))).toEqual([]);
    expect(parseErrorPatterns(JSON.stringify({ version: 1, entries: "bad" }))).toEqual([]);
  });

  it("round-trips through AgentPersistence", async () => {
    const persistence = makeInMemoryAgentPersistence();
    await flushErrorPatterns(persistence, entries);
    expect(await loadErrorPatterns(persistence)).toEqual(entries);
    expect(persistence.snapshot()["workspace:agent.error-patterns.v1"])
      .toBe(serializeErrorPatterns(entries));
  });

  it("degrades on read/write failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persistence = {
      version: 1 as const,
      read: async () => { throw new Error("read denied"); },
      write: async () => { throw new Error("disk full"); },
      remove: async () => undefined,
    };
    await expect(loadErrorPatterns(persistence)).resolves.toEqual([]);
    await expect(flushErrorPatterns(persistence, entries)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[errorRecovery]"), "disk full");
    warn.mockRestore();
  });
});
