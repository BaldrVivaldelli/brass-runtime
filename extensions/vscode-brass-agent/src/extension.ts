import * as readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

type RunMode = "propose" | "apply" | "read-only";
type HistoryRunMode = RunMode | "apply-approved-patch" | "rollback-approved-patch" | "batch";
type HistoryStatus = "done" | "failed" | "cancelled" | "unknown" | string;

type BatchSummary = {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly exitCode: number;
    readonly stoppedEarly: boolean;
};

type BrassProtocolMessage = {
    readonly protocol?: string;
    readonly version?: number;
    readonly type?: string;
    readonly event?: any;
    readonly state?: any;
    readonly summary?: BatchSummary;
    readonly message?: string;
};

type PatchStats = {
    readonly added: number;
    readonly removed: number;
    readonly files: readonly string[];
};

type PatchPreview = {
    readonly cwd: string;
    readonly goal: string;
    readonly patch: string;
};

type ChatMessageRole = "user" | "assistant" | "system";

type ChatSessionMessage = {
    readonly id: string;
    readonly role: ChatMessageRole;
    readonly text: string;
    readonly at: string;
    readonly mode?: RunMode;
    readonly actions?: readonly string[];
};

type ChatLastRunContext = {
    readonly cwd: string;
    readonly goal: string;
    readonly mode: RunMode;
    readonly status: HistoryStatus;
    readonly summary?: string;
    readonly error?: string;
    readonly validation?: string;
    readonly patchStats?: PatchStats;
    readonly completedAt: string;
};

type ChatSessionSnapshot = {
    readonly messages: readonly ChatSessionMessage[];
    readonly lastRun?: ChatLastRunContext;
    readonly lastPatch?: PatchPreview;
};

type ProblemCounts = {
    readonly workspace: number;
    readonly currentFile: number;
};

type ProblemTarget = "workspace" | "current-file";

type ProblemAction = "explain" | "fix";

type LlmProvider = "auto" | "google" | "openai-compatible" | "fake";
type ResponseLanguageSetting = "auto" | "match-user" | "es" | "en" | "pt" | "fr" | "de" | "it";
type ChatDefaultLocation = "sidebar" | "editor";

type LlmSetupStatus = {
    readonly provider: LlmProvider;
    readonly label: string;
    readonly ready: boolean;
    readonly needsSetup: boolean;
    readonly detail: string;
    readonly hasGoogleApiKey: boolean;
    readonly hasOpenAiCompatibleApiKey: boolean;
};

type AgentDoctorCheckStatus = "ok" | "warn" | "fail" | "skip";

type AgentDoctorCheck = {
    readonly id: string;
    readonly label: string;
    readonly status: AgentDoctorCheckStatus;
    readonly message: string;
};

type AgentDoctorReport = {
    readonly generatedAt: string;
    readonly cwd: string;
    readonly configPath?: string;
    readonly repoRoot?: string;
    readonly status: "ok" | "warn" | "fail";
    readonly checks: readonly AgentDoctorCheck[];
};

type ProjectDashboardSnapshot = {
    readonly workspace?: string;
    readonly status: "ok" | "warn" | "fail" | "loading";
    readonly cli?: string;
    readonly model: LlmSetupStatus;
    readonly configPath?: string;
    readonly configExists: boolean;
    readonly language: string;
    readonly packageManager?: string;
    readonly validation?: string;
    readonly profile?: string;
    readonly envFile?: string;
    readonly doctorStatus?: string;
    readonly warnings: readonly string[];
    readonly error?: string;
};

type CliRunResult = {
    readonly finalState?: any;
    readonly finalStates: readonly any[];
    readonly batchSummary?: BatchSummary;
    readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
    readonly cancelled: boolean;
};

type RunHistoryEntry = {
    readonly id: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly cwd: string;
    readonly goal: string;
    readonly mode: HistoryRunMode;
    readonly status: HistoryStatus;
    readonly steps?: number;
    readonly durationMs: number;
    readonly summary?: string;
    readonly error?: string;
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly patch?: string;
    readonly patchStats?: PatchStats;
    readonly batchFile?: string;
    readonly batchSummary?: BatchSummary;
    readonly children?: readonly RunHistoryEntry[];
};

type HistoryNode =
    | { readonly kind: "run"; readonly entry: RunHistoryEntry }
    | { readonly kind: "detail"; readonly entry: RunHistoryEntry; readonly label: string; readonly description?: string; readonly icon?: string; readonly command?: vscode.Command };

const HISTORY_KEY = "brassAgent.runHistory.v1";
const CHAT_SESSION_KEY = "brassAgent.chatSession.v1";
const LLM_SETUP_DISMISSED_KEY = "brassAgent.llmSetupDismissed.v1";
const GOOGLE_API_KEY_SECRET = "brassAgent.llm.googleApiKey";
const OPENAI_COMPATIBLE_API_KEY_SECRET = "brassAgent.llm.openAiCompatibleApiKey";

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let historyProvider: RunHistoryProvider;
let currentProcess: ChildProcessWithoutNullStreams | undefined;
let lastPatchPreview: PatchPreview | undefined;
let chatProvider: ChatViewProvider;
let projectProvider: ProjectDashboardProvider;
let extensionContext: vscode.ExtensionContext;
let cachedCliCommand: ResolvedCliCommand | undefined;

const summarizeAction = (action: any): string => {
    switch (action?.type) {
        case "fs.readFile":
            return `read ${action.path}`;
        case "fs.exists":
            return `check ${action.path}`;
        case "fs.searchText":
            return `search \"${action.query}\"`;
        case "shell.exec":
            return Array.isArray(action.command) ? action.command.join(" ") : "shell.exec";
        case "llm.complete":
            return `llm.${action.purpose}`;
        case "patch.propose":
            return "propose patch";
        case "patch.apply":
            return "apply patch";
        case "patch.rollback":
            return "rollback patch";
        case "agent.finish":
            return "finish";
        case "agent.fail":
            return "fail";
        default:
            return action?.type ?? "action";
    }
};

const summarizeObservation = (observation: any): string => {
    switch (observation?.type) {
        case "fs.fileRead":
            return `read ${observation.path}`;
        case "fs.exists":
            return `${observation.exists ? "found" : "missing"} ${observation.path}`;
        case "fs.searchResult":
            return `search \"${observation.query}\" (${observation.matches?.length ?? 0} matches)`;
        case "shell.result":
            return `${Array.isArray(observation.command) ? observation.command.join(" ") : "shell"} exited ${observation.exitCode}`;
        case "llm.response":
            return `llm.${observation.purpose} responded`;
        case "patch.proposed":
            return "patch proposed";
        case "patch.applied":
            return `patch applied (${(observation.changedFiles ?? []).join(", ") || "no files reported"})`;
        case "patch.rolledBack":
            return `patch rolled back (${(observation.changedFiles ?? []).join(", ") || "no files reported"})`;
        case "agent.done":
            return "done";
        case "agent.error":
            return `error ${observation.error?._tag ?? "unknown"}`;
        default:
            return observation?.type ?? "observation";
    }
};

const statusIcon = (observation: any): string => {
    if (observation?.type === "agent.error") return "✗";
    if (observation?.type === "shell.result" && observation.exitCode !== 0) return "!";
    return "✓";
};

const workspaceCwd = (): string | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath;
};

const extensionConfig = () => vscode.workspace.getConfiguration("brassAgent");

type ResolvedCliCommand = {
    readonly command: string;
    readonly argsPrefix: readonly string[];
    readonly label: string;
    readonly source: string;
    readonly envPatch?: Record<string, string>;
};

const configuredCommandSetting = (): string => extensionConfig().get<string>("command")?.trim() || "auto";

const configuredPreferBundledCli = (): boolean => extensionConfig().get<boolean>("preferBundledCli") ?? true;

const configuredNodeCommand = (): string => extensionConfig().get<string>("nodeCommand")?.trim() || "node";

const configuredExtraArgs = (): readonly string[] => extensionConfig().get<readonly string[]>("extraArgs") ?? [];

const configuredEnvironment = (): Record<string, string> => extensionConfig().get<Record<string, string>>("environment") ?? {};

const configuredLlmProvider = (): LlmProvider => {
    const value = extensionConfig().get<string>("llm.provider")?.trim();
    if (value === "google" || value === "openai-compatible" || value === "fake") return value;
    return "auto";
};

const configuredGoogleModel = (): string => extensionConfig().get<string>("llm.google.model")?.trim() || "gemini-2.5-flash";

const configuredOpenAiCompatibleEndpoint = (): string =>
    extensionConfig().get<string>("llm.openaiCompatible.endpoint")?.trim() || "https://api.openai.com/v1/chat/completions";

const configuredOpenAiCompatibleModel = (): string =>
    extensionConfig().get<string>("llm.openaiCompatible.model")?.trim() || "gpt-4.1";

const configuredHistoryLimit = (): number => Math.max(1, extensionConfig().get<number>("historyLimit") ?? 50);

const configuredStorePatchesInHistory = (): boolean => extensionConfig().get<boolean>("storePatchesInHistory") ?? true;

const configuredChatHistoryLimit = (): number => Math.max(1, extensionConfig().get<number>("chatHistoryLimit") ?? 80);

const configuredProblemContextLimit = (): number => Math.max(1, extensionConfig().get<number>("problemContextLimit") ?? 40);

const configuredInlineAssistSurroundingLines = (): number => Math.max(0, extensionConfig().get<number>("inlineAssistSurroundingLines") ?? 20);

const configuredChatDefaultLocation = (): ChatDefaultLocation => {
    const value = extensionConfig().get<string>("chat.defaultLocation")?.trim();
    return value === "editor" ? "editor" : "sidebar";
};

const configuredResponseLanguage = (): ResponseLanguageSetting => {
    const value = extensionConfig().get<string>("language.response")?.trim();
    if (["auto", "match-user", "es", "en", "pt", "fr", "de", "it"].includes(value ?? "")) {
        return value as ResponseLanguageSetting;
    }
    return "auto";
};

const responseLanguageCliArgs = (): readonly string[] => {
    const language = configuredResponseLanguage();
    return language === "auto" ? [] : ["--language", language];
};

const secretValue = async (key: string): Promise<string | undefined> => {
    const value = await extensionContext.secrets.get(key);
    return value?.trim() || undefined;
};

const configuredOrProcessEnvHasAny = (...keys: readonly string[]): boolean => {
    const configured = configuredEnvironment();
    return keys.some((key) => Boolean((configured[key] ?? process.env[key])?.trim()));
};

const llmSecretEnvironment = async (): Promise<Record<string, string>> => {
    const env: Record<string, string> = {};
    const provider = configuredLlmProvider();

    if (provider !== "auto") env.BRASS_LLM_PROVIDER = provider;

    const googleModel = configuredGoogleModel();
    if (googleModel) env.BRASS_GOOGLE_MODEL = googleModel;

    const openAiEndpoint = configuredOpenAiCompatibleEndpoint();
    if (openAiEndpoint) env.BRASS_LLM_ENDPOINT = openAiEndpoint;

    const openAiModel = configuredOpenAiCompatibleModel();
    if (openAiModel) env.BRASS_LLM_MODEL = openAiModel;

    const googleKey = await secretValue(GOOGLE_API_KEY_SECRET);
    if (googleKey) {
        env.GEMINI_API_KEY = googleKey;
        env.GOOGLE_API_KEY = googleKey;
        env.BRASS_GOOGLE_API_KEY = googleKey;
    }

    const openAiKey = await secretValue(OPENAI_COMPATIBLE_API_KEY_SECRET);
    if (openAiKey) env.BRASS_LLM_API_KEY = openAiKey;

    return env;
};

const cliEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...process.env,
    ...configuredEnvironment(),
    ...(await llmSecretEnvironment()),
    BRASS_AGENT_VSCODE_EXTENSION: "1",
});

const llmSetupStatus = async (): Promise<LlmSetupStatus> => {
    const provider = configuredLlmProvider();
    const hasGoogleApiKey = Boolean(await secretValue(GOOGLE_API_KEY_SECRET)) ||
        configuredOrProcessEnvHasAny("GEMINI_API_KEY", "GOOGLE_API_KEY", "BRASS_GOOGLE_API_KEY");
    const hasOpenAiCompatibleApiKey = Boolean(await secretValue(OPENAI_COMPATIBLE_API_KEY_SECRET)) ||
        configuredOrProcessEnvHasAny("BRASS_LLM_API_KEY", "OPENAI_API_KEY");

    if (provider === "google") {
        return {
            provider,
            label: `Google/Gemini (${configuredGoogleModel()})`,
            ready: hasGoogleApiKey,
            needsSetup: !hasGoogleApiKey,
            detail: hasGoogleApiKey ? "Google/Gemini API key is configured for VS Code runs." : "Google/Gemini selected but no API key is stored or available in the VS Code environment.",
            hasGoogleApiKey,
            hasOpenAiCompatibleApiKey,
        };
    }

    if (provider === "openai-compatible") {
        return {
            provider,
            label: `OpenAI-compatible (${configuredOpenAiCompatibleModel()})`,
            ready: hasOpenAiCompatibleApiKey,
            needsSetup: !hasOpenAiCompatibleApiKey,
            detail: hasOpenAiCompatibleApiKey ? "OpenAI-compatible API key is configured for VS Code runs." : "OpenAI-compatible provider selected but no API key is stored or available in the VS Code environment.",
            hasGoogleApiKey,
            hasOpenAiCompatibleApiKey,
        };
    }

    if (provider === "fake") {
        return {
            provider,
            label: "Fake/offline",
            ready: true,
            needsSetup: false,
            detail: "Fake/offline provider is selected. No API key is required.",
            hasGoogleApiKey,
            hasOpenAiCompatibleApiKey,
        };
    }

    const hasAnyKey = hasGoogleApiKey || hasOpenAiCompatibleApiKey;
    return {
        provider,
        label: hasAnyKey ? "Auto-detect" : "Auto-detect (fake fallback)",
        ready: true,
        needsSetup: !hasAnyKey,
        detail: hasAnyKey
            ? "A model API key is available; the CLI can auto-detect the provider or use workspace config."
            : "No model key is configured in VS Code. Brass Agent can still run with the fake/offline fallback, but real LLM runs need setup.",
        hasGoogleApiKey,
        hasOpenAiCompatibleApiKey,
    };
};

const refreshChatLlmStatus = (): void => {
    void chatProvider?.refreshLlmStatus();
    void projectProvider?.refresh();
};

const accessFile = async (filePath: string): Promise<boolean> => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

const isJavaScriptEntrypoint = (value: string): boolean => /\.(cjs|mjs|js)$/i.test(value);

const isPathLikeCommand = (value: string): boolean =>
    path.isAbsolute(value) || value.includes("/") || value.includes("\\");

const pathExecutableCandidates = (command: string): readonly string[] => {
    if (process.platform !== "win32") return [command];

    const lower = command.toLowerCase();
    if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) return [command];

    return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
};

const commandExists = async (command: string): Promise<boolean> => {
    if (!command.trim()) return false;

    if (isPathLikeCommand(command)) {
        for (const candidate of pathExecutableCandidates(command)) {
            if (await accessFile(candidate)) return true;
        }
        return false;
    }

    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
        for (const candidate of pathExecutableCandidates(path.join(entry, command))) {
            if (await accessFile(candidate)) return true;
        }
    }

    return false;
};

const nodeScriptCli = (scriptPath: string, source: string): ResolvedCliCommand => {
    const nodeCommand = configuredNodeCommand();

    return {
        command: nodeCommand,
        argsPrefix: [scriptPath],
        label: `${nodeCommand} ${scriptPath}`,
        source,
    };
};

const electronAsNodeScriptCli = (scriptPath: string, source: string): ResolvedCliCommand => ({
    command: process.execPath,
    argsPrefix: [scriptPath],
    label: `${process.execPath} ${scriptPath}`,
    source: `${source} via VS Code Electron-as-Node fallback`,
    envPatch: {
        ELECTRON_RUN_AS_NODE: "1",
    },
});

const scriptCliCandidates = async (scriptPath: string, source: string): Promise<readonly ResolvedCliCommand[]> => {
    const candidates: ResolvedCliCommand[] = [];

    if (await commandExists(configuredNodeCommand())) {
        candidates.push(nodeScriptCli(scriptPath, source));
    }

    candidates.push(electronAsNodeScriptCli(scriptPath, source));
    return candidates;
};

const scriptCli = async (scriptPath: string, source: string): Promise<ResolvedCliCommand> =>
    (await scriptCliCandidates(scriptPath, source))[0];

const shellCli = (command: string, source: string): ResolvedCliCommand => ({
    command,
    argsPrefix: [],
    label: command,
    source,
});

const cliFromSetting = async (value: string, source: string): Promise<ResolvedCliCommand> => {
    if (isJavaScriptEntrypoint(value)) {
        return scriptCli(value, source);
    }

    return shellCli(value, source);
};

const findUpPackage = async (start: string, packageName: string): Promise<string | undefined> => {
    let current = path.resolve(start);

    for (; ;) {
        const packageJson = path.join(current, "package.json");
        try {
            const json = JSON.parse(await fs.readFile(packageJson, "utf8")) as { readonly name?: string };
            if (json.name === packageName) return current;
        } catch {
            // keep walking upward
        }

        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
};

const bundledCliPath = (): string =>
    path.join(extensionContext.extensionPath, "bundled", "dist", "agent", "cli", "main.cjs");

const devCheckoutCliPath = async (): Promise<string | undefined> => {
    const root = await findUpPackage(extensionContext.extensionPath, "brass-runtime");
    if (!root) return undefined;
    const cli = path.join(root, "dist", "agent", "cli", "main.cjs");
    return await accessFile(cli) ? cli : undefined;
};

const workspaceLocalCliPath = async (cwd: string): Promise<string | undefined> => {
    const bin = process.platform === "win32" ? "brass-agent.cmd" : "brass-agent";
    const cli = path.join(cwd, "node_modules", ".bin", bin);
    return await accessFile(cli) ? cli : undefined;
};

const resolveCliCommand = async (cwd: string, refresh = false): Promise<ResolvedCliCommand> => {
    if (cachedCliCommand && !refresh) return cachedCliCommand;

    const setting = configuredCommandSetting();
    if (setting && setting.toLowerCase() !== "auto") {
        cachedCliCommand = await cliFromSetting(setting, "setting brassAgent.command");
        return cachedCliCommand;
    }

    const envCommand = process.env.BRASS_AGENT_COMMAND?.trim();
    if (envCommand) {
        cachedCliCommand = await cliFromSetting(envCommand, "BRASS_AGENT_COMMAND");
        return cachedCliCommand;
    }

    const candidates: ResolvedCliCommand[] = [];

    if (configuredPreferBundledCli()) {
        const bundled = bundledCliPath();
        if (await accessFile(bundled)) candidates.push(...await scriptCliCandidates(bundled, "bundled VS Code extension CLI"));
    }

    const workspaceLocal = await workspaceLocalCliPath(cwd);
    if (workspaceLocal) candidates.push(await cliFromSetting(workspaceLocal, "workspace node_modules/.bin"));

    const devCli = await devCheckoutCliPath();
    if (devCli) candidates.push(...await scriptCliCandidates(devCli, "brass-runtime checkout dist"));

    if (!configuredPreferBundledCli()) {
        const bundled = bundledCliPath();
        if (await accessFile(bundled)) candidates.push(...await scriptCliCandidates(bundled, "bundled VS Code extension CLI"));
    }

    candidates.push(shellCli("brass-agent", "PATH fallback"));

    cachedCliCommand = candidates[0];
    return cachedCliCommand;
};

const describeResolvedCli = (cli: ResolvedCliCommand): string => `${cli.label} (${cli.source})`;


const setRunningContext = (value: boolean): PromiseLike<unknown> =>
    vscode.commands.executeCommand("setContext", "brassAgent.running", value);

const diagnosticSeverityLabel = (severity: vscode.DiagnosticSeverity): string => {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return "error";
        case vscode.DiagnosticSeverity.Warning:
            return "warning";
        case vscode.DiagnosticSeverity.Information:
            return "info";
        case vscode.DiagnosticSeverity.Hint:
            return "hint";
        default:
            return String(severity);
    }
};

