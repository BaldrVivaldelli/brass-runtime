import { asyncSucceed } from "../../core/types/asyncEffect";
import type { AgentAction, AgentState, ApprovalDefaultAnswer, ApprovalRisk, PermissionDecision, PermissionService } from "../core/types";
import type { AgentPermissionConfig, PatchApplyPermissionConfig, ShellAskRule, ShellPermissionConfig } from "../core/config";

const DEFAULT_SAFE_SHELL_PATTERNS = [
    "npm test",
    "npm run test*",
    "npm run typecheck",
    "npm run type-check",
    "npm run check-types",
    "npm run tsc",
    "npm run check",
    "npm run *check*",
    "npm run *doctor*",
    "npm run *health*",
    "npm run *verify*",
    "npm run *validate*",
    "npm run repo:check",
    "npm run lint*",
    "pnpm test",
    "pnpm run test*",
    "pnpm run typecheck",
    "pnpm run type-check",
    "pnpm run check-types",
    "pnpm run tsc",
    "pnpm run check",
    "pnpm run *check*",
    "pnpm run *doctor*",
    "pnpm run *health*",
    "pnpm run *verify*",
    "pnpm run *validate*",
    "pnpm run repo:check",
    "pnpm run lint*",
    "yarn test",
    "yarn run test*",
    "yarn run typecheck",
    "yarn run type-check",
    "yarn run check-types",
    "yarn run tsc",
    "yarn run check",
    "yarn run *check*",
    "yarn run *doctor*",
    "yarn run *health*",
    "yarn run *verify*",
    "yarn run *validate*",
    "yarn run repo:check",
    "yarn run lint*",
    "bun run test*",
    "bun run typecheck",
    "bun run type-check",
    "bun run check-types",
    "bun run tsc",
    "bun run check",
    "bun run *check*",
    "bun run *doctor*",
    "bun run *health*",
    "bun run *verify*",
    "bun run *validate*",
    "bun run repo:check",
    "bun run lint*",
    "cargo check",
    "cargo test",
    "cargo fmt --check",
    "cargo clippy",
    "cargo clippy *",
    "git status",
    "git diff",
    "git log",
] as const;

const normalizeCommandText = (value: string): string => value.trim().replace(/\s+/g, " ");

const shellCommandText = (command: readonly string[]): string => normalizeCommandText(command.join(" "));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matchesPattern = (command: readonly string[], pattern: string): boolean => {
    const normalizedCommand = shellCommandText(command);
    const normalizedPattern = normalizeCommandText(pattern);

    if (!normalizedPattern.includes("*")) return normalizedCommand === normalizedPattern;

    const re = new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
    return re.test(normalizedCommand);
};

const matchAny = (command: readonly string[], patterns: readonly string[] | undefined): boolean =>
    Boolean(patterns?.some((pattern) => matchesPattern(command, pattern)));

const allow = (): PermissionDecision => ({ type: "allow" });
const deny = (reason: string): PermissionDecision => ({ type: "deny", reason });
const ask = (
    reason: string,
    risk: ApprovalRisk,
    defaultAnswer: ApprovalDefaultAnswer = "reject"
): PermissionDecision => ({ type: "ask", reason, risk, defaultAnswer });

const describeCommand = (action: AgentAction): string =>
    action.type === "shell.exec" ? action.command.join(" ") : action.type;

const shellAskRulePattern = (rule: ShellAskRule): string => typeof rule === "string" ? rule : rule.pattern;

const shellAskDecision = (command: readonly string[], rules: readonly ShellAskRule[] | undefined): PermissionDecision | undefined => {
    const rule = rules?.find((candidate) => matchesPattern(command, shellAskRulePattern(candidate)));
    if (!rule) return undefined;

    if (typeof rule === "string") {
        return ask(`Run command: ${shellCommandText(command)}`, "high", "reject");
    }

    return ask(
        rule.reason ?? `Run command: ${shellCommandText(command)}`,
        rule.risk ?? "high",
        rule.defaultAnswer ?? "reject"
    );
};

