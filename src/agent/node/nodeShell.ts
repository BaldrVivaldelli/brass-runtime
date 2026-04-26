import { async } from "../../core/types/asyncEffect";
import { Cause, Exit } from "../../core/types/effect";
import type { AgentError, ExecResult, Shell } from "../core/types";

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

const chunkToString = (chunk: unknown): string => {
    const maybeToString = (chunk as any)?.toString;
    return typeof maybeToString === "function" ? maybeToString.call(chunk, "utf8") : String(chunk);
};

export const NodeShell: Shell = {
    exec: (command, options) =>
        async((_env, cb) => {
            const [bin, ...args] = command;

            if (!bin) {
                cb(
                    Exit.failCause(
                        Cause.fail({
                            _tag: "ShellError",
                            operation: "exec",
                            command,
                            cause: new Error("Empty command"),
                        } satisfies AgentError)
                    )
                );
                return;
            }

            let stdout = "";
            let stderr = "";
            let done = false;
            let child: any | undefined;

            dynamicImport("node:child_process")
                .then(({ spawn }) => {
                    if (done) return;

                    child = spawn(bin, args, {
                        cwd: options.cwd,
                        shell: false,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    child.stdout?.on("data", (chunk: unknown) => {
                        stdout += chunkToString(chunk);
                    });

                    child.stderr?.on("data", (chunk: unknown) => {
                        stderr += chunkToString(chunk);
                    });

                    child.on("error", (cause: unknown) => {
                        if (done) return;
                        done = true;

                        cb(
                            Exit.failCause(
                                Cause.fail({
                                    _tag: "ShellError",
                                    operation: "exec",
                                    command,
                                    cause,
                                } satisfies AgentError)
                            )
                        );
                    });

                    child.on("close", (code: number | null) => {
                        if (done) return;
                        done = true;

                        cb(
                            Exit.succeed({
                                exitCode: code ?? 1,
                                stdout,
                                stderr,
                            } satisfies ExecResult)
                        );
                    });

                    if (options.stdin !== undefined) {
                        child.stdin?.end(options.stdin);
                    } else {
                        child.stdin?.end();
                    }
                })
                .catch((cause) => {
                    if (done) return;
                    done = true;

                    cb(
                        Exit.failCause(
                            Cause.fail({
                                _tag: "ShellError",
                                operation: "exec",
                                command,
                                cause,
                            } satisfies AgentError)
                        )
                    );
                });

            return () => {
                if (done) return;
                done = true;
                child?.kill?.("SIGTERM");
            };
        }),
};
