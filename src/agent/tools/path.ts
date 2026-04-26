import { asyncFail, asyncSucceed, type Async } from "../../core/types/asyncEffect";
import type { AgentError } from "../core/types";

export const isAbsoluteLike = (path: string): boolean =>
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

export const trimTrailingSlash = (path: string): string => {
    let end = path.length;

    while (end > 0) {
        const char = path.charCodeAt(end - 1);

        if (char !== 47 && char !== 92) {
            break;
        }

        end -= 1;
    }

    return end === path.length ? path : path.slice(0, end);
};
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
