import type {
    AgentAction,
    AgentHost,
    AgentLifecycle,
    AgentPersistenceKey,
    AgentState,
    AgentWorkspace,
    PermissionDecision,
    PermissionService,
} from "./types";
import { asyncSucceed } from "../../core/types/asyncEffect";

export const AGENT_HOST_CONTRACT_VERSION = 1 as const;

export class AgentHostConfigError extends Error {
    readonly _tag = "AgentHostConfigError" as const;

    constructor(message: string) {
        super(message);
        this.name = "AgentHostConfigError";
    }
}

export const AGENT_PERSISTENCE_KEYS: readonly AgentPersistenceKey[] = Object.freeze([
    "agent.error-patterns.v1",
    "agent.llm-budget.v1",
    "agent.output-preferences.v1",
    "agent.workspace-memory.v1",
    "agent.patch-strategy.v1",
    "agent.context-budget.v1",
    "agent.validation-intensity.v1",
    "agent.approval-history.v1",
]);

export function validateAgentWorkspace(workspace: AgentWorkspace): AgentWorkspace {
    if (!workspace.id.trim()) throw new AgentHostConfigError("AgentHost workspace.id must not be empty");
    if (!workspace.root.trim()) throw new AgentHostConfigError("AgentHost workspace.root must not be empty");
    if (typeof workspace.trusted !== "boolean") {
        throw new AgentHostConfigError("AgentHost workspace.trusted must be boolean");
    }
    return Object.freeze({ ...workspace });
}

export function validateAgentHost(host: AgentHost): AgentHost {
    if (host.contractVersion !== undefined && host.contractVersion !== AGENT_HOST_CONTRACT_VERSION) {
        throw new AgentHostConfigError(
            `Unsupported AgentHost contract version ${String(host.contractVersion)}`,
        );
    }
    if (!host.fs || !host.shell || !host.patch || !host.permissions) {
        throw new AgentHostConfigError("AgentHost requires fs, shell, patch, and permissions capabilities");
    }
    if (host.workspace) validateAgentWorkspace(host.workspace);
    if (host.persistence?.version !== undefined && host.persistence.version !== 1) {
        throw new AgentHostConfigError(
            `Unsupported AgentHost persistence version ${String(host.persistence.version)}`,
        );
    }
    return host;
}

export function makeAgentLifecycle(): AgentLifecycle {
    const controller = new AbortController();
    const listeners = new Set<() => void>();
    let shuttingDown = false;

    const shutdown = (): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        controller.abort(new Error("AgentHost shutdown"));
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                // Host lifecycle observers cannot change shutdown semantics.
            }
        }
        listeners.clear();
    };

    return {
        signal: controller.signal,
        isShuttingDown: () => shuttingDown,
        onShutdown: (listener) => {
            if (shuttingDown) {
                listener();
                return () => undefined;
            }
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        shutdown,
    };
}

const requiresTrustedWorkspace = (action: AgentAction): boolean =>
    action.type === "shell.exec" || action.type === "patch.apply" || action.type === "patch.rollback";

/**
 * Re-check workspace trust for every host-sensitive action. The wrapper is
 * intentionally outside UI state so a stale approval dialog cannot bypass it.
 */
export function withWorkspaceTrust(
    permissions: PermissionService,
    workspace: Pick<AgentWorkspace, "trusted">,
): PermissionService {
    if (workspace.trusted) return permissions;
    return {
        check: (action: AgentAction, state: AgentState) => {
            if (requiresTrustedWorkspace(action)) {
                return asyncSucceed({
                    type: "deny",
                    reason: `Action ${action.type} requires a trusted workspace`,
                } satisfies PermissionDecision) as any;
            }
            return permissions.check(action, state);
        },
    };
}
