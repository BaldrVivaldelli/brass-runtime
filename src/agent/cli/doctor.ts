import { existsSync, readdirSync, readFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { AgentConfig } from "../core/config";
import type { AgentEnvFileLoadResult } from "./envFile";
import type { AgentWorkspaceDiscoveryResult } from "../node/nodeWorkspaceDiscovery";

export type AgentDoctorCheckStatus = "ok" | "warn" | "fail" | "skip";

export type AgentDoctorCheck = {
    readonly id: string;
    readonly label: string;
    readonly status: AgentDoctorCheckStatus;
    readonly message: string;
};

export type AgentDoctorReport = {
    readonly generatedAt: string;
    readonly cwd: string;
    readonly configPath?: string;
    readonly repoRoot?: string;
    readonly status: "ok" | "warn" | "fail";
    readonly checks: readonly AgentDoctorCheck[];
};

export type AgentDoctorOptions = {
    readonly cwd: string;
    readonly config?: AgentConfig;
    readonly configPath?: string;
    readonly includeVsCode?: boolean;
    readonly envFileLoad?: AgentEnvFileLoadResult;
    readonly workspaceDiscovery?: AgentWorkspaceDiscoveryResult;
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

const findPackageRoot = (start: string, packageName: string): string | undefined => {
    let current = resolve(start);

    while (true) {
        const packageJsonPath = join(current, "package.json");
        const json = readJsonFile(packageJsonPath);
        if (isRecord(json) && json.name === packageName) return current;

        const parent = resolve(current, "..");
        if (parent === current) return undefined;
        current = parent;
    }
};

const commandVersion = (command: string, args: readonly string[] = ["--version"], cwd?: string): string | undefined => {
    const result = spawnSync(command, [...args], {
        cwd,
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
    });

    if (result.error || (result.status ?? 0) !== 0) return undefined;
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/g)[0];
};

const hasEnv = (name: string | undefined): boolean => Boolean(name && process.env[name]);

const launchedFromVsCodeExtension = (): boolean => process.env.BRASS_AGENT_VSCODE_EXTENSION === "1";

const packageManagerFromWorkspace = (cwd: string): { readonly manager: string; readonly source: string } => {
    const packageJson = readJsonFile(join(cwd, "package.json"));
    const packageManager = isRecord(packageJson) && typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.split("@")[0]
        : undefined;

    if (packageManager) return { manager: packageManager, source: "package.json packageManager" };
    if (existsSync(join(cwd, "pnpm-lock.yaml"))) return { manager: "pnpm", source: "pnpm-lock.yaml" };
    if (existsSync(join(cwd, "yarn.lock"))) return { manager: "yarn", source: "yarn.lock" };
    if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return { manager: "bun", source: "bun lockfile" };
    if (existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "npm-shrinkwrap.json"))) return { manager: "npm", source: "npm lockfile" };
    return { manager: "npm", source: "fallback" };
};

const packageScripts = (packageJson: unknown): readonly string[] =>
    isRecord(packageJson) && isRecord(packageJson.scripts)
        ? Object.entries(packageJson.scripts)
            .filter(([, value]) => typeof value === "string")
            .map(([name]) => name)
            .sort()
        : [];

const hasScriptMatching = (scripts: readonly string[], patterns: readonly RegExp[]): string | undefined =>
    scripts.find((name) => patterns.some((pattern) => pattern.test(name)));