const diagnosticCodeLabel = (code: vscode.Diagnostic["code"]): string | undefined => {
    if (code === undefined || code === null) return undefined;
    if (typeof code === "object" && "value" in code) return String(code.value);
    return String(code);
};

const diagnosticLocation = (cwd: string | undefined, uri: vscode.Uri, diagnostic: vscode.Diagnostic): string => {
    const file = cwd ? path.relative(cwd, uri.fsPath) || uri.fsPath : uri.fsPath;
    return `${file}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
};

const allWorkspaceDiagnostics = (): readonly [vscode.Uri, vscode.Diagnostic[]][] =>
    vscode.languages.getDiagnostics()
        .filter(([uri]) => uri.scheme === "file")
        .map(([uri, diagnostics]) => [uri, diagnostics] as [vscode.Uri, vscode.Diagnostic[]]);

const currentFileDiagnostics = (): readonly [vscode.Uri, vscode.Diagnostic[]][] => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];
    return [[editor.document.uri, vscode.languages.getDiagnostics(editor.document.uri)]];
};

const diagnosticPairsForTarget = (target: ProblemTarget): readonly [vscode.Uri, vscode.Diagnostic[]][] =>
    target === "current-file" ? currentFileDiagnostics() : allWorkspaceDiagnostics();

const problemCounts = (): ProblemCounts => {
    const workspace = allWorkspaceDiagnostics().reduce((sum, [, diagnostics]) => sum + diagnostics.length, 0);
    const currentFile = currentFileDiagnostics().reduce((sum, [, diagnostics]) => sum + diagnostics.length, 0);
    return { workspace, currentFile };
};

const diagnosticsPromptText = (target: ProblemTarget, maxDiagnostics = configuredProblemContextLimit()): string => {
    const cwd = workspaceCwd();
    const pairs = diagnosticPairsForTarget(target);
    const diagnostics: string[] = [];

    for (const [uri, fileDiagnostics] of pairs) {
        for (const diagnostic of fileDiagnostics) {
            if (diagnostics.length >= maxDiagnostics) break;
            const code = diagnosticCodeLabel(diagnostic.code);
            diagnostics.push([
                `${diagnostics.length + 1}. ${diagnosticSeverityLabel(diagnostic.severity)} at ${diagnosticLocation(cwd, uri, diagnostic)}`,
                `message: ${diagnostic.message}`,
                diagnostic.source ? `source: ${diagnostic.source}` : undefined,
                code ? `code: ${code}` : undefined,
            ].filter(Boolean).join("\n"));
        }
        if (diagnostics.length >= maxDiagnostics) break;
    }

    if (!diagnostics.length) return `No VS Code diagnostics are currently available for ${target === "current-file" ? "the current file" : "the workspace"}.`;
    const total = pairs.reduce((sum, [, fileDiagnostics]) => sum + fileDiagnostics.length, 0);
    return [
        `VS Code diagnostics (${diagnostics.length}/${total} included):`,
        diagnostics.join("\n\n"),
        total > diagnostics.length ? `\n${total - diagnostics.length} diagnostic(s) omitted by brassAgent.problemContextLimit.` : undefined,
    ].filter(Boolean).join("\n\n");
};

const problemAwarePrompt = (action: ProblemAction, target: ProblemTarget, tail?: string): string => {
    const label = target === "current-file" ? "current file" : "workspace";
    return [
        action === "fix"
            ? `Fix the VS Code diagnostics for the ${label}. Prefer a minimal, safe patch and explain the change.`
            : `Explain the VS Code diagnostics for the ${label}. Prioritize root cause, likely files, and safest next steps.`,
        tail?.trim() ? `Additional user request: ${tail.trim()}` : undefined,
        "",
        diagnosticsPromptText(target),
    ].filter(Boolean).join("\n");
};

const runLabel = (entry: RunHistoryEntry): string => {
    const prefix = entry.status === "done" ? "$(check)" : entry.status === "cancelled" ? "$(circle-slash)" : entry.status === "failed" ? "$(error)" : "$(history)";
    if (entry.mode === "batch") return `${prefix} batch: ${entry.goal}`;
    return `${prefix} ${entry.goal}`;
};

const humanDate = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const shortPath = (value: string): string => {
    const folder = vscode.workspace.workspaceFolders?.find((candidate) => value.startsWith(candidate.uri.fsPath));
    if (!folder) return value;
    const relative = path.relative(folder.uri.fsPath, value);
    return relative ? path.join(folder.name, relative) : folder.name;
};

const summaryFromState = (state: any): string | undefined => {
    const observations = Array.isArray(state?.observations) ? state.observations : [];
    const done = [...observations].reverse().find((observation: any) => observation?.type === "agent.done");
    if (typeof done?.summary === "string" && done.summary.trim()) return done.summary;
    return undefined;
};

const errorFromState = (state: any): string | undefined => {
    const observations = Array.isArray(state?.observations) ? state.observations : [];
    const error = [...observations].reverse().find((observation: any) => observation?.type === "agent.error");
    if (!error) return undefined;
    try {
        return JSON.stringify(error.error, null, 2);
    } catch {
        return String(error.error ?? "unknown error");
    }
};

const compactText = (value: string | undefined, maxChars = 4000): string | undefined => {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, maxChars)}\n… truncated ${trimmed.length - maxChars} chars`;
};

const latestValidationFromState = (state: any): string | undefined => {
    const observations = Array.isArray(state?.observations) ? state.observations : [];
    const shell = [...observations].reverse().find((observation: any) => observation?.type === "shell.result");
    if (!shell) return undefined;

    const command = Array.isArray(shell.command) ? shell.command.join(" ") : "shell";
    const stdout = compactText(shell.stdout, 2000);
    const stderr = compactText(shell.stderr, 2000);
    return compactText([
        `Command: ${command}`,
        `Exit code: ${shell.exitCode}`,
        stdout ? `stdout:\n${stdout}` : undefined,
        stderr ? `stderr:\n${stderr}` : undefined,
    ].filter(Boolean).join("\n\n"), 4500);
};

const patchStatsSummary = (stats?: PatchStats): string | undefined => {
    if (!stats) return undefined;
    const files = stats.files.length ? ` files: ${stats.files.slice(0, 8).join(", ")}${stats.files.length > 8 ? ", …" : ""}` : "";
    return `${stats.files.length} file(s), +${stats.added}/-${stats.removed}.${files}`;
};

const statusFromRun = (result: CliRunResult | undefined): HistoryStatus => {
    if (!result) return "unknown";
    if (result.cancelled) return "cancelled";
    if (result.batchSummary) return result.batchSummary.exitCode === 0 ? "done" : "failed";
    const phase = result.finalState?.phase;
    if (phase === "done") return "done";
    if (phase === "failed") return "failed";
    if (result.exitCode && result.exitCode !== 0) return "failed";
    return typeof phase === "string" ? phase : "unknown";
};

const appendEvent = (event: any) => {
    switch (event?.type) {
        case "agent.run.started":
            output.appendLine(`brass-agent ${event.goal?.mode ?? ""}`.trim());
            output.appendLine(`workspace: ${event.goal?.cwd ?? ""}`);
            output.appendLine(`goal: ${event.goal?.text ?? ""}`);
            output.appendLine("");
            status.text = "$(sync~spin) Brass Agent running";
            break;
        case "agent.action.started":
            output.appendLine(`→ ${summarizeAction(event.action)}`);
            break;
        case "agent.action.completed":
            output.appendLine(`${statusIcon(event.observation)} ${summarizeObservation(event.observation)} ${event.durationMs ?? 0}ms`);
            break;
        case "agent.action.failed":
            output.appendLine(`✗ ${summarizeAction(event.action)} failed with ${event.error?._tag ?? "error"} ${event.durationMs ?? 0}ms`);
            break;
        case "agent.permission.denied":
            output.appendLine(`✗ ${summarizeAction(event.action)} denied: ${event.reason}`);
            break;
        case "agent.approval.requested":
            output.appendLine(`? approval required for ${summarizeAction(event.action)} (${event.risk})`);
            break;
        case "agent.approval.resolved":
            output.appendLine(`${event.approved ? "✓" : "✗"} approval ${event.approved ? "granted" : "rejected"} for ${summarizeAction(event.action)}${event.reason ? `: ${event.reason}` : ""}`);
            break;
        case "agent.patch.applied":
            output.appendLine(`✓ patch applied (${(event.changedFiles ?? []).join(", ") || "no files reported"})`);
            break;
        case "agent.patch.rolledBack":
            output.appendLine(`✓ patch rolled back (${(event.changedFiles ?? []).join(", ") || "no files reported"})`);
            break;
        case "agent.run.completed":
            output.appendLine("");
            output.appendLine(`completed: ${event.status} in ${event.durationMs ?? 0}ms`);
            status.text = event.status === "done" ? "$(check) Brass Agent done" : "$(error) Brass Agent failed";
            break;
    }
};

const appendFinalState = (state: any) => {
    output.appendLine("");
    output.appendLine(`phase: ${state?.phase ?? "unknown"}`);
    output.appendLine(`steps: ${state?.steps ?? 0}`);

    const summary = summaryFromState(state);
    const error = errorFromState(state);

    if (summary) {
        output.appendLine("");
        output.appendLine("summary:");
        output.appendLine(summary);
    } else if (error) {
        output.appendLine("");
        output.appendLine("error:");
        output.appendLine(error);
    }
};

const appendBatchSummary = (summary: BatchSummary) => {
    output.appendLine("");
    output.appendLine("batch summary:");
    output.appendLine(`completed: ${summary.completed}/${summary.total}`);
    output.appendLine(`failed: ${summary.failed}`);
    if (summary.stoppedEarly) output.appendLine("stopped early: yes");
    output.appendLine(`exit code: ${summary.exitCode}`);
    status.text = summary.exitCode === 0 ? "$(check) Brass Agent batch done" : "$(error) Brass Agent batch failed";
};

const handleProtocolLine = (
    line: string,
    onMessage?: (message: BrassProtocolMessage) => void
) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: BrassProtocolMessage;
    try {
        message = JSON.parse(trimmed) as BrassProtocolMessage;
    } catch {
        output.appendLine(trimmed);
        return;
    }

    if (message.protocol !== "brass-agent") {
        output.appendLine(trimmed);
        return;
    }

    onMessage?.(message);

    if (message.type === "event") appendEvent(message.event);
    if (message.type === "final-state") appendFinalState(message.state);
    if (message.type === "batch-summary" && message.summary) appendBatchSummary(message.summary);
    if (message.type === "error") output.appendLine(`protocol error: ${message.message ?? "unknown"}`);
};

