import { asyncInterruptible, type Async } from "../../core/types/asyncEffect";
import { Cause, Exit } from "../../core/types/effect";
import type {
    AgentDiagnostics,
    AgentError,
    AgentEventSink,
    AgentHost,
    AgentPersistence,
    AgentSecretStore,
    AgentTelemetry,
    AgentToolPolicyConfig,
    ApprovalService,
    ExecResult,
    LLM,
    PatchApplyResult,
    PermissionService,
    SearchMatch,
} from "../core/types";
import type { HostProfile } from "../core/hostProfile";
import { makeAgentLifecycle, validateAgentHost, withWorkspaceTrust } from "../core/agentHost";
import {
    decodeAgentPersistenceEnvelope,
    encodeAgentPersistenceEnvelope,
    redactAgentPersistenceValue,
} from "../core/persistence";

export type VsCodeAgentHostApi = {
    readonly workspace: {
        readonly id: string;
        readonly root: string;
        readonly trusted: boolean;
    };
    readonly readFile: (absolutePath: string, signal: AbortSignal) => Promise<string>;
    readonly exists: (absolutePath: string, signal: AbortSignal) => Promise<boolean>;
    readonly searchText: (
        workspaceRoot: string,
        query: string,
        globs: readonly string[] | undefined,
        signal: AbortSignal,
    ) => Promise<readonly SearchMatch[]>;
    readonly exec?: (
        command: readonly string[],
        options: { readonly cwd: string; readonly stdin?: string },
        signal: AbortSignal,
    ) => Promise<ExecResult>;
    /** Must preview/revalidate the exact patch and apply through WorkspaceEdit. */
    readonly applyPatch: (cwd: string, patch: string, signal: AbortSignal) => Promise<PatchApplyResult>;
    readonly rollbackPatch: (cwd: string, patch: string, signal: AbortSignal) => Promise<PatchApplyResult>;
    readonly state: {
        readonly read: (key: string) => Promise<string | undefined>;
        readonly write: (key: string, value: string) => Promise<void>;
        readonly remove: (key: string) => Promise<void>;
    };
    readonly secrets: AgentSecretStore;
    readonly onDidDispose?: (listener: () => void) => () => void;
};

export type MakeVsCodeAgentHostOptions = {
    readonly api: VsCodeAgentHostApi;
    readonly llm?: LLM;
    readonly permissions: PermissionService;
    readonly approvals: ApprovalService;
    readonly events?: AgentEventSink;
    readonly toolPolicies?: AgentToolPolicyConfig;
    readonly hostProfile?: HostProfile;
    readonly diagnostics?: AgentDiagnostics;
    readonly telemetry?: AgentTelemetry;
    readonly persistenceCodec?: {
        readonly encode: (plaintext: string) => Promise<string>;
        readonly decode: (stored: string) => Promise<string>;
    };
    readonly persistenceNow?: () => number;
    readonly sessionRetentionMs?: number;
    readonly redactPersistence?: false | ((key: string, value: string) => string);
};

const fromHostPromise = <A>(
    operation: string,
    lifecycleSignal: AbortSignal,
    run: (signal: AbortSignal) => Promise<A>,
    error: (cause: unknown) => AgentError,
): Async<unknown, AgentError, A> => asyncInterruptible((_env, callback) => {
    const controller = new AbortController();
    let done = false;
    const onLifecycleAbort = () => controller.abort(lifecycleSignal.reason);
    lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });
    if (lifecycleSignal.aborted) onLifecycleAbort();

    run(controller.signal).then(
        (value) => {
            if (done) return;
            done = true;
            lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
            callback(Exit.succeed(value));
        },
        (cause) => {
            if (done) return;
            done = true;
            lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
            callback(Exit.failCause(Cause.fail(error(cause))));
        },
    );

    return () => {
        if (done) return;
        done = true;
        lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
        controller.abort(new Error(`Cancelled VS Code host operation ${operation}`));
    };
});