const projectProfileCheck = (cwd: string, packageJson: unknown): AgentDoctorCheck => {
    const scripts = packageScripts(packageJson);
    const markers = [
        "Cargo.toml",
        "Cargo.lock",
        "src-tauri/tauri.conf.json",
        "apps/desktop/package.json",
        "apps/desktop/src-tauri/tauri.conf.json",
        "bridges/whatsmeow-bridge/Cargo.toml",
        "apps",
        "packages",
        "bridges",
        "turbo.json",
        "nx.json",
        "pnpm-workspace.yaml",
    ].filter((path) => existsSync(join(cwd, path)));

    const stacks: string[] = [];
    if (isRecord(packageJson)) stacks.push("node");
    if (markers.some((marker) => marker === "Cargo.toml" || marker === "Cargo.lock" || marker.endsWith("Cargo.toml"))) stacks.push("rust");
    if (markers.some((marker) => marker.includes("tauri")) || scripts.some((name) => name.includes("tauri"))) stacks.push("tauri");
    if (markers.some((marker) => marker.startsWith("apps")) || scripts.some((name) => name.includes("desktop"))) stacks.push("desktop");
    if (markers.some((marker) => marker.startsWith("bridges")) || scripts.some((name) => name.includes("bridge"))) stacks.push("bridge");
    if (markers.some((marker) => ["apps", "packages", "bridges", "turbo.json", "nx.json", "pnpm-workspace.yaml"].includes(marker))) stacks.push("monorepo");

    const healthScript = hasScriptMatching(scripts, [
        /^repo:check$/,
        /^check$/,
        /(^|:)check($|:)/,
        /(^|:)doctor($|:)/,
        /(^|:)health($|:)/,
        /(^|:)verify($|:)/,
        /(^|:)validate($|:)/,
        /(^|:)ci($|:)/,
    ]);

    const pieces = [
        `stacks: ${stacks.length > 0 ? [...new Set(stacks)].join(", ") : "none detected"}`,
        `markers: ${markers.length > 0 ? markers.slice(0, 8).join(", ") : "none"}`,
        healthScript ? `likely validation: npm run ${healthScript}` : "likely validation: none detected",
    ];

    return {
        id: "workspace.projectProfile",
        label: "Workspace project profile",
        status: stacks.length > 0 ? "ok" : "skip",
        message: pieces.join(". "),
    };
};

const envFileCheck = (load: AgentEnvFileLoadResult | undefined): AgentDoctorCheck => {
    if (!load) {
        return {
            id: "envFile",
            label: "Agent env file",
            status: "skip",
            message: "Env file loading did not run.",
        };
    }

    if (load.disabled) {
        return {
            id: "envFile",
            label: "Agent env file",
            status: "skip",
            message: "Env file loading disabled by --no-env-file.",
        };
    }

    if (load.errors.length > 0) {
        return {
            id: "envFile",
            label: "Agent env file",
            status: "fail",
            message: load.errors.join("; "),
        };
    }

    if (load.paths.length === 0) {
        return {
            id: "envFile",
            label: "Agent env file",
            status: "skip",
            message: "No .brass-agent.env, .env.local, or .env found in workspace; using exported shell environment only.",
        };
    }

    const pieces: string[] = [`Loaded ${load.paths.join(", ")}`];
    if (load.loadedKeys.length > 0) pieces.push(`keys: ${load.loadedKeys.join(", ")}`);
    if (load.alreadySetKeys.length > 0) pieces.push(`already set by shell: ${load.alreadySetKeys.join(", ")}`);
    if (load.emptyKeys.length > 0) pieces.push(`empty keys skipped: ${load.emptyKeys.join(", ")}`);
    if (load.ignoredKeys.length > 0) pieces.push(`non-agent keys ignored: ${load.ignoredKeys.slice(0, 8).join(", ")}${load.ignoredKeys.length > 8 ? ", ..." : ""}`);
    if (load.invalidLines.length > 0) pieces.push(`invalid lines: ${load.invalidLines.join(", ")}`);

    return {
        id: "envFile",
        label: "Agent env file",
        status: load.loadedKeys.length > 0 || load.alreadySetKeys.length > 0 ? "ok" : "warn",
        message: pieces.join(". "),
    };
};

