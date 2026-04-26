import type { AgentMode } from "./types";

export type AgentPreset = "fix-tests" | "inspect" | "typecheck" | "lint";

export type AgentBatchGoal =
    | string
    | {
        readonly goal?: string;
        readonly preset?: AgentPreset;
        readonly mode?: AgentMode;
        readonly cwd?: string;
        readonly patchFile?: string;
        readonly patchFileMode?: "apply" | "rollback";
        readonly saveRunDir?: string;
    };

export type AgentBatchConfig = {
    /** Goals to execute sequentially when no --batch-file is provided. */
    readonly goals?: readonly AgentBatchGoal[];
    /** Stop after the first failed run. Default: true in --ci mode, false otherwise. */
    readonly stopOnFailure?: boolean;
};

export const isAgentPreset = (value: string): value is AgentPreset =>
    value === "fix-tests" || value === "inspect" || value === "typecheck" || value === "lint";

export const goalForAgentPreset = (preset: AgentPreset): string => {
    switch (preset) {
        case "fix-tests":
            return "fix the failing tests";
        case "inspect":
            return "inspect this workspace and summarize the current project state";
        case "typecheck":
            return "run typecheck discovery and fix type errors if possible";
        case "lint":
            return "run lint discovery and fix lint errors if possible";
    }
};
