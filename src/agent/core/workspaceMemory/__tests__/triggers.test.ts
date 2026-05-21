// src/agent/core/workspaceMemory/__tests__/triggers.test.ts

import { describe, it, expect } from "vitest";
import {
  detectTrigger,
  updateTriggerState,
  shouldReInfer,
  markReInferencePerformed,
  initialTriggerState,
  RE_INFERENCE_COOLDOWN_STEPS,
} from "../triggers";
import type { TriggerState } from "../triggers";
import type { Observation } from "../../types";
import type { HostSignalInput } from "../../hostSignals";

/**
 * Unit tests for workspace memory trigger detection.
 * Feature: workspace-profile-evolution
 * Validates: Requirements 6.1, 6.2, 6.4, 9.1, 9.2, 9.3, 9.4
 */

const baseSignals: HostSignalInput = {
  argv: [],
  env: { HOME: "/home/user", PATH: "/usr/bin", NODE_ENV: "development" },
  stdoutIsTTY: true,
  stdinIsTTY: true,
  ttyColumns: 120,
  parentProcessName: undefined,
  workspaceMarkers: ["/workspace/.vscode"],
  stdinFirstLine: undefined,
  configPaths: [],
};

describe("detectTrigger", () => {
  it("returns true for shell.result with new env var in stdout", () => {
    const observation: Observation = {
      type: "shell.result",
      command: ["env"],
      exitCode: 0,
      stdout: "DOCKER_HOST=tcp://localhost:2375",
      stderr: "",
    };

    expect(detectTrigger(observation, baseSignals)).toBe(true);
  });

  it("returns true for shell.result with new env var in stderr", () => {
    const observation: Observation = {
      type: "shell.result",
      command: ["script"],
      exitCode: 0,
      stdout: "",
      stderr: "CUSTOM_VAR=hello",
    };

    expect(detectTrigger(observation, baseSignals)).toBe(true);
  });

  it("returns false for shell.result with existing env var", () => {
    const observation: Observation = {
      type: "shell.result",
      command: ["echo"],
      exitCode: 0,
      stdout: "HOME=/home/user",
      stderr: "",
    };

    expect(detectTrigger(observation, baseSignals)).toBe(false);
  });

  it("returns false for shell.result without env var patterns", () => {
    const observation: Observation = {
      type: "shell.result",
      command: ["ls"],
      exitCode: 0,
      stdout: "file1.ts\nfile2.ts",
      stderr: "",
    };

    expect(detectTrigger(observation, baseSignals)).toBe(false);
  });

  it("returns true for fs.exists with new workspace marker", () => {
    const observation: Observation = {
      type: "fs.exists",
      path: "/workspace/.cursor",
      exists: true,
    };

    expect(detectTrigger(observation, baseSignals)).toBe(true);
  });

  it("returns false for fs.exists with already-known marker path", () => {
    const observation: Observation = {
      type: "fs.exists",
      path: "/workspace/.vscode",
      exists: true,
    };

    // .vscode is already in workspaceMarkers
    const signals: HostSignalInput = {
      ...baseSignals,
      workspaceMarkers: ["/workspace/.vscode"],
    };

    expect(detectTrigger(observation, signals)).toBe(false);
  });

  it("returns false for fs.exists with exists: false", () => {
    const observation: Observation = {
      type: "fs.exists",
      path: "/workspace/.cursor",
      exists: false,
    };

    expect(detectTrigger(observation, baseSignals)).toBe(false);
  });

  it("returns false for non-trigger observation types", () => {
    const observation: Observation = {
      type: "fs.fileRead",
      path: "/workspace/src/a.ts",
      content: "export const x = 1;",
    };

    expect(detectTrigger(observation, baseSignals)).toBe(false);
  });
});

describe("updateTriggerState", () => {
  it("flags pending trigger when detectTrigger returns true", () => {
    const state = initialTriggerState();
    const observation: Observation = {
      type: "shell.result",
      command: ["env"],
      exitCode: 0,
      stdout: "NEW_VAR=value",
      stderr: "",
    };

    const result = updateTriggerState(state, observation, baseSignals);
    expect(result.pendingTrigger).toBe(true);
  });

  it("does not change state when no trigger detected", () => {
    const state = initialTriggerState();
    const observation: Observation = {
      type: "fs.fileRead",
      path: "/workspace/a.ts",
      content: "hello",
    };

    const result = updateTriggerState(state, observation, baseSignals);
    expect(result).toBe(state); // Same reference — no change
  });

  it("does not overwrite existing pending trigger", () => {
    const state: TriggerState = { lastReInferenceStep: 5, pendingTrigger: true };
    const observation: Observation = {
      type: "shell.result",
      command: ["env"],
      exitCode: 0,
      stdout: "ANOTHER_VAR=value",
      stderr: "",
    };

    const result = updateTriggerState(state, observation, baseSignals);
    expect(result).toBe(state); // Same reference — already pending
  });
});

describe("shouldReInfer", () => {
  it("returns false when no trigger is pending", () => {
    const state: TriggerState = { lastReInferenceStep: 0, pendingTrigger: false };
    expect(shouldReInfer(state, 100)).toBe(false);
  });

  it("returns false within cooldown window", () => {
    const state: TriggerState = { lastReInferenceStep: 5, pendingTrigger: true };
    expect(shouldReInfer(state, 10)).toBe(false); // Only 5 steps elapsed
  });

  it("returns true when trigger pending and cooldown elapsed", () => {
    const state: TriggerState = { lastReInferenceStep: 0, pendingTrigger: true };
    expect(shouldReInfer(state, 10)).toBe(true); // Exactly 10 steps elapsed
  });

  it("returns true when trigger pending and well past cooldown", () => {
    const state: TriggerState = { lastReInferenceStep: 0, pendingTrigger: true };
    expect(shouldReInfer(state, 100)).toBe(true);
  });

  it("respects 10-step cooldown exactly", () => {
    const state: TriggerState = { lastReInferenceStep: 5, pendingTrigger: true };
    expect(shouldReInfer(state, 14)).toBe(false); // 9 steps
    expect(shouldReInfer(state, 15)).toBe(true); // 10 steps
  });
});

describe("markReInferencePerformed", () => {
  it("resets pendingTrigger to false", () => {
    const state: TriggerState = { lastReInferenceStep: 0, pendingTrigger: true };
    const result = markReInferencePerformed(state, 15);
    expect(result.pendingTrigger).toBe(false);
  });

  it("records current step as lastReInferenceStep", () => {
    const state: TriggerState = { lastReInferenceStep: 0, pendingTrigger: true };
    const result = markReInferencePerformed(state, 25);
    expect(result.lastReInferenceStep).toBe(25);
  });
});

describe("initialTriggerState", () => {
  it("returns state with no pending trigger", () => {
    const state = initialTriggerState();
    expect(state.pendingTrigger).toBe(false);
    expect(state.lastReInferenceStep).toBe(0);
  });
});

describe("RE_INFERENCE_COOLDOWN_STEPS", () => {
  it("is 10", () => {
    expect(RE_INFERENCE_COOLDOWN_STEPS).toBe(10);
  });
});