const runCli = async (
    args: readonly string[],
    cwd: string,
    title = "Brass Agent",
    onProtocolMessage?: (message: BrassProtocolMessage) => void,
    options?: { readonly showOutput?: boolean }
): Promise<CliRunResult | undefined> => {
    if (currentProcess) {
        await vscode.window.showWarningMessage("A Brass Agent run is already active. Cancel it before starting another one.");
        return undefined;
    }

    let finalState: any | undefined;
    const finalStates: any[] = [];
    let batchSummary: BatchSummary | undefined;
    let exitCode: number | null | undefined;
    let signal: NodeJS.Signals | null | undefined;
    let cancelled = false;

    const cli = await resolveCliCommand(cwd);
    const environment = await cliEnvironment();

    if (options?.showOutput !== false) output.show(true);
    output.appendLine(`CLI: ${describeResolvedCli(cli)}`);
    output.appendLine(`$ ${cli.label} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
    output.appendLine("");

    await setRunningContext(true);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: true,
        },
        (_progress, token) => new Promise<void>((resolve) => {
            const child = spawn(cli.command, [...cli.argsPrefix, ...args], {
                cwd,
                shell: process.platform === "win32" && cli.argsPrefix.length === 0,
                env: {
                    ...environment,
                    BRASS_AGENT_VSCODE_CLI_SOURCE: cli.source,
                    ...(cli.envPatch ?? {}),
                },
            });

            currentProcess = child;
            status.show();
            status.text = "$(sync~spin) Brass Agent running";

            token.onCancellationRequested(() => {
                cancelled = true;
                output.appendLine("\nCancelling Brass Agent...");
                child.kill("SIGTERM");
            });

            readline.createInterface({ input: child.stdout }).on("line", (line) =>
                handleProtocolLine(line, (message) => {
                    if (message.type === "final-state") {
                        finalState = message.state;
                        finalStates.push(message.state);
                    }
                    if (message.type === "batch-summary") batchSummary = message.summary;
                    onProtocolMessage?.(message);
                })
            );
            readline.createInterface({ input: child.stderr }).on("line", (line) => output.appendLine(`[stderr] ${line}`));

            child.on("error", async (error) => {
                exitCode = 1;
                output.appendLine(`Failed to start ${cli.label}: ${String(error)}`);
                status.text = "$(error) Brass Agent failed";
                const action = await vscode.window.showErrorMessage(
                    `Failed to start Brass Agent (${cli.source}).`,
                    "Configure CLI",
                    "Show Output"
                );
                if (action === "Configure CLI") await vscode.commands.executeCommand("brassAgent.configureCli");
                if (action === "Show Output") output.show(true);
                currentProcess = undefined;
                void setRunningContext(false);
                resolve();
            });

            child.on("close", (code, childSignal) => {
                exitCode = code;
                signal = childSignal;
                output.appendLine("");
                output.appendLine(`process exited with ${code ?? childSignal ?? "unknown"}`);
                if (cancelled) status.text = "$(circle-slash) Brass Agent cancelled";
                else if (code && code !== 0) status.text = "$(error) Brass Agent failed";
                currentProcess = undefined;
                void setRunningContext(false);
                resolve();
            });
        })
    );

    return { finalState, finalStates, batchSummary, exitCode, signal, cancelled };
};

const extractProposedPatch = (state: any): string | undefined => {
    const observations = Array.isArray(state?.observations) ? state.observations : [];
    const proposed = [...observations].reverse().find((observation: any) => observation?.type === "patch.proposed");
    return typeof proposed?.patch === "string" && proposed.patch.trim() ? proposed.patch : undefined;
};

const diffStats = (patch: string): PatchStats => {
    const files = new Set<string>();
    let added = 0;
    let removed = 0;

    for (const line of patch.split("\n")) {
        if (line.startsWith("+++ b/")) files.add(line.slice("+++ b/".length));
        else if (line.startsWith("--- a/")) files.add(line.slice("--- a/".length));
        else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }

    return { added, removed, files: [...files].sort() };
};

const createHistoryEntry = (options: {
    readonly startedAt: Date;
    readonly completedAt: Date;
    readonly cwd: string;
    readonly goal: string;
    readonly mode: HistoryRunMode;
    readonly result?: CliRunResult;
    readonly patch?: string;
    readonly batchFile?: string;
    readonly batchSummary?: BatchSummary;
    readonly children?: readonly RunHistoryEntry[];
}): RunHistoryEntry => {
    const maybePatch = configuredStorePatchesInHistory() ? options.patch : undefined;
    const summary = summaryFromState(options.result?.finalState);
    const error = errorFromState(options.result?.finalState);

    return {
        id: `${options.startedAt.getTime()}-${Math.random().toString(36).slice(2)}`,
        startedAt: options.startedAt.toISOString(),
        completedAt: options.completedAt.toISOString(),
        cwd: options.cwd,
        goal: options.goal,
        mode: options.mode,
        status: statusFromRun(options.result),
        steps: typeof options.result?.finalState?.steps === "number" ? options.result.finalState.steps : undefined,
        durationMs: Math.max(0, options.completedAt.getTime() - options.startedAt.getTime()),
        summary,
        error,
        exitCode: options.result?.exitCode,
        signal: options.result?.signal ?? undefined,
        patch: maybePatch,
        patchStats: maybePatch ? diffStats(maybePatch) : undefined,
        ...(options.batchFile ? { batchFile: options.batchFile } : {}),
        ...(options.batchSummary ? { batchSummary: options.batchSummary } : {}),
        ...(options.children ? { children: options.children } : {}),
    };
};

const modeFromState = (state: any): HistoryRunMode => {
    const mode = state?.goal?.mode;
    if (mode === "read-only") return "read-only";
    if (mode === "write" || mode === "autonomous") return "apply";
    return "propose";
};

const extractStoredPatch = (state: any): string | undefined => {
    const observations = Array.isArray(state?.observations) ? state.observations : [];
    const withPatch = [...observations].reverse().find((observation: any) =>
        (observation?.type === "patch.proposed" || observation?.type === "patch.applied" || observation?.type === "patch.rolledBack") &&
        typeof observation.patch === "string" &&
        observation.patch.trim()
    );
    return typeof withPatch?.patch === "string" ? withPatch.patch : undefined;
};

const createHistoryEntryFromState = (options: {
    readonly state: any;
    readonly startedAt: Date;
    readonly completedAt: Date;
    readonly fallbackCwd: string;
    readonly fallbackGoal: string;
    readonly idSuffix: string;
}): RunHistoryEntry => {
    const patch = extractStoredPatch(options.state);
    const result: CliRunResult = {
        finalState: options.state,
        finalStates: [options.state],
        exitCode: options.state?.phase === "done" ? 0 : 1,
        cancelled: false,
    };

    return {
        ...createHistoryEntry({
            startedAt: options.startedAt,
            completedAt: options.completedAt,
            cwd: options.state?.goal?.cwd ?? options.fallbackCwd,
            goal: options.state?.goal?.text ?? options.fallbackGoal,
            mode: modeFromState(options.state),
            result,
            patch,
        }),
        id: `${options.startedAt.getTime()}-${options.idSuffix}`,
    };
};

const escapeHtml = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const nonce = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36);

type PatchFileSection = {
    readonly displayPath: string;
    readonly oldPath?: string;
    readonly newPath?: string;
    readonly patch: string;
    readonly added: number;
    readonly removed: number;
    readonly hunks: number;
};

const cleanPatchPath = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "/dev/null") return undefined;
    const withoutTimestamp = trimmed.split(/\s+/)[0] ?? trimmed;
    return withoutTimestamp.replace(/^[ab]\//, "");
};

const parsePatchFileSections = (patch: string): readonly PatchFileSection[] => {
    const sections: { oldPath?: string; newPath?: string; lines: string[] }[] = [];
    let current: { oldPath?: string; newPath?: string; lines: string[] } | undefined;

    const start = (line: string) => {
        if (current?.lines.length) sections.push(current);
        current = { lines: [line] };
    };

    for (const line of patch.split("\n")) {
        if (line.startsWith("diff --git ")) {
            start(line);
            continue;
        }
        if (!current) current = { lines: [] };
        current.lines.push(line);
        if (line.startsWith("--- ")) current.oldPath = cleanPatchPath(line.slice(4));
        if (line.startsWith("+++ ")) current.newPath = cleanPatchPath(line.slice(4));
    }
    if (current?.lines.length) sections.push(current);

    return sections.map((section, index) => {
        let added = 0;
        let removed = 0;
        let hunks = 0;
        for (const line of section.lines) {
            if (line.startsWith("@@")) hunks += 1;
            else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
            else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
        }
        return {
            oldPath: section.oldPath,
            newPath: section.newPath,
            displayPath: section.newPath ?? section.oldPath ?? `patch-section-${index + 1}`,
            patch: section.lines.join("\n"),
            added,
            removed,
            hunks,
        } satisfies PatchFileSection;
    });
};

const patchLineClass = (line: string): string => {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+") && !line.startsWith("+++")) return "add";
    if (line.startsWith("-") && !line.startsWith("---")) return "del";
    if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) return "meta";
    return "ctx";
};

const resolvePatchFilePath = (cwd: string, file: string): string | undefined => {
    const cleaned = cleanPatchPath(file);
    if (!cleaned) return undefined;
    const absolute = path.resolve(cwd, cleaned);
    const relative = path.relative(cwd, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return absolute;
};

const patchPreviewHtml = (webview: vscode.Webview, preview: PatchPreview): string => {
    const id = nonce();
    const stats = diffStats(preview.patch);
    const files = parsePatchFileSections(preview.patch);
    const fileNav = files.map((file, index) => `
        <a href="#file-${index}">${escapeHtml(file.displayPath)}</a>
    `).join("");
    const fileCards = files.map((file, index) => {
        const lines = file.patch.split("\n").map((line) =>
            `<div class="line ${patchLineClass(line)}"><span class="marker">${escapeHtml(line.slice(0, 1) || " ")}</span><span class="code">${escapeHtml(line)}</span></div>`
        ).join("");
        return `
            <details class="file" id="file-${index}" open>
                <summary>
                    <span class="file-name">${escapeHtml(file.displayPath)}</span>
                    <span class="file-stat add">+${file.added}</span>
                    <span class="file-stat del">-${file.removed}</span>
                    <span class="file-stat">${file.hunks} hunk(s)</span>
                    <span class="spacer"></span>
                    <button class="mini" data-open-file="${index}" type="button">Open</button>
                    <button class="mini" data-copy-file="${index}" type="button">Copy file patch</button>
                </summary>
                <pre class="diff">${lines}</pre>
            </details>
        `;
    }).join("");

    const filePayload = JSON.stringify(files.map((file) => ({ path: file.displayPath, patch: file.patch })));

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${id}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Brass Agent Patch Preview</title>
<style>
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
main { padding: 16px 20px 96px; }
footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 20px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 8px 12px; cursor: pointer; border-radius: 3px; }
button.secondary, button.mini { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.mini { padding: 4px 8px; font-size: 11px; margin-left: 6px; }
.meta { color: var(--vscode-descriptionForeground); }
.stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.stat { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; border-radius: 999px; }
.add { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
.del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
.nav { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.nav a { color: var(--vscode-textLink-foreground); text-decoration: none; border: 1px solid var(--vscode-panel-border); padding: 3px 7px; border-radius: 999px; }
.file { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 14px; overflow: hidden; background: var(--vscode-editor-background); }
summary { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 9px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
.file-name { font-weight: 600; word-break: break-all; }
.file-stat { font-size: 11px; color: var(--vscode-descriptionForeground); }
.spacer { flex: 1; }
.diff { margin: 0; overflow: auto; background: var(--vscode-textCodeBlock-background); }
.line { display: grid; grid-template-columns: 24px minmax(max-content, 1fr); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size); line-height: 1.45; white-space: pre; }
.line .marker { color: var(--vscode-descriptionForeground); text-align: center; user-select: none; }
.line.add { background: rgba(63, 185, 80, 0.12); }
.line.del { background: rgba(248, 81, 73, 0.12); }
.line.hunk { background: rgba(88, 166, 255, 0.16); color: var(--vscode-textLink-foreground); }
.line.meta { color: var(--vscode-descriptionForeground); }
.empty { border: 1px dashed var(--vscode-panel-border); padding: 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
<h1>Brass Agent Patch Preview</h1>
<div class="meta">${escapeHtml(preview.cwd)}</div>
<div class="meta">Goal: ${escapeHtml(preview.goal)}</div>
<div class="stats">
  <span class="stat"><strong>${stats.files.length}</strong> file(s)</span>
  <span class="stat add"><strong>+${stats.added}</strong> added</span>
  <span class="stat del"><strong>-${stats.removed}</strong> removed</span>
</div>
<div class="nav">${fileNav || ""}</div>
</header>
<main>
${fileCards || `<div class="empty">No file sections detected in this patch.</div><pre class="diff">${escapeHtml(preview.patch)}</pre>`}
</main>
<footer>
<button id="apply">Apply Patch</button>
<button id="copy" class="secondary">Copy Full Patch</button>
<button id="collapse" class="secondary">Collapse All</button>
<button id="expand" class="secondary">Expand All</button>
<button id="close" class="secondary">Close</button>
</footer>
<script nonce="${id}">
const vscode = acquireVsCodeApi();
const files = ${filePayload};
document.getElementById('apply').addEventListener('click', () => vscode.postMessage({ type: 'apply' }));
document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
document.getElementById('collapse').addEventListener('click', () => document.querySelectorAll('details.file').forEach((node) => node.open = false));
document.getElementById('expand').addEventListener('click', () => document.querySelectorAll('details.file').forEach((node) => node.open = true));
document.addEventListener('click', (event) => {
  const openButton = event.target.closest('[data-open-file]');
  if (openButton) {
    const file = files[Number(openButton.getAttribute('data-open-file'))];
    vscode.postMessage({ type: 'openFile', file: file?.path });
    return;
  }
  const copyButton = event.target.closest('[data-copy-file]');
  if (copyButton) {
    const file = files[Number(copyButton.getAttribute('data-copy-file'))];
    vscode.postMessage({ type: 'copyFilePatch', patch: file?.patch });
  }
});
</script>
</body>
</html>`;
};

const markdownFence = (value: string, language = ""): string => `\`\`\`${language}\n${value.replace(/\`\`\`/g, "``\\`")}\n\`\`\``;
const escapeMarkdownTableCell = (value: unknown): string =>
    String(value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, " ");

const runDetailsMarkdown = (entry: RunHistoryEntry): string => {
    const stats = entry.patchStats;
    const lines = [
        `# Brass Agent Run`,
        ``,
        `| Field | Value |`,
        `| --- | --- |`,
        `| Status | ${entry.status} |`,
        `| Mode | ${entry.mode} |`,
        `| Goal | ${escapeMarkdownTableCell(entry.goal)} |`,
        `| Workspace | ${escapeMarkdownTableCell(entry.cwd)} |`,
        `| Started | ${humanDate(entry.startedAt)} |`,
        `| Completed | ${humanDate(entry.completedAt)} |`,
        `| Duration | ${entry.durationMs}ms |`,
        `| Steps | ${entry.steps ?? "unknown"} |`,
        `| Exit | ${entry.exitCode ?? entry.signal ?? "unknown"} |`,
        ``,
    ];

    if (entry.summary) {
        lines.push(`## Summary`, ``, entry.summary, ``);
    }

    if (entry.error) {
        lines.push(`## Error`, ``, markdownFence(entry.error, "json"), ``);
    }

    if (entry.batchSummary) {
        lines.push(
            `## Batch summary`,
            ``,
            `- Total: ${entry.batchSummary.total}`,
            `- Completed: ${entry.batchSummary.completed}`,
            `- Failed: ${entry.batchSummary.failed}`,
            `- Exit code: ${entry.batchSummary.exitCode}`,
            `- Stopped early: ${entry.batchSummary.stoppedEarly ? "yes" : "no"}`,
            ``
        );
    }

    if (entry.children?.length) {
        lines.push(`## Batch runs`, ``);
        for (const child of entry.children) {
            lines.push(`- **${child.status}** · ${child.mode} · ${child.goal}`);
        }
        lines.push("");
    }

    if (entry.patch) {
        lines.push(
            `## Patch`,
            ``,
            `${stats?.added ?? 0} added, ${stats?.removed ?? 0} removed, ${(stats?.files ?? []).length} file(s).`,
            ``,
            markdownFence(entry.patch, "diff"),
            ""
        );
    }

    return lines.join("\n");
};

class RunHistoryProvider implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<HistoryNode | undefined | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private readonly context: vscode.ExtensionContext) { }

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    entries(): readonly RunHistoryEntry[] {
        return this.context.workspaceState.get<RunHistoryEntry[]>(HISTORY_KEY, []);
    }

    async add(entry: RunHistoryEntry): Promise<void> {
        const next = [entry, ...this.entries()].slice(0, configuredHistoryLimit());
        await this.context.workspaceState.update(HISTORY_KEY, next);
        this.refresh();
    }

    async clear(): Promise<void> {
        await this.context.workspaceState.update(HISTORY_KEY, []);
        this.refresh();
    }

    getTreeItem(element: HistoryNode): vscode.TreeItem {
        if (element.kind === "detail") {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.description = element.description;
            item.iconPath = element.icon ? new vscode.ThemeIcon(element.icon) : undefined;
            item.contextValue = element.command ? "brassAgentRunDetailAction" : "brassAgentRunDetail";
            item.command = element.command;
            return item;
        }

        const item = new vscode.TreeItem(runLabel(element.entry), vscode.TreeItemCollapsibleState.Collapsed);
        item.id = element.entry.id;
        item.description = `${element.entry.mode} · ${humanDate(element.entry.startedAt)}`;
        item.tooltip = `${element.entry.goal}\n${element.entry.cwd}\n${element.entry.status} · ${element.entry.durationMs}ms`;
        item.contextValue = element.entry.mode === "batch"
            ? "brassAgentBatch"
            : element.entry.patch ? "brassAgentRunWithPatch" : "brassAgentRun";
        item.iconPath = new vscode.ThemeIcon(element.entry.mode === "batch" ? "list-tree" : element.entry.status === "done" ? "check" : element.entry.status === "cancelled" ? "circle-slash" : element.entry.status === "failed" ? "error" : "history");
        item.command = {
            title: "Open Run Details",
            command: "brassAgent.openHistoryRun",
            arguments: [element],
        };
        return item;
    }

    getChildren(element?: HistoryNode): Thenable<HistoryNode[]> {
        if (!element) {
            return Promise.resolve(this.entries().map((entry) => ({ kind: "run", entry }) satisfies HistoryNode));
        }

        if (element.kind === "detail") return Promise.resolve([]);

        const entry = element.entry;
        const childNodes = (entry.children ?? []).map((child) => ({ kind: "run", entry: child }) satisfies HistoryNode);
        const nodes: HistoryNode[] = [
            { kind: "detail", entry, label: "Status", description: entry.status, icon: entry.status === "done" ? "check" : entry.status === "failed" ? "error" : "info" },
            { kind: "detail", entry, label: "Mode", description: entry.mode, icon: "gear" },
            { kind: "detail", entry, label: "Workspace", description: shortPath(entry.cwd), icon: "folder" },
            { kind: "detail", entry, label: "Duration", description: `${entry.durationMs}ms`, icon: "watch" },
        ];

        if (entry.batchSummary) {
            nodes.push(
                { kind: "detail", entry, label: "Batch completed", description: `${entry.batchSummary.completed}/${entry.batchSummary.total}`, icon: "list-ordered" },
                { kind: "detail", entry, label: "Batch failed", description: String(entry.batchSummary.failed), icon: entry.batchSummary.failed ? "warning" : "check" },
            );
        }

        if (entry.steps !== undefined) nodes.push({ kind: "detail", entry, label: "Steps", description: String(entry.steps), icon: "list-ordered" });
        if (entry.patchStats) nodes.push({
            kind: "detail",
            entry,
            label: "Patch",
            description: `${entry.patchStats.files.length} files, +${entry.patchStats.added}/-${entry.patchStats.removed}`,
            icon: "diff",
            command: {
                title: "Show Patch",
                command: "brassAgent.showHistoryPatch",
                arguments: [{ kind: "run", entry } satisfies HistoryNode],
            },
        });
        if (entry.summary) nodes.push({ kind: "detail", entry, label: "Summary", description: entry.summary.split("\n")[0]?.slice(0, 80), icon: "note" });
        if (entry.error) nodes.push({ kind: "detail", entry, label: "Error", description: entry.error.split("\n")[0]?.slice(0, 80), icon: "warning" });

        return Promise.resolve([...childNodes, ...nodes]);
    }
}

const entryFromNode = (node?: HistoryNode | RunHistoryEntry): RunHistoryEntry | undefined => {
    if (!node) return undefined;
    if ((node as HistoryNode).kind === "run" || (node as HistoryNode).kind === "detail") return (node as HistoryNode).entry;
    return node as RunHistoryEntry;
};

const showRunDetails = async (node?: HistoryNode | RunHistoryEntry) => {
    const entry = entryFromNode(node);
    if (!entry) return;

    const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: runDetailsMarkdown(entry),
    });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
};

const showHistoryPatch = async (node?: HistoryNode | RunHistoryEntry) => {
    const entry = entryFromNode(node);
    if (!entry?.patch) {
        await vscode.window.showInformationMessage("This Brass Agent run does not have a stored patch.");
        return;
    }

    openPatchPreview({ cwd: entry.cwd, goal: entry.goal, patch: entry.patch });
};

const clearHistory = async () => {
    const answer = await vscode.window.showWarningMessage(
        "Clear Brass Agent run history for this workspace?",
        { modal: true },
        "Clear History"
    );
    if (answer !== "Clear History") return;
    await historyProvider.clear();
};


type ChatDraft = {
    readonly prompt: string;
    readonly mode: RunMode;
};

type InlineAssistIntent = "ask" | "explain" | "fix" | "refactor" | "tests" | "custom";

type InlineAssistInfo = {
    readonly cwd: string;
    readonly file: string;
    readonly language: string;
    readonly text: string;
    readonly rangeLabel: string;
    readonly hasSelection: boolean;
};

type SlashCommandResult =
    | { readonly type: "run"; readonly prompt: string; readonly mode: RunMode }
    | { readonly type: "clear" }
    | { readonly type: "doctor" }
    | { readonly type: "configure-llm" }
    | { readonly type: "configure-workspace" }
    | { readonly type: "project-dashboard" }
    | { readonly type: "open-chat-editor" }
    | { readonly type: "output" }
    | { readonly type: "open-last-patch" }
    | { readonly type: "apply-last" }
    | { readonly type: "rollback-last" }
    | { readonly type: "explain-last" }
    | { readonly type: "problems"; readonly action: ProblemAction; readonly target: ProblemTarget; readonly tail?: string }
    | { readonly type: "help" };

const chatModeLabel = (mode: RunMode): string => {
    if (mode === "read-only") return "Ask";
    if (mode === "apply") return "Apply after preview";
    return "Propose";
};

const FOLLOW_UP_PATTERNS = [
    /\b(why|what|how)\b.*\b(that|this|it|last|previous)\b/i,
    /\b(again|retry|continue|previous|last|above|same)\b/i,
    /\b(apply|rollback|explain)\b.*\b(last|previous|that|it)\b/i,
    /\b(por que|por qué|porque|que paso|qué pasó|eso|esto|ultimo|último|anterior|de nuevo|otra vez)\b/i,
    /\b(aplica|aplicar|reverti|revertir|explica|explicar)\b.*\b(ultimo|último|anterior|eso|esto)\b/i,
];

const looksLikeFollowUpPrompt = (prompt: string): boolean =>
    FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(prompt));

const compactChatContextText = (value: string | undefined, max = 1200): string | undefined =>
    value ? compactText(value, max) : undefined;

