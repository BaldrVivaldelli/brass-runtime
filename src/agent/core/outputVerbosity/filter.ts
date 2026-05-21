import type { AgentEvent, AgentEventSink } from "../types";
import type { VerbosityLevel } from "./types";
import { MINIMAL_EVENTS, NORMAL_EVENTS } from "./types";

/**
 * Returns true if the given event should be emitted at the given verbosity level.
 * Pure function — no side effects.
 *
 * - "verbose" → always true (all events pass)
 * - "normal" → true if event.type is in NORMAL_EVENTS
 * - "minimal" → true if event.type is in MINIMAL_EVENTS
 */
export const shouldEmit = (event: AgentEvent, level: VerbosityLevel): boolean => {
    if (level === "verbose") return true;
    if (level === "normal") return NORMAL_EVENTS.has(event.type);
    return MINIMAL_EVENTS.has(event.type);
};

export type VerbosityFilterOptions = {
    readonly inner: AgentEventSink;
    readonly initialLevel: VerbosityLevel;
};

export type VerbosityFilterInstance = AgentEventSink & {
    /** Returns the current active verbosity level. */
    readonly getLevel: () => VerbosityLevel;
    /** Updates the verbosity level. Takes effect on the next emit call. */
    readonly setLevel: (level: VerbosityLevel) => void;
};

/**
 * Creates a VerbosityFilter wrapping the given AgentEventSink.
 * The filter gates events based on the active VerbosityLevel.
 * Permitted events are delegated to the inner sink without modification.
 * Filtered events are silently discarded.
 */
export const makeVerbosityFilter = (options: VerbosityFilterOptions): VerbosityFilterInstance => {
    let currentLevel: VerbosityLevel = options.initialLevel;

    return {
        emit: (event: AgentEvent): void => {
            if (shouldEmit(event, currentLevel)) {
                options.inner.emit(event);
            }
        },
        getLevel: () => currentLevel,
        setLevel: (level: VerbosityLevel): void => {
            currentLevel = level;
        },
    };
};
