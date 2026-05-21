// src/agent/core/validationIntensity/types.ts

/** The three intensity levels governing validation behavior. */
export type IntensityLevel = "full" | "reduced" | "skip";

/** Per-command historical statistics. */
export type CommandStats = {
    readonly totalRuns: number;
    readonly failures: number;
    readonly avgTimeToFailureMs: number;
};

/** Map from command text (joined with space) to its stats. */
export type ValidationHistory = {
    readonly version: 1;
    readonly commands: Readonly<Record<string, CommandStats>>;
};

/** Input to the transition engine. */
export type TransitionInput = {
    readonly currentLevel: IntensityLevel;
    readonly consecutivePassCount: number;
    readonly outcome: "pass" | "fail";
};

/** Output from the transition engine. */
export type TransitionOutput = {
    readonly nextLevel: IntensityLevel;
    readonly consecutivePassCount: number;
};

/** Input to the stats update function. */
export type StatsUpdateInput = {
    readonly current: CommandStats;
    readonly exitCode: number;
    readonly durationMs: number;
};

/** Thresholds for intensity transitions. */
export const FULL_TO_REDUCED_THRESHOLD = 3;
export const REDUCED_TO_SKIP_THRESHOLD = 6;

/** Known typecheck script patterns for identifying the type-check command. */
export const TYPECHECK_PATTERNS: readonly string[] = [
    "typecheck",
    "type-check",
    "check-types",
    "tsc",
    "check",
];
