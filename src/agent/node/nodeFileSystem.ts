import { asyncFail, asyncFlatMap, asyncSucceed } from "../../core/types/asyncEffect";
import { fromPromiseAbortable } from "../../core/runtime/runtime";
import type { AgentError, FileSystem, SearchMatch, Shell } from "../core/types";

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

const parseRipgrep = (stdout: string): readonly SearchMatch[] =>
    stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [path = "", lineNo = "0", ...rest] = line.split(":");
            return { path, line: Number(lineNo), text: rest.join(":") };
        });

export const makeNodeFileSystem = (shell: Shell): FileSystem => ({
    readFile: (path) =>
        fromPromiseAbortable<AgentError, string>(
            async (signal) => {
                const { readFile } = await dynamicImport("node:fs/promises");
                return readFile(path, { encoding: "utf8", signal });
            },
            (cause): AgentError => ({ _tag: "FsError", operation: "readFile", cause })
        ),

    exists: (path) =>
        fromPromiseAbortable<AgentError, boolean>(
            async (signal) => {
                if (signal.aborted) return false;
                const { stat } = await dynamicImport("node:fs/promises");
                if (signal.aborted) return false;
                try {
                    await stat(path);
                    return true;
                } catch {
                    return false;
                }
            },
            (cause): AgentError => ({ _tag: "FsError", operation: "exists", cause })
        ),

    searchText: (cwd, query, options) =>
        asyncFlatMap(
            shell.exec(
                [
                    "rg",
                    "--fixed-strings",
                    "--line-number",
                    "--no-heading",
                    "--color",
                    "never",
                    "--max-count",
                    "5",
                    ...(options?.globs?.flatMap((glob) => ["--glob", glob]) ?? []),
                    "--",
                    query,
                    ".",
                ],
                { cwd }
            ) as any,
            (result: import("../core/types").ExecResult) => {
                // rg exit codes: 0 = matches, 1 = no matches, >1 = error.
                if (result.exitCode > 1) {
                    return asyncFail({
                        _tag: "FsError",
                        operation: "searchText",
                        cause: result.stderr,
                    } satisfies AgentError) as any;
                }

                return asyncSucceed(parseRipgrep(result.stdout)) as any;
            }
        ) as any,
});