class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private panel?: vscode.WebviewPanel;
    private pendingDraft?: ChatDraft;
    private readonly clients = new Set<vscode.Webview>();
    private readonly disposables: vscode.Disposable[] = [];
    private messages: ChatSessionMessage[] = [];
    private lastRun: ChatLastRunContext | undefined;
    private lastPatch: PatchPreview | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        const stored = this.context.workspaceState.get<ChatSessionSnapshot>(CHAT_SESSION_KEY, { messages: [] });
        this.messages = [...(stored.messages ?? [])];
        this.lastRun = stored.lastRun;
        this.lastPatch = stored.lastPatch;
        if (stored.lastPatch) lastPatchPreview = stored.lastPatch;
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this.attachWebview(webviewView.webview);
        this.disposables.push(webviewView.onDidDispose(() => {
            this.clients.delete(webviewView.webview);
            if (this.view === webviewView) this.view = undefined;
        }));
        void maybePromptLlmSetup();
    }

    async openInEditor(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            await this.postSession();
            this.flushPendingDraft();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "brassAgent.chatPanel",
            "Brass Agent Chat",
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel = panel;
        this.attachWebview(panel.webview);
        panel.onDidDispose(() => {
            this.clients.delete(panel.webview);
            if (this.panel === panel) this.panel = undefined;
        }, undefined, this.disposables);
        void maybePromptLlmSetup();
    }

    revealDraft(prompt: string, mode: RunMode): void {
        this.pendingDraft = { prompt, mode };
        if (configuredChatDefaultLocation() === "editor") {
            void this.openInEditor();
        } else {
            void vscode.commands.executeCommand("brassAgent.chat.focus");
        }
        this.flushPendingDraft();
    }

    private attachWebview(webview: vscode.Webview): void {
        this.clients.add(webview);
        webview.options = { enableScripts: true };
        webview.html = this.html(webview);
        this.disposables.push(webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)));
        void this.postSession();
        this.flushPendingDraft();
    }

    private flushPendingDraft(): void {
        if (this.clients.size === 0 || !this.pendingDraft) return;
        this.post({ type: "draft", ...this.pendingDraft });
        this.pendingDraft = undefined;
    }

    private post(message: unknown): void {
        for (const client of this.clients) {
            void client.postMessage(message);
        }
    }

    private async postSession(): Promise<void> {
        this.post({
            type: "session",
            messages: this.messages,
            lastRun: this.lastRun,
            lastPatchStats: this.lastPatch ? diffStats(this.lastPatch.patch) : undefined,
            problemCounts: problemCounts(),
            llmStatus: await llmSetupStatus(),
        });
    }

    refreshProblemContext(): void {
        this.post({ type: "problemContext", problemCounts: problemCounts() });
    }

    async refreshLlmStatus(): Promise<void> {
        this.post({ type: "llmStatus", llmStatus: await llmSetupStatus() });
    }

    private async saveSession(): Promise<void> {
        const snapshot: ChatSessionSnapshot = {
            messages: this.messages.slice(-configuredChatHistoryLimit()),
            ...(this.lastRun ? { lastRun: this.lastRun } : {}),
            ...(configuredStorePatchesInHistory() && this.lastPatch ? { lastPatch: this.lastPatch } : {}),
        };
        await this.context.workspaceState.update(CHAT_SESSION_KEY, snapshot);
        this.post({
            type: "context",
            lastRun: this.lastRun,
            lastPatchStats: this.lastPatch ? diffStats(this.lastPatch.patch) : undefined,
            problemCounts: problemCounts(),
            llmStatus: await llmSetupStatus(),
        });
    }

    private async appendMessage(role: ChatMessageRole, text: string, options?: { readonly mode?: RunMode; readonly actions?: readonly string[] }): Promise<void> {
        const message: ChatSessionMessage = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role,
            text,
            at: new Date().toISOString(),
            ...(options?.mode ? { mode: options.mode } : {}),
            ...(options?.actions ? { actions: options.actions } : {}),
        };
        this.messages = [...this.messages, message].slice(-configuredChatHistoryLimit());
        this.post({ type: "chatMessage", message });
        await this.saveSession();
    }

    private async clearSession(): Promise<void> {
        this.messages = [];
        this.lastRun = undefined;
        this.lastPatch = undefined;
        lastPatchPreview = undefined;
        await this.context.workspaceState.update(CHAT_SESSION_KEY, { messages: [] } satisfies ChatSessionSnapshot);
        this.post({ type: "chatCleared" });
        void this.postSession();
    }

    private async handleWebviewMessage(message: any): Promise<void> {
        switch (message?.type) {
            case "run":
                await this.run(String(message.prompt ?? ""), this.parseMode(message.mode));
                return;
            case "openOutput":
                output.show(true);
                return;
            case "openLastPatch":
                await this.openLastPatch();
                return;
            case "openInEditor":
                await this.openInEditor();
                return;
            case "quickPrompt":
                this.revealDraft(String(message.prompt ?? ""), this.parseMode(message.mode));
                return;
            case "configureLlm":
                await configureLlm();
                return;
            case "configureWorkspace":
                await configureWorkspace();
                return;
        }
    }

    private parseMode(value: unknown): RunMode {
        if (value === "apply") return "apply";
        if (value === "read-only") return "read-only";
        return "propose";
    }

    private parseSlashCommand(input: string, selectedMode: RunMode): SlashCommandResult | undefined {
        const trimmed = input.trim();
        if (!trimmed.startsWith("/")) return undefined;
        const [rawCommand, ...rest] = trimmed.split(/\s+/);
        const command = rawCommand.toLowerCase();
        const tail = rest.join(" ").trim();

        switch (command) {
            case "/inspect":
                return { type: "run", prompt: tail || "inspect this workspace", mode: "read-only" };
            case "/fix-tests":
            case "/fix":
                return { type: "run", prompt: tail || "fix the failing tests", mode: "apply" };
            case "/typecheck":
                return { type: "run", prompt: tail || "run typecheck discovery and fix type errors if possible", mode: "apply" };
            case "/lint":
                return { type: "run", prompt: tail || "run lint discovery and fix lint errors if possible", mode: "apply" };
            case "/problems":
            case "/explain-problems":
                return { type: "problems", action: "explain", target: "workspace", tail };
            case "/fix-problems":
                return { type: "problems", action: "fix", target: "workspace", tail };
            case "/current-file-problems":
            case "/explain-current-file":
                return { type: "problems", action: "explain", target: "current-file", tail };
            case "/fix-current-file":
            case "/fix-file":
                return { type: "problems", action: "fix", target: "current-file", tail };
            case "/ask":
                return { type: "run", prompt: tail || "inspect this workspace", mode: "read-only" };
            case "/propose":
                return { type: "run", prompt: tail || "propose a safe patch for the current issue", mode: "propose" };
            case "/apply":
                return { type: "run", prompt: tail || "fix the current issue", mode: "apply" };
            case "/model":
            case "/setup":
            case "/configure-model":
                return { type: "configure-llm" };
            case "/workspace":
            case "/config":
            case "/configure-workspace":
            case "/init":
                return { type: "configure-workspace" };
            case "/project":
            case "/dashboard":
                return { type: "project-dashboard" };
            case "/focus":
            case "/editor":
            case "/chat-editor":
                return { type: "open-chat-editor" };
            case "/doctor":
                return { type: "doctor" };
            case "/output":
                return { type: "output" };
            case "/clear":
                return { type: "clear" };
            case "/last-patch":
            case "/patch":
            case "/open-last":
                return { type: "open-last-patch" };
            case "/apply-last":
                return { type: "apply-last" };
            case "/rollback-last":
                return { type: "rollback-last" };
            case "/explain-last":
                return { type: "explain-last" };
            case "/help":
            case "/commands":
                return { type: "help" };
            default:
                return { type: "run", prompt: trimmed, mode: selectedMode };
        }
    }

    private async run(prompt: string, mode: RunMode): Promise<void> {
        const trimmed = prompt.trim();
        if (!trimmed) return;

        const slash = this.parseSlashCommand(trimmed, mode);
        if (slash) {
            await this.handleSlashCommand(trimmed, slash);
            return;
        }

        await this.runPrompt(trimmed, mode);
    }

    private async handleSlashCommand(original: string, command: SlashCommandResult): Promise<void> {
        switch (command.type) {
            case "run":
                await this.runPrompt(command.prompt, command.mode, original, { usePreviousContext: false });
                return;
            case "problems":
                await this.runPrompt(
                    problemAwarePrompt(command.action, command.target, command.tail),
                    command.action === "fix" ? "apply" : "read-only",
                    original,
                    { usePreviousContext: false }
                );
                return;
            case "clear":
                await this.clearSession();
                return;
            case "configure-llm":
                await this.appendMessage("user", original, { mode: "read-only" });
                await configureLlm();
                await this.appendMessage("assistant", "Model configuration updated. Use `/doctor` to validate the setup.", { actions: ["openOutput"] });
                this.post({ type: "runFinished", status: "done" });
                return;
            case "configure-workspace":
                await this.appendMessage("user", original, { mode: "read-only" });
                await configureWorkspace();
                await this.appendMessage("assistant", "Workspace config updated. Use `/doctor` or `/inspect` to verify the setup.", { actions: ["openOutput", "quickInspect"] });
                this.post({ type: "runFinished", status: "done" });
                return;
            case "project-dashboard":
                await this.appendMessage("user", original, { mode: "read-only" });
                await vscode.commands.executeCommand("brassAgent.openProjectDashboard");
                await this.appendMessage("assistant", "Opened the Project dashboard.");
                this.post({ type: "runFinished", status: "done" });
                return;
            case "open-chat-editor":
                await this.appendMessage("user", original, { mode: "read-only" });
                await this.openInEditor();
                await this.appendMessage("assistant", "Opened the chat in a full editor tab. Use it for longer Brass Agent sessions or move it to another editor group.");
                this.post({ type: "runFinished", status: "done" });
                return;
            case "doctor":
                await this.appendMessage("user", original, { mode: "read-only" });
                await this.appendMessage("assistant", "Running Brass Agent doctor. Check the Output panel for details.", { actions: ["openOutput"] });
                await runDoctor();
                this.post({ type: "runFinished", status: "done" });
                return;
            case "output":
                output.show(true);
                this.post({ type: "runFinished", status: "done" });
                return;
            case "open-last-patch":
            case "apply-last":
                await this.appendMessage("user", original, { mode: "apply" });
                await this.openLastPatch(true);
                this.post({ type: "runFinished", status: "done" });
                return;
            case "rollback-last":
                await this.appendMessage("user", original, { mode: "apply" });
                await this.rollbackLastPatch();
                this.post({ type: "runFinished", status: "done" });
                return;
            case "explain-last":
                await this.appendMessage("user", original, { mode: "read-only" });
                await this.explainLastRun();
                this.post({ type: "runFinished", status: "done" });
                return;
            case "help":
                await this.appendMessage("user", original, { mode: "read-only" });
                await this.appendMessage("assistant", [
                    "Available slash commands:",
                    "",
                    "- `/inspect` — inspect this workspace in read-only mode",
                    "- `/fix-tests` — propose a fix for failing tests and preview any patch",
                    "- `/typecheck` — investigate type errors and preview any patch",
                    "- `/lint` — investigate lint errors and preview any patch",
                    "- `/problems` — explain current VS Code workspace diagnostics",
                    "- `/fix-problems` — fix current VS Code workspace diagnostics",
                    "- `/fix-current-file` — fix diagnostics in the active editor",
                    "- `/ask <question>` — ask a read-only question",
                    "- `/propose <task>` — generate a patch proposal without writing",
                    "- `/apply <task>` — generate a proposal and apply only after preview approval",
                    "- `/explain-last` — explain the previous run/patch",
                    "- `/apply-last` — reopen the last patch preview",
                    "- `/rollback-last` — rollback the last stored patch through brass-agent",
                    "- `/model` — configure the LLM provider and API keys stored in VS Code Secret Storage",
                    "- `/workspace` or `/config` — create/update `.brass-agent.json` from VS Code",
                    "- `/project` — open the Project dashboard",
                    "- `/focus` — open this chat in a larger editor tab",
                    "- `/doctor` — run setup diagnostics",
                    "- `/clear` — clear this chat session",
                ].join("\n"), { actions: ["quickInspect", "quickFixTests"] });
                this.post({ type: "runFinished", status: "done" });
                return;
        }
    }

    private async runPrompt(
        prompt: string,
        mode: RunMode,
        originalPrompt = prompt,
        options?: { readonly forceContext?: boolean; readonly includePatch?: boolean; readonly usePreviousContext?: boolean }
    ): Promise<void> {
        const cwd = workspaceCwd();
        if (!cwd) {
            await vscode.window.showWarningMessage("Open a workspace folder before running Brass Agent.");
            return;
        }

        await this.appendMessage("user", originalPrompt, { mode });
        this.post({ type: "runStarted", prompt: originalPrompt, mode, cwd });

        try {
            const agentGoal = this.composeAgentGoal(prompt, {
                forceContext: options?.forceContext,
                includePatch: options?.includePatch,
                usePreviousContext: options?.usePreviousContext,
            });
            const outcome = await runBrassAgentGoal(mode, cwd, agentGoal, {
                showOutput: false,
                openPatchPreviewOnPatch: false,
                historyGoal: originalPrompt,
                onProtocolMessage: (protocolMessage) => this.handleProtocol(protocolMessage),
            });

            const patch = outcome?.patch;
            const result = outcome?.result;
            const finalState = result?.finalState;
            const statusValue = statusFromRun(result);
            const summary = summaryFromState(finalState);
            const error = errorFromState(finalState);
            const validation = latestValidationFromState(finalState);
            const patchStats = patch ? diffStats(patch) : undefined;

            this.lastRun = {
                cwd,
                goal: originalPrompt,
                mode,
                status: statusValue,
                ...(summary ? { summary: compactText(summary, 2500) } : {}),
                ...(error ? { error: compactText(error, 2500) } : {}),
                ...(validation ? { validation } : {}),
                ...(patchStats ? { patchStats } : {}),
                completedAt: new Date().toISOString(),
            };

            if (patch && mode !== "read-only") {
                this.lastPatch = { cwd, goal: originalPrompt, patch };
                lastPatchPreview = this.lastPatch;
                this.post({ type: "patch", stats: patchStats });
            }

            const assistantText = summary
                ? summary
                : error
                    ? `Run finished with an error:\n\n${error}`
                    : `Run finished with status: ${statusValue}`;

            await this.appendMessage("assistant", assistantText, {
                actions: patch ? ["openPatch", "explainLast", "rollbackLast"] : ["explainLast"],
            });
            await this.saveSession();

            this.post({
                type: "runFinished",
                status: statusValue,
                summary,
                error,
                hasPatch: Boolean(patch),
            });
        } catch (error) {
            await this.appendMessage("assistant", `Run failed:\n\n${String(error)}`, { actions: ["openOutput"] });
            this.post({ type: "runFailed", error: String(error) });
        }
    }

    private composeAgentGoal(
        prompt: string,
        options?: { readonly forceContext?: boolean; readonly includePatch?: boolean; readonly usePreviousContext?: boolean }
    ): string {
        const hasContext = Boolean(this.lastRun || this.lastPatch);
        if (!hasContext) return prompt;

        const shouldUseContext = options?.forceContext === true
            || (options?.usePreviousContext !== false && looksLikeFollowUpPrompt(prompt));

        if (!shouldUseContext) return prompt;

        const context: string[] = [];
        if (this.lastRun) {
            const summary = compactChatContextText(this.lastRun.summary, 1200);
            const error = compactChatContextText(this.lastRun.error, 1000);
            const validation = compactChatContextText(this.lastRun.validation, 1500);
            context.push(
                "Previous Brass Agent run:",
                `- goal: ${compactChatContextText(this.lastRun.goal, 280) ?? this.lastRun.goal}`,
                `- mode: ${this.lastRun.mode}`,
                `- status: ${this.lastRun.status}`,
                summary ? `- summary: ${summary}` : "",
                error ? `- error: ${error}` : "",
                validation ? `- latest validation:\n${validation}` : "",
                this.lastRun.patchStats ? `- patch: ${patchStatsSummary(this.lastRun.patchStats)}` : "",
            );
        }

        if (this.lastPatch) {
            const stats = diffStats(this.lastPatch.patch);
            context.push(`Last patch available: ${patchStatsSummary(stats) ?? "yes"}`);
            if (options?.includePatch) {
                context.push("Last patch unified diff:", "```diff", compactText(this.lastPatch.patch, 8000) ?? "", "```");
            }
        }

        return [
            "User request:",
            prompt,
            "",
            "Relevant previous Brass Agent chat context follows. Use it only for follow-up intent; do not repeat it as the current user request.",
            "",
            context.filter(Boolean).join("\n"),
        ].filter(Boolean).join("\n");
    }

    private async openLastPatch(showMessage = false): Promise<void> {
        const preview = this.lastPatch ?? lastPatchPreview;
        if (preview) {
            openPatchPreview(preview);
            if (showMessage) await this.appendMessage("assistant", "Opened the last patch preview. Review the exact diff before applying.", { actions: ["openPatch", "explainLast"] });
            return;
        }
        await this.appendMessage("assistant", "No patch is available in this chat session yet.");
    }

    private async rollbackLastPatch(): Promise<void> {
        const preview = this.lastPatch ?? lastPatchPreview;
        if (!preview) {
            await this.appendMessage("assistant", "No patch is available to rollback in this chat session yet.");
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            "Rollback the last stored Brass Agent patch through brass-agent?",
            { modal: true },
            "Rollback Patch"
        );
        if (answer !== "Rollback Patch") {
            await this.appendMessage("assistant", "Rollback cancelled.");
            return;
        }

        await rollbackPreviewedPatch(preview);
        await this.appendMessage("assistant", "Rollback command finished. Check Run History or Output for the validation result.", { actions: ["openOutput"] });
    }

    private async explainLastRun(): Promise<void> {
        if (!this.lastRun) {
            await this.appendMessage("assistant", "No previous Brass Agent run is available yet. Try `/inspect` or `/fix-tests` first.", { actions: ["quickInspect", "quickFixTests"] });
            return;
        }

        const lines = [
            `Last run: ${this.lastRun.goal}`,
            `Mode: ${this.lastRun.mode}`,
            `Status: ${this.lastRun.status}`,
            "",
        ];

        if (this.lastRun.summary) {
            lines.push("Summary:", this.lastRun.summary, "");
        }

        if (this.lastRun.error) {
            lines.push(
                "What happened:",
                "The previous run stopped with an agent/tool error before it could complete normally.",
                "",
                "Error:",
                this.lastRun.error,
                ""
            );
        }

        if (this.lastRun.validation) {
            lines.push("Latest validation output:", this.lastRun.validation, "");
        }

        if (this.lastRun.patchStats) {
            lines.push(`Patch: ${patchStatsSummary(this.lastRun.patchStats) ?? "available"}`, "");
        }

        if (this.lastPatch) {
            lines.push("A patch is still available in this chat session. Use `Open patch preview` to review the exact diff.", "");
        }

        lines.push(
            "Next steps:",
            "- Use `/inspect` to verify the workspace setup.",
            "- Use `/ask <question>` for an AI follow-up using this context.",
            "- Open Output if you need the raw protocol/tool log."
        );

        await this.appendMessage("assistant", lines.filter(Boolean).join("\n"), {
            actions: [
                ...(this.lastPatch ? ["openPatch"] : []),
                "openOutput",
                "quickInspect",
            ],
        });
    }

    private handleProtocol(message: BrassProtocolMessage): void {
        if (message.type === "event") {
            const event = message.event;
            switch (event?.type) {
                case "agent.action.started":
                    this.post({ type: "progress", icon: "→", text: summarizeAction(event.action) });
                    return;
                case "agent.action.completed":
                    this.post({ type: "progress", icon: statusIcon(event.observation), text: summarizeObservation(event.observation), durationMs: event.durationMs });
                    return;
                case "agent.action.failed":
                    this.post({ type: "progress", icon: "✗", text: `${summarizeAction(event.action)} failed with ${event.error?._tag ?? "error"}`, durationMs: event.durationMs });
                    return;
                case "agent.permission.denied":
                    this.post({ type: "progress", icon: "✗", text: `${summarizeAction(event.action)} denied: ${event.reason}` });
                    return;
                case "agent.approval.requested":
                    this.post({ type: "progress", icon: "?", text: `approval required for ${summarizeAction(event.action)} (${event.risk})` });
                    return;
                case "agent.approval.resolved":
                    this.post({ type: "progress", icon: event.approved ? "✓" : "✗", text: `approval ${event.approved ? "granted" : "rejected"}` });
                    return;
            }
        }

        if (message.type === "batch-summary" && message.summary) {
            this.post({ type: "progress", icon: "✓", text: `batch completed ${message.summary.completed}/${message.summary.total}; failed ${message.summary.failed}` });
        }
    }

    private html(webview: vscode.Webview): string {
        const id = nonce();
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${id}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Brass Agent Chat</title>
<style>
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; height: 100vh; display: flex; flex-direction: column; }
header { padding: 12px 12px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
h1 { margin: 0; font-size: 13px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
.subtitle { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.35; }
#context { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px; }
.chip { border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); border-radius: 999px; padding: 2px 7px; font-size: 11px; }
#messages { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.message { border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); border-radius: 8px; padding: 10px; white-space: normal; }
.message.user { border-color: var(--vscode-focusBorder); }
.message.system { background: transparent; color: var(--vscode-descriptionForeground); }
.message strong { display: block; margin-bottom: 4px; }
.message .body { white-space: pre-wrap; line-height: 1.38; }
.progress { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 4px 0; }
.progress .icon { display: inline-block; width: 16px; }
.suggestions { display: grid; gap: 6px; margin-top: 10px; }
button, select, textarea { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 7px 9px; cursor: pointer; text-align: left; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.inline { display: inline-block; margin-top: 8px; margin-right: 6px; }
button:disabled { opacity: 0.65; cursor: not-allowed; }
form { border-top: 1px solid var(--vscode-panel-border); padding: 10px; background: var(--vscode-sideBar-background); }
textarea { width: 100%; resize: vertical; min-height: 72px; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 8px; border-radius: 4px; }
.controls { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
select { flex: 1; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); padding: 5px; }
#send { text-align: center; min-width: 72px; }
.small { font-size: 12px; color: var(--vscode-descriptionForeground); }
.command-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.command-row button { padding: 4px 7px; font-size: 11px; }
.setup-card { margin-top: 10px; padding: 10px; border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); background: var(--vscode-inputValidation-warningBackground, transparent); border-radius: 8px; }
.setup-card strong { display: block; margin-bottom: 4px; }
@media (min-width: 720px) {
  body { background: var(--vscode-editor-background); }
  header, #messages, form { max-width: 1040px; width: calc(100% - 48px); margin-left: auto; margin-right: auto; }
  header { border: 1px solid var(--vscode-panel-border); border-radius: 10px; margin-top: 16px; background: var(--vscode-sideBar-background); }
  #messages { padding: 18px 0; }
  form { border: 1px solid var(--vscode-panel-border); border-radius: 10px; margin-bottom: 16px; background: var(--vscode-sideBar-background); }
  .suggestions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  textarea { min-height: 96px; }
}
</style>
</head>
<body>
<header>
<h1><span class="logo" aria-hidden="true">✦</span> Brass Agent Chat</h1>
<div class="subtitle">Ask follow-up questions, use slash commands, or request a patch preview.</div>
<div id="context"><span class="chip">workspace</span><span class="chip">no previous run</span></div>
<div id="setup"></div>
<div class="command-row">
<button class="secondary" data-action="configureLlm">Configure model</button>
<button class="secondary" data-action="configureWorkspace">Configure workspace</button>
<button class="secondary" data-action="openInEditor">Open in editor</button>
<button class="secondary" data-command="/project">/project</button>
<button class="secondary" data-command="/inspect">/inspect</button>
<button class="secondary" data-command="/fix-tests">/fix-tests</button>
<button class="secondary" data-command="/typecheck">/typecheck</button>
<button class="secondary" data-command="/lint">/lint</button>
<button class="secondary" data-command="/fix-problems">/fix-problems</button>
<button class="secondary" data-command="/fix-current-file">/fix-current-file</button>
<button class="secondary" data-command="/explain-last">/explain-last</button>
<button class="secondary" data-command="/help">/help</button>
</div>
<div class="suggestions">
<button class="secondary" data-prompt="inspect this workspace" data-mode="read-only">Inspect workspace</button>
<button class="secondary" data-prompt="fix the failing tests" data-mode="apply">Fix failing tests</button>
<button class="secondary" data-prompt="run typecheck discovery and fix type errors if possible" data-mode="apply">Fix type errors</button>
<button class="secondary" data-command="/fix-problems">Fix VS Code problems</button>
</div>
</header>
<div id="messages" aria-live="polite"></div>
<form id="form">
<textarea id="prompt" placeholder="Ask Brass Agent… Try /help, /fix-tests, or a follow-up like ‘why did that fail?’"></textarea>
<div class="controls">
<select id="mode" title="Run mode">
<option value="read-only">Ask</option>
<option value="propose" selected>Propose patch</option>
<option value="apply">Apply after preview</option>
</select>
<button id="send" type="submit">Send</button>
</div>
<div class="small">Follow-ups use the previous run summary, validation output, and patch stats when relevant.</div>
</form>
<script nonce="${id}">
const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const prompt = document.getElementById('prompt');
const mode = document.getElementById('mode');
const form = document.getElementById('form');
const send = document.getElementById('send');
const context = document.getElementById('context');
const setup = document.getElementById('setup');
let running = false;
let currentLastRun;
let currentLastPatchStats;
let currentProblemCounts;
let currentLlmStatus;

const updateContext = (updates = {}) => {
  if ('lastRun' in updates) currentLastRun = updates.lastRun;
  if ('lastPatchStats' in updates) currentLastPatchStats = updates.lastPatchStats;
  if ('problemCounts' in updates) currentProblemCounts = updates.problemCounts;
  if ('llmStatus' in updates) currentLlmStatus = updates.llmStatus;
  renderContext(currentLastRun, currentLastPatchStats, currentProblemCounts, currentLlmStatus);
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const actionButton = (action) => {
  if (action === 'openPatch') return '<button class="inline" data-command="/apply-last">Open patch preview</button>';
  if (action === 'explainLast') return '<button class="inline secondary" data-command="/explain-last">Explain last</button>';
  if (action === 'rollbackLast') return '<button class="inline secondary" data-command="/rollback-last">Rollback last</button>';
  if (action === 'openOutput') return '<button class="inline secondary" data-command="/output">Show output</button>';
  if (action === 'quickInspect') return '<button class="inline secondary" data-command="/inspect">Inspect</button>';
  if (action === 'quickFixTests') return '<button class="inline secondary" data-command="/fix-tests">Fix tests</button>';
  return '';
};

const renderMessage = (message) => {
  const div = document.createElement('div');
  div.className = 'message ' + escapeHtml(message.role || 'assistant');
  const label = message.role === 'user' ? 'You' : message.role === 'system' ? 'System' : 'Brass Agent';
  const modeText = message.mode ? '<div class="small">Mode: ' + escapeHtml(message.mode) + '</div>' : '';
  const actions = Array.isArray(message.actions) ? '<div>' + message.actions.map(actionButton).join('') + '</div>' : '';
  div.innerHTML = '<strong>' + label + '</strong><div class="body">' + escapeHtml(message.text || '') + '</div>' + modeText + actions;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
};

const renderSetup = (llmStatus) => {
  if (!llmStatus || !llmStatus.needsSetup) { setup.innerHTML = ''; return; }
  setup.innerHTML = '<div class="setup-card"><strong>Configure your model</strong><div class="small">' + escapeHtml(llmStatus.detail || 'Add an API key to use real LLM runs.') + '</div><button class="inline" data-action="configureLlm">Configure model</button><button class="inline secondary" data-action="configureWorkspace">Configure workspace</button><button class="inline secondary" data-command="/doctor">Run doctor</button></div>';
};

const renderContext = (lastRun, lastPatchStats, problemCounts, llmStatus) => {
  const chips = ['<span class="chip">workspace</span>'];
  if (lastRun) chips.push('<span class="chip">last: ' + escapeHtml(lastRun.status || 'unknown') + '</span>');
  if (lastRun?.validation) chips.push('<span class="chip">validation</span>');
  if (lastPatchStats) chips.push('<span class="chip">patch +' + escapeHtml(lastPatchStats.added || 0) + '/-' + escapeHtml(lastPatchStats.removed || 0) + '</span>');
  if (problemCounts?.workspace) chips.push('<span class="chip">problems ' + escapeHtml(problemCounts.workspace) + '</span>');
  if (problemCounts?.currentFile) chips.push('<span class="chip">file problems ' + escapeHtml(problemCounts.currentFile) + '</span>');
  if (llmStatus) chips.push('<span class="chip">model: ' + escapeHtml(llmStatus.label || llmStatus.provider || 'unknown') + '</span>');
  if (!lastRun) chips.push('<span class="chip">no previous run</span>');
  context.innerHTML = chips.join('');
  renderSetup(llmStatus);
};

const setRunning = (value) => {
  running = value;
  send.textContent = value ? 'Running…' : 'Send';
  send.disabled = value;
};

const addProgress = (icon, text, durationMs) => {
  const div = document.createElement('div');
  div.className = 'progress';
  div.innerHTML = '<span class="icon">' + escapeHtml(icon || '') + '</span>' + escapeHtml(text || '') + (durationMs == null ? '' : ' <span class="small">' + durationMs + 'ms</span>');
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
};

const submitText = (text, selectedMode) => {
  const value = String(text || '').trim();
  if (!value || running) return;
  setRunning(true);
  vscode.postMessage({ type: 'run', prompt: value, mode: selectedMode || mode.value });
  prompt.value = '';
};

form.addEventListener('submit', (event) => { event.preventDefault(); submitText(prompt.value, mode.value); });
prompt.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submitText(prompt.value, mode.value);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const action = button.getAttribute('data-action');
  if (action === 'configureLlm') { vscode.postMessage({ type: 'configureLlm' }); return; }
  if (action === 'configureWorkspace') { vscode.postMessage({ type: 'configureWorkspace' }); return; }
  if (action === 'openInEditor') { vscode.postMessage({ type: 'openInEditor' }); return; }
  const command = button.getAttribute('data-command');
  if (command) { submitText(command, mode.value); return; }
  const quickPrompt = button.getAttribute('data-prompt');
  if (quickPrompt) {
    prompt.value = quickPrompt;
    mode.value = button.getAttribute('data-mode') || 'propose';
    prompt.focus();
  }
});

