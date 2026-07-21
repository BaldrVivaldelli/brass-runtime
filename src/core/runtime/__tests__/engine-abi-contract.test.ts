import { describe, expect, it } from "vitest";
import {
  ENGINE_ABI_LIMITS,
  EngineAbiCompatibilityError,
  assertAbiWordLimit,
  negotiateEngineAbi,
  type EngineAbiProvider,
} from "../engine/abiContract";
import { encodeOpcodeProgram } from "../engine/binaryAbi";

const provider = (overrides: Partial<Record<keyof EngineAbiProvider, () => number | string>> = {}): EngineAbiProvider => ({
  abi_version: () => 1,
  min_compatible_abi_version: () => 1,
  engine_version: () => "0.2.0-test",
  capabilities: () => 15,
  max_program_words: () => ENGINE_ABI_LIMITS.maxProgramWords,
  max_patch_words: () => ENGINE_ABI_LIMITS.maxPatchWords,
  max_event_batch: () => ENGINE_ABI_LIMITS.maxEventBatch,
  ...overrides,
} as EngineAbiProvider);

describe("engine ABI contract", () => {
  it("negotiates the current version, capabilities, and bounded limits", () => {
    expect(negotiateEngineAbi(provider())).toEqual({
      abiVersion: 1,
      minCompatibleAbiVersion: 1,
      engineVersion: "0.2.0-test",
      capabilities: 15,
      maxProgramWords: 4_194_307,
      maxPatchWords: 4_194_305,
      maxEventBatch: 65_536,
    });
  });

  it("rejects future versions, missing capabilities, and unsafe advertised limits", () => {
    expect(() => negotiateEngineAbi(provider({ abi_version: () => 2 }))).toThrow(/newer/);
    expect(() => negotiateEngineAbi(provider({ capabilities: () => 7 }))).toThrow(/capabilities/);
    expect(() => negotiateEngineAbi(provider({ max_event_batch: () => 65_537 }))).toThrow(/safety contract/);
  });

  it("rejects oversized buffers before allocation", () => {
    expect(() => assertAbiWordLimit("program", ENGINE_ABI_LIMITS.maxProgramWords + 1))
      .toThrow(EngineAbiCompatibilityError);
    expect(() => encodeOpcodeProgram({ version: 1, root: 1, nodes: [{ tag: "Succeed", valueRef: 1 }] }))
      .toThrow(/root/);
  });
});
