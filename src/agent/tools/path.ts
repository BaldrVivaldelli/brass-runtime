import { asyncFail, asyncSucceed, type Async } from "../../core/types/asyncEffect";
import type { AgentError } from "../core/types";

export const isAbsoluteLike = (path: string): boolean =>
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

export const trimTrailingSlash = (path: string): string => path.replace(/[\\/]+$/, "");
export const trimLeadingDotSlash = (path: string): string => path.replace(/^(?:\.[\\/])+/, "");

export const normalizeWorkspaceRelativePath = (inputPath: string): string | undefined => {
    const trimmed = inputPath.trim();

    if (
        !trimmed ||
        trimmed.includes("\0") ||
        isAbsoluteLike(trimmed) ||
        trimmed.split(/[\\/]+/).includes("..")
    ) {
        return undefined;
    }

    return trimLeadingDotSlash(trimmed);
};

export const isWorkspaceRelativePath = (inputPath: string): boolean =>
    normalizeWorkspaceRelativePath(inputPath) !== undefined;

export const resolveWorkspacePath = (cwd: string, inputPath: string): Async<unknown, AgentError, string> => {
    const normalized = normalizeWorkspaceRelativePath(inputPath);

    if (!normalized) {
        return asyncFail({ _tag: "PathOutsideWorkspace", path: inputPath, cwd } satisfies AgentError) as any;
    }

    return asyncSucceed(`${trimTrailingSlash(cwd)}/${normalized}`) as any;
};
