import { async } from "../../core/types/asyncEffect";
import { Cause, Exit } from "../../core/types/effect";
import { summarizeAgentAction } from "../core/events";
import type { AgentError, ApprovalRequest, ApprovalResponse, ApprovalService } from "../core/types";

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

const isYes = (value: string): boolean => ["y", "yes", "approve", "approved", "si", "sí", "s"].includes(value);
const isNo = (value: string): boolean => ["n", "no", "reject", "rejected", "deny", "denied"].includes(value);

const answerToResponse = (answer: string, request: ApprovalRequest): ApprovalResponse => {
    const normalized = answer.trim().toLowerCase();

    if (!normalized) {
        return request.defaultAnswer === "approve"
            ? { type: "approved" }
            : { type: "rejected", reason: "Rejected by default answer." };
    }

    if (isYes(normalized)) return { type: "approved" };
    if (isNo(normalized)) return { type: "rejected", reason: "Rejected by user." };

    return { type: "rejected", reason: `Unrecognized approval answer: ${answer}` };
};

export const makeCliApprovalService = (options: {
    readonly input?: any;
    readonly output?: any;
} = {}): ApprovalService => ({
    request: (request) =>
        async((_env, cb) => {
            let closed = false;
            let rl: any | undefined;

            dynamicImport("node:readline/promises")
                .then(({ createInterface }) => {
                    if (closed) return undefined;

                    const input = options.input ?? (process as any).stdin;
                    const output = options.output ?? (process as any).stderr ?? (process as any).stdout;
                    const defaultHint = request.defaultAnswer === "approve" ? "Y/n" : "y/N";

                    rl = createInterface({ input, output });
                    output?.write?.(`\nApproval required (${request.risk})\n`);
                    output?.write?.(`Action: ${summarizeAgentAction(request.action)}\n`);
                    output?.write?.(`Reason: ${request.reason}\n`);

                    return rl.question(`Approve? [${defaultHint}] `);
                })
                .then((answer: string | undefined) => {
                    if (answer === undefined || closed) return;
                    closed = true;
                    rl?.close?.();
                    cb(Exit.succeed(answerToResponse(answer, request)));
                })
                .catch((cause: unknown) => {
                    if (closed) return;
                    closed = true;
                    rl?.close?.();
                    cb(
                        Exit.failCause(
                            Cause.fail({
                                _tag: "AgentLoopError",
                                message: `Approval prompt failed: ${String(cause)}`,
                            } satisfies AgentError)
                        )
                    );
                });

            return () => {
                if (closed) return;
                closed = true;
                rl?.close?.();
            };
        }),
});
