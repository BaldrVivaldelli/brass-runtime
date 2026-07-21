import { describe, expect, it, vi } from "vitest";
import { makeInMemoryAgentPersistence } from "../../persistence";
import { flushRewardStore, loadRewardStore, parseRewardStore, serializeRewardStore } from "../store";
import type { RewardEntry } from "../types";

const entries: RewardEntry[] = [
  { arm: "direct-patch", reward: 1, timestamp: 1_718_000_000_000 },
  { arm: "multi-step-patch", reward: 0.5, timestamp: 1_718_000_100_000 },
];

describe("patch strategy persistence", () => {
  it("parses only the versioned reward shape", () => {
    expect(parseRewardStore(serializeRewardStore(entries))).toEqual(entries);
    expect(parseRewardStore("not json")).toEqual([]);
    expect(parseRewardStore(JSON.stringify({ version: 2, entries }))).toEqual([]);
    expect(parseRewardStore(JSON.stringify({ version: 1, entries: "bad" }))).toEqual([]);
  });

  it("round-trips through AgentPersistence and uses the versioned key", async () => {
    const persistence = makeInMemoryAgentPersistence();
    await flushRewardStore(persistence, entries);
    expect(await loadRewardStore(persistence)).toEqual(entries);
    expect(persistence.snapshot()["workspace:agent.patch-strategy.v1"])
      .toBe(serializeRewardStore(entries));
  });

  it("degrades on read/write failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persistence = {
      version: 1 as const,
      read: async () => { throw new Error("read denied"); },
      write: async () => { throw new Error("disk full"); },
      remove: async () => undefined,
    };
    await expect(loadRewardStore(persistence)).resolves.toEqual([]);
    await expect(flushRewardStore(persistence, entries)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[patchStrategy]"), "disk full");
    warn.mockRestore();
  });
});
