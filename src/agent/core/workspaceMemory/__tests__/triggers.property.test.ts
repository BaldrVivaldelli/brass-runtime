// src/agent/core/workspaceMemory/__tests__/triggers.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
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
import { buildHostProfile } from "../../hostInference";

// --- Generators ---

const envKeyArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,14}$/);
const envValueArb = fc.string({ minLength: 1, maxLength: 20 });

const baseSignalInput: HostSignalInput = {
  argv: [],
  env: { HOME: "/home/user", PATH: "/usr/bin" },
  stdoutIsTTY: true,
  stdinIsTTY: true,
  ttyColumns: 120,
  parentProcessName: undefined,
  workspaceMarkers: [],
  stdinFirstLine: undefined,
  configPaths: [],
};

// --- Property 6: Trigger detection correctness ---

describe("Property 6: Trigger detection correctness", () => {
  /**
   * **Validates: Requirements 6.1, 6.2, 9.1, 9.2, 9.3**
   *
   * For any shell.result observation whose stdout or stderr contains an environment
   * variable assignment (KEY=value) where KEY is not present in the original
   * HostSignalInput.env, detectTrigger SHALL return true.
   */
  it("detects new env vars in shell.result stdout", () => {
    fc.assert(
      fc.property(
        envKeyArb,
        envValueArb,
        (newKey, value) => {
          // Ensure the key is not in the original signals
          fc.pre(!Object.keys(baseSignalInput.env).includes(newKey));
          fc.pre(newKey.length >= 2);

          const observation: Observation = {
            type: "shell.result",
            command: ["echo"],
            exitCode: 0,
            stdout: `export ${newKey}=${value}`,
            stderr: "",
          };

          const result = detectTrigger(observation, baseSignalInput);
          expect(result).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not trigger for env vars already in original signals", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(baseSignalInput.env)),
        envValueArb,
        (existingKey, value) => {
          const observation: Observation = {
            type: "shell.result",
            command: ["echo"],
            exitCode: 0,
            stdout: `${existingKey}=${value}`,
            stderr: "",
          };

          const result = detectTrigger(observation, baseSignalInput);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not trigger for observations without new signals", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (content) => {
          const observation: Observation = {
            type: "fs.fileRead",
            path: "/some/file.ts",
            content,
          };

          const result = detectTrigger(observation, baseSignalInput);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("detects new workspace markers in fs.exists observations", () => {
    const markerArb = fc.constantFrom(".vscode", ".cursor", ".kiro", ".idea", "package.json", "tsconfig.json");

    fc.assert(
      fc.property(markerArb, (marker) => {
        const observation: Observation = {
          type: "fs.exists",
          path: `/workspace/${marker}`,
          exists: true,
        };

        const signals: HostSignalInput = {
          ...baseSignalInput,
          workspaceMarkers: [], // No existing markers
        };

        const result = detectTrigger(observation, signals);
        expect(result).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("does not trigger for fs.exists with exists: false", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(".vscode", ".cursor", ".kiro"),
        (marker) => {
          const observation: Observation = {
            type: "fs.exists",
            path: `/workspace/${marker}`,
            exists: false,
          };

          const result = detectTrigger(observation, baseSignalInput);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 7: Re-inference rate limiting ---

describe("Property 7: Re-inference rate limiting", () => {
  /**
   * **Validates: Requirements 6.4, 9.4**
   *
   * For any sequence of agent steps with trigger events, shouldReInfer SHALL return
   * true at most once per 10 consecutive steps.
   */
  it("shouldReInfer returns true at most once per 10 consecutive steps", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 10, maxLength: 50 }),
        fc.integer({ min: 0, max: 100 }),
        (triggerSequence, startStep) => {
          let state: TriggerState = initialTriggerState();
          const reInferenceSteps: number[] = [];

          for (let i = 0; i < triggerSequence.length; i++) {
            const currentStep = startStep + i;

            // Simulate trigger detection
            if (triggerSequence[i]) {
              state = { ...state, pendingTrigger: true };
            }

            // Check if re-inference should fire
            if (shouldReInfer(state, currentStep)) {
              reInferenceSteps.push(currentStep);
              state = markReInferencePerformed(state, currentStep);
            }
          }

          // Verify rate limiting: consecutive re-inferences must be at least 10 steps apart
          for (let i = 1; i < reInferenceSteps.length; i++) {
            expect(reInferenceSteps[i] - reInferenceSteps[i - 1]).toBeGreaterThanOrEqual(
              RE_INFERENCE_COOLDOWN_STEPS,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("shouldReInfer returns false when no trigger is pending", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        (currentStep) => {
          const state: TriggerState = { lastReInferenceStep: 0, pendingTrigger: false };
          expect(shouldReInfer(state, currentStep)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("shouldReInfer returns false within cooldown window even with pending trigger", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: RE_INFERENCE_COOLDOWN_STEPS - 1 }),
        (lastStep, offset) => {
          const state: TriggerState = { lastReInferenceStep: lastStep, pendingTrigger: true };
          expect(shouldReInfer(state, lastStep + offset)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 8: Re-inference purity and determinism ---

describe("Property 8: Re-inference purity and determinism", () => {
  /**
   * **Validates: Requirements 6.5, 10.4**
   *
   * For any HostSignalInput, invoking buildHostProfile twice with the same input
   * SHALL produce structurally equal HostProfile results.
   */
  it("buildHostProfile called twice with same input produces equal results", () => {
    const hostSignalInputArb: fc.Arbitrary<HostSignalInput> = fc.record({
      argv: fc.array(fc.string({ minLength: 0, maxLength: 10 }), { minLength: 0, maxLength: 5 }),
      env: fc.dictionary(envKeyArb, envValueArb, { minKeys: 0, maxKeys: 5 }),
      stdoutIsTTY: fc.boolean(),
      stdinIsTTY: fc.boolean(),
      ttyColumns: fc.option(fc.integer({ min: 40, max: 300 }), { nil: undefined }),
      parentProcessName: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      workspaceMarkers: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
      stdinFirstLine: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
      configPaths: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
    });

    fc.assert(
      fc.property(hostSignalInputArb, (input) => {
        const first = buildHostProfile(input);
        const second = buildHostProfile(input);
        expect(first).toStrictEqual(second);
      }),
      { numRuns: 200 },
    );
  });
});
