import { asyncFail, asyncFlatMap, asyncSucceed, asyncSync, type Async } from "../../core/types/asyncEffect";
import type { Scope } from "../../core/runtime/scope";
import type {
    AgentAction,
    AgentEnv,
    AgentError,
    AgentState,
    AgentToolPolicyConfig,
    ApprovalRequest,
    ApprovalResponse,
    Observation,
    PermissionDecision,
} from "../core/types";
import { makeApprovalCapability, sha256Hex, validateApprovalCapability } from "../core/approvalCapability";
import { emitAgentEvent, nowMillis } from "../core/events";
import { actionToEffect } from "./actionToEffect";
import { service } from "./env";
import { retry } from "./retry";
import { timeout } from "./timeout";

type ToolPolicy = {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly retryable: (error: AgentError) => boolean;
};

const isTransient = (error: AgentError): boolean => error._tag === "LLMError" || error._tag === "ToolTimeout";

const defaultPolicyFor = (action: AgentAction): ToolPolicy => {
    switch (action.type) {
        case "fs.readFile":
        case "fs.exists":
        case "fs.searchText":
            return { timeoutMs: 5_000, retries: 1, retryable: isTransient };
        case "llm.complete":
            return { timeoutMs: 60_000, retries: 2, retryable: isTransient };
        case "shell.exec":
            return { timeoutMs: 120_000, retries: 0, retryable: () => false };
        case "patch.propose":
        case "agent.finish":
        case "agent.fail":
            return { timeoutMs: 1_000, retries: 0, retryable: () => false };

        case "patch.apply":
        case "patch.rollback":
            return { timeoutMs: 15_000, retries: 0, retryable: () => false };
    }
};

const configuredPolicyFor = (
    action: AgentAction,
    overrides: AgentToolPolicyConfig | undefined
): ToolPolicy => {
    const base = defaultPolicyFor(action);
    const override = overrides?.[action.type];

    return {
        ...base,
        timeoutMs: override?.timeoutMs !== undefined
            ? Math.max(1, Math.floor(override.timeoutMs))
            : base.timeoutMs,
        retries: override?.retries !== undefined
            ? Math.max(0, Math.floor(override.retries))
            : base.retries,
    };
};

const runAuthorizedAction = (
    action: AgentAction,
    state: AgentState,
    scope: Scope<AgentEnv>
): Async<AgentEnv, AgentError, Observation> =>
    asyncFlatMap(asyncSync((env: AgentEnv) => env.toolPolicies) as any, (toolPolicies: AgentToolPolicyConfig | undefined) => {
        const policy = configuredPolicyFor(action, toolPolicies);
        return retry(() => timeout(actionToEffect(action, state), policy.timeoutMs, scope), {
            times: policy.retries,
            while: policy.retryable,
        }) as any;
    }) as any;

const rejected = (action: AgentAction, reason: string): AgentError => ({
    _tag: "ApprovalRejected",
    action,
    reason,
});

const emitApprovalResolved = (
    action: AgentAction,
    state: AgentState,
    approved: boolean,
    reason: string | undefined
): Async<AgentEnv, never, void> =>
    asyncFlatMap(nowMillis() as any, (at: number) =>
        emitAgentEvent({
            type: "agent.approval.resolved",
            action,
            step: state.steps + 1,
            phase: state.phase,
            approved,
            ...(reason ? { reason } : {}),
            at,
        }) as any
    ) as any;

const requestApproval = (
    action: AgentAction,
    state: AgentState,
    decision: Extract<PermissionDecision, { type: "ask" }>
): Async<AgentEnv, AgentError, void> => {
    const defaultAnswer = decision.defaultAnswer ?? "reject";

    return asyncFlatMap(
        asyncSync((env: AgentEnv) => env.workspace?.id ?? sha256Hex(state.goal.cwd).slice(0, 24)) as any,
        (workspaceId: string) => asyncFlatMap(nowMillis() as any, (at: number) => {
            const capability = makeApprovalCapability({
                action,
                workspaceId,
                goalId: state.goal.id,
                issuedAt: at,
            });
            const request: ApprovalRequest = {
                action,
                state,
                reason: decision.reason,
                risk: decision.risk,
                defaultAnswer,
                capability,
            };

            return asyncFlatMap(
                emitAgentEvent({
                    type: "agent.approval.requested",
                    action,
                    step: state.steps + 1,
                    phase: state.phase,
                    reason: decision.reason,
                    risk: decision.risk,
                    defaultAnswer,
                    capabilityId: capability.capabilityId,
                    operationHash: capability.operationHash,
                    expiresAt: capability.expiresAt,
                    at,
                }) as any,
                () => asyncFlatMap(service("approvals") as any, (approvals: AgentEnv["approvals"]) => {
                    if (!approvals) {
                        const reason = "No approval service configured.";
                        return asyncFlatMap(emitApprovalResolved(action, state, false, reason) as any, () =>
                            asyncFail(rejected(action, reason)) as any
                        ) as any;
                    }

                    return asyncFlatMap(
                        approvals.request(request) as any,
                        (response: ApprovalResponse) => asyncFlatMap(nowMillis() as any, (resolvedAt: number) => {
                            if (response.type === "approved") {
                                const validation = validateApprovalCapability(response, request, resolvedAt);
                                if (!validation.valid) {
                                    return asyncFlatMap(
                                        emitApprovalResolved(action, state, false, validation.reason) as any,
                                        () => asyncFail(rejected(action, validation.reason)) as any,
                                    ) as any;
                                }
                                return asyncFlatMap(emitApprovalResolved(action, state, true, undefined) as any, () =>
                                    asyncSucceed(undefined) as any
                                ) as any;
                            }

                            const reason = response.reason ?? "Approval rejected.";
                            return asyncFlatMap(emitApprovalResolved(action, state, false, reason) as any, () =>
                                asyncFail(rejected(action, reason)) as any
                            ) as any;
                        }) as any,
                    ) as any;
                }) as any,
            ) as any;
        }) as any,
    ) as any;
};

export const invokeAction = (
    action: AgentAction,
    state: AgentState,
    scope: Scope<AgentEnv>
): Async<AgentEnv, AgentError, Observation> =>
    asyncFlatMap(service("permissions") as any, (permissions: AgentEnv["permissions"]) =>
        asyncFlatMap(permissions.check(action, state) as any, (decision: PermissionDecision) => {
            if (decision.type === "deny") {
                return asyncFail({
                    _tag: "PermissionDenied",
                    action,
                    reason: decision.reason,
                } satisfies AgentError) as any;
            }

            if (decision.type === "ask") {
                return asyncFlatMap(requestApproval(action, state, decision) as any, () =>
                    runAuthorizedAction(action, state, scope) as any
                ) as any;
            }

            return runAuthorizedAction(action, state, scope) as any;
        }) as any
    ) as any;
