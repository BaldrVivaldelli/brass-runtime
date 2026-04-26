import type { AgentState, Observation } from "./types";
import type { ProjectCommand } from "./projectCommands";

export type AgentRollbackStrategy = "last" | "all";

export type RollbackSafetySummary = {
    readonly enabled: boolean;
    readonly onFinalValidationFailure: boolean;
    readonly strategy: AgentRollbackStrategy;
    readonly maxRollbackDepth: number;
    readonly runValidationAfterRollback: boolean;
    readonly allowForSuppliedPatches: boolean;
    readonly rollbackCount: number;
    readonly appliedStackDepth: number;
    readonly exactSuppliedPatch: boolean;
};

export type AppliedPatchEntry = {
    readonly index: number;
    readonly patch: string;
    readonly changedFiles: readonly string[];
};

const DEFAULT_MAX_ROLLBACK_DEPTH = 8;

const clampNonNegativeInteger = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
};

const rollbackStrategy = (value: string | undefined): AgentRollbackStrategy =>
    value === "last" ? "last" : "all";

export const rollbackSafetySummary = (state: AgentState): RollbackSafetySummary => {
    const rollback = state.goal.rollback;
    const enabled = rollback?.enabled ?? true;
    const maxRollbackDepth = clampNonNegativeInteger(rollback?.maxRollbackDepth, DEFAULT_MAX_ROLLBACK_DEPTH);
    const rollbackCount = state.observations.filter((obs) => obs.type === "patch.rolledBack").length;
    const appliedStackDepth = unappliedPatchStack(state).length;

    return {
        enabled,
        onFinalValidationFailure: rollback?.onFinalValidationFailure ?? true,
        strategy: rollbackStrategy(rollback?.strategy),
        maxRollbackDepth,
        runValidationAfterRollback: rollback?.runValidationAfterRollback ?? true,
        allowForSuppliedPatches: rollback?.allowForSuppliedPatches ?? false,
        rollbackCount,
        appliedStackDepth,
        exactSuppliedPatch: Boolean(state.goal.initialPatch?.trim()),
    };
};

export const unappliedPatchStack = (state: AgentState): readonly AppliedPatchEntry[] => {
    const stack: AppliedPatchEntry[] = [];

    for (const [index, observation] of state.observations.entries()) {
        if (observation.type === "patch.applied" && observation.patch?.trim()) {
            stack.push({
                index,
                patch: observation.patch,
                changedFiles: observation.changedFiles,
            });
            continue;
        }

        if (observation.type === "patch.rolledBack" && observation.patch?.trim()) {
            const existingIndex = [...stack]
                .reverse()
                .findIndex((entry) => entry.patch.trim() === observation.patch?.trim());

            if (existingIndex >= 0) {
                stack.splice(stack.length - 1 - existingIndex, 1);
            }
        }
    }

    return stack;
};

export const latestUnappliedPatch = (state: AgentState): AppliedPatchEntry | undefined =>
    unappliedPatchStack(state).at(-1);

export const canAutoRollback = (state: AgentState): boolean => {
    const summary = rollbackSafetySummary(state);
    if (!summary.enabled) return false;
    if (summary.rollbackCount >= summary.maxRollbackDepth) return false;
    if (summary.exactSuppliedPatch && !summary.allowForSuppliedPatches) return false;
    return summary.appliedStackDepth > 0;
};

export const shouldContinueRollbackStack = (state: AgentState): boolean => {
    const summary = rollbackSafetySummary(state);
    const latest = state.observations.at(-1);

    return latest?.type === "patch.rolledBack"
        && summary.strategy === "all"
        && canAutoRollback(state);
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

export type WorkspaceValidationStatus =
    | { readonly type: "not-run" }
    | { readonly type: "pending"; readonly completed: number; readonly total: number }
    | {
        readonly type: "passed" | "failed";
        readonly results: readonly Extract<Observation, { type: "shell.result" }>[];
    };

export const workspaceValidationStatus = (
    commands: readonly ProjectCommand[],
    observationsAfterWorkspaceChange: readonly Observation[]
): WorkspaceValidationStatus => {
    if (commands.length === 0) return { type: "not-run" };

    const results = shellResultsForCommands(commands, observationsAfterWorkspaceChange);
    if (results.length < commands.length) {
        return { type: "pending", completed: results.length, total: commands.length };
    }

    return results.some((result) => result.exitCode !== 0)
        ? { type: "failed", results }
        : { type: "passed", results };
};

export const describeRollbackSafety = (state: AgentState): string => {
    const summary = rollbackSafetySummary(state);
    if (!summary.enabled) return "Rollback safety: disabled.";
    if (summary.exactSuppliedPatch && !summary.allowForSuppliedPatches) {
        return "Rollback safety: disabled for supplied exact patches.";
    }

    return [
        `Rollback safety: ${summary.onFinalValidationFailure ? "enabled" : "not configured for final validation failure"}.`,
        `Strategy: ${summary.strategy}.`,
        `Rollbacks used: ${summary.rollbackCount}/${summary.maxRollbackDepth}.`,
        `Applied patch stack depth: ${summary.appliedStackDepth}.`,
    ].join(" ");
};
