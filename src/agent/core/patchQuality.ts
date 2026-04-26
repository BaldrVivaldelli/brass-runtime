import type { AgentState, Observation } from "./types";
import type { ProjectCommand } from "./projectCommands";

export type PatchQualitySummary = {
    readonly enabled: boolean;
    readonly maxRepairAttempts: number;
    readonly repairAttemptsUsed: number;
    readonly repairsRemaining: number;
    readonly exactSuppliedPatch: boolean;
};

const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;

const clampNonNegativeInteger = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
};

export const patchRepairAttemptsUsed = (state: AgentState): number =>
    state.observations.filter((obs) => obs.type === "llm.response" && obs.purpose === "patch").length;

export const patchQualitySummary = (state: AgentState): PatchQualitySummary => {
    const enabled = state.goal.patchQuality?.enabled ?? true;
    const maxRepairAttempts = clampNonNegativeInteger(
        state.goal.patchQuality?.maxRepairAttempts,
        DEFAULT_MAX_REPAIR_ATTEMPTS
    );
    const repairAttemptsUsed = patchRepairAttemptsUsed(state);

    return {
        enabled,
        maxRepairAttempts,
        repairAttemptsUsed,
        repairsRemaining: Math.max(0, maxRepairAttempts - repairAttemptsUsed),
        exactSuppliedPatch: Boolean(state.goal.initialPatch?.trim()),
    };
};

export const canRequestPatchRepair = (state: AgentState): boolean => {
    const summary = patchQualitySummary(state);
    return summary.enabled && !summary.exactSuppliedPatch && summary.repairsRemaining > 0;
};

const commandsEqual = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((part, index) => part === b[index]);

const shellResultsForCommands = (
    commands: readonly ProjectCommand[],
    observations: readonly Observation[]
): readonly Extract<Observation, { type: "shell.result" }>[] =>
    commands.flatMap((command) =>
        observations.filter(
            (obs): obs is Extract<Observation, { type: "shell.result" }> =>
                obs.type === "shell.result" && commandsEqual(obs.command, command)
        ).slice(-1)
    );

export type PatchValidationStatus =
    | { readonly type: "not-run" }
    | { readonly type: "pending"; readonly completed: number; readonly total: number }
    | {
        readonly type: "passed" | "failed";
        readonly results: readonly Extract<Observation, { type: "shell.result" }>[];
    };

export const patchValidationStatus = (
    commands: readonly ProjectCommand[],
    observationsAfterPatch: readonly Observation[]
): PatchValidationStatus => {
    if (commands.length === 0) return { type: "not-run" };

    const results = shellResultsForCommands(commands, observationsAfterPatch);
    if (results.length < commands.length) {
        return { type: "pending", completed: results.length, total: commands.length };
    }

    return results.some((result) => result.exitCode !== 0)
        ? { type: "failed", results }
        : { type: "passed", results };
};

export const describePatchQuality = (state: AgentState): string => {
    const summary = patchQualitySummary(state);
    if (!summary.enabled) return "Patch quality loop: disabled.";
    if (summary.exactSuppliedPatch) {
        return "Patch quality loop: disabled for supplied exact patches.";
    }

    return [
        `Patch quality loop: ${summary.repairAttemptsUsed}/${summary.maxRepairAttempts} repair attempts used.`,
        `Repairs remaining: ${summary.repairsRemaining}.`,
    ].join(" ");
};
