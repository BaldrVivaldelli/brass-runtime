import type { Async } from "../../core/types/asyncEffect";

export type AgentMode = "read-only" | "propose" | "write" | "autonomous";

export type AgentPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type AgentPackageManagerConfig = AgentPackageManager | "auto";

export type AgentResponseLanguage = "auto" | "match-user" | "en" | "es" | "pt" | "fr" | "de" | "it" | "custom";

export type AgentLanguageConfig = {
    /** Natural language used for LLM-facing responses. Default: auto, which matches the user goal when possible. */
    readonly response?: AgentResponseLanguage;
    /** Human-readable language name used when response is custom, e.g. "Argentinian Spanish". */
    readonly custom?: string;
};

export type AgentContextConfig = {
    /** Enable or disable context discovery before the first LLM planning call. Default: true. */
    readonly enabled?: boolean;
    /** Maximum searchText actions to run before planning. Default: 3. */
    readonly maxSearchQueries?: number;
    /** Maximum distinct files to read from direct error paths and search results. Default: 4. */
    readonly maxFiles?: number;
    /** Maximum matches to consider from search results when selecting files. Default: 40. */
    readonly maxSearchResults?: number;
    /** Ripgrep globs used for context searches. */
    readonly globs?: readonly string[];
    /** Glob-like paths excluded from context reads/searches, e.g. secrets/** or *.pem. */
    readonly excludeGlobs?: readonly string[];
};

export type AgentRedactionConfig = {
    /** Redact likely secrets before prompts/protocol summaries. Default: true. */
    readonly enabled?: boolean;
    /** Extra regular-expression source strings to redact. Invalid patterns are ignored. */
    readonly additionalPatterns?: readonly string[];
};

export type AgentPatchQualityConfig = {
    /** Enable repair attempts after generated patches fail to apply or fail validation. Default: true. */
    readonly enabled?: boolean;
    /** Number of llm.patch repair calls after the initial generated patch. Default: 1. */
    readonly maxRepairAttempts?: number;
};

export type AgentRollbackConfig = {
    /** Enable automatic rollback safety for generated patches. Default: true. */
    readonly enabled?: boolean;
    /** Roll back generated patches when final validation still fails and no repair remains. Default: true. */
    readonly onFinalValidationFailure?: boolean;
    /** Roll back only the latest patch or the full generated patch stack. Default: all. */
    readonly strategy?: "last" | "all";
    /** Maximum automatic rollback actions in one run. Default: 8. */
    readonly maxRollbackDepth?: number;
    /** Re-run validation after automatic rollback completes. Default: true. */
    readonly runValidationAfterRollback?: boolean;
    /** Allow automatic rollback for exact supplied patches. Default: false. */
    readonly allowForSuppliedPatches?: boolean;
};

export type AgentProjectConfig = {
    /** Force a package manager or let the agent infer it from package.json and lockfiles. */
    readonly packageManager?: AgentPackageManagerConfig;
    /** Exact validation commands to run. When present, discovery from package.json is skipped. */
    readonly validationCommands?: readonly string[];
    /** Ordered script names to consider as the primary test command. */
    readonly testScriptNames?: readonly string[];
    /** Include a typecheck/check script even when the goal does not mention it. */
    readonly includeTypecheck?: boolean;
    /** Include a lint script even when the goal does not mention it. */
    readonly includeLint?: boolean;
    /** Bound the amount of validation work discovered automatically. Default: 2. */
    readonly maxValidationCommands?: number;
};

export type AgentGoal = {
    readonly id: string;
    readonly cwd: string;
    readonly text: string;
    readonly mode: AgentMode;
    readonly project?: AgentProjectConfig;
    readonly context?: AgentContextConfig;
    readonly patchQuality?: AgentPatchQualityConfig;
    readonly rollback?: AgentRollbackConfig;
    readonly redaction?: AgentRedactionConfig;
    readonly language?: AgentLanguageConfig;
    /** Optional precomputed unified diff. Used by trusted clients after a patch preview approval. */
    readonly initialPatch?: string;
    /** How to materialize initialPatch in write/autonomous mode. Default: apply. */
    readonly initialPatchMode?: "apply" | "rollback";
};

export type AgentPhase = "boot" | "discovering" | "planning" | "validating" | "proposing" | "done" | "failed";

