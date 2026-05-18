/** A bandit arm representing a group of files matched by a path pattern. */
export type Arm = {
  readonly id: string;
  readonly pattern: string;
};

/** Per-arm statistics for Thompson Sampling (Beta distribution). */
export type ArmStats = {
  readonly alpha: number;
  readonly beta: number;
  readonly pulls: number;
  readonly lastPulledAt: number;
};

/** The complete persisted bandit state. */
export type BanditState = {
  readonly version: 1;
  readonly arms: Readonly<Record<string, ArmStats>>;
  readonly log: readonly AttributionLogEntry[];
};

/** A single attribution log entry for one agent run. */
export type AttributionLogEntry = {
  readonly timestamp: number;
  readonly pulledArms: readonly string[];
  readonly filesPerArm: Readonly<Record<string, readonly string[]>>;
  readonly reward: number;
};

/** Empty/default bandit state for first run or invalid persistence. */
export type EmptyBanditState = {
  readonly version: 1;
  readonly arms: Readonly<Record<string, never>>;
  readonly log: readonly [];
};

/** Factory function for empty bandit state. */
export const emptyBanditState = (): BanditState => ({
  version: 1,
  arms: {},
  log: [],
});