const persistenceFor = (
    api: VsCodeAgentHostApi,
    options: Pick<MakeVsCodeAgentHostOptions, "persistenceCodec" | "persistenceNow" | "sessionRetentionMs" | "redactPersistence">,
): AgentPersistence => {
    const codec = options.persistenceCodec ?? {
        encode: async (value: string) => value,
        decode: async (value: string) => value,
    };
    const now = options.persistenceNow ?? Date.now;
    const sessionRetentionMs = options.sessionRetentionMs ?? 86_400_000;
    const redact = options.redactPersistence === false
        ? (_key: string, value: string) => value
        : options.redactPersistence ?? ((_key: string, value: string) => redactAgentPersistenceValue(value));
    return {
    version: 1,
    read: async (scope, key) => {
        const raw = await api.state.read(`${scope}:${key}`);
        if (raw === undefined) return undefined;
        const decoded = decodeAgentPersistenceEnvelope(await codec.decode(raw), now());
        if (decoded.kind === "expired") {
            await api.state.remove(`${scope}:${key}`);
            return undefined;
        }
        return decoded.value;
    },
    write: async (scope, key, value, options) => {
        const redacted = redact(key, value);
        const bytes = new TextEncoder().encode(redacted).byteLength;
        const maximum = options?.maxBytes ?? 1_048_576;
        if (bytes > maximum) throw new Error(`VS Code agent state ${key} exceeds ${maximum} bytes`);
        const currentTime = now();
        const expiresAt = options?.expiresAt ?? (
            scope === "session" && sessionRetentionMs > 0 ? currentTime + sessionRetentionMs : undefined
        );
        if (expiresAt !== undefined && expiresAt <= currentTime) {
            throw new Error(`VS Code agent state ${key} is already expired`);
        }
        const encoded = await codec.encode(encodeAgentPersistenceEnvelope(redacted, currentTime, expiresAt));
        if (new TextEncoder().encode(encoded).byteLength > maximum + 4_096) {
            throw new Error(`Encoded VS Code agent state ${key} exceeds storage quota`);
        }
        await api.state.write(`${scope}:${key}`, encoded);
    },
    remove: (scope, key) => api.state.remove(`${scope}:${key}`),
    };
};

export function makeVsCodeAgentHost(options: MakeVsCodeAgentHostOptions): AgentHost {
    const { api } = options;
    const lifecycle = makeAgentLifecycle();
    api.onDidDispose?.(() => lifecycle.shutdown());
    const fsError = (operation: string) => (cause: unknown): AgentError => ({ _tag: "FsError", operation, cause });
    const shellUnavailable = (): AgentError => ({
        _tag: "ShellError",
        operation: "exec",
        cause: "VS Code host did not provide a cancellable shell adapter",
    });

    const host: AgentHost = {
        contractVersion: 1,
        kind: "vscode",
        workspace: api.workspace,
        lifecycle,
        fs: {
            readFile: (path) => fromHostPromise("fs.readFile", lifecycle.signal, (signal) => api.readFile(path, signal), fsError("readFile")),
            exists: (path) => fromHostPromise("fs.exists", lifecycle.signal, (signal) => api.exists(path, signal), fsError("exists")),
            searchText: (cwd, query, searchOptions) => fromHostPromise(
                "fs.searchText",
                lifecycle.signal,
                (signal) => api.searchText(cwd, query, searchOptions?.globs, signal),
                fsError("searchText"),
            ),
        },
        shell: {
            exec: (command, execOptions) => api.exec
                ? fromHostPromise(
                    "shell.exec",
                    lifecycle.signal,
                    (signal) => api.exec!(command, execOptions, signal),
                    (cause) => ({ _tag: "ShellError", operation: "exec", command, cause }),
                )
                : fromHostPromise("shell.exec", lifecycle.signal, () => Promise.reject(shellUnavailable()), (cause) =>
                    typeof cause === "object" && cause !== null && "_tag" in cause ? cause as AgentError : shellUnavailable()),
        },
        patch: {
            apply: (cwd, patch) => fromHostPromise(
                "patch.apply",
                lifecycle.signal,
                (signal) => api.applyPatch(cwd, patch, signal),
                (cause) => ({ _tag: "PatchError", operation: "apply", cause, patch }),
            ),
            rollback: (cwd, patch) => fromHostPromise(
                "patch.rollback",
                lifecycle.signal,
                (signal) => api.rollbackPatch(cwd, patch, signal),
                (cause) => ({ _tag: "PatchError", operation: "rollback", cause, patch }),
            ),
        },
        llm: options.llm,
        permissions: withWorkspaceTrust(options.permissions, api.workspace),
        approvals: options.approvals,
        persistence: persistenceFor(api, options),
        secrets: api.secrets,
        terminal: { isInteractive: true },
        ...(options.events ? { events: options.events } : {}),
        ...(options.toolPolicies ? { toolPolicies: options.toolPolicies } : {}),
        ...(options.hostProfile ? { hostProfile: options.hostProfile } : {}),
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    };
    return validateAgentHost(host);
}
