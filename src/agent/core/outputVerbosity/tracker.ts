import type { HostProfile } from "../hostProfile";
import type { VerbosityLevel } from "./types";
import { ESCALATION_THRESHOLD_MS } from "./types";

export type RunDurationTrackerOptions = {
    readonly filter: { setLevel(level: VerbosityLevel): void; getLevel(): VerbosityLevel };
    readonly hostProfile: HostProfile | undefined;
    /** Override for testing — returns current time in ms. Defaults to Date.now. */
    readonly now?: () => number;
    /** Escalation threshold in ms. Defaults to ESCALATION_THRESHOLD_MS (30000). */
    readonly thresholdMs?: number;
};

export type RunDurationTrackerInstance = {
    /** Call when the agent run starts. Records the start time. */
    readonly start: () => void;
    /** Call periodically (e.g., each loop iteration) to check escalation. */
    readonly tick: () => void;
    /** Call when the agent run completes. Returns the total duration in ms. */
    readonly stop: () => number;
    /** Whether escalation has already fired. */
    readonly hasEscalated: () => boolean;
};

/**
 * Creates a RunDurationTracker that monitors elapsed time and escalates
 * verbosity from "minimal" to "normal" after the threshold is crossed.
 *
 * Escalation rules:
 * - Only fires once per run
 * - Only escalates "minimal" → "normal"
 * - Never escalates when hostProfile transport is "ci"
 */
export const makeRunDurationTracker = (options: RunDurationTrackerOptions): RunDurationTrackerInstance => {
    const { filter, hostProfile, thresholdMs = ESCALATION_THRESHOLD_MS } = options;
    const now = options.now ?? Date.now;

    let startTime = 0;
    let escalated = false;

    return {
        start: (): void => {
            startTime = now();
        },
        tick: (): void => {
            if (escalated) return;
            if (hostProfile?.transport === "ci") return;
            if (filter.getLevel() !== "minimal") return;

            const elapsed = now() - startTime;
            if (elapsed > thresholdMs) {
                filter.setLevel("normal");
                escalated = true;
            }
        },
        stop: (): number => {
            return now() - startTime;
        },
        hasEscalated: (): boolean => escalated,
    };
};
