import { asyncFail, asyncFlatMap, asyncMap, asyncSucceed, type Async } from "../../core/types/asyncEffect";
import type { AgentAction, AgentEnv, AgentError, AgentState, Observation } from "../core/types";
import { service } from "./env";
import { resolveWorkspacePath } from "./path";

export const actionToEffect = (action: AgentAction, state: AgentState): Async<AgentEnv, AgentError, Observation> => {
    switch (action.type) {
        case "fs.readFile":
            return asyncFlatMap(resolveWorkspacePath(state.goal.cwd, action.path) as any, (path: string) =>
                asyncFlatMap(service("fs") as any, (fs: AgentEnv["fs"]) =>
                    asyncMap(
                        fs.readFile(path) as any,
                        (content: string): Observation => ({ type: "fs.fileRead", path: action.path, content })
                    ) as any
                ) as any
            ) as any;

        case "fs.exists":
            return asyncFlatMap(resolveWorkspacePath(state.goal.cwd, action.path) as any, (path: string) =>
                asyncFlatMap(service("fs") as any, (fs: AgentEnv["fs"]) =>
                    asyncMap(
                        fs.exists(path) as any,
                        (exists: boolean): Observation => ({ type: "fs.exists", path: action.path, exists })
                    ) as any
                ) as any
            ) as any;

        case "fs.searchText":
            return asyncFlatMap(service("fs") as any, (fs: AgentEnv["fs"]) =>
                asyncMap(
                    fs.searchText(state.goal.cwd, action.query, { globs: action.globs }) as any,
                    (matches: import("../core/types").SearchMatch[]): Observation => ({ type: "fs.searchResult", query: action.query, matches })
                ) as any
            ) as any;

        case "shell.exec":
            return asyncFlatMap(service("shell") as any, (shell: AgentEnv["shell"]) =>
                asyncMap(
                    shell.exec(action.command, { cwd: action.cwd ?? state.goal.cwd }) as any,
                    (result: import("../core/types").ExecResult): Observation => ({
                        type: "shell.result",
                        command: action.command,
                        exitCode: result.exitCode,
                        stdout: result.stdout,
                        stderr: result.stderr,
                    })
                ) as any
            ) as any;

        case "llm.complete":
            return asyncFlatMap(service("llm") as any, (llm: AgentEnv["llm"]) =>
                asyncMap(
                    llm.complete({ purpose: action.purpose, prompt: action.prompt }) as any,
                    (response: import("../core/types").LLMResponse): Observation => ({ type: "llm.response", purpose: action.purpose, content: response.content })
                ) as any
            ) as any;

        case "patch.propose":
            return asyncSucceed({ type: "patch.proposed", patch: action.patch } satisfies Observation) as any;

        case "patch.apply":
            return asyncFlatMap(service("patch") as any, (patch: AgentEnv["patch"]) =>
                asyncMap(
                    patch.apply(state.goal.cwd, action.patch) as any,
                    (result: import("../core/types").PatchApplyResult): Observation => ({
                        type: "patch.applied",
                        changedFiles: result.changedFiles,
                        patch: action.patch,
                    })
                ) as any
            ) as any;

        case "patch.rollback":
            return asyncFlatMap(service("patch") as any, (patch: AgentEnv["patch"]) =>
                asyncMap(
                    patch.rollback(state.goal.cwd, action.patch) as any,
                    (result: import("../core/types").PatchApplyResult): Observation => ({
                        type: "patch.rolledBack",
                        changedFiles: result.changedFiles,
                        patch: action.patch,
                        ...(action.automatic !== undefined ? { automatic: action.automatic } : {}),
                        ...(action.reason ? { reason: action.reason } : {}),
                    })
                ) as any
            ) as any;

        case "agent.finish":
            return asyncSucceed({ type: "agent.done", summary: action.summary } satisfies Observation) as any;

        case "agent.fail":
            return asyncFail({ _tag: "AgentLoopError", message: action.reason } satisfies AgentError) as any;
    }
};
