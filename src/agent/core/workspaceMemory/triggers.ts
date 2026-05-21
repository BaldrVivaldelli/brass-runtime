// src/agent/core/workspaceMemory/triggers.ts

import type { Observation } from "../types";
import type { HostSignalInput } from "../hostSignals";

export type TriggerState = {
  readonly lastReInferenceStep: number;
  readonly pendingTrigger: boolean;
};

export const initialTriggerState = (): TriggerState => ({
  lastReInferenceStep: 0,
  pendingTrigger: false,
});

export const RE_INFERENCE_COOLDOWN_STEPS = 10;

/**
 * Pattern for detecting environment variable assignments in shell output.
 * Matches KEY=value where KEY is uppercase letters, digits, and underscores.
 */
const ENV_VAR_PATTERN = /\b([A-Z][A-Z0-9_]{1,})\s*=/;

/** Known workspace marker paths to detect. */
const WORKSPACE_MARKERS = [
  ".vscode",
  ".cursor",
  ".kiro",
  ".idea",
  ".fleet",
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  ".git",
] as const;

/**
 * Detects whether an observation introduces new signal information
 * not present in the original HostSignalInput.
 *
 * Returns true when:
 * - A shell.result contains env var assignments (KEY=value patterns)
 *   not in the original env keys
 * - An fs.exists confirms a workspace marker path not in the original markers
 *
 * Pure function — no side effects.
 */
export const detectTrigger = (
  observation: Observation,
  originalSignals: HostSignalInput,
): boolean => {
  if (observation.type === "shell.result") {
    const output = observation.stdout + "\n" + observation.stderr;
    const lines = output.split("\n");
    const originalKeys = new Set(Object.keys(originalSignals.env));

    for (const line of lines) {
      const match = ENV_VAR_PATTERN.exec(line);
      if (match && !originalKeys.has(match[1])) {
        return true;
      }
    }
    return false;
  }

  if (observation.type === "fs.exists" && observation.exists) {
    const path = observation.path;
    const originalMarkerSet = new Set(originalSignals.workspaceMarkers);

    // Check if this path matches a known workspace marker not already known
    for (const marker of WORKSPACE_MARKERS) {
      if (path.includes(marker) && !originalMarkerSet.has(path)) {
        return true;
      }
    }
    return false;
  }

  return false;
};

/**
 * Updates trigger state after an observation.
 * Flags a pending trigger if detectTrigger returns true.
 * Pure function.
 */
export const updateTriggerState = (
  state: TriggerState,
  observation: Observation,
  originalSignals: HostSignalInput,
): TriggerState => {
  if (state.pendingTrigger) return state;
  const triggered = detectTrigger(observation, originalSignals);
  if (!triggered) return state;
  return { ...state, pendingTrigger: true };
};

/**
 * Determines whether re-inference should fire at the current step.
 * Returns true only when a trigger is pending AND at least 10 steps
 * have elapsed since the last re-inference.
 * Pure function.
 */
export const shouldReInfer = (
  state: TriggerState,
  currentStep: number,
): boolean => {
  if (!state.pendingTrigger) return false;
  return currentStep - state.lastReInferenceStep >= RE_INFERENCE_COOLDOWN_STEPS;
};

/**
 * Resets trigger state after re-inference is performed.
 * Records the current step as the last re-inference step.
 */
export const markReInferencePerformed = (
  state: TriggerState,
  currentStep: number,
): TriggerState => ({
  lastReInferenceStep: currentStep,
  pendingTrigger: false,
});