const llmCheck = (config: AgentConfig | undefined): AgentDoctorCheck => {
    const provider = (process.env.BRASS_LLM_PROVIDER ?? config?.llm?.provider)?.trim().toLowerCase();
    const configuredApiKeyEnv = config?.llm?.apiKeyEnv;

    if (provider === "fake") {
        return {
            id: "llm",
            label: "LLM provider",
            status: "ok",
            message: "Fake LLM provider is selected.",
        };
    }

    if (provider === "google" || provider === "gemini") {
        const keyPresent = hasEnv(configuredApiKeyEnv) || hasEnv("BRASS_GOOGLE_API_KEY") || hasEnv("GOOGLE_API_KEY") || hasEnv("GEMINI_API_KEY");
        return {
            id: "llm",
            label: "LLM provider",
            status: keyPresent ? "ok" : "fail",
            message: keyPresent
                ? `Google/Gemini provider is configured (${provider}).`
                : "Google/Gemini provider is selected but no API key env var is set. Export GEMINI_API_KEY or put it in .env/.brass-agent.env.",
        };
    }

    if (provider === "openai" || provider === "openai-compatible") {
        const endpointPresent = Boolean(process.env.BRASS_LLM_ENDPOINT ?? config?.llm?.endpoint);
        const keyPresent = hasEnv(configuredApiKeyEnv) || hasEnv("BRASS_LLM_API_KEY");
        return {
            id: "llm",
            label: "LLM provider",
            status: endpointPresent && keyPresent ? "ok" : "fail",
            message: endpointPresent && keyPresent
                ? `OpenAI-compatible provider is configured (${provider}).`
                : "OpenAI-compatible provider is selected but endpoint or API key env var is missing. Export BRASS_LLM_API_KEY or put it in .env/.brass-agent.env.",
        };
    }

    if (hasEnv("BRASS_GOOGLE_API_KEY") || hasEnv("GOOGLE_API_KEY") || hasEnv("GEMINI_API_KEY")) {
        return {
            id: "llm",
            label: "LLM provider",
            status: "ok",
            message: "Google/Gemini credentials are available and will be auto-detected.",
        };
    }

    if ((process.env.BRASS_LLM_ENDPOINT ?? config?.llm?.endpoint) && hasEnv("BRASS_LLM_API_KEY")) {
        return {
            id: "llm",
            label: "LLM provider",
            status: "ok",
            message: "OpenAI-compatible credentials are available and will be auto-detected.",
        };
    }

    return {
        id: "llm",
        label: "LLM provider",
        status: "warn",
        message: "No real LLM credentials found. The CLI will fall back to the fake provider unless config selects a real provider.",
    };
};

const workspaceSettingsCommand = (cwd: string): string | undefined => {
    const settings = readJsonFile(join(cwd, ".vscode", "settings.json"));
    if (!isRecord(settings)) return undefined;
    const command = settings["brassAgent.command"];
    return typeof command === "string" ? command : undefined;
};

const newestVsix = (extensionDir: string): string | undefined => {
    try {
        return readdirSync(extensionDir)
            .filter((name) => name.endsWith(".vsix"))
            .sort()
            .at(-1);
    } catch {
        return undefined;
    }
};

const push = (checks: AgentDoctorCheck[], check: AgentDoctorCheck): void => {
    checks.push(check);
};

