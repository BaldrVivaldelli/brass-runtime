// src/agent/core/approvalLearning/__tests__/learningService.property.test.ts

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { shouldAutoApprove, computeConfidence } from "../confidence";
import { validateConfig } from "../learningService";
import { makeLearningApprovalService } from "../learningService";
import { makeInMemoryHistoryStore, addObservation } from "../store";
import { DEFAULT_LEARNING_CONFIG, emptyApprovalHistory } from "../types";
import type { ApprovalObservation, LearningConfig, ApprovalHistory } from "../types";
import type { ApprovalRequest, ApprovalResponse, ApprovalService, AgentEnv, AgentError } from "../../types";
import type { Async } from "../../../../core/types/asyncEffect";
import { approveApprovalRequest, makeApprovalCapability } from "../../approvalCapability";

// --- Generators ---

const observationArb: fc.Arbitrary<ApprovalObservation> = fc.record({
  approved: fc.boolean(),
  timestamp: fc.nat(),
});

// --- Helpers ---

/** Run an Async effect synchronously for testing (works for simple Async/Succeed cases). */
const runAsync = <A>(effect: Async<AgentEnv, AgentError, A>, env: AgentEnv): Promise<A> =>
  new Promise((resolve, reject) => {
    if (effect._tag === "Succeed") {
      resolve(effect.value);
      return;
    }
    if (effect._tag === "Fail") {
      reject(effect.error);
      return;
    }
    if (effect._tag === "Async") {
      effect.register(env, (exit: any) => {
        if (exit._tag === "Success") resolve(exit.value);
        else reject(exit);
      });
      return;
    }
    if (effect._tag === "FlatMap") {
      runAsync(effect.first, env).then((a) => {
        const next = effect.andThen(a);
        return runAsync(next, env);
      }).then(resolve, reject);
      return;
    }
    reject(new Error(`Unsupported Async tag: ${(effect as any)._tag}`));
  });

const makeTestEnv = (): AgentEnv => ({
  fs: undefined as any,
  shell: undefined as any,
  llm: undefined,
  patch: undefined as any,
  permissions: undefined as any,
});

const makeApprovalRequest = (actionType: string): ApprovalRequest => {
  const action = actionType === "shell.exec"
    ? { type: "shell.exec" as const, command: ["npm", "test"] }
    : actionType === "patch.apply"
      ? { type: "patch.apply" as const, patch: "diff --git a/a b/a" }
      : { type: "fs.readFile" as const, path: "README.md" };
  const state = { goal: { id: "goal-test" } as any, phase: "boot" as const, observations: [], errors: [], steps: 0 };
  return {
    action,
    state,
    reason: "test",
    risk: "low",
    defaultAnswer: "approve",
    capability: makeApprovalCapability({ action, workspaceId: "workspace-test", goalId: "goal-test", issuedAt: 1 }),
  };
};

const makeUnderlying = (response: { readonly type: "approved" } | Extract<ApprovalResponse, { type: "rejected" }>): ApprovalService => ({
  request: (request): Async<AgentEnv, AgentError, ApprovalResponse> => ({
    _tag: "Succeed",
    value: response.type === "approved" ? approveApprovalRequest(request) : response,
  } as any),
});

// --- Property 4: Threshold decision boundary ---