window.addEventListener('message', (event) => {
  const message = event.data || {};
  switch (message.type) {
    case 'session':
      messages.innerHTML = '';
      (message.messages || []).forEach(renderMessage);
      updateContext({ lastRun: message.lastRun, lastPatchStats: message.lastPatchStats, problemCounts: message.problemCounts, llmStatus: message.llmStatus });
      break;
    case 'context':
      updateContext({ lastRun: message.lastRun, lastPatchStats: message.lastPatchStats, problemCounts: message.problemCounts, llmStatus: message.llmStatus });
      break;
    case 'problemContext':
      updateContext({ problemCounts: message.problemCounts });
      break;
    case 'llmStatus':
      updateContext({ llmStatus: message.llmStatus });
      break;
    case 'chatMessage':
      renderMessage(message.message || {});
      break;
    case 'chatCleared':
      messages.innerHTML = '';
      currentLastRun = undefined; currentLastPatchStats = undefined; currentProblemCounts = undefined; currentLlmStatus = undefined; renderContext(undefined, undefined, undefined, undefined);
      setRunning(false);
      break;
    case 'draft':
      prompt.value = message.prompt || '';
      mode.value = message.mode || 'propose';
      prompt.focus();
      break;
    case 'runStarted':
      addProgress('→', 'running in ' + (message.cwd || ''), undefined);
      break;
    case 'progress':
      addProgress(message.icon, message.text, message.durationMs);
      break;
    case 'patch':
      addProgress('✓', 'patch ready: ' + ((message.stats?.files?.length || 0) + ' file(s), +' + (message.stats?.added || 0) + '/-' + (message.stats?.removed || 0)), undefined);
      break;
    case 'runFinished':
      setRunning(false);
      break;
    case 'runFailed':
      setRunning(false);
      break;
  }
});
</script>
</body>
</html>`;
    }
}


const applyPreviewedPatch = async (preview: PatchPreview) => {
    const patchPath = path.join(os.tmpdir(), `brass-agent-approved-${Date.now()}.diff`);
    await fs.writeFile(patchPath, preview.patch, "utf8");

    const startedAt = new Date();

    try {
        const args = [
            "--protocol-json",
            "--cwd",
            preview.cwd,
            ...configuredExtraArgs(),
            ...responseLanguageCliArgs(),
            "--apply-patch-file",
            patchPath,
            "--yes",
            `apply approved patch for: ${preview.goal}`,
        ];
        const result = await runCli(args, preview.cwd, "Brass Agent: Apply approved patch");
        await historyProvider.add(createHistoryEntry({
            startedAt,
            completedAt: new Date(),
            cwd: preview.cwd,
            goal: `apply approved patch for: ${preview.goal}`,
            mode: "apply-approved-patch",
            result,
            patch: preview.patch,
        }));
    } finally {
        await fs.unlink(patchPath).catch(() => undefined);
    }
};

const rollbackPreviewedPatch = async (preview: PatchPreview) => {
    const patchPath = path.join(os.tmpdir(), `brass-agent-rollback-${Date.now()}.diff`);
    await fs.writeFile(patchPath, preview.patch, "utf8");

    const startedAt = new Date();

    try {
        const args = [
            "--protocol-json",
            "--cwd",
            preview.cwd,
            ...configuredExtraArgs(),
            ...responseLanguageCliArgs(),
            "--rollback-patch-file",
            patchPath,
            "--yes",
            `rollback approved patch for: ${preview.goal}`,
        ];
        const result = await runCli(args, preview.cwd, "Brass Agent: Rollback approved patch");
        await historyProvider.add(createHistoryEntry({
            startedAt,
            completedAt: new Date(),
            cwd: preview.cwd,
            goal: `rollback approved patch for: ${preview.goal}`,
            mode: "rollback-approved-patch",
            result,
            patch: preview.patch,
        }));
    } finally {
        await fs.unlink(patchPath).catch(() => undefined);
    }
};

const openPatchPreview = (preview: PatchPreview) => {
    lastPatchPreview = preview;
    const panel = vscode.window.createWebviewPanel(
        "brassAgentPatchPreview",
        "Brass Agent Patch Preview",
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        }
    );

    panel.webview.html = patchPreviewHtml(panel.webview, preview);
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message?.type) {
            case "apply": {
                const answer = await vscode.window.showWarningMessage(
                    "Apply this exact patch to the current workspace via brass-agent?",
                    { modal: true },
                    "Apply Patch"
                );
                if (answer !== "Apply Patch") return;
                panel.dispose();
                await applyPreviewedPatch(preview);
                break;
            }
            case "copy":
                await vscode.env.clipboard.writeText(preview.patch);
                await vscode.window.showInformationMessage("Patch copied to clipboard.");
                break;
            case "copyFilePatch":
                if (typeof message.patch === "string") {
                    await vscode.env.clipboard.writeText(message.patch);
                    await vscode.window.showInformationMessage("File patch copied to clipboard.");
                }
                break;
            case "openFile": {
                if (typeof message.file !== "string") break;
                const filePath = resolvePatchFilePath(preview.cwd, message.file);
                if (!filePath) {
                    await vscode.window.showWarningMessage("Patch file path is outside the workspace or could not be resolved.");
                    break;
                }
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
                } catch {
                    await vscode.window.showWarningMessage(`Could not open ${message.file}. The file may not exist yet.`);
                }
                break;
            }
            case "close":
                panel.dispose();
                break;
        }
    });
};

const runBrassAgentGoal = async (
    mode: RunMode,
    cwd: string,
    goal: string,
    options?: {
        readonly onProtocolMessage?: (message: BrassProtocolMessage) => void;
        readonly openPatchPreviewOnPatch?: boolean;
        readonly showOutput?: boolean;
        readonly historyGoal?: string;
    }
) => {
    const args = ["--protocol-json", "--protocol-full-patches", "--cwd", cwd, ...configuredExtraArgs(), ...responseLanguageCliArgs()];

    if (mode === "read-only") {
        args.push("--mode", "read-only");
    } else {
        // Both Propose Fix and Apply Fix generate a proposal first. Applying happens only
        // after the user approves the exact diff in the webview preview.
        args.push("--mode", "propose");
    }

    const agentGoal = goal.trim();
    const historyGoal = options?.historyGoal?.trim() || agentGoal;

    args.push(agentGoal);

    const startedAt = new Date();
    const result = await runCli(args, cwd, "Brass Agent", options?.onProtocolMessage, { showOutput: options?.showOutput });
    const patch = extractProposedPatch(result?.finalState);

    await historyProvider.add(createHistoryEntry({
        startedAt,
        completedAt: new Date(),
        cwd,
        goal: historyGoal,
        mode,
        result,
        patch,
    }));

    if (patch && mode !== "read-only" && options?.openPatchPreviewOnPatch !== false) {
        openPatchPreview({ cwd, goal: historyGoal, patch });
    } else if (mode === "apply" && options?.openPatchPreviewOnPatch !== false) {
        await vscode.window.showInformationMessage("Brass Agent did not produce a patch to preview.");
    }

    return { result, patch };
};

const runBrassAgentPreset = async (mode: RunMode, goal: string) => {
    const cwd = workspaceCwd();
    if (!cwd) {
        await vscode.window.showWarningMessage("Open a workspace folder before running Brass Agent.");
        return;
    }

    await runBrassAgentGoal(mode, cwd, goal);
};

const runBrassAgent = async (mode: RunMode) => {
    const cwd = workspaceCwd();
    if (!cwd) {
        await vscode.window.showWarningMessage("Open a workspace folder before running Brass Agent.");
        return;
    }

    const goal = await vscode.window.showInputBox({
        prompt: mode === "read-only" ? "What should Brass Agent inspect?" : "What should Brass Agent do?",
        placeHolder: mode === "read-only" ? "inspect this repo" : "fix the failing tests",
    });

    if (!goal?.trim()) return;

    await runBrassAgentGoal(mode, cwd, goal.trim());
};



const configureCli = async () => {
    const cwd = workspaceCwd() ?? process.cwd();
    const resolved = await resolveCliCommand(cwd, true);

    const pick = await vscode.window.showQuickPick(
        [
            {
                label: "$(wand) Auto-discover CLI",
                description: "recommended",
                detail: `Current: ${describeResolvedCli(resolved)}`,
                action: "auto",
            },
            {
                label: "$(package) Prefer bundled CLI",
                description: "VSIX self-contained",
                detail: "Use the CLI packaged inside the Brass Agent extension when available.",
                action: "bundled",
            },
            {
                label: "$(terminal) Use global brass-agent",
                description: "PATH",
                detail: "Use brass-agent from your shell/editor PATH.",
                action: "global",
            },
            {
                label: "$(folder-opened) Select CLI file...",
                description: "advanced",
                detail: "Pick a dist/agent/cli/main.cjs or another executable/script.",
                action: "select",
            },
            {
                label: "$(info) Show resolved CLI",
                description: "debug",
                detail: describeResolvedCli(resolved),
                action: "show",
            },
        ],
        {
            title: "Configure Brass Agent CLI",
            placeHolder: "How should VS Code find brass-agent?",
            matchOnDescription: true,
            matchOnDetail: true,
        }
    );

    if (!pick) return;

    const config = extensionConfig();

    switch (pick.action) {
        case "auto":
            await config.update("command", "auto", vscode.ConfigurationTarget.Global);
            cachedCliCommand = undefined;
            await vscode.window.showInformationMessage("Brass Agent CLI set to auto-discovery.");
            return;
        case "bundled":
            await config.update("command", "auto", vscode.ConfigurationTarget.Global);
            await config.update("preferBundledCli", true, vscode.ConfigurationTarget.Global);
            cachedCliCommand = undefined;
            await vscode.window.showInformationMessage("Brass Agent will prefer the bundled VS Code CLI.");
            return;
        case "global":
            await config.update("command", "brass-agent", vscode.ConfigurationTarget.Global);
            cachedCliCommand = undefined;
            await vscode.window.showInformationMessage("Brass Agent CLI set to global `brass-agent`.");
            return;
        case "select": {
            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                title: "Select brass-agent CLI entrypoint",
                filters: {
                    "Node entrypoints": ["cjs", "mjs", "js"],
                    "All files": ["*"],
                },
            });
            const file = selected?.[0]?.fsPath;
            if (!file) return;
            await config.update("command", file, vscode.ConfigurationTarget.Global);
            cachedCliCommand = undefined;
            await vscode.window.showInformationMessage(`Brass Agent CLI set to ${file}.`);
            return;
        }
        case "show":
            output.show(true);
            output.appendLine(`Resolved Brass Agent CLI: ${describeResolvedCli(resolved)}`);
            await vscode.window.showInformationMessage(`Resolved CLI: ${describeResolvedCli(resolved)}`);
            return;
    }
};

const storeSecretIfProvided = async (key: string, value: string | undefined): Promise<boolean> => {
    if (value === undefined) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    await extensionContext.secrets.store(key, trimmed);
    return true;
};

const configureLlm = async () => {
    const current = await llmSetupStatus();
    const pick = await vscode.window.showQuickPick(
        [
            {
                label: "$(sparkle) Google / Gemini",
                description: current.provider === "google" ? "current" : "recommended",
                detail: "Stores GEMINI_API_KEY in VS Code Secret Storage and passes it only to brass-agent runs launched from VS Code.",
                action: "google",
            },
            {
                label: "$(hubot) OpenAI-compatible",
                description: current.provider === "openai-compatible" ? "current" : "chat completions",
                detail: "Use an OpenAI-compatible /chat/completions endpoint and store the API key in VS Code Secret Storage.",
                action: "openai-compatible",
            },
            {
                label: "$(debug-alt) Fake / offline",
                description: current.provider === "fake" ? "current" : "no API key",
                detail: "Useful for smoke tests and trying the UI without a real model.",
                action: "fake",
            },
            {
                label: "$(wand) Auto-detect",
                description: current.provider === "auto" ? "current" : "workspace/env",
                detail: "Let the CLI use workspace config/env files. Stored VS Code secrets are still injected when available.",
                action: "auto",
            },
            {
                label: "$(eye) Show current model setup",
                description: current.label,
                detail: current.detail,
                action: "show",
            },
            {
                label: "$(trash) Clear stored model secrets",
                description: "destructive",
                detail: "Deletes API keys stored by the Brass Agent VS Code extension.",
                action: "clear",
            },
        ],
        {
            title: "Configure Brass Agent model",
            placeHolder: "Which LLM should Brass Agent use from VS Code?",
            matchOnDescription: true,
            matchOnDetail: true,
        }
    );

    if (!pick) return;

    const config = extensionConfig();

    switch (pick.action) {
        case "google": {
            await config.update("llm.provider", "google", vscode.ConfigurationTarget.Global);
            const key = await vscode.window.showInputBox({
                title: "Google / Gemini API key",
                prompt: "Stored in VS Code Secret Storage, not in settings or the repo. Leave blank to keep an existing key.",
                placeHolder: "GEMINI_API_KEY",
                password: true,
                ignoreFocusOut: true,
            });
            await storeSecretIfProvided(GOOGLE_API_KEY_SECRET, key);
            const model = await vscode.window.showInputBox({
                title: "Gemini model",
                value: configuredGoogleModel(),
                prompt: "Example: gemini-2.5-flash",
                ignoreFocusOut: true,
            });
            if (model?.trim()) await config.update("llm.google.model", model.trim(), vscode.ConfigurationTarget.Global);
            await vscode.window.showInformationMessage("Brass Agent model set to Google/Gemini.");
            break;
        }
        case "openai-compatible": {
            await config.update("llm.provider", "openai-compatible", vscode.ConfigurationTarget.Global);
            const endpoint = await vscode.window.showInputBox({
                title: "OpenAI-compatible endpoint",
                value: configuredOpenAiCompatibleEndpoint(),
                prompt: "Example: https://api.openai.com/v1/chat/completions",
                ignoreFocusOut: true,
            });
            if (endpoint?.trim()) await config.update("llm.openaiCompatible.endpoint", endpoint.trim(), vscode.ConfigurationTarget.Global);
            const model = await vscode.window.showInputBox({
                title: "OpenAI-compatible model",
                value: configuredOpenAiCompatibleModel(),
                prompt: "Example: gpt-4.1",
                ignoreFocusOut: true,
            });
            if (model?.trim()) await config.update("llm.openaiCompatible.model", model.trim(), vscode.ConfigurationTarget.Global);
            const key = await vscode.window.showInputBox({
                title: "OpenAI-compatible API key",
                prompt: "Stored in VS Code Secret Storage, not in settings or the repo. Leave blank to keep an existing key.",
                placeHolder: "BRASS_LLM_API_KEY",
                password: true,
                ignoreFocusOut: true,
            });
            await storeSecretIfProvided(OPENAI_COMPATIBLE_API_KEY_SECRET, key);
            await vscode.window.showInformationMessage("Brass Agent model set to OpenAI-compatible.");
            break;
        }
        case "fake":
            await config.update("llm.provider", "fake", vscode.ConfigurationTarget.Global);
            await vscode.window.showInformationMessage("Brass Agent model set to fake/offline.");
            break;
        case "auto":
            await config.update("llm.provider", "auto", vscode.ConfigurationTarget.Global);
            await vscode.window.showInformationMessage("Brass Agent model set to auto-detect.");
            break;
        case "show": {
            const latest = await llmSetupStatus();
            output.show(true);
            output.appendLine("Brass Agent model setup:");
            output.appendLine(`provider: ${latest.provider}`);
            output.appendLine(`label: ${latest.label}`);
            output.appendLine(`ready: ${latest.ready}`);
            output.appendLine(`detail: ${latest.detail}`);
            output.appendLine(`google key: ${latest.hasGoogleApiKey ? "configured" : "missing"}`);
            output.appendLine(`openai-compatible key: ${latest.hasOpenAiCompatibleApiKey ? "configured" : "missing"}`);
            await vscode.window.showInformationMessage(`Model setup: ${latest.label}. ${latest.detail}`);
            return;
        }
        case "clear": {
            const answer = await vscode.window.showWarningMessage(
                "Delete Brass Agent API keys stored in VS Code Secret Storage?",
                { modal: true },
                "Delete Secrets"
            );
            if (answer !== "Delete Secrets") return;
            await extensionContext.secrets.delete(GOOGLE_API_KEY_SECRET);
            await extensionContext.secrets.delete(OPENAI_COMPATIBLE_API_KEY_SECRET);
            await vscode.window.showInformationMessage("Brass Agent stored model secrets deleted.");
            break;
        }
    }

    await extensionContext.globalState.update(LLM_SETUP_DISMISSED_KEY, true);
    refreshChatLlmStatus();
};

const maybePromptLlmSetup = async () => {
    if (extensionContext.globalState.get<boolean>(LLM_SETUP_DISMISSED_KEY)) return;
    const setup = await llmSetupStatus();
    if (!setup.needsSetup) return;

    const answer = await vscode.window.showInformationMessage(
        "Configure a model for Brass Agent? API keys are stored in VS Code Secret Storage, not in the repo.",
        "Configure Model",
        "Use Fake",
        "Later"
    );

    if (answer === "Configure Model") {
        await configureLlm();
        return;
    }

    if (answer === "Use Fake") {
        await extensionConfig().update("llm.provider", "fake", vscode.ConfigurationTarget.Global);
        await extensionContext.globalState.update(LLM_SETUP_DISMISSED_KEY, true);
        refreshChatLlmStatus();
        return;
    }

    if (answer === "Later") await extensionContext.globalState.update(LLM_SETUP_DISMISSED_KEY, true);
};



const readJsonObjectFile = async (filePath: string): Promise<Record<string, any>> => {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
    } catch {
        return {};
    }
};

const readWorkspacePackageJson = async (cwd: string): Promise<Record<string, any> | undefined> => {
    try {
        const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, any> : undefined;
    } catch {
        return undefined;
    }
};

const workspaceScriptNames = async (cwd: string): Promise<readonly string[]> => {
    const packageJson = await readWorkspacePackageJson(cwd);
    const scripts = packageJson?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
    return Object.entries(scripts)
        .filter(([, value]) => typeof value === "string")
        .map(([name]) => name)
        .sort();
};

const inferWorkspacePackageManager = async (cwd: string): Promise<"npm" | "pnpm" | "yarn" | "bun" | "auto"> => {
    const packageJson = await readWorkspacePackageJson(cwd);
    const packageManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager.split("@")[0] : undefined;
    if (packageManager === "npm" || packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun") return packageManager;
    if (await accessFile(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (await accessFile(path.join(cwd, "yarn.lock"))) return "yarn";
    if (await accessFile(path.join(cwd, "bun.lockb")) || await accessFile(path.join(cwd, "bun.lock"))) return "bun";
    if (await accessFile(path.join(cwd, "package-lock.json")) || await accessFile(path.join(cwd, "npm-shrinkwrap.json"))) return "npm";
    return "auto";
};

const packageManagerRunPrefix = (pm: "npm" | "pnpm" | "yarn" | "bun" | "auto"): string => {
    switch (pm) {
        case "pnpm": return "pnpm run";
        case "yarn": return "yarn run";
        case "bun": return "bun run";
        case "npm":
        case "auto":
            return "npm run";
    }
};

const validationCommandCandidates = async (cwd: string): Promise<readonly string[]> => {
    const scripts = await workspaceScriptNames(cwd);
    const pm = await inferWorkspacePackageManager(cwd);
    const prefix = packageManagerRunPrefix(pm);
    const priority = ["test", "test:ci", "test:unit", "repo:check", "check", "typecheck", "type-check", "check-types", "tsc", "lint", "lint:ci", "bridge:doctor"];
    const scored = scripts
        .filter((script) => /test|check|type|lint|doctor/i.test(script))
        .sort((a, b) => {
            const ai = priority.indexOf(a);
            const bi = priority.indexOf(b);
            return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
        });
    return scored.map((script) => script === "test" && pm !== "bun" ? `${pm === "auto" ? "npm" : pm} test` : `${prefix} ${script}`);
};

const mergeShellAllow = (config: Record<string, any>, command: string | undefined): void => {
    if (!command) return;
    const permissions = typeof config.permissions === "object" && config.permissions !== null && !Array.isArray(config.permissions) ? config.permissions : {};
    const shell = typeof permissions.shell === "object" && permissions.shell !== null && !Array.isArray(permissions.shell) ? permissions.shell : {};
    const allow = Array.isArray(shell.allow) ? shell.allow.filter((value: unknown) => typeof value === "string") : [];
    if (!allow.includes(command)) allow.push(command);
    config.permissions = {
        ...permissions,
        shell: {
            inheritDefaults: shell.inheritDefaults ?? true,
            ...shell,
            allow,
        },
        patchApply: permissions.patchApply ?? {
            decision: "ask",
            reason: "Apply the generated unified diff to the workspace.",
            risk: "high",
            defaultAnswer: "reject",
        },
    };
};

const configureWorkspace = async () => {
    const cwd = workspaceCwd();
    if (!cwd) {
        await vscode.window.showWarningMessage("Open a workspace folder before configuring Brass Agent.");
        return;
    }

    const configPath = path.join(cwd, ".brass-agent.json");
    const existing = await readJsonObjectFile(configPath);
    const scripts = await workspaceScriptNames(cwd);
    const pm = await inferWorkspacePackageManager(cwd);
    const candidates = await validationCommandCandidates(cwd);

    const languagePick = await vscode.window.showQuickPick(
        [
            { label: "Auto / match each prompt", description: "recommended", value: "auto" },
            { label: "Spanish", description: "responder en español", value: "es" },
            { label: "English", description: "respond in English", value: "en" },
            { label: "Portuguese", value: "pt" },
            { label: "French", value: "fr" },
            { label: "German", value: "de" },
            { label: "Italian", value: "it" },
        ],
        {
            title: "Brass Agent workspace language",
            placeHolder: "How should Brass Agent answer in this workspace?",
        }
    );
    if (!languagePick) return;

    const validationItems = [
        { label: "Auto-discover validation commands", description: "use package.json heuristics", value: "auto" },
        { label: "No validation command", description: "do not run shell validation before planning", value: "none" },
        ...candidates.map((command) => ({ label: command, description: "from package.json scripts", value: command })),
        { label: "Custom command...", description: "enter an exact shell command", value: "custom" },
    ];

    const validationPick = await vscode.window.showQuickPick(validationItems, {
        title: "Brass Agent validation command",
        placeHolder: scripts.length ? "Choose how this repo should be checked" : "No package.json scripts found; choose auto or custom",
        matchOnDescription: true,
    });
    if (!validationPick) return;

    let validationCommand: string | undefined;
    let validationCommands: string[] | undefined;
    if (validationPick.value === "custom") {
        const custom = await vscode.window.showInputBox({
            title: "Custom validation command",
            prompt: "Example: npm run repo:check. The command is added to permissions.shell.allow.",
            ignoreFocusOut: true,
        });
        if (!custom?.trim()) return;
        const command = custom.trim();
        validationCommand = command;
        validationCommands = [command];
    } else if (validationPick.value === "none") {
        validationCommands = [];
    } else if (validationPick.value !== "auto") {
        const command = validationPick.value;
        validationCommand = command;
        validationCommands = [command];
    }

    const next: Record<string, any> = {
        mode: existing.mode ?? "propose",
        approval: existing.approval ?? "auto",
        ...existing,
        language: { ...(existing.language ?? {}), response: languagePick.value },
        project: {
            ...(existing.project ?? {}),
            packageManager: existing.project?.packageManager ?? pm,
            maxValidationCommands: existing.project?.maxValidationCommands ?? 2,
            ...(validationCommands !== undefined ? { validationCommands } : {}),
        },
        redaction: existing.redaction ?? { enabled: true },
        context: existing.context ?? {
            enabled: true,
            maxSearchQueries: 3,
            maxFiles: 4,
            maxSearchResults: 40,
            excludeGlobs: [".env*", "**/.env*", "**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/*.pem", "**/*.key", "**/secrets/**"],
        },
    };

    if (validationPick.value === "auto" && next.project && "validationCommands" in next.project) {
        delete next.project.validationCommands;
    }

    mergeShellAllow(next, validationCommand);

    const exists = await accessFile(configPath);
    const action = exists ? "Update" : "Create";
    const answer = await vscode.window.showInformationMessage(
        `${action} .brass-agent.json for this workspace?`,
        { modal: false },
        action,
        "Preview"
    );
    if (!answer) return;

    const content = `${JSON.stringify(next, null, 2)}\n`;
    if (answer === "Preview") {
        const doc = await vscode.workspace.openTextDocument({ language: "json", content });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
    }

    await fs.writeFile(configPath, content, "utf8");
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    void projectProvider?.refresh();
    await vscode.window.showInformationMessage("Brass Agent workspace config saved. Run Doctor or /inspect to verify it.");
};

const runDoctor = async () => {
    const cwd = workspaceCwd() ?? process.cwd();
    await runCli(["--doctor", "--cwd", cwd], cwd, "Brass Agent: Doctor");
};

const checkMessage = (report: AgentDoctorReport | undefined, id: string): string | undefined =>
    report?.checks.find((check) => check.id === id)?.message;

const doctorWarnings = (report: AgentDoctorReport | undefined): readonly string[] =>
    (report?.checks ?? [])
        .filter((check) => check.status === "warn" || check.status === "fail")
        .map((check) => `${check.label}: ${check.message}`)
        .slice(0, 6);

const parseLikelyValidation = (profile: string | undefined): string | undefined => {
    const match = profile?.match(/likely validation:\s*([^\.]+)/i);
    const value = match?.[1]?.trim();
    return value && value !== "none detected" ? value : undefined;
};

const workspaceConfigPath = (cwd: string): string => path.join(cwd, ".brass-agent.json");

const workspaceConfigSummary = async (cwd: string): Promise<{
    readonly path: string;
    readonly exists: boolean;
    readonly language?: string;
    readonly validation?: string;
}> => {
    const configPath = workspaceConfigPath(cwd);
    const config = await readJsonObjectFile(configPath);
    const exists = await accessFile(configPath);
    const language = typeof config.language?.response === "string" ? config.language.response : undefined;
    const validationCommands = Array.isArray(config.project?.validationCommands)
        ? config.project.validationCommands.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined;

    return {
        path: configPath,
        exists,
        ...(language ? { language } : {}),
        ...(validationCommands && validationCommands.length > 0 ? { validation: validationCommands.join(", ") } : {}),
    };
};

const runDoctorJson = async (cwd: string): Promise<{ readonly report?: AgentDoctorReport; readonly cli?: string; readonly error?: string }> => {
    try {
        const cli = await resolveCliCommand(cwd);
        const environment = await cliEnvironment();

        return await new Promise((resolve) => {
            let stdout = "";
            let stderr = "";
            let settled = false;
            const child = spawn(cli.command, [...cli.argsPrefix, "--doctor", "--json", "--cwd", cwd], {
                cwd,
                shell: process.platform === "win32" && cli.argsPrefix.length === 0,
                env: {
                    ...environment,
                    BRASS_AGENT_VSCODE_CLI_SOURCE: cli.source,
                    ...(cli.envPatch ?? {}),
                },
            });

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill("SIGTERM");
                resolve({ cli: describeResolvedCli(cli), error: "Doctor timed out after 15s." });
            }, 15_000);

            child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
            child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
            child.on("error", (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ cli: describeResolvedCli(cli), error: String(error) });
            });
            child.on("close", () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try {
                    resolve({ cli: describeResolvedCli(cli), report: JSON.parse(stdout) as AgentDoctorReport });
                } catch {
                    resolve({ cli: describeResolvedCli(cli), error: (stderr || stdout || "Doctor did not return JSON.").trim() });
                }
            });
        });
    } catch (error) {
        return { error: String(error) };
    }
};

const projectDashboardSnapshot = async (): Promise<ProjectDashboardSnapshot> => {
    const cwd = workspaceCwd();
    const model = await llmSetupStatus();

    if (!cwd) {
        return {
            status: "warn",
            model,
            configExists: false,
            language: configuredResponseLanguage(),
            warnings: ["Open a workspace folder to use Brass Agent."],
            error: "No workspace folder is open.",
        };
    }

    const config = await workspaceConfigSummary(cwd);
    const doctor = await runDoctorJson(cwd);
    const report = doctor.report;
    const profile = checkMessage(report, "workspace.projectProfile");
    const validation = config.validation ?? parseLikelyValidation(profile);
    const warnings = doctor.error ? [doctor.error] : doctorWarnings(report);
    const doctorStatus = report?.status;
    const status: ProjectDashboardSnapshot["status"] = doctor.error
        ? "fail"
        : doctorStatus === "fail"
            ? "fail"
            : doctorStatus === "warn" || warnings.length > 0 || model.needsSetup
                ? "warn"
                : "ok";

    return {
        workspace: report?.cwd ?? cwd,
        status,
        cli: doctor.cli,
        model,
        configPath: report?.configPath ?? (config.exists ? config.path : undefined),
        configExists: config.exists,
        language: config.language ?? configuredResponseLanguage(),
        packageManager: checkMessage(report, "workspace.packageManager"),
        validation,
        profile,
        envFile: checkMessage(report, "envFile"),
        doctorStatus,
        warnings,
        ...(doctor.error ? { error: doctor.error } : {}),
    };
};

class ProjectDashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private panel?: vscode.WebviewPanel;
    private readonly clients = new Set<vscode.Webview>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) { }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        this.attachWebview(webviewView.webview);
        this.disposables.push(webviewView.onDidDispose(() => {
            this.clients.delete(webviewView.webview);
            if (this.view === webviewView) this.view = undefined;
        }));
        void this.refresh();
    }

    async openInEditor(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            await this.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "brassAgent.projectPanel",
            "Brass Agent Project",
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel = panel;
        this.attachWebview(panel.webview);
        panel.onDidDispose(() => {
            this.clients.delete(panel.webview);
            if (this.panel === panel) this.panel = undefined;
        }, undefined, this.disposables);
        await this.refresh();
    }

    private attachWebview(webview: vscode.Webview): void {
        this.clients.add(webview);
        webview.options = { enableScripts: true };
        webview.html = this.html(webview);
        this.disposables.push(webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)));
    }

    async refresh(): Promise<void> {
        if (this.clients.size === 0) return;
        for (const client of this.clients) void client.postMessage({ type: "loading" });
        const snapshot = await projectDashboardSnapshot();
        for (const client of this.clients) void client.postMessage({ type: "snapshot", snapshot });
    }

    private async handleWebviewMessage(message: any): Promise<void> {
        switch (message?.type) {
            case "refresh":
                await this.refresh();
                return;
            case "configureModel":
                await configureLlm();
                await this.refresh();
                return;
            case "configureWorkspace":
                await configureWorkspace();
                await this.refresh();
                return;
            case "doctor":
                await runDoctor();
                await this.refresh();
                return;
            case "inspect":
                await runBrassAgentPreset("read-only", "inspect this workspace");
                await this.refresh();
                return;
            case "openChat":
                await openChat();
                return;
            case "openInEditor":
                await this.openInEditor();
                return;
            case "openConfig": {
                const cwd = workspaceCwd();
                if (!cwd) return;
                const configPath = workspaceConfigPath(cwd);
                if (await accessFile(configPath)) {
                    await vscode.window.showTextDocument(vscode.Uri.file(configPath), { preview: false });
                } else {
                    await configureWorkspace();
                    await this.refresh();
                }
                return;
            }
            case "showOutput":
                output.show(true);
                return;
        }
    }

    private html(webview: vscode.Webview): string {
        const id = nonce();
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${id}';" />
<style>
:root { color-scheme: light dark; }
body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
header { padding: 12px 12px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
h1 { font-size: 14px; margin: 0 0 4px; display: flex; gap: 6px; align-items: center; }
.logo { color: var(--vscode-charts-yellow); }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; }
main { padding: 10px; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; background: var(--vscode-editor-background); }
.card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
.row { display: flex; justify-content: space-between; gap: 10px; margin: 6px 0; align-items: flex-start; }
.label { color: var(--vscode-descriptionForeground); flex: 0 0 82px; }
.value { text-align: right; overflow-wrap: anywhere; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 999px; font-size: 11px; border: 1px solid var(--vscode-panel-border); }
.badge.ok { color: var(--vscode-testing-iconPassed); }
.badge.warn { color: var(--vscode-testing-iconQueued); }
.badge.fail { color: var(--vscode-testing-iconFailed); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
button { border: 0; border-radius: 4px; padding: 5px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.small { color: var(--vscode-descriptionForeground); font-size: 12px; }
.warning { margin: 6px 0; color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
@media (min-width: 720px) {
  body { background: var(--vscode-editor-background); }
  header, main { max-width: 1040px; width: calc(100% - 48px); margin-left: auto; margin-right: auto; }
  header { border: 1px solid var(--vscode-panel-border); border-radius: 10px; margin-top: 16px; background: var(--vscode-sideBar-background); }
  main { padding: 18px 0; }
  .card { background: var(--vscode-sideBar-background); }
}
</style>
</head>
<body>
<header>
<h1><span class="logo">✦</span> Brass Agent Project</h1>
<div class="subtitle">Workspace readiness, model, validation command, and project profile.</div>
</header>
<main id="app"><div class="card">Loading project dashboard…</div></main>
<script nonce="${id}">
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const send = (type) => vscode.postMessage({ type });
const row = (label, value) => '<div class="row"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value || '—') + '</div></div>';
const card = (title, body) => '<section class="card"><h2>' + escapeHtml(title) + '</h2>' + body + '</section>';
const actions = (...items) => '<div class="actions">' + items.map(([label, type, secondary]) => '<button class="' + (secondary ? 'secondary' : '') + '" data-action="' + escapeHtml(type) + '">' + escapeHtml(label) + '</button>').join('') + '</div>';
const render = (snapshot) => {
  const status = snapshot?.status || 'warn';
  const warnings = Array.isArray(snapshot?.warnings) ? snapshot.warnings : [];
  app.innerHTML = '' +
    card('Status',
      '<div class="row"><div class="label">Ready</div><div class="value"><span class="badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></div></div>' +
      row('Workspace', snapshot.workspace) +
      row('Doctor', snapshot.doctorStatus || status) +
      row('CLI', snapshot.cli) +
      actions(['Refresh', 'refresh'], ['Open in Editor', 'openInEditor', true], ['Run Doctor', 'doctor', true], ['Open Chat', 'openChat', true])
    ) +
    card('Model',
      row('Provider', snapshot.model?.label) +
      row('Ready', snapshot.model?.ready ? 'yes' : 'needs setup') +
      '<div class="small">' + escapeHtml(snapshot.model?.detail || '') + '</div>' +
      actions(['Configure Model', 'configureModel'], ['Show Output', 'showOutput', true])
    ) +
    card('Workspace config',
      row('Config', snapshot.configPath || (snapshot.configExists ? '.brass-agent.json' : 'not configured')) +
      row('Language', snapshot.language) +
      row('Validation', snapshot.validation || 'auto / not detected') +
      row('Package manager', snapshot.packageManager) +
      actions(['Configure Workspace', 'configureWorkspace'], ['Open Config', 'openConfig', true])
    ) +
    card('Project profile',
      '<pre>' + escapeHtml(snapshot.profile || 'No profile detected yet. Run Doctor or Configure Workspace.') + '</pre>' +
      (snapshot.envFile ? '<div class="small" style="margin-top:8px">Env: ' + escapeHtml(snapshot.envFile) + '</div>' : '') +
      actions(['Inspect Workspace', 'inspect'], ['Open Chat', 'openChat', true])
    ) +
    (warnings.length ? card('Warnings', warnings.map((warning) => '<div class="warning">! ' + escapeHtml(warning) + '</div>').join('')) : '');
};
window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'loading') app.innerHTML = '<div class="card">Refreshing project dashboard…</div>';
  if (message.type === 'snapshot') render(message.snapshot || {});
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  send(button.getAttribute('data-action'));
});
</script>
</body>
</html>`;
    }
}