export const runAgentDoctor = async (options: AgentDoctorOptions): Promise<AgentDoctorReport> => {
    const cwd = resolve(options.cwd);
    const checks: AgentDoctorCheck[] = [];
    const repoRoot = findPackageRoot(cwd, "brass-runtime") ?? findPackageRoot(process.cwd(), "brass-runtime");

    const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
    push(checks, {
        id: "node",
        label: "Node.js",
        status: nodeMajor >= 18 ? "ok" : "fail",
        message: `Node ${process.versions.node}${nodeMajor >= 18 ? "" : " is too old; use Node 18 or newer."}`,
    });

    const npmVersion = commandVersion("npm");
    push(checks, {
        id: "npm",
        label: "npm",
        status: npmVersion ? "ok" : "fail",
        message: npmVersion ? `npm ${npmVersion}` : "npm is not available on PATH.",
    });

    const gitVersion = commandVersion("git");
    push(checks, {
        id: "git",
        label: "git",
        status: gitVersion ? "ok" : "warn",
        message: gitVersion ? gitVersion : "git is not available; patch apply/rollback uses git apply.",
    });

    const rgVersion = commandVersion("rg");
    push(checks, {
        id: "ripgrep",
        label: "ripgrep",
        status: rgVersion ? "ok" : "warn",
        message: rgVersion ? rgVersion : "rg is not available; context discovery search will be limited.",
    });

    push(checks, {
        id: "workspace",
        label: "Workspace",
        status: existsSync(cwd) ? "ok" : "fail",
        message: existsSync(cwd) ? cwd : `Workspace does not exist: ${cwd}`,
    });

    if (options.workspaceDiscovery) {
        const discovery = options.workspaceDiscovery;
        push(checks, {
            id: "workspace.discovery",
            label: "Workspace discovery",
            status: discovery.disabled ? "skip" : discovery.marker ? "ok" : "warn",
            message: discovery.disabled
                ? "Workspace discovery disabled by --no-discover-workspace."
                : discovery.marker
                    ? `${discovery.changed ? `Resolved ${discovery.inputCwd} -> ${discovery.cwd}` : `Using ${discovery.cwd}`} via ${discovery.marker}.`
                    : `No workspace marker found upward from ${discovery.inputCwd}; using input cwd.`,
        });
    }

    const packageJsonPath = join(cwd, "package.json");
    const packageJson = readJsonFile(packageJsonPath);
    push(checks, {
        id: "workspace.packageJson",
        label: "Workspace package.json",
        status: isRecord(packageJson) ? "ok" : "warn",
        message: isRecord(packageJson) ? `Found ${packageJsonPath}` : "No package.json found in workspace; project command discovery may use fallbacks.",
    });

    if (isRecord(packageJson)) {
        const scripts = isRecord(packageJson.scripts) ? Object.keys(packageJson.scripts) : [];
        push(checks, {
            id: "workspace.scripts",
            label: "Workspace scripts",
            status: scripts.length ? "ok" : "warn",
            message: scripts.length ? `Scripts: ${scripts.slice(0, 12).join(", ")}${scripts.length > 12 ? ", ..." : ""}` : "No package scripts found.",
        });

        const pm = packageManagerFromWorkspace(cwd);
        const pmVersion = commandVersion(pm.manager);
        push(checks, {
            id: "workspace.packageManager",
            label: "Workspace package manager",
            status: pmVersion ? "ok" : "warn",
            message: pmVersion ? `${pm.manager} available (${pm.source}): ${pmVersion}` : `${pm.manager} inferred from ${pm.source}, but command is not available on PATH.`,
        });
    }

    push(checks, projectProfileCheck(cwd, packageJson));

    push(checks, envFileCheck(options.envFileLoad));
    push(checks, llmCheck(options.config));

    push(checks, {
        id: "config",
        label: "Agent config",
        status: options.configPath ? "ok" : "skip",
        message: options.configPath
            ? `Loaded ${options.configPath}`
            : "No .brass-agent.json / brass-agent.config.json loaded; using built-in defaults and VS Code/CLI settings.",
    });

    if (options.includeVsCode !== false) {
        const codeVersion = commandVersion(process.env.BRASS_CODE_CMD ?? "code");
        push(checks, {
            id: "vscode.code",
            label: "VS Code CLI",
            status: codeVersion ? "ok" : "warn",
            message: codeVersion ? `code ${codeVersion}` : "VS Code CLI `code` is not available on PATH; .vsix install needs it unless using the VS Code UI.",
        });

        const configured = workspaceSettingsCommand(cwd);
        const launchedByExtension = launchedFromVsCodeExtension();
        push(checks, {
            id: "vscode.settings",
            label: "VS Code extension setting",
            status: configured ? "ok" : launchedByExtension ? "skip" : "warn",
            message: configured
                ? `brassAgent.command = ${configured}`
                : launchedByExtension
                    ? `No workspace brassAgent.command needed; launched by the VS Code extension (${process.env.BRASS_AGENT_VSCODE_CLI_SOURCE ?? "auto"}).`
                    : "No workspace .vscode/settings.json brassAgent.command found.",
        });
    }

    if (repoRoot) {
        const cliSource = join(repoRoot, "src", "agent", "cli", "main.ts");
        const cliBuild = join(repoRoot, "dist", "agent", "cli", "main.cjs");
        const extensionDir = join(repoRoot, "extensions", "vscode-brass-agent");

        push(checks, {
            id: "repo.root",
            label: "brass-runtime repo",
            status: "ok",
            message: repoRoot,
        });

        push(checks, {
            id: "repo.cliSource",
            label: "CLI source",
            status: existsSync(cliSource) ? "ok" : "fail",
            message: existsSync(cliSource) ? `Found ${cliSource}` : `Missing ${cliSource}`,
        });

        push(checks, {
            id: "repo.cliBuild",
            label: "CLI build",
            status: existsSync(cliBuild) ? "ok" : "warn",
            message: existsSync(cliBuild) ? `Found ${cliBuild}` : "dist/agent/cli/main.cjs is missing; run npm run build.",
        });

        push(checks, {
            id: "repo.extensionDir",
            label: "VS Code extension source",
            status: existsSync(join(extensionDir, "package.json")) ? "ok" : "warn",
            message: existsSync(join(extensionDir, "package.json")) ? extensionDir : "extensions/vscode-brass-agent was not found.",
        });

        push(checks, {
            id: "repo.extensionBuild",
            label: "VS Code extension build",
            status: existsSync(join(extensionDir, "out", "extension.js")) ? "ok" : "warn",
            message: existsSync(join(extensionDir, "out", "extension.js")) ? "out/extension.js exists." : "Extension output missing; run npm run agent:vscode:package or compile the extension.",
        });

        const vsix = newestVsix(extensionDir);
        push(checks, {
            id: "repo.extensionVsix",
            label: "VSIX package",
            status: vsix ? "ok" : "warn",
            message: vsix ? `Found ${vsix}` : "No .vsix found in extensions/vscode-brass-agent.",
        });

        const cliReadable = await access(cliBuild, constants.R_OK).then(() => true).catch(() => false);
        push(checks, {
            id: "repo.cliReadable",
            label: "CLI artifact readable",
            status: cliReadable ? "ok" : "warn",
            message: cliReadable ? "Built CLI artifact is readable." : "Built CLI artifact is not readable yet.",
        });
    } else {
        push(checks, {
            id: "repo.root",
            label: "brass-runtime repo",
            status: "skip",
            message: "Not running inside a brass-runtime checkout; local source/build checks skipped.",
        });
    }

    const status = checks.some((check) => check.status === "fail")
        ? "fail"
        : checks.some((check) => check.status === "warn") ? "warn" : "ok";

    return {
        generatedAt: new Date().toISOString(),
        cwd,
        ...(options.configPath ? { configPath: options.configPath } : {}),
        ...(repoRoot ? { repoRoot } : {}),
        status,
        checks,
    };
};

const icon = (status: AgentDoctorCheckStatus): string => {
    switch (status) {
        case "ok":
            return "✓";
        case "warn":
            return "!";
        case "fail":
            return "✗";
        case "skip":
            return "-";
    }
};

export const printAgentDoctorReport = (report: AgentDoctorReport): void => {
    console.log("brass-agent doctor");
    console.log(`workspace: ${report.cwd}`);
    if (report.configPath) console.log(`config: ${report.configPath}`);
    if (report.repoRoot) console.log(`repo: ${report.repoRoot}`);
    console.log(`status: ${report.status}`);
    console.log("");

    for (const check of report.checks) {
        console.log(`${icon(check.status)} ${check.label}: ${check.message}`);
    }
};
