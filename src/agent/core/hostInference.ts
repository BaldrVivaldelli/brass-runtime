// Host inference pipeline.
// Pure functions that transform collected signals into transport, capabilities,
// constraints, and optional identity. Each stage returns its default value
// when no patterns match (never throws).

import type {
    HostCapabilities,
    HostConstraints,
    HostIdentity,
    HostProfile,
    HostSignal,
    HostTransport,
} from "./hostProfile";
import { deepFreeze } from "./hostProfile";
import type { HostSignalInput } from "./hostSignals";
import { collectHostSignals } from "./hostSignals";

/**
 * Known CI environment variable indicators.
 * Presence of any of these keys in the environment signals a CI transport.
 */
export const CI_INDICATORS = [
    "CI",
    "GITHUB_ACTIONS",
    "JENKINS_URL",
    "CIRCLECI",
    "TRAVIS",
    "GITLAB_CI",
    "BUILDKITE",
    "TF_BUILD",
] as const;

// --- Transport Inference ---

/**
 * Infers the communication transport from collected signals.
 * Priority order: mcp > extension > ci > terminal > stdio > unknown.
 * Returns "unknown" when no signals match any known pattern.
 */
export const inferTransport = (signals: readonly HostSignal[]): HostTransport => {
    // Priority 1: MCP — protocol handshake signal containing "mcp"
    const hasProtocolMcp = signals.some(
        (s) => s.source === "protocol-handshake" && s.value.toLowerCase().includes("mcp"),
    );
    if (hasProtocolMcp) return "mcp";

    // Priority 2: Extension — workspace markers for known extensions
    const extensionMarkers = [".vscode", ".cursor", ".kiro"];
    const hasExtensionMarker = signals.some(
        (s) =>
            s.source === "workspace-marker" &&
            extensionMarkers.some((m) => s.value.toLowerCase().includes(m)),
    );
    const hasExtensionConfig = signals.some(
        (s) => s.source === "config" && extensionMarkers.some((m) => s.value.toLowerCase().includes(m)),
    );
    if (hasExtensionMarker || hasExtensionConfig) return "extension";

    // Priority 3: CI — any CI indicator environment variable present
    const hasCiEnv = signals.some(
        (s) =>
            s.source === "env-key" &&
            CI_INDICATORS.some((ci) => s.value === ci),
    );
    if (hasCiEnv) return "ci";

    // Priority 4: Terminal — stdout is TTY
    const stdoutIsTty = signals.some(
        (s) => s.source === "stdio" && s.value === "stdout:tty",
    );
    if (stdoutIsTty) return "terminal";

    // Priority 5: stdio — stdout is not TTY (pipe)
    const stdoutIsPipe = signals.some(
        (s) => s.source === "stdio" && s.value === "stdout:pipe",
    );
    if (stdoutIsPipe) return "stdio";

    // Priority 6: unknown
    return "unknown";
};

// --- Capability Inference ---

/**
 * Infers host capabilities from collected signals and resolved transport.
 * All fields default to false when no signal triggers them.
 */
export const inferCapabilities = (
    signals: readonly HostSignal[],
    transport: HostTransport,
): HostCapabilities => {
    // hasOwnLLM: env var key matching LLM availability patterns or protocol metadata
    const hasOwnLLM = signals.some(
        (s) =>
            (s.source === "env-key" &&
                (s.value.toUpperCase().includes("LLM") ||
                    s.value.toUpperCase().includes("AI_API"))) ||
            (s.source === "protocol-handshake" &&
                s.value.toLowerCase().includes("llm")),
    );

    // wantsJson: transport is stdio (non-TTY) or MCP
    const wantsJson = transport === "stdio" || transport === "mcp";

    // supportsStreamingEvents: transport supports incremental delivery
    // (terminal TTY, MCP, extension)
    const supportsStreamingEvents =
        transport === "terminal" || transport === "mcp" || transport === "extension";

    // supportsMcp: transport is "mcp"
    const supportsMcp = transport === "mcp";

    // canAskApproval: stdin is TTY, or extension/MCP transport
    const stdinIsTty = signals.some(
        (s) => s.source === "stdio" && s.value === "stdin:tty",
    );
    const canAskApproval =
        stdinIsTty || transport === "extension" || transport === "mcp";

    // canRenderDiff: TTY with ≥80 columns, or extension transport
    const ttyColumnsSignal = signals.find(
        (s) => s.source === "stdio" && s.value.startsWith("columns:"),
    );
    const ttyColumns = ttyColumnsSignal
        ? parseInt(ttyColumnsSignal.value.slice("columns:".length), 10)
        : undefined;
    const stdoutIsTty = signals.some(
        (s) => s.source === "stdio" && s.value === "stdout:tty",
    );
    const canRenderDiff =
        (stdoutIsTty && ttyColumns !== undefined && ttyColumns >= 80) ||
        transport === "extension";

    // canApplyPatch: extension or MCP transport (they have patch-apply support)
    const canApplyPatch = transport === "extension" || transport === "mcp";

    // interactiveTty: stdout is TTY
    const interactiveTty = stdoutIsTty;

    return {
        hasOwnLLM,
        wantsJson,
        supportsStreamingEvents,
        supportsMcp,
        canAskApproval,
        canRenderDiff,
        canApplyPatch,
        interactiveTty,
    };
};

