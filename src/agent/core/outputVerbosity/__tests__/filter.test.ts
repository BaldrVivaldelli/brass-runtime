import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { shouldEmit, makeVerbosityFilter } from "../filter";
import type { VerbosityLevel } from "../types";
import { MINIMAL_EVENTS, NORMAL_EVENTS } from "../types";
import type { AgentEvent, AgentEventSink } from "../../types";

/** All known AgentEvent type strings. */
const ALL_EVENT_TYPES = [
    "agent.run.started",
    "agent.action.started",
    "agent.action.completed",
    "agent.action.failed",
    "agent.observation.recorded",
    "agent.tool.timeout",
    "agent.permission.denied",
    "agent.approval.requested",
    "agent.approval.resolved",
    "agent.patch.applied",
    "agent.patch.rolledBack",
    "agent.run.completed",
    "budget.usage",
    "budget.routed",
    "budget.confidence",
    "budget.warning",
    "budget.exceeded",
] as const;

type KnownEventType = (typeof ALL_EVENT_TYPES)[number];

const arbEventType: fc.Arbitrary<KnownEventType> = fc.constantFrom(...ALL_EVENT_TYPES);

const arbVerbosityLevel: fc.Arbitrary<VerbosityLevel> = fc.constantFrom("minimal", "normal", "verbose");

/** Minimal stub event with just the type field for shouldEmit testing. */
const makeStubEvent = (type: KnownEventType): AgentEvent => ({ type, at: 0 }) as unknown as AgentEvent;

describe("Feature: adaptive-output-verbosity", () => {
    describe("Property 1: Event filtering correctness", () => {
        /**
         * Validates: Requirements 1.2, 1.3, 1.4, 8.2, 8.3
         */
        it("shouldEmit returns true for 'verbose' always; for 'normal' iff event.type in NORMAL_EVENTS; for 'minimal' iff event.type in MINIMAL_EVENTS", () => {
            fc.assert(
                fc.property(arbEventType, arbVerbosityLevel, (eventType, level) => {
                    const event = makeStubEvent(eventType);
                    const result = shouldEmit(event, level);

                    if (level === "verbose") {
                        expect(result).toBe(true);
                    } else if (level === "normal") {
                        expect(result).toBe(NORMAL_EVENTS.has(eventType));
                    } else {
                        // "minimal"
                        expect(result).toBe(MINIMAL_EVENTS.has(eventType));
                    }
                }),
                { numRuns: 200 },
            );
        });
    });

    describe("Property 10: Event identity preservation", () => {
        /**
         * Validates: Requirements 8.2
         */
        it("events that pass the filter are delegated to inner sink as the exact same object reference", () => {
            fc.assert(
                fc.property(arbEventType, arbVerbosityLevel, (eventType, level) => {
                    const event = makeStubEvent(eventType);

                    // Only test events that pass the filter
                    if (!shouldEmit(event, level)) return;

                    const received: AgentEvent[] = [];
                    const inner: AgentEventSink = {
                        emit: (e: AgentEvent) => { received.push(e); },
                    };

                    const filter = makeVerbosityFilter({ inner, initialLevel: level });
                    filter.emit(event);

                    expect(received).toHaveLength(1);
                    // Referential identity check
                    expect(received[0]).toBe(event);
                }),
                { numRuns: 200 },
            );
        });
    });
});