const configuredShellAllowPatterns = (config: ShellPermissionConfig | undefined): readonly string[] => [
    ...(config?.inheritDefaults === false ? [] : DEFAULT_SAFE_SHELL_PATTERNS),
    ...(config?.allow ?? []),
];

const shellDecisionFromConfig = (
    command: readonly string[],
    config: ShellPermissionConfig | undefined
): PermissionDecision | undefined => {
    if (matchAny(command, config?.deny)) return deny(`Command denied by policy: ${shellCommandText(command)}`);

    const askDecision = shellAskDecision(command, config?.ask);
    if (askDecision) return askDecision;

    if (matchAny(command, configuredShellAllowPatterns(config))) return allow();

    return undefined;
};

const defaultPatchMutationReason = (action: Extract<AgentAction, { type: "patch.apply" | "patch.rollback" }>): string =>
    action.type === "patch.rollback"
        ? "Reverse-apply a patch to restore the workspace."
        : "Apply the proposed patch to the workspace.";

const patchApplyDecisionFromConfig = (
    action: Extract<AgentAction, { type: "patch.apply" | "patch.rollback" }>,
    config: PatchApplyPermissionConfig | undefined
): PermissionDecision => {
    const defaultReason = defaultPatchMutationReason(action);
    if (!config) return ask(defaultReason, "high", "reject");

    const decision = typeof config === "string" ? config : config.decision ?? "ask";
    const reason = typeof config === "string"
        ? defaultReason
        : config.reason ?? defaultReason;
    const risk = typeof config === "string" ? "high" : config.risk ?? "high";
    const defaultAnswer = typeof config === "string" ? "reject" : config.defaultAnswer ?? "reject";

    if (decision === "allow") return allow();
    if (decision === "deny") return deny(reason);
    return ask(reason, risk, defaultAnswer);
};

export const makeConfiguredPermissions = (config: AgentPermissionConfig = {}): PermissionService => ({
    check: (action: AgentAction, state: AgentState) => {
        switch (state.goal.mode) {
            case "read-only": {
                if (
                    action.type === "fs.readFile" ||
                    action.type === "fs.exists" ||
                    action.type === "fs.searchText" ||
                    action.type === "llm.complete" ||
                    action.type === "agent.finish" ||
                    action.type === "agent.fail"
                ) {
                    return asyncSucceed(allow()) as any;
                }
                return asyncSucceed(deny(`Action ${action.type} is not allowed in read-only mode`)) as any;
            }

            case "propose": {
                if (action.type === "shell.exec") {
                    const decision = shellDecisionFromConfig(action.command, config.shell);
                    return asyncSucceed(
                        decision ?? deny(`Command not whitelisted: ${action.command.join(" ")}`)
                    ) as any;
                }

                if (action.type === "patch.apply" || action.type === "patch.rollback") {
                    return asyncSucceed(deny(`${action.type} is not allowed in propose mode; use write mode or --apply.`)) as any;
                }

                return asyncSucceed(allow()) as any;
            }

            case "write": {
                if (action.type === "shell.exec") {
                    const decision = shellDecisionFromConfig(action.command, config.shell);
                    return asyncSucceed(
                        decision ?? deny(`Command not whitelisted: ${action.command.join(" ")}`)
                    ) as any;
                }

                if (action.type === "patch.apply" || action.type === "patch.rollback") {
                    return asyncSucceed(patchApplyDecisionFromConfig(action, config.patchApply)) as any;
                }

                return asyncSucceed(allow()) as any;
            }

            case "autonomous": {
                if (action.type === "patch.apply" || action.type === "patch.rollback") {
                    return asyncSucceed(patchApplyDecisionFromConfig(action, config.patchApply)) as any;
                }

                if (action.type === "shell.exec") {
                    const decision = shellDecisionFromConfig(action.command, config.shell);
                    return asyncSucceed(
                        decision ?? ask(`Run non-whitelisted command: ${describeCommand(action)}`, "high", "reject")
                    ) as any;
                }

                return asyncSucceed(allow()) as any;
            }
        }
    },
});

export const defaultPermissions: PermissionService = makeConfiguredPermissions();