// --- Constraint Inference ---

/**
 * Infers behavioral constraints from capabilities and transport.
 * All fields default to false when their inference rules do not match.
 */
export const inferConstraints = (
    capabilities: HostCapabilities,
    transport: HostTransport,
): HostConstraints => {
    // readOnlyByDefault: transport is "ci"
    const readOnlyByDefault = transport === "ci";

    // patchPreviewRequired: canRenderDiff is true AND canApplyPatch is false
    const patchPreviewRequired =
        capabilities.canRenderDiff === true && capabilities.canApplyPatch === false;

    // requireNoNetwork: false (default, no signal currently triggers this)
    const requireNoNetwork = false;

    return {
        readOnlyByDefault,
        patchPreviewRequired,
        requireNoNetwork,
    };
};

// --- Identity Inference ---

/**
 * Known host identity patterns with their matching rules and confidence levels.
 */
type IdentityPattern = {
    readonly name: string;
    readonly match: (signals: readonly HostSignal[]) => number; // returns confidence or 0
};

const IDENTITY_PATTERNS: readonly IdentityPattern[] = [
    {
        name: "cursor",
        match: (signals) => {
            // Workspace marker ".cursor" → 0.8
            if (signals.some((s) => s.source === "workspace-marker" && s.value.toLowerCase().includes(".cursor"))) {
                return 0.8;
            }
            return 0;
        },
    },
    {
        name: "vscode",
        match: (signals) => {
            // Workspace marker ".vscode" → 0.8
            if (signals.some((s) => s.source === "workspace-marker" && s.value.toLowerCase().includes(".vscode"))) {
                return 0.8;
            }
            return 0;
        },
    },
    {
        name: "kiro",
        match: (signals) => {
            // Workspace marker ".kiro" → 0.8
            if (signals.some((s) => s.source === "workspace-marker" && s.value.toLowerCase().includes(".kiro"))) {
                return 0.8;
            }
            // Env key "KIRO_*" → 0.7
            if (signals.some((s) => s.source === "env-key" && s.value.startsWith("KIRO_"))) {
                return 0.7;
            }
            return 0;
        },
    },
    {
        name: "codex",
        match: (signals) => {
            // Parent process containing "codex" → 0.9
            if (signals.some((s) => s.source === "parent-process" && s.value.toLowerCase().includes("codex"))) {
                return 0.9;
            }
            // Env key "CODEX_*" → 0.7
            if (signals.some((s) => s.source === "env-key" && s.value.startsWith("CODEX_"))) {
                return 0.7;
            }
            return 0;
        },
    },
    {
        name: "claude-code",
        match: (signals) => {
            // Parent process containing "claude" → 0.9
            if (signals.some((s) => s.source === "parent-process" && s.value.toLowerCase().includes("claude"))) {
                return 0.9;
            }
            return 0;
        },
    },
];

/**
 * Infers optional host identity from collected signals.
 * Returns undefined when no pattern matches.
 * When multiple patterns match, selects the one with highest confidence.
 * Confidence is rounded to 2 decimal places.
 */
export const inferOptionalIdentity = (signals: readonly HostSignal[]): HostIdentity | undefined => {
    let bestName: string | undefined;
    let bestConfidence = 0;

    for (const pattern of IDENTITY_PATTERNS) {
        const confidence = pattern.match(signals);
        if (confidence > bestConfidence) {
            bestConfidence = confidence;
            bestName = pattern.name;
        }
    }

    if (bestName === undefined || bestConfidence <= 0) {
        return undefined;
    }

    return {
        name: bestName,
        confidence: Math.round(bestConfidence * 100) / 100,
    };
};

// --- Pipeline Composition ---

/**
 * Builds a complete HostProfile from raw signal input.
 * Composes all inference stages and applies deepFreeze to the result.
 * Pure function — no shared mutable state.
 */
export const buildHostProfile = (input: HostSignalInput): HostProfile => {
    const signals = collectHostSignals(input);
    const transport = inferTransport(signals);
    const capabilities = inferCapabilities(signals, transport);
    const constraints = inferConstraints(capabilities, transport);
    const identity = inferOptionalIdentity(signals);

    return deepFreeze({
        transport,
        capabilities,
        constraints,
        identity,
        evidence: signals,
    });
};