const openProjectDashboard = async () => {
    await vscode.commands.executeCommand("brassAgent.project.focus");
    await projectProvider?.refresh();
};

const openProjectDashboardInEditor = async () => {
    await projectProvider?.openInEditor();
};

const runInit = async () => {
    const cwd = workspaceCwd();
    if (!cwd) {
        await vscode.window.showWarningMessage("Open a workspace folder before initializing Brass Agent.");
        return;
    }

    const profile = await vscode.window.showQuickPick(
        [
            { label: "default", description: "Provider auto-detection; safest starting point" },
            { label: "google", description: "Gemini config using GEMINI_API_KEY" },
            { label: "openai-compatible", description: "OpenAI-compatible /chat/completions config" },
            { label: "fake", description: "Offline fake provider for smoke tests" },
        ],
        { title: "Initialize Brass Agent", placeHolder: "Select an init profile" }
    );

    if (!profile) return;

    const existing = await Promise.all([
        fs.access(path.join(cwd, ".brass-agent.json")).then(() => true, () => false),
        fs.access(path.join(cwd, "brass-agent.batch.json")).then(() => true, () => false),
        fs.access(path.join(cwd, ".env.example")).then(() => true, () => false),
        fs.access(path.join(cwd, "BRASS_AGENT.md")).then(() => true, () => false),
    ]);

    const force = existing.some(Boolean)
        ? await vscode.window.showWarningMessage(
            "Some Brass Agent init files already exist. Overwrite them?",
            { modal: true },
            "Skip existing",
            "Overwrite"
        )
        : "Skip existing";

    if (force === undefined) return;

    const args = ["--init", "--cwd", cwd, "--init-profile", profile.label];
    if (force === "Overwrite") args.push("--force");

    await runCli(args, cwd, "Brass Agent: Initialize Workspace");
};

