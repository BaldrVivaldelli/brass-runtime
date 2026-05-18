// Host profile types and deep freeze utility.
// Describes the inferred execution environment's identity, transport,
// capabilities, constraints, and the evidence used to derive them.

export type HostSignalSource =
    | "argv"
    | "env-key"
    | "stdio"
    | "parent-process"
    | "workspace-marker"
    | "protocol-handshake"
    | "config";

export type HostSignal = {
    readonly source: HostSignalSource;
    readonly value: string;
};

export type HostTransport = "stdio" | "terminal" | "mcp" | "extension" | "ci" | "unknown";

export type HostCapabilities = {
    readonly hasOwnLLM: boolean;
    readonly wantsJson: boolean;
    readonly supportsStreamingEvents: boolean;
    readonly supportsMcp: boolean;
    readonly canAskApproval: boolean;
    readonly canRenderDiff: boolean;
    readonly canApplyPatch: boolean;
    readonly interactiveTty: boolean;
};

export type HostConstraints = {
    readonly readOnlyByDefault: boolean;
    readonly patchPreviewRequired: boolean;
    readonly requireNoNetwork: boolean;
};

export type HostIdentity = {
    readonly name: string;
    readonly confidence: number; // 0.0–1.0, rounded to 2 decimal places
};

export type HostProfile = {
    readonly transport: HostTransport;
    readonly capabilities: HostCapabilities;
    readonly constraints: HostConstraints;
    readonly identity: HostIdentity | undefined;
    readonly evidence: readonly HostSignal[];
};

/**
 * Recursively freezes an object and all nested objects/arrays so that
 * Object.isFrozen returns true at every nesting level. Attempted mutations
 * throw TypeError in strict mode.
 */
export const deepFreeze = <T extends object>(obj: T): Readonly<T> => {
    Object.freeze(obj);
    for (const name of Object.getOwnPropertyNames(obj)) {
        const value = (obj as Record<string, unknown>)[name];
        if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
            deepFreeze(value as object);
        }
    }
    return obj;
};
