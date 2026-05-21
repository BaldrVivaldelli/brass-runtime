import type { AgentEvent } from "../types";

/** Discriminated union of all AgentEvent type tags. */
export type AgentEventType = AgentEvent["type"];

/** Ordered verbosity levels from least to most verbose. */
export type VerbosityLevel = "minimal" | "normal" | "verbose";

/** Ordered levels for step-based reduction/escalation. */
export const VERBOSITY_LEVELS: readonly VerbosityLevel[] = ["minimal", "normal", "verbose"] as const;

/** Events emitted at "minimal" verbosity — only critical outcomes. */
export const MINIMAL_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
    "agent.run.completed",
    "agent.action.failed",
    "agent.tool.timeout",
    "agent.permission.denied",
]);

/** Events emitted at "normal" verbosity — lifecycle + errors. */
export const NORMAL_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
    "agent.run.started",
    "agent.action.started",
    "agent.action.completed",
    "agent.run.completed",
    "agent.action.failed",
    "agent.tool.timeout",
    "agent.permission.denied",
]);

/** "verbose" emits all events — no allow-list needed. */

/** Environmental signals used to compute the final VerbosityLevel. */
export type AdaptationSignals = {
    /** Whether stdout is a pipe (non-TTY). */
    readonly isPipe: boolean;
    /** TTY column width, or undefined if not a TTY. */
    readonly ttyWidth: number | undefined;
    /** Historical run durations in milliseconds (most recent last). */
    readonly runHistory: readonly number[];
    /** Explicit user preference override, if set. */
    readonly userOverride: VerbosityLevel | undefined;
};

/** Persisted user preferences for output verbosity. */
export type OutputPreferences = {
    readonly version: 1;
    /** Historical run durations in ms, max 20 entries, oldest first. */
    readonly runHistory: readonly number[];
    /** Explicit user-set verbosity override. */
    readonly userOverride: VerbosityLevel | undefined;
};

/** Factory returning empty/default output preferences. */
export const emptyOutputPreferences = (): OutputPreferences => ({
    version: 1,
    runHistory: [],
    userOverride: undefined,
});

/** Maximum number of historical run duration entries to retain. */
export const MAX_RUN_HISTORY_ENTRIES = 20;

/** Elapsed time (ms) after which mid-run escalation triggers. */
export const ESCALATION_THRESHOLD_MS = 30_000;

/** TTY column width below which the narrow-terminal reduction applies. */
export const NARROW_TTY_THRESHOLD = 80;

/** Median run duration (ms) below which the short-run reduction applies. */
export const SHORT_RUN_THRESHOLD_MS = 5_000;

/** Configuration for the VerbosityFilter. */
export type FilterConfig = {
    readonly level: VerbosityLevel;
};