describe("Property 4: Threshold decision boundary", () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 7.1**
   *
   * For observations with sufficient sample size, shouldAutoApprove returns
   * true iff confidence strictly > threshold.
   */
  it("shouldAutoApprove returns true iff confidence strictly > threshold", () => {
    fc.assert(
      fc.property(
        fc.array(observationArb, { minLength: 5, maxLength: 50 }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        (observations, decayFactor, threshold) => {
          const config: LearningConfig = {
            confidenceThreshold: threshold,
            observationWindow: 50,
            decayFactor,
            minSampleSize: 5,
          };

          const confidence = computeConfidence(observations, config);
          const result = shouldAutoApprove(observations, config);

          if (confidence > threshold) {
            expect(result).toBe(true);
          } else {
            expect(result).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 5: Minimum sample size delegation ---

describe("Property 5: Minimum sample size delegation", () => {
  /**
   * **Validates: Requirements 6.1, 6.2, 7.2**
   *
   * For observation arrays shorter than minSampleSize (even all-approved),
   * shouldAutoApprove always returns false.
   */
  it("shouldAutoApprove returns false when observations < minSampleSize", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        (minSampleSize, decayFactor, threshold) => {
          // Generate all-approved observations with count < minSampleSize
          const count = minSampleSize - 1;
          const observations: ApprovalObservation[] = Array.from(
            { length: count },
            (_, i) => ({ approved: true, timestamp: i }),
          );

          const config: LearningConfig = {
            confidenceThreshold: threshold,
            observationWindow: 50,
            decayFactor,
            minSampleSize,
          };

          expect(shouldAutoApprove(observations, config)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 6: Observation recording completeness ---

describe("Property 6: Observation recording completeness", () => {
  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * After processing an approval request through the learning service,
   * the history for the action type gains exactly one observation.
   */
  it("each request adds exactly one observation to the action type history", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("fs.readFile", "shell.exec", "patch.apply"),
        fc.boolean(),
        async (actionType, underlyingApproves) => {
          const store = makeInMemoryHistoryStore();
          const underlying = makeUnderlying(
            underlyingApproves ? { type: "approved" } : { type: "rejected", reason: "no" },
          );

          const service = await makeLearningApprovalService({
            underlying,
            store,
            config: {
              // High threshold + high minSampleSize ensures delegation
              confidenceThreshold: 0.99,
              minSampleSize: 100,
              observationWindow: 50,
              decayFactor: 0.85,
            },
          });

          const req = makeApprovalRequest(actionType);
          const env = makeTestEnv();

          // Before: 0 observations
          const beforeCount = store.getState().actions[actionType]?.observations.length ?? 0;
          expect(beforeCount).toBe(0);

          // Process request
          await runAsync(service.request(req), env);

          // After: exactly 1 observation
          const afterCount = store.getState().actions[actionType]?.observations.length ?? 0;
          expect(afterCount).toBe(beforeCount + 1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("auto-approved requests also record an observation", async () => {
    // Pre-populate with enough approvals to trigger auto-approve
    const actionType = "fs.readFile";
    let history: ApprovalHistory = emptyApprovalHistory();
    for (let i = 0; i < 10; i++) {
      history = addObservation(history, actionType, { approved: true, timestamp: i }, 50);
    }

    const store = makeInMemoryHistoryStore(history);
    const underlying = makeUnderlying({ type: "approved" });

    const service = await makeLearningApprovalService({
      underlying,
      store,
      config: {
        confidenceThreshold: 0.5,
        minSampleSize: 5,
        observationWindow: 50,
        decayFactor: 0.85,
      },
    });

    const req = makeApprovalRequest(actionType);
    const env = makeTestEnv();

    const beforeCount = store.getState().actions[actionType]?.observations.length ?? 0;
    await runAsync(service.request(req), env);
    const afterCount = store.getState().actions[actionType]?.observations.length ?? 0;

    expect(afterCount).toBe(beforeCount + 1);
  });
});

// --- Property 9: Configuration validation ---

describe("Property 9: Configuration validation", () => {
  /**
   * **Validates: Requirements 9.4, 9.5**
   *
   * validateConfig accepts threshold in (0, 1], rejects outside;
   * accepts positive integer windows, rejects non-positive/non-integer;
   * accepts decayFactor in (0, 1), rejects outside.
   */
  it("accepts valid confidenceThreshold in (0, 1]", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 1.0, noNaN: true }),
        (threshold) => {
          const result = validateConfig({ confidenceThreshold: threshold });
          expect(result.confidenceThreshold).toBe(threshold);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects confidenceThreshold <= 0 or > 1", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: -100, max: 0, noNaN: true }),
          fc.double({ min: 1.001, max: 100, noNaN: true }),
        ),
        (threshold) => {
          expect(() => validateConfig({ confidenceThreshold: threshold })).toThrow(
            /Invalid confidenceThreshold/,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("accepts valid observationWindow (positive integer)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        (window) => {
          const result = validateConfig({ observationWindow: window });
          expect(result.observationWindow).toBe(window);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects non-positive or non-integer observationWindow", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -100, max: 0 }),
          fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        ),
        (window) => {
          expect(() => validateConfig({ observationWindow: window })).toThrow(
            /Invalid observationWindow/,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("accepts valid decayFactor in (0, 1)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        (decay) => {
          const result = validateConfig({ decayFactor: decay });
          expect(result.decayFactor).toBe(decay);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects decayFactor <= 0 or >= 1", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: -100, max: 0, noNaN: true }),
          fc.double({ min: 1, max: 100, noNaN: true }),
        ),
        (decay) => {
          expect(() => validateConfig({ decayFactor: decay })).toThrow(
            /Invalid decayFactor/,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("accepts valid minSampleSize (positive integer)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        (size) => {
          const result = validateConfig({ minSampleSize: size });
          expect(result.minSampleSize).toBe(size);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects non-positive or non-integer minSampleSize", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -100, max: 0 }),
          fc.double({ min: 0.1, max: 0.9, noNaN: true }),
        ),
        (size) => {
          expect(() => validateConfig({ minSampleSize: size })).toThrow(
            /Invalid minSampleSize/,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
