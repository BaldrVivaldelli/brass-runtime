import { describe, expect, it } from "vitest";
import { makeInMemoryAgentPersistence } from "../../persistence";
import {
  loadWorkspaceMemory,
  parseWorkspaceMemory,
  persistWorkspaceMemory,
  serializeWorkspaceMemory,
} from "../store";
import { emptyWorkspaceMemory, type WorkspaceMemory } from "../types";

const memory: WorkspaceMemory = {
  version: 1,
  fileChangeFrequency: [{ key: "a.ts", updatedAt: 1_000, count: 5 }],
  commandFailureRate: [{ key: "npm test", updatedAt: 2_000, successes: 3, failures: 1 }],
  goalPatternSuccessRate: [],
  coChangeClusters: [],
};

describe("workspace memory persistence", () => {
  it("serializes deterministically and validates every required collection", () => {
    expect(serializeWorkspaceMemory(memory)).toBe(serializeWorkspaceMemory(memory));
    expect(parseWorkspaceMemory(serializeWorkspaceMemory(memory))).toEqual(memory);
    expect(parseWorkspaceMemory("not json")).toEqual(emptyWorkspaceMemory());
    expect(parseWorkspaceMemory(JSON.stringify({ ...memory, version: 2 }))).toEqual(emptyWorkspaceMemory());
    expect(parseWorkspaceMemory(JSON.stringify({ version: 1 }))).toEqual(emptyWorkspaceMemory());
    expect(parseWorkspaceMemory(JSON.stringify({
      ...memory,
      fileChangeFrequency: [{ key: 123, updatedAt: "bad", count: "bad" }],
    }))).toEqual(emptyWorkspaceMemory());
  });

  it("round-trips through AgentPersistence and uses a bounded write", async () => {
    const persistence = makeInMemoryAgentPersistence();
    await persistWorkspaceMemory(persistence, memory);
    expect(await loadWorkspaceMemory(persistence)).toEqual(memory);
    expect(persistence.snapshot()["workspace:agent.workspace-memory.v1"])
      .toBe(serializeWorkspaceMemory(memory));
  });

  it("falls back on reads and propagates writes through the host boundary", async () => {
    const persistence = {
      version: 1 as const,
      read: async () => { throw new Error("read denied"); },
      write: async () => { throw new Error("disk full"); },
      remove: async () => undefined,
    };
    await expect(loadWorkspaceMemory(persistence)).resolves.toEqual(emptyWorkspaceMemory());
    await expect(persistWorkspaceMemory(persistence, memory)).rejects.toThrow("disk full");
  });
});
