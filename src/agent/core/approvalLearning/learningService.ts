// src/agent/core/approvalLearning/learningService.ts

import type { Async } from "../../../core/types/asyncEffect";
import type {
  AgentEnv,
  AgentError,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalService,
} from "../types";
import type { ApprovalHistory, LearningConfig } from "./types";
import { DEFAULT_LEARNING_CONFIG } from "./types";
import { shouldAutoApprove } from "./confidence";
import type { HistoryStore } from "./store";
import { addObservation } from "./store";
import { approveApprovalRequest } from "../approvalCapability";

export type LearningApprovalServiceConfig = {
  readonly underlying: ApprovalService;
  readonly store: HistoryStore;
  readonly config?: Partial<LearningConfig>;
};

/**
 * Validate a partial LearningConfig, throwing on invalid values.
 * Merges with defaults for any missing fields.
 */
export const validateConfig = (
  partial: Partial<LearningConfig> | undefined,
): LearningConfig => {
  const config = { ...DEFAULT_LEARNING_CONFIG, ...partial };

  if (
    typeof config.confidenceThreshold !== "number" ||
    config.confidenceThreshold <= 0 ||
    config.confidenceThreshold > 1
  ) {
    throw new Error(
      `Invalid confidenceThreshold: must be a number in (0, 1], got ${config.confidenceThreshold}`,
    );
  }

  if (
    typeof config.observationWindow !== "number" ||
    !Number.isInteger(config.observationWindow) ||
    config.observationWindow <= 0
  ) {
    throw new Error(
      `Invalid observationWindow: must be a positive integer, got ${config.observationWindow}`,
    );
  }

  if (
    typeof config.decayFactor !== "number" ||
    config.decayFactor <= 0 ||
    config.decayFactor >= 1
  ) {
    throw new Error(
      `Invalid decayFactor: must be a number in (0, 1), got ${config.decayFactor}`,
    );
  }

  if (
    typeof config.minSampleSize !== "number" ||
    !Number.isInteger(config.minSampleSize) ||
    config.minSampleSize <= 0
  ) {
    throw new Error(
      `Invalid minSampleSize: must be a positive integer, got ${config.minSampleSize}`,
    );
  }

  return config;
};

/**
 * Create a LearningApprovalService that wraps an existing ApprovalService.
 * Implements the ApprovalService interface transparently.
 *
 * Loads history from the store on initialization, then intercepts approval
 * requests to check confidence before delegating.
 */
export const makeLearningApprovalService = async (
  options: LearningApprovalServiceConfig,
): Promise<ApprovalService> => {
  const config = validateConfig(options.config);
  let history: ApprovalHistory = await options.store.load();

  const recordAndPersist = async (
    actionType: string,
    approved: boolean,
  ): Promise<void> => {
    const observation = { approved, timestamp: Date.now() };
    history = addObservation(history, actionType, observation, config.observationWindow);
    try {
      await options.store.save(history);
    } catch {
      // Persistence failure is non-fatal — in-memory state is still updated
    }
  };

  const request = (
    req: ApprovalRequest,
  ): Async<AgentEnv, AgentError, ApprovalResponse> => {
    const actionType = req.action.type;
    const actionHistory = history.actions[actionType];
    const observations = actionHistory?.observations ?? [];

    if (shouldAutoApprove(observations, config)) {
      // Auto-approve: record and return immediately
      return {
        _tag: "Async",
        register: (_env: AgentEnv, cb: (exit: { readonly _tag: "Success"; readonly value: ApprovalResponse }) => void) => {
          recordAndPersist(actionType, true).then(
            () => cb({ _tag: "Success", value: approveApprovalRequest(req) }),
            () => cb({ _tag: "Success", value: approveApprovalRequest(req) }), // persist failure is non-fatal
          );
        },
      } as Async<AgentEnv, AgentError, ApprovalResponse>;
    }

    // Delegate to underlying service, then record the result
    return {
      _tag: "FlatMap",
      first: options.underlying.request(req),
      andThen: (response: ApprovalResponse): Async<AgentEnv, AgentError, ApprovalResponse> => ({
        _tag: "Async",
        register: (_env: AgentEnv, cb: (exit: { readonly _tag: "Success"; readonly value: ApprovalResponse }) => void) => {
          const approved = response.type === "approved";
          recordAndPersist(actionType, approved).then(
            () => cb({ _tag: "Success", value: response }),
            () => cb({ _tag: "Success", value: response }), // persist failure is non-fatal
          );
        },
      } as Async<AgentEnv, AgentError, ApprovalResponse>),
    } as Async<AgentEnv, AgentError, ApprovalResponse>;
  };

  return { request };
};
