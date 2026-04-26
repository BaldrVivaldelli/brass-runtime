import { asyncFail, asyncFlatMap, asyncSucceed, type Async } from "../../core/types/asyncEffect";
import type { AgentError, PatchService, Shell } from "../core/types";
import { extractPatchPaths, extractUnifiedDiff } from "../tools/patch";
import { resolveWorkspacePath } from "../tools/path";

const validatePatchTargets = (cwd: string, paths: readonly string[]): Async<unknown, AgentError, readonly string[]> =>
    paths.reduce(
        (acc, path) =>
            asyncFlatMap(acc as any, (validated: readonly string[]) =>
                asyncFlatMap(resolveWorkspacePath(cwd, path) as any, () =>
                    asyncSucceed([...validated, path] as readonly string[]) as any
                ) as any
            ) as any,
        asyncSucceed([] as readonly string[]) as any
    ) as any;

const patchFailure = (operation: string, cause: unknown, patch?: string): AgentError => ({
    _tag: "PatchError",
    operation,
    cause,
    patch,
});

export const makeNodePatchService = (shell: Shell): PatchService => {
    const runGitApply = (cwd: string, rawPatch: string, reverse: boolean) => {
        const patch = extractUnifiedDiff(rawPatch) ?? rawPatch.trim();
        const changedFiles = extractPatchPaths(patch);
        const stdin = `${patch.trim()}
`;
        const operation = reverse ? "rollback" : "apply";

        if (!patch || !changedFiles.length) {
            return asyncFail(
                patchFailure("extract", "No unified diff with workspace-scoped paths was found.", rawPatch)
            ) as any;
        }

        const applyArgs = [
            "git",
            "apply",
            ...(reverse ? ["--reverse"] : []),
            "--recount",
            "--whitespace=nowarn",
            "-",
        ];

        const checkArgs = [
            "git",
            "apply",
            ...(reverse ? ["--reverse"] : []),
            "--check",
            "--recount",
            "--whitespace=nowarn",
            "-",
        ];

        return asyncFlatMap(validatePatchTargets(cwd, changedFiles) as any, () =>
            asyncFlatMap(
                shell.exec(checkArgs, { cwd, stdin }) as any,
                (checkResult: import("../core/types").ExecResult) => {
                    if (checkResult.exitCode !== 0) {
                        return asyncFail(
                            patchFailure(
                                `${operation}.check`,
                                checkResult.stderr || checkResult.stdout || `git apply --check exited with ${checkResult.exitCode}`,
                                patch
                            )
                        ) as any;
                    }

                    return asyncFlatMap(
                        shell.exec(applyArgs, { cwd, stdin }) as any,
                        (applyResult: import("../core/types").ExecResult) => {
                            if (applyResult.exitCode !== 0) {
                                return asyncFail(
                                    patchFailure(
                                        operation,
                                        applyResult.stderr || applyResult.stdout || `git apply exited with ${applyResult.exitCode}`,
                                        patch
                                    )
                                ) as any;
                            }

                            return asyncSucceed({ changedFiles }) as any;
                        }
                    ) as any;
                }
            ) as any
        ) as any;
    };

    return {
        apply: (cwd, rawPatch) => runGitApply(cwd, rawPatch, false),
        rollback: (cwd, rawPatch) => runGitApply(cwd, rawPatch, true),
    };
};