const runBrassAgentBatch = async (options: {
    readonly cwd: string;
    readonly label: string;
    readonly batchFile?: string;
}) => {
    const args = ["--protocol-json", "--protocol-full-patches", "--cwd", options.cwd, ...configuredExtraArgs(), ...responseLanguageCliArgs()];
    if (options.batchFile) args.push("--batch-file", options.batchFile);

    const startedAt = new Date();
    const result = await runCli(args, options.cwd, "Brass Agent: Batch");
    const completedAt = new Date();
    if (!result) return;

    const children = result.finalStates.map((state, index) => createHistoryEntryFromState({
        state,
        startedAt,
        completedAt,
        fallbackCwd: options.cwd,
        fallbackGoal: `${options.label} #${index + 1}`,
        idSuffix: `batch-${index + 1}`,
    }));

    const summary = result.batchSummary ?? {
        total: children.length,
        completed: children.length,
        failed: children.filter((child) => child.status !== "done").length,
        exitCode: result.exitCode && result.exitCode !== 0 ? 1 : 0,
        stoppedEarly: false,
    } satisfies BatchSummary;

    await historyProvider.add(createHistoryEntry({
        startedAt,
        completedAt,
        cwd: options.cwd,
        goal: options.label,
        mode: "batch",
        result: { ...result, batchSummary: summary },
        batchFile: options.batchFile,
        batchSummary: summary,
        children,
    }));
};

const runBatchFile = async () => {
    const cwd = workspaceCwd();
    if (!cwd) {
        await vscode.window.showWarningMessage("Open a workspace folder before running a Brass Agent batch.");
        return;
    }

    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(cwd),
        filters: {
            "Brass Agent batch files": ["json", "jsonc", "txt"],
            "All files": ["*"],
        },
        title: "Select Brass Agent batch file",
    });

    const batchFile = selected?.[0]?.fsPath;
    if (!batchFile) return;

    await runBrassAgentBatch({
        cwd,
        batchFile,
        label: path.relative(cwd, batchFile) || path.basename(batchFile),
    });
};

const runConfiguredBatch = async () => {
    const cwd = workspaceCwd();
    if (!cwd) {
        await vscode.window.showWarningMessage("Open a workspace folder before running a Brass Agent batch.");
        return;
    }

    await runBrassAgentBatch({ cwd, label: "configured batch" });
};

const runQuickRun = async () => {
    const pick = await vscode.window.showQuickPick(
        [
            { label: "$(comment-discussion) Open Chat", description: "copilot-like", detail: "Ask Brass Agent from a persistent chat panel or editor tab.", action: "chat" },
            { label: "$(layout-panel-center) Open Chat in Editor", description: "focus mode", detail: "Use a larger editor tab for long Brass Agent sessions.", action: "chatEditor" },
            { label: "$(sparkle) Inline Assist...", description: "editor", detail: "Use the current selection or cursor context from the editor.", action: "inlineAssist" },
            { label: "$(search) Inspect Workspace", description: "read-only", detail: "Read project metadata and ask for a safe overview.", action: "inspect" },
            { label: "$(lightbulb) Propose Fix...", description: "safe", detail: "Generate a plan and patch preview without writing files.", action: "propose" },
            { label: "$(tools) Apply Fix...", description: "preview first", detail: "Generate a proposal, show the exact diff, then apply only after approval.", action: "apply" },
            { label: "$(beaker) Fix Tests", description: "preset", detail: "Run the failing-tests preset and preview any patch.", action: "fixTests" },
            { label: "$(checklist) Typecheck", description: "preset", detail: "Run typecheck discovery and preview any patch.", action: "typecheck" },
            { label: "$(symbol-color) Lint", description: "preset", detail: "Run lint discovery and preview any patch.", action: "lint" },
            { label: "$(warning) Fix VS Code Problems", description: "diagnostics", detail: "Use current VS Code diagnostics as context and preview any patch.", action: "fixProblems" },
            { label: "$(list-tree) Run Configured Batch", description: "batch", detail: "Run config.batch.goals from the workspace config.", action: "configuredBatch" },
            { label: "$(file-code) Run Batch File...", description: "batch", detail: "Pick a batch file and run it.", action: "batchFile" },
            { label: "$(pulse) Doctor", description: "setup", detail: "Check CLI, model, workspace, and VS Code configuration.", action: "doctor" },
            { label: "$(key) Configure Model", description: "setup", detail: "Choose Google, OpenAI-compatible, fake, or auto and store keys safely.", action: "configureLlm" },
            { label: "$(gear) Configure Workspace", description: "setup", detail: "Create or update .brass-agent.json with language and validation commands.", action: "configureWorkspace" },
            { label: "$(plug) Configure CLI", description: "setup", detail: "Auto-discover, use bundled CLI, global command, or select a CLI file.", action: "configureCli" },
            { label: "$(rocket) Initialize Workspace", description: "setup", detail: "Create .brass-agent.json, batch defaults, and safe examples.", action: "init" },
            { label: "$(output) Show Output", description: "logs", detail: "Open the Brass Agent output channel.", action: "output" },
        ],
        {
            title: "Brass Agent",
            placeHolder: "What do you want to run?",
            matchOnDescription: true,
            matchOnDetail: true,
        }
    );

    switch (pick?.action) {
        case "chat":
            await openChat();
            return;
        case "chatEditor":
            await openChatInEditor();
            return;
        case "inspect":
            await runBrassAgentPreset("read-only", "inspect this workspace");
            return;
        case "propose":
            await runBrassAgent("propose");
            return;
        case "apply":
            await runBrassAgent("apply");
            return;
        case "fixTests":
            await runBrassAgentPreset("apply", "fix the failing tests");
            return;
        case "typecheck":
            await runBrassAgentPreset("apply", "run typecheck discovery and fix type errors if possible");
            return;
        case "lint":
            await runBrassAgentPreset("apply", "run lint discovery and fix lint errors if possible");
            return;
        case "fixProblems":
            await runProblemAwareCommand("fix", "workspace");
            return;
        case "configuredBatch":
            await runConfiguredBatch();
            return;
        case "batchFile":
            await runBatchFile();
            return;
        case "doctor":
            await runDoctor();
            return;
        case "configureLlm":
            await configureLlm();
            return;
        case "configureWorkspace":
            await configureWorkspace();
            return;
        case "configureCli":
            await configureCli();
            return;
        case "init":
            await runInit();
            return;
        case "output":
            output.show(true);
            return;
    }
};


const selectionInfo = (): { readonly cwd: string; readonly file: string; readonly language: string; readonly text: string } | undefined => {
    const editor = vscode.window.activeTextEditor;
    const cwd = workspaceCwd();
    if (!editor || !cwd) return undefined;
    const text = editor.document.getText(editor.selection);
    if (!text.trim()) return undefined;
    return {
        cwd,
        file: path.relative(cwd, editor.document.uri.fsPath) || editor.document.uri.fsPath,
        language: editor.document.languageId || "text",
        text,
    };
};


