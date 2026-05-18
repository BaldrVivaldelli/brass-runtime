import { describe, it, expect } from "vitest";
import { decideNextAction } from "../../decide";
import { strategyPromptFragment } from "../promptStrategy";
import { PATCH_STRATEGIES } from "../types";
import type { AgentState, AgentEnv } from "../../types";

/**
 * Integration tests for decide.ts strategy selection.
 * Feature: adaptive-patch-strategy
 */

/**
 * Build a minimal AgentState that will reach the planning branch in decideNextAction.
 * The state must:
 * - Have a package.json read observation (so it doesn't try to read it)
 * - Have no pending project probes (lockfile checks done)
 * - Have no initialPatch
 * - Have no pending LLM patch candidate
 * - Have no plan response yet
 * - Have llmAvailable = true
 * - Have context discovery satisfied (no pending context actions)
 */
const makePlanningState = (overrides?: {
    rewardHistory?: readonly { arm: string; reward: number; timestamp: number }[];
    patchStrategy?: { algorithm?: string; enabled?: boolean; gamma?: number };
}): AgentState => ({
    goal: {
        id: "test-goal",
        cwd: "/tmp/test",
        text: "fix the bug in src/index.ts",
        mode: "write",
        llmAvailable: true,
        project: { validationCommands: [] },
        context: { enabled: false },
        patchStrategy: overrides?.patchStrategy as any,
        rewardHistory: overrides?.rewardHistory as any,
    },
    phase: "planning",
    observations: [
        { type: "fs.fileRead", path: "package.json", content: '{"name":"test","scripts":{}}' },
        // Lockfile probes done (all non-existent)
        { type: "fs.exists", path: "pnpm-lock.yaml", exists: false },
        { type: "fs.exists", path: "yarn.lock", exists: false },
        { type: "fs.exists", path: "bun.lockb", exists: false },
        { type: "fs.exists", path: "bun.lock", exists: false },
        { type: "fs.exists", path: "package-lock.json", exists: true },
        { type: "fs.exists", path: "npm-shrinkwrap.json", exists: false },
        // Project profile probes (all from PROJECT_PROFILE_PROBES)
        { type: "fs.exists", path: "Cargo.toml", exists: false },
        { type: "fs.exists", path: "Cargo.lock", exists: false },
        { type: "fs.exists", path: "src-tauri/tauri.conf.json", exists: false },
        { type: "fs.exists", path: "src-tauri/Cargo.toml", exists: false },
        { type: "fs.exists", path: "apps/desktop/package.json", exists: false },
        { type: "fs.exists", path: "apps/desktop/src-tauri/tauri.conf.json", exists: false },
        { type: "fs.exists", path: "apps/desktop/src-tauri/Cargo.toml", exists: false },
        { type: "fs.exists", path: "bridges/whatsmeow-bridge/Cargo.toml", exists: false },
        { type: "fs.exists", path: "bridges/whatsmeow-bridge/package.json", exists: false },
        { type: "fs.exists", path: "apps", exists: false },
        { type: "fs.exists", path: "packages", exists: false },
        { type: "fs.exists", path: "bridges", exists: false },
        { type: "fs.exists", path: "turbo.json", exists: false },
        { type: "fs.exists", path: "nx.json", exists: false },
        { type: "fs.exists", path: "pnpm-workspace.yaml", exists: false },
    ],
    errors: [],
    steps: 3,
});

describe("integration tests for decide.ts strategy selection", () => {
    it("decideNextAction produces a planning prompt containing a strategy fragment", () => {
        const state = makePlanningState({
            rewardHistory: [
                { arm: "direct-patch", reward: 1.0, timestamp: 1718000000000 },
                { arm: "multi-step-patch", reward: 0.5, timestamp: 1718000100000 },
            ],
            patchStrategy: { algorithm: "thompson", enabled: true },
        });

        const action = (decideNextAction(state) as any).value;

        expect(action.type).toBe("llm.complete");
        expect(action.purpose).toBe("plan");

        // The prompt should contain at least one of the strategy fragments
        const containsFragment = PATCH_STRATEGIES.some((strategy) =>
            action.prompt.includes(strategyPromptFragment(strategy)),
        );
        expect(containsFragment).toBe(true);
    });

    it("strategy selection does not alter AgentState", () => {
        const state = makePlanningState({
            rewardHistory: [
                { arm: "direct-patch", reward: 0.8, timestamp: 1718000000000 },
            ],
            patchStrategy: { algorithm: "thompson", enabled: true },
        });

        const stateCopy = JSON.parse(JSON.stringify(state));

        (decideNextAction(state) as any).value;

        // State should be unchanged
        expect(state).toStrictEqual(stateCopy);
    });

    it("graceful degradation with empty history returns direct-patch fragment", () => {
        const state = makePlanningState({
            rewardHistory: [],
            patchStrategy: { algorithm: "thompson", enabled: true },
        });

        const action = (decideNextAction(state) as any).value;

        expect(action.type).toBe("llm.complete");
        expect(action.purpose).toBe("plan");
        // With empty history, should use direct-patch (default strategy)
        expect(action.prompt).toContain(strategyPromptFragment("direct-patch"));
    });
});
