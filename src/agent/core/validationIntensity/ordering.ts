// src/agent/core/validationIntensity/ordering.ts

import type { CommandStats, ValidationHistory } from "./types";

/**
 * Command key used for history lookup (space-joined command parts).
 */
export const commandKey = (command: readonly string[]): string =>
    command.join(" ");

/**
 * Compute the fail-fast score for a command.
 * Score = (failures / totalRuns) * (1 / avgTimeToFailureMs)
 * Returns 0 when totalRuns is 0 or avgTimeToFailureMs is 0.
 */
export const failFastScore = (stats: CommandStats): number => {
    if (stats.totalRuns === 0 || stats.avgTimeToFailureMs === 0) return 0;
    const failureRate = stats.failures / stats.totalRuns;
    const inverseTime = 1 / stats.avgTimeToFailureMs;
    return failureRate * inverseTime;
};

/**
 * Sort commands by fail-fast score (descending).
 * Commands with no history are placed after commands with history,
 * preserving their original relative order.
 */
export const sortByFailFast = (
    commands: readonly (readonly string[])[],
    history: ValidationHistory,
): readonly (readonly string[])[] => {
    const withHistory: Array<{ command: readonly string[]; score: number }> = [];
    const withoutHistory: (readonly string[])[] = [];

    for (const command of commands) {
        const key = commandKey(command);
        const stats = history.commands[key];
        if (stats && stats.totalRuns > 0) {
            withHistory.push({ command, score: failFastScore(stats) });
        } else {
            withoutHistory.push(command);
        }
    }

    // Sort commands with history by score descending (stable sort)
    withHistory.sort((a, b) => b.score - a.score);

    return [...withHistory.map((entry) => entry.command), ...withoutHistory];
};