const inlineAssistInfo = (): InlineAssistInfo | undefined => {
    const editor = vscode.window.activeTextEditor;
    const cwd = workspaceCwd();
    if (!editor || !cwd) return undefined;

    const document = editor.document;
    const hasSelection = !editor.selection.isEmpty;
    const range = hasSelection
        ? editor.selection
        : new vscode.Range(
            Math.max(0, editor.selection.active.line - configuredInlineAssistSurroundingLines()),
            0,
            Math.min(document.lineCount - 1, editor.selection.active.line + configuredInlineAssistSurroundingLines()),
            document.lineAt(Math.min(document.lineCount - 1, editor.selection.active.line + configuredInlineAssistSurroundingLines())).range.end.character
        );
    const text = document.getText(range);
    if (!text.trim()) return undefined;

    return {
        cwd,
        file: path.relative(cwd, document.uri.fsPath) || document.uri.fsPath,
        language: document.languageId || "text",
        text,
        rangeLabel: `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`,
        hasSelection,
    };
};

const promptForInlineAssist = (intro: string, info: InlineAssistInfo): string => [
    intro,
    "",
    `File: ${info.file}`,
    `Language: ${info.language}`,
    `Range: ${info.rangeLabel}`,
    `Context kind: ${info.hasSelection ? "explicit selection" : "cursor surroundings"}`,
    "",
    info.hasSelection ? "Selected code:" : "Relevant surrounding code:",
    "```" + info.language,
    info.text,
    "```",
].join("\n");

const runInlineAssist = async () => {
    const info = inlineAssistInfo();
    if (!info) {
        await vscode.window.showInformationMessage("Open a file before using Brass Agent Inline Assist.");
        return;
    }

    const pick = await vscode.window.showQuickPick(
        [
            { label: "Ask about this code", description: "read-only", intent: "ask" as InlineAssistIntent, mode: "read-only" as RunMode },
            { label: "Explain this code", description: "read-only", intent: "explain" as InlineAssistIntent, mode: "read-only" as RunMode },
            { label: "Fix this code", description: "patch preview", intent: "fix" as InlineAssistIntent, mode: "apply" as RunMode },
            { label: "Refactor this code", description: "patch preview", intent: "refactor" as InlineAssistIntent, mode: "apply" as RunMode },
            { label: "Generate tests", description: "patch preview", intent: "tests" as InlineAssistIntent, mode: "apply" as RunMode },
            { label: "Custom instruction...", description: "choose your own prompt", intent: "custom" as InlineAssistIntent, mode: "propose" as RunMode },
        ],
        { title: "Brass Agent Inline Assist", placeHolder: info.hasSelection ? "Use the selected code as context" : "Use cursor surroundings as context" }
    );

    if (!pick) return;

    let intro: string;
    let mode = pick.mode;

    switch (pick.intent) {
        case "ask": {
            const question = await vscode.window.showInputBox({
                prompt: "What do you want to ask about this code?",
                placeHolder: "why is this effect not cancelling?",
            });
            if (!question?.trim()) return;
            intro = question.trim();
            mode = "read-only";
            break;
        }
        case "explain":
            intro = "Explain this code. Include behavior, dependencies, edge cases, and risks.";
            break;
        case "fix":
            intro = "Fix this code. Prefer a minimal patch and explain the change.";
            break;
        case "refactor":
            intro = "Refactor this code while preserving behavior. Prefer a minimal patch and call out risks.";
            break;
        case "tests":
            intro = "Generate focused tests for this code. Prefer a minimal patch and explain coverage.";
            break;
        case "custom": {
            const instruction = await vscode.window.showInputBox({
                prompt: "What should Brass Agent do with this code?",
                placeHolder: "make this cancellation path easier to reason about",
            });
            if (!instruction?.trim()) return;
            intro = instruction.trim();
            const selectedMode = await vscode.window.showQuickPick(
                [
                    { label: "Ask", mode: "read-only" as RunMode },
                    { label: "Propose patch", mode: "propose" as RunMode },
                    { label: "Apply after preview", mode: "apply" as RunMode },
                ],
                { title: "Inline Assist mode" }
            );
            if (!selectedMode) return;
            mode = selectedMode.mode;
            break;
        }
    }

    chatProvider.revealDraft(promptForInlineAssist(intro, info), mode);
};

const promptForSelection = (intro: string, info: NonNullable<ReturnType<typeof selectionInfo>>): string => [
    intro,
    "",
    `File: ${info.file}`,
    `Language: ${info.language}`,
    "",
    "Selected code:",
    "```" + info.language,
    info.text,
    "```",
].join("\n");

const openChat = async () => {
    if (configuredChatDefaultLocation() === "editor") {
        await chatProvider.openInEditor();
        return;
    }
    await vscode.commands.executeCommand("brassAgent.chat.focus");
};

const openChatInEditor = async () => {
    await chatProvider.openInEditor();
};

const focusChatLayout = async () => {
    await chatProvider.openInEditor();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
};

const askSelection = async () => {
    const info = selectionInfo();
    if (!info) {
        await vscode.window.showInformationMessage("Select code in an editor before asking Brass Agent about it.");
        return;
    }

    const question = await vscode.window.showInputBox({
        prompt: "What do you want to ask about the selected code?",
        placeHolder: "explain this selection",
        value: "explain this selection",
    });

    if (!question?.trim()) return;
    chatProvider.revealDraft(promptForSelection(question.trim(), info), "read-only");
};

const explainSelection = async () => {
    const info = selectionInfo();
    if (!info) {
        await vscode.window.showInformationMessage("Select code in an editor before asking Brass Agent to explain it.");
        return;
    }
    chatProvider.revealDraft(promptForSelection("Explain this selected code. Include important dependencies, assumptions, and risks.", info), "read-only");
};

const fixSelection = async () => {
    const info = selectionInfo();
    if (!info) {
        await vscode.window.showInformationMessage("Select code in an editor before asking Brass Agent to fix it.");
        return;
    }
    chatProvider.revealDraft(promptForSelection("Fix or improve this selected code. Prefer a minimal patch and explain the change.", info), "apply");
};

const generateTestForSelection = async () => {
    const info = selectionInfo();
    if (!info) {
        await vscode.window.showInformationMessage("Select code in an editor before asking Brass Agent to generate tests.");
        return;
    }
    chatProvider.revealDraft(promptForSelection("Generate focused tests for this selected code. Prefer a minimal patch and explain the test coverage.", info), "apply");
};

const refactorSelection = async () => {
    const info = selectionInfo();
    if (!info) {
        await vscode.window.showInformationMessage("Select code in an editor before asking Brass Agent to refactor it.");
        return;
    }
    chatProvider.revealDraft(promptForSelection("Refactor this selected code while preserving behavior. Prefer a minimal patch and call out risks.", info), "apply");
};

const rangeFromArg = (range: vscode.Range | undefined): vscode.Range | undefined => {
    if (!range) return undefined;
    if (range instanceof vscode.Range) return range;

    const candidate = range as any;
    const start = candidate.start;
    const end = candidate.end;
    if (typeof start?.line !== "number" || typeof start?.character !== "number") return undefined;
    if (typeof end?.line !== "number" || typeof end?.character !== "number") return undefined;

    return new vscode.Range(start.line, start.character, end.line, end.character);
};

const diagnosticsText = (diagnostics: readonly vscode.Diagnostic[]): string =>
    diagnostics.map((diagnostic, index) => [
        `${index + 1}. ${diagnostic.message}`,
        diagnostic.source ? `source: ${diagnostic.source}` : undefined,
        diagnostic.code !== undefined ? `code: ${String(diagnostic.code)}` : undefined,
        `severity: ${diagnostic.severity}`,
    ].filter(Boolean).join("\n")).join("\n\n");

const promptForProblem = async (intro: string, uri: vscode.Uri, rangeArg: vscode.Range, diagnostics: readonly vscode.Diagnostic[]): Promise<string> => {
    const cwd = workspaceCwd();
    const document = await vscode.workspace.openTextDocument(uri);
    const range = rangeArg.isEmpty ? document.lineAt(rangeArg.start.line).range : rangeArg;
    const file = cwd ? path.relative(cwd, uri.fsPath) || uri.fsPath : uri.fsPath;
    const snippet = document.getText(range) || document.lineAt(range.start.line).text;

    return [
        intro,
        "",
        `File: ${file}`,
        `Language: ${document.languageId || "text"}`,
        `Range: ${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`,
        "",
        diagnostics.length ? `Diagnostics:\n${diagnosticsText(diagnostics)}` : "Diagnostics: none provided.",
        "",
        "Relevant code:",
        "```" + (document.languageId || "text"),
        snippet,
        "```",
    ].join("\n");
};

const explainProblem = async (uri?: vscode.Uri, rangeArg?: vscode.Range, diagnostics: readonly vscode.Diagnostic[] = []) => {
    if (!uri || !rangeArg) {
        await vscode.window.showInformationMessage("No editor problem was provided to Brass Agent.");
        return;
    }

    const range = rangeFromArg(rangeArg);
    if (!range) {
        await vscode.window.showInformationMessage("Could not read the selected problem range.");
        return;
    }

    chatProvider.revealDraft(await promptForProblem("Explain this editor problem and suggest the smallest safe fix.", uri, range, diagnostics), "read-only");
};

const fixProblem = async (uri?: vscode.Uri, rangeArg?: vscode.Range, diagnostics: readonly vscode.Diagnostic[] = []) => {
    if (!uri || !rangeArg) {
        await vscode.window.showInformationMessage("No editor problem was provided to Brass Agent.");
        return;
    }

    const range = rangeFromArg(rangeArg);
    if (!range) {
        await vscode.window.showInformationMessage("Could not read the selected problem range.");
        return;
    }

    chatProvider.revealDraft(await promptForProblem("Fix this editor problem. Prefer a minimal patch and explain the change.", uri, range, diagnostics), "apply");
};


const runProblemAwareCommand = async (action: ProblemAction, target: ProblemTarget) => {
    chatProvider.revealDraft(
        problemAwarePrompt(action, target),
        action === "fix" ? "apply" : "read-only"
    );
};

class BrassAgentCodeActionProvider implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorRewrite,
        vscode.CodeActionKind.Source,
    ];

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const diagnostics = context.diagnostics ?? [];

        if (diagnostics.length > 0) {
            const fix = new vscode.CodeAction("Fix problem with Brass Agent", vscode.CodeActionKind.QuickFix);
            fix.command = {
                command: "brassAgent.fixProblem",
                title: "Fix problem with Brass Agent",
                arguments: [document.uri, range, diagnostics],
            };
            fix.diagnostics = [...diagnostics];
            fix.isPreferred = true;
            actions.push(fix);

            const explain = new vscode.CodeAction("Explain problem with Brass Agent", vscode.CodeActionKind.QuickFix);
            explain.command = {
                command: "brassAgent.explainProblem",
                title: "Explain problem with Brass Agent",
                arguments: [document.uri, range, diagnostics],
            };
            explain.diagnostics = [...diagnostics];
            actions.push(explain);
        }

        if (!range.isEmpty) {
            const explainSelectionAction = new vscode.CodeAction("Explain selection with Brass Agent", vscode.CodeActionKind.RefactorRewrite);
            explainSelectionAction.command = { command: "brassAgent.explainSelection", title: "Explain selection with Brass Agent" };
            actions.push(explainSelectionAction);

            const fixSelectionAction = new vscode.CodeAction("Fix selection with Brass Agent", vscode.CodeActionKind.RefactorRewrite);
            fixSelectionAction.command = { command: "brassAgent.fixSelection", title: "Fix selection with Brass Agent" };
            actions.push(fixSelectionAction);

            const refactorAction = new vscode.CodeAction("Refactor selection with Brass Agent", vscode.CodeActionKind.RefactorRewrite);
            refactorAction.command = { command: "brassAgent.refactorSelection", title: "Refactor selection with Brass Agent" };
            actions.push(refactorAction);

            const testAction = new vscode.CodeAction("Generate tests with Brass Agent", vscode.CodeActionKind.Source);
            testAction.command = { command: "brassAgent.generateTestForSelection", title: "Generate tests with Brass Agent" };
            actions.push(testAction);
        }

        return actions;
    }
}

const rerunHistoryRun = async (node?: HistoryNode | RunHistoryEntry) => {
    const entry = entryFromNode(node);
    if (!entry) return;

    const answer = await vscode.window.showInformationMessage(
        `Rerun Brass Agent goal: ${entry.goal}`,
        { modal: false },
        "Rerun"
    );
    if (answer !== "Rerun") return;

    if (entry.mode === "batch") {
        await runBrassAgentBatch({ cwd: entry.cwd, label: entry.goal, batchFile: entry.batchFile });
        return;
    }

    if (entry.mode === "apply-approved-patch" && entry.patch) {
        await applyPreviewedPatch({ cwd: entry.cwd, goal: entry.goal, patch: entry.patch });
        return;
    }

    if (entry.mode === "rollback-approved-patch" && entry.patch) {
        await rollbackPreviewedPatch({ cwd: entry.cwd, goal: entry.goal, patch: entry.patch });
        return;
    }

    const mode: RunMode = entry.mode === "read-only" ? "read-only" : entry.mode === "apply" ? "apply" : "propose";
    await runBrassAgentGoal(mode, entry.cwd, entry.goal);
};

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    output = vscode.window.createOutputChannel("Brass Agent");
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = "brassAgent.showOutput";
    status.text = "$(sparkle) Brass Agent";
    historyProvider = new RunHistoryProvider(context);
    chatProvider = new ChatViewProvider(context);
    projectProvider = new ProjectDashboardProvider(context);
    void setRunningContext(false);
    setTimeout(() => { void maybePromptLlmSetup(); }, 1200);

    context.subscriptions.push(
        output,
        status,
        historyProvider,
        chatProvider,
        projectProvider,
        vscode.window.registerWebviewViewProvider("brassAgent.project", projectProvider),
        vscode.window.registerWebviewViewProvider("brassAgent.chat", chatProvider),
        vscode.window.registerTreeDataProvider("brassAgent.runs", historyProvider),
        vscode.languages.onDidChangeDiagnostics(() => chatProvider.refreshProblemContext()),
        vscode.window.onDidChangeActiveTextEditor(() => chatProvider.refreshProblemContext()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("brassAgent")) void projectProvider.refresh();
        }),
        vscode.commands.registerCommand("brassAgent.quickRun", runQuickRun),
        vscode.commands.registerCommand("brassAgent.openProjectDashboard", openProjectDashboard),
        vscode.commands.registerCommand("brassAgent.openProjectDashboardInEditor", openProjectDashboardInEditor),
        vscode.commands.registerCommand("brassAgent.refreshProjectDashboard", () => projectProvider.refresh()),
        vscode.commands.registerCommand("brassAgent.openChat", openChat),
        vscode.commands.registerCommand("brassAgent.openChatInEditor", openChatInEditor),
        vscode.commands.registerCommand("brassAgent.focusChatLayout", focusChatLayout),
        vscode.commands.registerCommand("brassAgent.inlineAssist", runInlineAssist),
        vscode.commands.registerCommand("brassAgent.askSelection", askSelection),
        vscode.commands.registerCommand("brassAgent.explainSelection", explainSelection),
        vscode.commands.registerCommand("brassAgent.fixSelection", fixSelection),
        vscode.commands.registerCommand("brassAgent.explainProblems", () => runProblemAwareCommand("explain", "workspace")),
        vscode.commands.registerCommand("brassAgent.fixProblems", () => runProblemAwareCommand("fix", "workspace")),
        vscode.commands.registerCommand("brassAgent.fixCurrentFileProblems", () => runProblemAwareCommand("fix", "current-file")),
        vscode.commands.registerCommand("brassAgent.generateTestForSelection", generateTestForSelection),
        vscode.commands.registerCommand("brassAgent.refactorSelection", refactorSelection),
        vscode.commands.registerCommand("brassAgent.explainProblem", explainProblem),
        vscode.commands.registerCommand("brassAgent.fixProblem", fixProblem),
        vscode.languages.registerCodeActionsProvider(
            { scheme: "file" },
            new BrassAgentCodeActionProvider(),
            { providedCodeActionKinds: BrassAgentCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.commands.registerCommand("brassAgent.init", runInit),
        vscode.commands.registerCommand("brassAgent.doctor", runDoctor),
        vscode.commands.registerCommand("brassAgent.configureCli", configureCli),
        vscode.commands.registerCommand("brassAgent.configureLlm", configureLlm),
        vscode.commands.registerCommand("brassAgent.configureWorkspace", configureWorkspace),
        vscode.commands.registerCommand("brassAgent.propose", () => runBrassAgent("propose")),
        vscode.commands.registerCommand("brassAgent.apply", () => runBrassAgent("apply")),
        vscode.commands.registerCommand("brassAgent.readOnly", () => runBrassAgent("read-only")),
        vscode.commands.registerCommand("brassAgent.fixTests", () => runBrassAgentPreset("apply", "fix the failing tests")),
        vscode.commands.registerCommand("brassAgent.typecheck", () => runBrassAgentPreset("apply", "run typecheck discovery and fix type errors if possible")),
        vscode.commands.registerCommand("brassAgent.lint", () => runBrassAgentPreset("apply", "run lint discovery and fix lint errors if possible")),
        vscode.commands.registerCommand("brassAgent.runBatchFile", runBatchFile),
        vscode.commands.registerCommand("brassAgent.runConfiguredBatch", runConfiguredBatch),
        vscode.commands.registerCommand("brassAgent.showOutput", () => output.show(true)),
        vscode.commands.registerCommand("brassAgent.showLastPatchPreview", async () => {
            if (!lastPatchPreview) {
                await vscode.window.showInformationMessage("No Brass Agent patch preview is available yet.");
                return;
            }
            openPatchPreview(lastPatchPreview);
        }),
        vscode.commands.registerCommand("brassAgent.openHistoryRun", showRunDetails),
        vscode.commands.registerCommand("brassAgent.showHistoryPatch", showHistoryPatch),
        vscode.commands.registerCommand("brassAgent.rerunHistoryRun", rerunHistoryRun),
        vscode.commands.registerCommand("brassAgent.refreshHistory", () => historyProvider.refresh()),
        vscode.commands.registerCommand("brassAgent.clearHistory", clearHistory),
        vscode.commands.registerCommand("brassAgent.cancel", () => currentProcess?.kill("SIGTERM"))
    );
}

export function deactivate() {
    currentProcess?.kill("SIGTERM");
}
