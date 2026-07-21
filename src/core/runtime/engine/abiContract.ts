export const ENGINE_ABI_VERSION = 1 as const;
export const ENGINE_ABI_MIN_COMPATIBLE_VERSION = 1 as const;

export const ENGINE_ABI_LIMITS = Object.freeze({
  maxProgramNodes: 1_048_576,
  maxProgramWords: 3 + 1_048_576 * 4,
  maxPatchWords: 1 + 1_048_576 * 4,
  maxEventBatch: 65_536,
});

export const ENGINE_ABI_CAPABILITIES = Object.freeze({
  binaryAbi: 1 << 0,
  zeroCopy: 1 << 1,
  batchedEvents: 1 << 2,
  metricsSnapshot: 1 << 3,
});

export const REQUIRED_ENGINE_ABI_CAPABILITIES =
  ENGINE_ABI_CAPABILITIES.binaryAbi |
  ENGINE_ABI_CAPABILITIES.zeroCopy |
  ENGINE_ABI_CAPABILITIES.batchedEvents |
  ENGINE_ABI_CAPABILITIES.metricsSnapshot;

export type EngineAbiHandshake = {
  readonly abiVersion: number;
  readonly minCompatibleAbiVersion: number;
  readonly engineVersion: string;
  readonly capabilities: number;
  readonly maxProgramWords: number;
  readonly maxPatchWords: number;
  readonly maxEventBatch: number;
};

export type EngineAbiProvider = {
  abi_version(): number;
  min_compatible_abi_version(): number;
  engine_version(): string;
  capabilities(): number;
  max_program_words(): number;
  max_patch_words(): number;
  max_event_batch(): number;
};

export class EngineAbiCompatibilityError extends Error {
  readonly _tag = "EngineAbiCompatibilityError" as const;

  constructor(message: string, readonly handshake?: Partial<EngineAbiHandshake>) {
    super(message);
    this.name = "EngineAbiCompatibilityError";
  }
}
const requireSafeInteger = (name: string, value: number, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new EngineAbiCompatibilityError(
      `Invalid Brass engine ABI handshake field ${name}: expected an integer >= ${minimum}, got ${String(value)}`,
    );
  }
  return value;
};

export function negotiateEngineAbi(provider: EngineAbiProvider): EngineAbiHandshake {
  const handshake: EngineAbiHandshake = Object.freeze({
    abiVersion: requireSafeInteger("abiVersion", provider.abi_version(), 1),
    minCompatibleAbiVersion: requireSafeInteger(
      "minCompatibleAbiVersion",
      provider.min_compatible_abi_version(),
      1,
    ),
    engineVersion: String(provider.engine_version()),
    capabilities: requireSafeInteger("capabilities", provider.capabilities()),
    maxProgramWords: requireSafeInteger("maxProgramWords", provider.max_program_words(), 3),
    maxPatchWords: requireSafeInteger("maxPatchWords", provider.max_patch_words(), 1),
    maxEventBatch: requireSafeInteger("maxEventBatch", provider.max_event_batch(), 1),
  });

  if (handshake.abiVersion > ENGINE_ABI_VERSION) {
    throw new EngineAbiCompatibilityError(
      `Brass engine ABI ${handshake.abiVersion} is newer than the supported ABI ${ENGINE_ABI_VERSION}; upgrade brass-runtime before loading this engine`,
      handshake,
    );
  }
  if (
    handshake.abiVersion < ENGINE_ABI_MIN_COMPATIBLE_VERSION ||
    handshake.minCompatibleAbiVersion > ENGINE_ABI_VERSION
  ) {
    throw new EngineAbiCompatibilityError(
      `Brass engine ABI range ${handshake.minCompatibleAbiVersion}-${handshake.abiVersion} is incompatible with host ABI ${ENGINE_ABI_VERSION}`,
      handshake,
    );
  }
  if (handshake.minCompatibleAbiVersion > handshake.abiVersion) {
    throw new EngineAbiCompatibilityError(
      "Brass engine minimum compatible ABI cannot exceed its current ABI version",
      handshake,
    );
  }
  const missing = REQUIRED_ENGINE_ABI_CAPABILITIES & ~handshake.capabilities;
  if (missing !== 0) {
    throw new EngineAbiCompatibilityError(
      `Brass engine is missing required ABI capabilities (mask 0x${missing.toString(16)})`,
      handshake,
    );
  }
  if (
    handshake.maxProgramWords > ENGINE_ABI_LIMITS.maxProgramWords ||
    handshake.maxPatchWords > ENGINE_ABI_LIMITS.maxPatchWords ||
    handshake.maxEventBatch > ENGINE_ABI_LIMITS.maxEventBatch
  ) {
    throw new EngineAbiCompatibilityError(
      "Brass engine advertises limits above the host safety contract",
      handshake,
    );
  }
  return handshake;
}

export function assertAbiWordLimit(
  kind: "program" | "patch",
  wordLength: number,
  handshake?: Pick<EngineAbiHandshake, "maxProgramWords" | "maxPatchWords">,
): void {
  const maximum = kind === "program"
    ? Math.min(handshake?.maxProgramWords ?? ENGINE_ABI_LIMITS.maxProgramWords, ENGINE_ABI_LIMITS.maxProgramWords)
    : Math.min(handshake?.maxPatchWords ?? ENGINE_ABI_LIMITS.maxPatchWords, ENGINE_ABI_LIMITS.maxPatchWords);
  if (!Number.isSafeInteger(wordLength) || wordLength < 0 || wordLength > maximum) {
    throw new EngineAbiCompatibilityError(
      `Brass ${kind} buffer requires ${String(wordLength)} words; negotiated maximum is ${maximum}`,
      handshake,
    );
  }
}