export type AgentState = {
    readonly goal: AgentGoal;
    readonly phase: AgentPhase;
    readonly observations: readonly Observation[];
    readonly errors: readonly AgentError[];
    readonly steps: number;
};

export type AgentEvent =
    | { readonly type: "agent.run.started"; readonly goal: AgentGoal; readonly at: number }
    | { readonly type: "agent.action.started"; readonly action: AgentAction; readonly step: number; readonly phase: AgentPhase; readonly at: number }
    | {
        readonly type: "agent.action.completed";
        readonly action: AgentAction;
        readonly observation: Observation;
        readonly step: number;
        readonly phase: AgentPhase;
        readonly durationMs: number;
        readonly at: number;
    }
    | {
        readonly type: "agent.action.failed";
        readonly action: AgentAction;
        readonly error: AgentError;
        readonly step: number;
        readonly phase: AgentPhase;
        readonly durationMs: number;
        readonly at: number;
    }
    | {
        readonly type: "agent.observation.recorded";
        readonly observation: Observation;
        readonly step: number;
        readonly phase: AgentPhase;
        readonly at: number;
    }
    | { readonly type: "agent.tool.timeout"; readonly action: AgentAction; readonly step: number; readonly phase: AgentPhase; readonly timeoutMs: number; readonly at: number }
    | { readonly type: "agent.permission.denied"; readonly action: AgentAction; readonly step: number; readonly phase: AgentPhase; readonly reason: string; readonly at: number }
    | {
        readonly type: "agent.approval.requested";
        readonly action: AgentAction;
        readonly step: number;
        readonly phase: AgentPhase;
        readonly reason: string;
        readonly risk: ApprovalRisk;
        readonly defaultAnswer: ApprovalDefaultAnswer;
        readonly at: number;
    }
    | {
        readonly type: "agent.approval.resolved";
        readonly action: AgentAction;
        readonly step: number;
        readonly phase: AgentPhase;
        readonly approved: boolean;
        readonly reason?: string;
        readonly at: number;
    }
    | { readonly type: "agent.patch.applied"; readonly step: number; readonly phase: AgentPhase; readonly changedFiles: readonly string[]; readonly automaticRollbackEligible?: boolean; readonly at: number }
    | { readonly type: "agent.patch.rolledBack"; readonly step: number; readonly phase: AgentPhase; readonly changedFiles: readonly string[]; readonly automatic?: boolean; readonly reason?: string; readonly at: number }
    | {
        readonly type: "agent.run.completed";
        readonly goal: AgentGoal;
        readonly status: "done" | "failed";
        readonly phase: AgentPhase;
        readonly steps: number;
        readonly durationMs: number;
        readonly at: number;
    };

export type AgentEventSink = {
    readonly emit: (event: AgentEvent) => void;
};

export type LLMPurpose = "plan" | "patch" | "explain";

export type AgentAction =
    | { readonly type: "fs.readFile"; readonly path: string }
    | { readonly type: "fs.exists"; readonly path: string }
    | { readonly type: "fs.searchText"; readonly query: string; readonly globs?: readonly string[] }
    | { readonly type: "shell.exec"; readonly command: readonly string[]; readonly cwd?: string }
    | { readonly type: "llm.complete"; readonly purpose: LLMPurpose; readonly prompt: string }
    | { readonly type: "patch.propose"; readonly patch: string }
    | { readonly type: "patch.apply"; readonly patch: string }
    | { readonly type: "patch.rollback"; readonly patch: string; readonly automatic?: boolean; readonly reason?: string }
    | { readonly type: "agent.finish"; readonly summary: string }
    | { readonly type: "agent.fail"; readonly reason: string };

export type AgentActionType = AgentAction["type"];

export type AgentToolPolicyOverride = {
    readonly timeoutMs?: number;
    readonly retries?: number;
};

export type AgentToolPolicyConfig = Partial<Record<AgentActionType, AgentToolPolicyOverride>>;

