// src/agent/core/validationIntensity/filter.ts

import type { IntensityLevel, ValidationHistory } from "./types";
import { TYPECHECK_PATTERNS } from "./types";
import { sortByFailFast } from "./ordering";

/**
 * Identify whether a command is a type-check command by matching
 * its arguments against known typecheck script patterns.
 * Returns true if any argument in the command contains one of the
 * TYPECHECK_PATTERNS entries as a substring.
 */
export const isTypecheckCommand = (command: readonly string[]): boolean =>
    command.some((arg) =>
        TYPECHECK_PATTERNS.some((pattern) => arg.includes(pattern))
    );

/**
 * Find the first type-check command in the original discovery order.
 */
export const findTypecheckCommand = (
    commands: readonly (readonly string[])[],
): (readonly string[]) | undefined =>
    commands.find(isTypecheckCommand);

/**
 * Filter and reorder validation commands based on intensity level and history.
 *
 * - "skip": empty list
 * - "reduced": only the type-check command (or fallback to full if none found)
 * - "full": all commands, sorted by fail-fast score
 *
 * When history is empty (no stats for any command), original order is preserved.
 */
export const filterByIntensity = (
    commands: readonly (readonly string[])[],
    level: IntensityLevel,
    history: ValidationHistory,
): readonly (readonly string[])[] => {
    switch (level) {
        case "skip":
            return [];

        case "reduced": {
            const typecheck = findTypecheckCommand(commands);
            if (typecheck) return [typecheck];
            // Fallback: no typecheck command found, behave like "full"
            return sortByFailFast(commands, history);
        }

        case "full":
            return sortByFailFast(commands, history);
    }
};
