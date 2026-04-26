import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentConfig } from "../core/config";
import type { AgentBatchGoal } from "../core/batch";
import type { AgentPackageManagerConfig } from "../core/types";

export type AgentInitProfile = "default" | "google" | "openai-compatible" | "fake";

export type AgentInitOptions = {
    readonly cwd: string;
    readonly profile?: AgentInitProfile;
    readonly force?: boolean;
    readonly dryRun?: boolean;
};

export type AgentInitFileStatus = "created" | "overwritten" | "skipped";

export type AgentInitFile = {
    readonly path: string;
    readonly relativePath: string;
    readonly status: AgentInitFileStatus;
    readonly bytes: number;
};

export type AgentInitResult = {
    readonly cwd: string;
    readonly profile: AgentInitProfile;
    readonly dryRun: boolean;
    readonly files: readonly AgentInitFile[];
    readonly nextSteps: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonFile = (path: string): unknown | undefined => {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

const readPackageJson = (cwd: string): Record<string, unknown> | undefined => {
    const json = readJsonFile(join(cwd, "package.json"));
    return isRecord(json) ? json : undefined;
};

const scriptNames = (packageJson: Record<string, unknown> | undefined): readonly string[] => {
    const scripts = packageJson?.scripts;
    if (!isRecord(scripts)) return [];
    return Object.entries(scripts)
        .filter(([, value]) => typeof value === "string")
        .map(([name]) => name)
        .sort();
};

const hasAnyScript = (scripts: readonly string[], candidates: readonly string[]): boolean =>
    candidates.some((candidate) => scripts.includes(candidate));

const inferPackageManager = (cwd: string, packageJson: Record<string, unknown> | undefined): AgentPackageManagerConfig => {
    const packageManager = typeof packageJson?.packageManager === "string"
        ? packageJson.packageManager.split("@")[0]
        : undefined;

    if (packageManager === "npm" || packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun") {
        return packageManager;
    }

    if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
    if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
    if (existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "npm-shrinkwrap.json"))) return "npm";
    return "auto";
};

const llmConfigForProfile = (profile: AgentInitProfile): AgentConfig["llm"] | undefined => {
    switch (profile) {
        case "default":
            return undefined;
        case "google":
            return {
                provider: "google",
                model: "gemini-2.5-flash",
                apiKeyEnv: "GEMINI_API_KEY",
                temperature: 0.2,
                maxOutputTokens: 4096,
            };
        case "openai-compatible":
            return {
                provider: "openai-compatible",
                endpoint: "https://api.openai.com/v1/chat/completions",
                model: "gpt-4.1",
                apiKeyEnv: "BRASS_LLM_API_KEY",
                temperature: 0.2,
            };
        case "fake":
            return {
                provider: "fake",
                fakeResponse: "Fake plan from brass-agent init. Configure a real provider when ready.",
            };
    }
};

