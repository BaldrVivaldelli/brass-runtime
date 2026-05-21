import { describe, it, expect } from "vitest";
import { makePreferencesStore } from "../store";
import { computeVerbosityLevel } from "../signals";
import { makeVerbosityFilter } from "../filter";
import { makeRunDurationTracker } from "../tracker";
import type { AdaptationSignals, OutputPreferences } from "../types";
import { ESCALATION_THRESHOLD_MS } from "../types";
import type { HostProfile } from "../../hostProfile";
import type { AgentEvent, AgentEventSink, AgentGoal } from "../../types";

// --- Helpers ---

/** Creates a minimal HostProfile for testing. */
const makeHostProfile = (
    transport: HostProfile["transport"],
    overrides?: Partial<HostProfile["capabilities"]>,
): HostProfile => ({
    transport,
    capabilities: {
        hasOwnLLM: false,
        wantsJson: false,
        supportsStreamingEvents: false,
        supportsMcp: false,
        canAskApproval: false,
        canRenderDiff: false,
        canApplyPatch: false,
        interactiveTty: transport === "terminal",
        ...overrides,
    },
    constraints: {
        readOnlyByDefault: false,
        patchPreviewRequired: false,
        requireNoNetwork: false,
    },
    identity: undefined,
    evidence: [],
});

/** Creates an in-memory filesystem for the preferences store. */
const makeMemoryFs = () => {
    const files = new Map<string, string>();
    return {
        impl: {
            readFile: async (path: string): Promise<string> => {
                const content = files.get(path);
                if (content === undefined) throw new Error(`ENOENT: ${path}`);
                return content;
            },
            writeFile: async (path: string, content: string): Promise<void> => {
                files.set(path, content);
            },
            mkdir: async (): Promise<void> => {},
        },
        files,
    };
};

/** Creates a mock AgentEventSink that records emitted events. */
const makeRecordingSink = (): AgentEventSink & { readonly events: AgentEvent[] } => {
    const events: AgentEvent[] = [];
    return {
        emit: (event: AgentEvent) => { events.push(event); },
        events,
    };
};

/** Minimal AgentGoal for event construction. */
const stubGoal: AgentGoal = {
    id: "test-goal",
    cwd: "/tmp",
    text: "test",
    mode: "read-only",
};

/** Creates a sample AgentEvent of the given type. */
const makeEvent = (type: AgentEvent["type"]): AgentEvent => {
    const at = Date.now();
    switch (type) {
        case "agent.run.started":
            return { type, goal: stubGoal, at };
        case "agent.run.completed":
            return { type, goal: stubGoal, status: "done", phase: "done", steps: 1, durationMs: 100, at };
        case "agent.action.started":
            return { type, action: { type: "agent.finish", summary: "" }, step: 1, phase: "planning", at };
        case "agent.action.completed":
            return { type, action: { type: "agent.finish", summary: "" }, observation: { type: "agent.done", summary: "" }, step: 1, phase: "planning", durationMs: 10, at };
        case "agent.action.failed":
            return { type, action: { type: "agent.finish", summary: "" }, error: { _tag: "AgentLoopError", message: "fail" }, step: 1, phase: "planning", durationMs: 10, at };
        case "agent.tool.timeout":
            return { type, action: { type: "agent.finish", summary: "" }, step: 1, phase: "planning", timeoutMs: 5000, at };
        case "agent.permission.denied":
            return { type, action: { type: "agent.finish", summary: "" }, step: 1, phase: "planning", reason: "denied", at };
        case "agent.observation.recorded":
            return { type, observation: { type: "agent.done", summary: "" }, step: 1, phase: "planning", at };
        case "agent.approval.requested":
            return { type, action: { type: "agent.finish", summary: "" }, step: 1, phase: "planning", reason: "need approval", risk: "low", defaultAnswer: "approve", at };
        case "agent.approval.resolved":
            return { type, action: { type: "agent.finish", summary: "" }, step: 1, phase: "planning", approved: true, at };
        case "agent.patch.applied":
            return { type, step: 1, phase: "planning", changedFiles: ["a.ts"], at };
        case "agent.patch.rolledBack":
            return { type, step: 1, phase: "planning", changedFiles: ["a.ts"], at };
        default:
            return { type: "agent.run.completed", goal: stubGoal, status: "done", phase: "done", steps: 1, durationMs: 100, at };
    }
};

