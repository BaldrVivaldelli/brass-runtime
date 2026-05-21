import type { HostProfile } from "../hostProfile";
import type { AdaptationSignals, VerbosityLevel } from "./types";
import { NARROW_TTY_THRESHOLD, SHORT_RUN_THRESHOLD_MS } from "./types";

/**
 * Derives the base VerbosityLevel from the HostProfile alone.
 * Returns "normal" when hostProfile is undefined.
 *
 * Mapping:
 * - "ci" | "stdio" → "minimal"
 * - wantsJson capability → "minimal"
 * - "terminal" + interactiveTty | "extension" | "mcp" | "unknown" → "normal"
 */
export const deriveBaseLevel = (hostProfile: HostProfile | undefined): VerbosityLevel => {
    if (hostProfile === undefined) return "normal";

    const { transport, capabilities } = hostProfile;

    if (transport === "ci" || transport === "stdio") return "minimal";
    if (capabilities.wantsJson) return "minimal";

    return "normal";
};

/**
 * Reduces a VerbosityLevel by one step toward "minimal".
 * "verbose" → "normal", "normal" → "minimal", "minimal" → "minimal".
 */
export const reduceLevel = (level: VerbosityLevel): VerbosityLevel => {
    if (level === "verbose") return "normal";
    if (level === "normal") return "minimal";
    return "minimal";
};

/**
 * Computes the median of a numeric array.
 * Returns undefined for empty arrays.
 */
export const median = (values: readonly number[]): number | undefined => {
    if (values.length === 0) return undefined;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
};

/**
 * Computes the final VerbosityLevel by applying all adaptation signals
 * in priority order:
 *   1. CI transport override (highest) — short-circuits to "minimal"
 *   2. Explicit user preference (replaces base level)
 *   3. Pipe detection (reduce one step)
 *   4. TTY width < 80 (reduce one step)
 *   5. Historical run duration median < 5s (reduce one step)
 *
 * Pure function — deterministic for the same inputs.
 */
export const computeVerbosityLevel = (
    hostProfile: HostProfile | undefined,
    signals: AdaptationSignals,
): VerbosityLevel => {
    // 1. CI override — highest priority, short-circuit
    if (hostProfile?.transport === "ci") return "minimal";

    // 2. Start with base level, or user preference if set
    let level: VerbosityLevel =
        signals.userOverride !== undefined ? signals.userOverride : deriveBaseLevel(hostProfile);

    // 3. Pipe detection — reduce one step
    if (signals.isPipe) {
        level = reduceLevel(level);
    }

    // 4. TTY width — reduce one step if narrow
    if (signals.ttyWidth !== undefined && signals.ttyWidth < NARROW_TTY_THRESHOLD) {
        level = reduceLevel(level);
    }

    // 5. Historical duration — reduce one step if median < threshold
    if (signals.runHistory.length > 0) {
        const med = median(signals.runHistory);
        if (med !== undefined && med < SHORT_RUN_THRESHOLD_MS) {
            level = reduceLevel(level);
        }
    }

    return level;
};
