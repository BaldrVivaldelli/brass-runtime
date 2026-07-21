import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type {
    AgentEventSink,
    AgentHost,
    AgentHostKind,
    AgentPersistence,
    AgentPersistenceKey,
    AgentPersistenceScope,
    AgentSecretStore,
    AgentTelemetry,
    AgentDiagnostics,
    AgentToolPolicyConfig,
    ApprovalService,
    LLM,
    PermissionService,
} from "../core/types";
import type { HostProfile } from "../core/hostProfile";
import { makeAgentLifecycle, validateAgentHost, withWorkspaceTrust } from "../core/agentHost";
import {
    decodeAgentPersistenceEnvelope,
    encodeAgentPersistenceEnvelope,
    redactAgentPersistenceValue,
} from "../core/persistence";
import { NodeShell } from "./nodeShell";
import { makeNodeFileSystem } from "./nodeFileSystem";
import { makeNodePatchService } from "./nodePatchService";

const STATE_PATHS: Readonly<Record<AgentPersistenceKey, string>> = Object.freeze({
    "agent.error-patterns.v1": ".brass/error-patterns.json",
    "agent.llm-budget.v1": ".brass/llm-budget.json",
    "agent.output-preferences.v1": ".brass/output-prefs.json",
    "agent.workspace-memory.v1": ".brass/workspace-memory.json",
    "agent.patch-strategy.v1": ".brass/patch-strategy.json",
    "agent.context-budget.v1": ".brass/context-budget.json",
    "agent.validation-intensity.v1": ".brass/validation-intensity.json",
    "agent.approval-history.v1": ".brass/approval-history.json",
});

export type AgentPersistenceCodec = {
    readonly encode: (plaintext: string) => Promise<string>;
    readonly decode: (stored: string) => Promise<string>;
};

export type MakeNodeAgentPersistenceOptions = {
    readonly sessionId?: string;
    readonly codec?: AgentPersistenceCodec;
    readonly defaultMaxBytes?: number;
    /** Default retention for session-scoped records. Default: 24 hours. */
    readonly sessionRetentionMs?: number;
    /** Clock override for deterministic retention tests. */
    readonly now?: () => number;
    /** Redactor applied before encoding. Set to false only for trusted custom data. */
    readonly redact?: false | ((key: AgentPersistenceKey, value: string) => string);
};

const identityCodec: AgentPersistenceCodec = {
    encode: async (value) => value,
    decode: async (value) => value,
};

const containedPath = (root: string, relative: string): string => {
    const normalizedRoot = resolve(root);
    const candidate = resolve(normalizedRoot, relative);
    if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
        throw new Error(`Agent persistence path escapes workspace: ${relative}`);
    }
    return candidate;
};

export function makeNodeAgentPersistence(
    workspaceRoot: string,
    options: MakeNodeAgentPersistenceOptions = {},
): AgentPersistence {
    const root = resolve(workspaceRoot);
    const sessionId = (options.sessionId ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const codec = options.codec ?? identityCodec;
    const defaultMaxBytes = options.defaultMaxBytes ?? 1_048_576;
    const sessionRetentionMs = options.sessionRetentionMs ?? 86_400_000;
    const now = options.now ?? Date.now;
    const redact = options.redact === false
        ? (_key: AgentPersistenceKey, value: string) => value
        : options.redact ?? ((_key: AgentPersistenceKey, value: string) => redactAgentPersistenceValue(value));

    const pathFor = (scope: AgentPersistenceScope, key: AgentPersistenceKey): string => {
        const relative = STATE_PATHS[key];
        if (!relative) throw new Error(`Unknown agent persistence key: ${key}`);
        return containedPath(
            root,
            scope === "workspace" ? relative : `.brass/sessions/${sessionId}/${relative.split("/").at(-1)}`,
        );
    };

    return {
        version: 1,
        read: async (scope, key) => {
            try {
                const stored = await codec.decode(await readFile(pathFor(scope, key), "utf8"));
                const decoded = decodeAgentPersistenceEnvelope(stored, now());
                if (decoded.kind === "expired") {
                    await rm(pathFor(scope, key), { force: true });
                    return undefined;
                }
                return decoded.value;
            } catch (error) {
                if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
                    return undefined;
                }
                throw error;
            }
        },
        write: async (scope, key, value, writeOptions) => {
            const maxBytes = writeOptions?.maxBytes ?? defaultMaxBytes;
            const redacted = redact(key, value);
            const bytes = Buffer.byteLength(redacted, "utf8");
            if (bytes > maxBytes) {
                throw new Error(`Agent persistence payload for ${key} is ${bytes} bytes; limit is ${maxBytes}`);
            }
            const currentTime = now();
            const expiresAt = writeOptions?.expiresAt ?? (
                scope === "session" && sessionRetentionMs > 0
                    ? currentTime + sessionRetentionMs
                    : undefined
            );
            if (expiresAt !== undefined && expiresAt <= currentTime) {
                throw new Error(`Agent persistence payload for ${key} is already expired`);
            }
            const target = pathFor(scope, key);
            const encoded = await codec.encode(encodeAgentPersistenceEnvelope(redacted, currentTime, expiresAt));
            if (Buffer.byteLength(encoded, "utf8") > maxBytes + 4_096) {
                throw new Error(`Encoded agent persistence payload for ${key} exceeds storage quota`);
            }
            const temporary = `${target}.${randomUUID()}.tmp`;
            await mkdir(dirname(target), { recursive: true });
            try {
                await writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600 });
                await rename(temporary, target);
            } finally {
                await rm(temporary, { force: true });
            }
        },
        remove: async (scope, key) => {
            await rm(pathFor(scope, key), { force: true });
        },
    };
}

export type MakeNodeAgentHostOptions = {
    readonly cwd: string;
    readonly llm?: LLM;
    readonly permissions: PermissionService;
    readonly approvals?: ApprovalService;
    readonly events?: AgentEventSink;
    readonly toolPolicies?: AgentToolPolicyConfig;
    readonly hostProfile?: HostProfile;
    readonly trusted?: boolean;
    readonly persistence?: AgentPersistence;
    readonly secrets?: AgentSecretStore;
    readonly diagnostics?: AgentDiagnostics;
    readonly telemetry?: AgentTelemetry;
    readonly kind?: Extract<AgentHostKind, "node" | "test" | "custom">;
};

export function makeNodeAgentHost(options: MakeNodeAgentHostOptions): AgentHost {
    const root = resolve(options.cwd);
    const shell = NodeShell;
    const workspace = {
        id: createHash("sha256").update(root).digest("hex").slice(0, 24),
        root,
        trusted: options.trusted ?? true,
    } as const;
    const host: AgentHost = {
        contractVersion: 1,
        kind: options.kind ?? "node",
        workspace,
        shell,
        fs: makeNodeFileSystem(shell),
        patch: makeNodePatchService(shell),
        llm: options.llm,
        permissions: withWorkspaceTrust(options.permissions, workspace),
        approvals: options.approvals,
        persistence: options.persistence ?? makeNodeAgentPersistence(root),
        lifecycle: makeAgentLifecycle(),
        terminal: {
            isInteractive: Boolean(process.stdout?.isTTY),
            ...(process.stdout?.columns ? { columns: process.stdout.columns } : {}),
        },
        ...(options.events ? { events: options.events } : {}),
        ...(options.toolPolicies ? { toolPolicies: options.toolPolicies } : {}),
        ...(options.hostProfile ? { hostProfile: options.hostProfile } : {}),
        ...(options.secrets ? { secrets: options.secrets } : {}),
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    };
    return validateAgentHost(host);
}
