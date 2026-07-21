import { describe, expect, it, vi } from "vitest";
import { makeInMemoryAgentPersistence } from "../../persistence";
import {
  emptyHistory,
  flushValidationHistory,
  loadValidationHistory,
  parseValidationHistory,
  serializeValidationHistory,
} from "../store";
import type { ValidationHistory } from "../types";

const history: ValidationHistory = {
  version: 1,
  commands: { "npm test": { totalRuns: 5, failures: 1, avgTimeToFailureMs: 2_000 } },
};

describe("validation intensity persistence", () => {
  it("validates version and commands", () => {
    expect(parseValidationHistory(serializeValidationHistory(history))).toEqual(history);
    expect(parseValidationHistory("bad json")).toEqual(emptyHistory());
    expect(parseValidationHistory(JSON.stringify({ version: 99, commands: {} }))).toEqual(emptyHistory());
    expect(parseValidationHistory(JSON.stringify({ version: 1 }))).toEqual(emptyHistory());
  });

  it("round-trips through AgentPersistence", async () => {
    const persistence = makeInMemoryAgentPersistence();
    await flushValidationHistory(persistence, history);
    expect(await loadValidationHistory(persistence)).toEqual(history);
    expect(persistence.snapshot()["workspace:agent.validation-intensity.v1"])
      .toBe(serializeValidationHistory(history));
  });

  it("falls back on read failure and warns without throwing on write failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persistence = {
      version: 1 as const,
      read: async () => { throw new Error("read denied"); },
      write: async () => { throw new Error("permission denied"); },
      remove: async () => undefined,
    };
    await expect(loadValidationHistory(persistence)).resolves.toEqual(emptyHistory());
    await expect(flushValidationHistory(persistence, history)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[validationIntensity]"), "permission denied");
    warn.mockRestore();
  });
});