const buildAgentConfig = (cwd: string, profile: AgentInitProfile): AgentConfig => {
    const packageJson = readPackageJson(cwd);
    const scripts = scriptNames(packageJson);
    const includeTypecheck = hasAnyScript(scripts, ["typecheck", "type-check", "check-types", "tsc", "check"]);
    const includeLint = hasAnyScript(scripts, ["lint", "lint:ci"]);
    const llm = llmConfigForProfile(profile);

    return {
        mode: "propose",
        approval: "auto",
        ...(llm ? { llm } : {}),
        project: {
            packageManager: inferPackageManager(cwd, packageJson),
            testScriptNames: ["test", "test:ci", "test:unit"],
            includeTypecheck,
            includeLint,
            maxValidationCommands: 2,
        },
        context: {
            enabled: true,
            maxSearchQueries: 3,
            maxFiles: 4,
            maxSearchResults: 40,
            globs: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.json", "*.md", "*.yml", "*.yaml"],
            excludeGlobs: [
                ".env*",
                "**/.env*",
                "**/node_modules/**",
                "**/dist/**",
                "**/build/**",
                "**/.git/**",
                "**/*.pem",
                "**/*.key",
                "**/secrets/**",
            ],
        },
        patchQuality: {
            enabled: true,
            maxRepairAttempts: 1,
        },
        rollback: {
            enabled: true,
            onFinalValidationFailure: true,
            strategy: "all",
            maxRollbackDepth: 8,
            runValidationAfterRollback: true,
            allowForSuppliedPatches: false,
        },
        redaction: {
            enabled: true,
            additionalPatterns: [],
        },
        language: {
            response: "auto",
        },
        permissions: {
            shell: {
                inheritDefaults: true,
                ask: [
                    {
                        pattern: "npm run build",
                        reason: "Build commands can be slow and may produce large outputs.",
                        risk: "medium",
                        defaultAnswer: "approve",
                    },
                    {
                        pattern: "pnpm run build",
                        reason: "Build commands can be slow and may produce large outputs.",
                        risk: "medium",
                        defaultAnswer: "approve",
                    },
                    {
                        pattern: "yarn run build",
                        reason: "Build commands can be slow and may produce large outputs.",
                        risk: "medium",
                        defaultAnswer: "approve",
                    },
                    {
                        pattern: "bun run build",
                        reason: "Build commands can be slow and may produce large outputs.",
                        risk: "medium",
                        defaultAnswer: "approve",
                    },
                ],
                deny: [
                    "rm *",
                    "git push *",
                    "git reset *",
                    "git clean *",
                ],
            },
            patchApply: {
                decision: "ask",
                reason: "Apply the generated unified diff to the workspace.",
                risk: "high",
                defaultAnswer: "reject",
            },
        },
        tools: {
            "fs.readFile": { timeoutMs: 10_000, retries: 1 },
            "fs.exists": { timeoutMs: 5_000, retries: 0 },
            "fs.searchText": { timeoutMs: 10_000, retries: 1 },
            "shell.exec": { timeoutMs: 180_000, retries: 0 },
            "llm.complete": { timeoutMs: 90_000, retries: 2 },
            "patch.apply": { timeoutMs: 30_000, retries: 0 },
            "patch.rollback": { timeoutMs: 30_000, retries: 0 },
        },
    };
};

const batchGoalsForWorkspace = (cwd: string): readonly AgentBatchGoal[] => {
    const scripts = scriptNames(readPackageJson(cwd));
    const goals: AgentBatchGoal[] = [{ preset: "inspect", mode: "read-only" }];

    if (hasAnyScript(scripts, ["typecheck", "type-check", "check-types", "tsc", "check"])) {
        goals.push({ preset: "typecheck", mode: "propose" });
    }

    if (hasAnyScript(scripts, ["lint", "lint:ci"])) {
        goals.push({ preset: "lint", mode: "propose" });
    }

    if (hasAnyScript(scripts, ["test", "test:ci", "test:unit"])) {
        goals.push({ preset: "fix-tests", mode: "propose" });
    }

    return goals;
};

const buildBatchFile = (cwd: string): string => `${JSON.stringify({
    stopOnFailure: false,
    goals: batchGoalsForWorkspace(cwd),
}, null, 2)}\n`;

const buildEnvExample = (profile: AgentInitProfile): string => {
    const lines = [
        "# Brass Agent environment variables",
        "# Copy this file to .env or .brass-agent.env, or export the variables in your shell.",
        "# brass-agent auto-loads supported agent env keys from --cwd.",
        "# Do not commit real API keys.",
        "",
    ];

    if (profile === "fake") {
        lines.push(
            "BRASS_LLM_PROVIDER=fake",
            "BRASS_FAKE_LLM_RESPONSE=Fake plan from .env.example",
            ""
        );
    }

    lines.push(
        "# Google / Gemini",
        "# Used when .brass-agent.json selects provider google, or when auto-detected.",
        "GEMINI_API_KEY=",
        "BRASS_GOOGLE_MODEL=gemini-2.5-flash",
        "",
        "# OpenAI-compatible providers",
        "# BRASS_LLM_PROVIDER=openai-compatible",
        "BRASS_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions",
        "BRASS_LLM_API_KEY=",
        "BRASS_LLM_MODEL=gpt-4.1",
        "",
        "# Approval behavior: auto | interactive | approve | deny",
        "# BRASS_AGENT_APPROVAL=auto",
        ""
    );

    if (profile === "google") {
        lines.splice(4, 0, "BRASS_LLM_PROVIDER=google", "");
    } else if (profile === "openai-compatible") {
        lines.splice(4, 0, "BRASS_LLM_PROVIDER=openai-compatible", "");
    }

    return `${lines.join("\n")}\n`;
};