export type Observation =
    | { readonly type: "fs.fileRead"; readonly path: string; readonly content: string }
    | { readonly type: "fs.exists"; readonly path: string; readonly exists: boolean }
    | { readonly type: "fs.searchResult"; readonly query: string; readonly matches: readonly SearchMatch[] }
    | { readonly type: "shell.result"; readonly command: readonly string[]; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
    | { readonly type: "llm.response"; readonly purpose: LLMPurpose; readonly content: string }
    | { readonly type: "patch.proposed"; readonly patch: string }
    | { readonly type: "patch.applied"; readonly changedFiles: readonly string[]; readonly patch?: string }
    | { readonly type: "patch.rolledBack"; readonly changedFiles: readonly string[]; readonly patch?: string; readonly automatic?: boolean; readonly reason?: string }
    | { readonly type: "agent.done"; readonly summary: string }
    | { readonly type: "agent.error"; readonly error: AgentError };

export type SearchMatch = {
    readonly path: string;
    readonly line: number;
    readonly text: string;
};

export type ExecResult = {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
};

export type LLMRequest = {
    readonly purpose: LLMPurpose;
    readonly prompt: string;
};

export type LLMResponse = {
    readonly content: string;
};

export type AgentError =
    | { readonly _tag: "FsError"; readonly operation: string; readonly cause: unknown }
    | { readonly _tag: "ShellError"; readonly operation: string; readonly command?: readonly string[]; readonly cause: unknown }
    | { readonly _tag: "LLMError"; readonly cause: unknown }
    | { readonly _tag: "PatchError"; readonly operation: string; readonly cause: unknown; readonly patch?: string }
    | { readonly _tag: "PermissionDenied"; readonly action: AgentAction; readonly reason: string }
    | { readonly _tag: "ApprovalRejected"; readonly action: AgentAction; readonly reason: string }
    | { readonly _tag: "ToolTimeout"; readonly timeoutMs: number }
    | { readonly _tag: "AgentLoopError"; readonly message: string }
    | { readonly _tag: "PathOutsideWorkspace"; readonly path: string; readonly cwd: string };

export type FileSystem = {
    readonly readFile: (path: string) => Async<unknown, AgentError, string>;
    readonly exists: (path: string) => Async<unknown, AgentError, boolean>;
    readonly searchText: (
        cwd: string,
        query: string,
        options?: { readonly globs?: readonly string[] }
    ) => Async<unknown, AgentError, readonly SearchMatch[]>;
};

export type Shell = {
    readonly exec: (
        command: readonly string[],
        options: { readonly cwd: string; readonly stdin?: string }
    ) => Async<unknown, AgentError, ExecResult>;
};

export type LLM = {
    readonly complete: (request: LLMRequest) => Async<unknown, AgentError, LLMResponse>;
};

export type PatchApplyResult = {
    readonly changedFiles: readonly string[];
};

export type PatchService = {
    readonly apply: (cwd: string, patch: string) => Async<unknown, AgentError, PatchApplyResult>;
    /** Reverse-apply a unified diff, usually for manual rollback of an approved patch. */
    readonly rollback: (cwd: string, patch: string) => Async<unknown, AgentError, PatchApplyResult>;
};

export type ApprovalRisk = "low" | "medium" | "high";

export type ApprovalDefaultAnswer = "approve" | "reject";

export type ApprovalRequest = {
    readonly action: AgentAction;
    readonly state: AgentState;
    readonly reason: string;
    readonly risk: ApprovalRisk;
    readonly defaultAnswer: ApprovalDefaultAnswer;
};

export type ApprovalResponse =
    | { readonly type: "approved" }
    | { readonly type: "rejected"; readonly reason?: string };

export type ApprovalService = {
    readonly request: (request: ApprovalRequest) => Async<AgentEnv, AgentError, ApprovalResponse>;
};

export type PermissionDecision =
    | { readonly type: "allow" }
    | { readonly type: "deny"; readonly reason: string }
    | {
        readonly type: "ask";
        readonly reason: string;
        readonly risk: ApprovalRisk;
        readonly defaultAnswer?: ApprovalDefaultAnswer;
    };

export type PermissionService = {
    readonly check: (action: AgentAction, state: AgentState) => Async<AgentEnv, AgentError, PermissionDecision>;
};

export type AgentEnv = {
    readonly fs: FileSystem;
    readonly shell: Shell;
    readonly llm: LLM;
    readonly patch: PatchService;
    readonly permissions: PermissionService;
    readonly approvals?: ApprovalService;
    readonly events?: AgentEventSink;
    readonly toolPolicies?: AgentToolPolicyConfig;
};