// --- Integration Tests ---

describe("outputVerbosity integration", () => {
    describe("full initialization flow: load prefs → compute level → create filter → emit events → persist", () => {
        it("computes 'normal' for interactive terminal with no reduction signals and filters correctly", async () => {
            const memFs = makeMemoryFs();
            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });

            // 1. Load preferences (file doesn't exist → empty prefs)
            const prefs = await store.load();
            expect(prefs.runHistory).toEqual([]);
            expect(prefs.userOverride).toBeUndefined();

            // 2. Collect signals
            const hostProfile = makeHostProfile("terminal");
            const signals: AdaptationSignals = {
                isPipe: false,
                ttyWidth: 120,
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };

            // 3. Compute verbosity level
            const level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("normal");

            // 4. Create filter wrapping a recording sink
            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: level });

            // 5. Emit events and verify filtering
            // "normal" should pass lifecycle events but block verbose-only events
            filter.emit(makeEvent("agent.run.started"));
            filter.emit(makeEvent("agent.action.started"));
            filter.emit(makeEvent("agent.observation.recorded")); // verbose-only → blocked
            filter.emit(makeEvent("agent.action.completed"));
            filter.emit(makeEvent("agent.run.completed"));

            expect(innerSink.events).toHaveLength(4);
            expect(innerSink.events.map(e => e.type)).toEqual([
                "agent.run.started",
                "agent.action.started",
                "agent.action.completed",
                "agent.run.completed",
            ]);

            // 6. Persist updated preferences with run duration
            const updatedPrefs = store.recordRunDuration(15000, prefs);
            await store.save(updatedPrefs);

            // Verify persistence
            const reloaded = await store.load();
            expect(reloaded.runHistory).toEqual([15000]);
        });

        it("applies pipe and narrow TTY reductions to reduce level to 'minimal'", async () => {
            const memFs = makeMemoryFs();
            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            const prefs = await store.load();

            const hostProfile = makeHostProfile("terminal");
            const signals: AdaptationSignals = {
                isPipe: true,       // reduces normal → minimal
                ttyWidth: 60,       // would reduce further but already at minimal
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };

            const level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("minimal");

            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: level });

            // At "minimal", only critical events pass
            filter.emit(makeEvent("agent.run.started"));       // blocked
            filter.emit(makeEvent("agent.action.failed"));     // passes
            filter.emit(makeEvent("agent.tool.timeout"));      // passes
            filter.emit(makeEvent("agent.run.completed"));     // passes
            filter.emit(makeEvent("agent.observation.recorded")); // blocked

            expect(innerSink.events).toHaveLength(3);
            expect(innerSink.events.map(e => e.type)).toEqual([
                "agent.action.failed",
                "agent.tool.timeout",
                "agent.run.completed",
            ]);
        });

        it("CI transport forces 'minimal' regardless of user override", async () => {
            const memFs = makeMemoryFs();
            // Pre-populate preferences with a user override of "verbose"
            memFs.files.set("/prefs.json", JSON.stringify({
                version: 1,
                runHistory: [10000, 20000],
                userOverride: "verbose",
            }));

            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            const prefs = await store.load();
            expect(prefs.userOverride).toBe("verbose");

            const hostProfile = makeHostProfile("ci");
            const signals: AdaptationSignals = {
                isPipe: false,
                ttyWidth: 200,
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };

            // CI override dominates
            const level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("minimal");
        });

        it("user override replaces base level before reductions apply", async () => {
            const memFs = makeMemoryFs();
            memFs.files.set("/prefs.json", JSON.stringify({
                version: 1,
                runHistory: [],
                userOverride: "verbose",
            }));

            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            const prefs = await store.load();

            const hostProfile = makeHostProfile("terminal");
            const signals: AdaptationSignals = {
                isPipe: true,       // reduces verbose → normal
                ttyWidth: 60,       // reduces normal → minimal
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };

            const level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("minimal");
        });

        it("historical short runs reduce level by one step", async () => {
            const memFs = makeMemoryFs();
            // Median of [1000, 2000, 3000] = 2000 < 5000 → reduce
            memFs.files.set("/prefs.json", JSON.stringify({
                version: 1,
                runHistory: [1000, 2000, 3000],
            }));

            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            const prefs = await store.load();

            const hostProfile = makeHostProfile("terminal");
            const signals: AdaptationSignals = {
                isPipe: false,
                ttyWidth: 120,
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };

            // Base is "normal", short history reduces to "minimal"
            const level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("minimal");
        });
    });

    describe("mid-run escalation with fake timers", () => {
        it("escalates from 'minimal' to 'normal' after 30s elapsed", () => {
            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: "minimal" });
            const hostProfile = makeHostProfile("terminal");

            let time = 0;
            const tracker = makeRunDurationTracker({
                filter,
                hostProfile,
                now: () => time,
            });

            tracker.start();
            expect(filter.getLevel()).toBe("minimal");
            expect(tracker.hasEscalated()).toBe(false);

            // Emit event before escalation — only minimal events pass
            filter.emit(makeEvent("agent.run.started")); // blocked at minimal
            expect(innerSink.events).toHaveLength(0);

            // Advance time to just before threshold
            time = ESCALATION_THRESHOLD_MS;
            tracker.tick();
            expect(tracker.hasEscalated()).toBe(false);
            expect(filter.getLevel()).toBe("minimal");

            // Advance past threshold
            time = ESCALATION_THRESHOLD_MS + 1;
            tracker.tick();
            expect(tracker.hasEscalated()).toBe(true);
            expect(filter.getLevel()).toBe("normal");

            // Now "normal" events pass through
            filter.emit(makeEvent("agent.run.started"));
            filter.emit(makeEvent("agent.action.started"));
            filter.emit(makeEvent("agent.observation.recorded")); // still blocked at normal
            expect(innerSink.events).toHaveLength(2);
            expect(innerSink.events.map(e => e.type)).toEqual([
                "agent.run.started",
                "agent.action.started",
            ]);
        });

        it("does not escalate when transport is 'ci'", () => {
            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: "minimal" });
            const hostProfile = makeHostProfile("ci");

            let time = 0;
            const tracker = makeRunDurationTracker({
                filter,
                hostProfile,
                now: () => time,
            });

            tracker.start();
            time = ESCALATION_THRESHOLD_MS + 10_000;
            tracker.tick();

            expect(tracker.hasEscalated()).toBe(false);
            expect(filter.getLevel()).toBe("minimal");
        });

        it("does not escalate when level is already 'normal'", () => {
            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: "normal" });
            const hostProfile = makeHostProfile("terminal");

            let time = 0;
            const tracker = makeRunDurationTracker({
                filter,
                hostProfile,
                now: () => time,
            });

            tracker.start();
            time = ESCALATION_THRESHOLD_MS + 10_000;
            tracker.tick();

            expect(tracker.hasEscalated()).toBe(false);
            expect(filter.getLevel()).toBe("normal");
        });

        it("escalation fires at most once", () => {
            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: "minimal" });
            const hostProfile = makeHostProfile("terminal");

            let time = 0;
            const tracker = makeRunDurationTracker({
                filter,
                hostProfile,
                now: () => time,
            });

            tracker.start();
            time = ESCALATION_THRESHOLD_MS + 1;
            tracker.tick();
            expect(tracker.hasEscalated()).toBe(true);
            expect(filter.getLevel()).toBe("normal");

            // Manually set back to minimal and tick again — should not re-escalate
            filter.setLevel("minimal");
            time = ESCALATION_THRESHOLD_MS + 60_000;
            tracker.tick();
            expect(filter.getLevel()).toBe("minimal"); // no re-escalation
        });

        it("stop() returns total duration", () => {
            const innerSink = makeRecordingSink();
            const filter = makeVerbosityFilter({ inner: innerSink, initialLevel: "minimal" });
            const hostProfile = makeHostProfile("terminal");

            let time = 0;
            const tracker = makeRunDurationTracker({
                filter,
                hostProfile,
                now: () => time,
            });

            tracker.start();
            time = 45_000;
            const duration = tracker.stop();
            expect(duration).toBe(45_000);
        });
    });

    describe("preferences round-trip (write then read back)", () => {
        it("persists and reloads run history correctly", async () => {
            const memFs = makeMemoryFs();
            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });

            // Start with empty
            let prefs = await store.load();
            expect(prefs.runHistory).toEqual([]);

            // Record several durations
            prefs = store.recordRunDuration(5000, prefs);
            prefs = store.recordRunDuration(12000, prefs);
            prefs = store.recordRunDuration(8000, prefs);
            await store.save(prefs);

            // Reload and verify
            const reloaded = await store.load();
            expect(reloaded.runHistory).toEqual([5000, 12000, 8000]);
            expect(reloaded.version).toBe(1);
        });

        it("persists and reloads user override correctly", async () => {
            const memFs = makeMemoryFs();
            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });

            let prefs = await store.load();
            prefs = store.setUserOverride("verbose", prefs);
            await store.save(prefs);

            const reloaded = await store.load();
            expect(reloaded.userOverride).toBe("verbose");
        });

        it("clearing user override persists correctly", async () => {
            const memFs = makeMemoryFs();
            memFs.files.set("/prefs.json", JSON.stringify({
                version: 1,
                runHistory: [1000],
                userOverride: "minimal",
            }));

            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            let prefs = await store.load();
            expect(prefs.userOverride).toBe("minimal");

            prefs = store.setUserOverride(undefined, prefs);
            await store.save(prefs);

            const reloaded = await store.load();
            expect(reloaded.userOverride).toBeUndefined();
        });

        it("handles corrupted file gracefully on load", async () => {
            const memFs = makeMemoryFs();
            memFs.files.set("/prefs.json", "not valid json {{{");

            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            const prefs = await store.load();

            // Should return empty preferences without throwing
            expect(prefs.version).toBe(1);
            expect(prefs.runHistory).toEqual([]);
            expect(prefs.userOverride).toBeUndefined();
        });

        it("run history trims to 20 entries on round-trip", async () => {
            const memFs = makeMemoryFs();
            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });

            let prefs = await store.load();

            // Add 25 entries
            for (let i = 1; i <= 25; i++) {
                prefs = store.recordRunDuration(i * 1000, prefs);
            }

            expect(prefs.runHistory).toHaveLength(20);
            // Oldest 5 should be discarded (1000..5000), keeping 6000..25000
            expect(prefs.runHistory[0]).toBe(6000);
            expect(prefs.runHistory[19]).toBe(25000);

            await store.save(prefs);
            const reloaded = await store.load();
            expect(reloaded.runHistory).toHaveLength(20);
            expect(reloaded.runHistory[0]).toBe(6000);
            expect(reloaded.runHistory[19]).toBe(25000);
        });

        it("full end-to-end: load → run → record duration → save → reload affects next computation", async () => {
            const memFs = makeMemoryFs();
            const store = makePreferencesStore({ path: "/prefs.json", fs: memFs.impl });
            const hostProfile = makeHostProfile("terminal");

            // First run: no history, level should be "normal"
            let prefs = await store.load();
            let signals: AdaptationSignals = {
                isPipe: false,
                ttyWidth: 120,
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };
            let level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("normal");

            // Simulate a short run (2 seconds)
            prefs = store.recordRunDuration(2000, prefs);
            await store.save(prefs);

            // Second run: one short entry, median = 2000 < 5000 → reduces to "minimal"
            prefs = await store.load();
            signals = {
                isPipe: false,
                ttyWidth: 120,
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };
            level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("minimal");

            // Third run: add a long run (60s), median of [2000, 60000] = 31000 >= 5000 → no reduction
            prefs = store.recordRunDuration(60000, prefs);
            await store.save(prefs);

            prefs = await store.load();
            signals = {
                isPipe: false,
                ttyWidth: 120,
                runHistory: prefs.runHistory,
                userOverride: prefs.userOverride,
            };
            level = computeVerbosityLevel(hostProfile, signals);
            expect(level).toBe("normal");
        });
    });
});