const buildAgentReadme = (): string => [
    "# Brass Agent",
    "",
    "This workspace was initialized with `brass-agent --init`.",
    "",
    "Generated files:",
    "",
    "- `.brass-agent.json` — local policy/config for Brass Agent.",
    "- `brass-agent.batch.json` — sample multi-goal batch workflow.",
    "- `.env.example` — example environment variables. Copy to `.env` or `.brass-agent.env`; keep real secrets out of git.",
    "",
    "Recommended first commands:",
    "",
    "```bash",
    "brass-agent --doctor",
    "brass-agent --preset inspect",
    "brass-agent --batch-file brass-agent.batch.json",
    "```",
    "",
    "Apply mode is intentionally approval-gated:",
    "",
    "```bash",
    "brass-agent --apply \"fix the failing tests\"",
    "```",
    "",
].join("\n");

const nextStepsForProfile = (profile: AgentInitProfile): readonly string[] => {
    const steps = [
        "Review .brass-agent.json and adjust permissions/context budgets for this repo.",
        "Run: brass-agent --doctor",
        "Run: brass-agent --preset inspect",
        "Run: brass-agent --batch-file brass-agent.batch.json",
    ];

    if (profile === "google") {
        return ["Set GEMINI_API_KEY in your shell, `.env`, or `.brass-agent.env`.", ...steps];
    }

    if (profile === "openai-compatible") {
        return ["Set BRASS_LLM_API_KEY and BRASS_LLM_ENDPOINT in your shell, `.env`, or `.brass-agent.env`.", ...steps];
    }

    if (profile === "default") {
        return ["Set an LLM provider env var in your shell, `.env`, or `.brass-agent.env` when ready, or let the CLI fall back to fake mode.", ...steps];
    }

    return steps;
};

const writeInitFile = async (options: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly content: string;
    readonly force: boolean;
    readonly dryRun: boolean;
}): Promise<AgentInitFile> => {
    const path = resolve(options.cwd, options.relativePath);
    const exists = existsSync(path);
    const status: AgentInitFileStatus = exists ? options.force ? "overwritten" : "skipped" : "created";

    if (!options.dryRun && status !== "skipped") {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, options.content, "utf8");
    }

    return {
        path,
        relativePath: options.relativePath,
        status,
        bytes: Buffer.byteLength(options.content, "utf8"),
    };
};

export const initializeAgentWorkspace = async (options: AgentInitOptions): Promise<AgentInitResult> => {
    const cwd = resolve(options.cwd);
    const profile = options.profile ?? "default";
    const force = options.force ?? false;
    const dryRun = options.dryRun ?? false;

    const config = buildAgentConfig(cwd, profile);
    const files = await Promise.all([
        writeInitFile({
            cwd,
            relativePath: ".brass-agent.json",
            content: `${JSON.stringify(config, null, 2)}\n`,
            force,
            dryRun,
        }),
        writeInitFile({
            cwd,
            relativePath: "brass-agent.batch.json",
            content: buildBatchFile(cwd),
            force,
            dryRun,
        }),
        writeInitFile({
            cwd,
            relativePath: ".env.example",
            content: buildEnvExample(profile),
            force,
            dryRun,
        }),
        writeInitFile({
            cwd,
            relativePath: "BRASS_AGENT.md",
            content: buildAgentReadme(),
            force,
            dryRun,
        }),
    ]);

    return {
        cwd,
        profile,
        dryRun,
        files,
        nextSteps: nextStepsForProfile(profile),
    };
};

const statusIcon = (status: AgentInitFileStatus): string => {
    switch (status) {
        case "created":
            return "✓";
        case "overwritten":
            return "!";
        case "skipped":
            return "-";
    }
};

export const printAgentInitResult = (result: AgentInitResult): void => {
    console.log(`brass-agent init${result.dryRun ? " (dry run)" : ""}`);
    console.log(`workspace: ${result.cwd}`);
    console.log(`profile: ${result.profile}`);
    console.log("");

    for (const file of result.files) {
        console.log(`${statusIcon(file.status)} ${file.status} ${file.relativePath}`);
    }

    console.log("");
    console.log("next steps:");
    for (const step of result.nextSteps) {
        console.log(`- ${step}`);
    }
};
