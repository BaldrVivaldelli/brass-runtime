#!/usr/bin/env node

import { Runtime } from "../../core/runtime/runtime";
import {
    autoApproveApprovals,
    goalForAgentPreset,
    isAgentPreset,
    loadNodeAgentConfig,
    makeAutoDenyApprovals,
    makeConfiguredPermissions,
    makeFakeLLM,
    makeGoogleGenerativeAILLM,
    makeNodeFileSystem,
    makeNodePatchService,
    discoverNodeWorkspaceRoot,
    makeOpenAICompatibleLLM,
    NodeShell,
    observationStatus,
    runAgent,
    summarizeAgentAction,
    summarizeAgentObservation,
    type AgentAction,
    type AgentConfig,
    type AgentEnv,
    type AgentEvent,
    type AgentEventSink,
    type AgentLLMConfig,
    type AgentMode,
    type AgentResponseLanguage,
    type ApprovalService,
    type AgentBatchGoal,
    type AgentPreset,
    type AgentState,
    type LLM,
    type Observation,
} from "../index";
import { makeCliApprovalService } from "./approvals";
import { printAgentDoctorReport, runAgentDoctor } from "./doctor";
import { loadAgentEnvFile, type AgentEnvFileLoadResult } from "./envFile";
import { initializeAgentWorkspace, printAgentInitResult, type AgentInitProfile } from "./init";

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

const readPatchFile = async (cwd: string, patchFile: string): Promise<string> => {
    const nodePath = await dynamicImport("node:path");
    const nodeFs = await dynamicImport("node:fs/promises");
    return nodeFs.readFile(nodePath.resolve(cwd, patchFile), "utf8");
};

type CliOutputMode = "human" | "json" | "events-json" | "protocol-json";
type CliApprovalMode = "auto" | "interactive" | "approve" | "deny";
type CliPreset = AgentPreset;

type ParsedCliArgs = {
    readonly cwd: string;
    readonly discoverWorkspace: boolean;
    readonly where: boolean;
    readonly goalText: string;
    readonly mode: AgentMode;
    readonly modeSpecified: boolean;
    readonly showHelp: boolean;
    readonly output: CliOutputMode;
    readonly approval: CliApprovalMode;
    readonly approvalSpecified: boolean;
    readonly configPath?: string;
    readonly noConfig: boolean;
    readonly envFile?: string;
    readonly noEnvFile: boolean;
    readonly protocolFullPatches: boolean;
    readonly patchFile?: string;
    readonly patchFileMode: "apply" | "rollback";
    readonly saveRunDir?: string;
    readonly ci: boolean;
    readonly failOnPatchProposed: boolean;
    readonly preset?: CliPreset;
    readonly batchFile?: string;
    readonly batchStopOnFailure?: boolean;
    readonly doctor: boolean;
    readonly init: boolean;
    readonly initForce: boolean;
    readonly initProfile: AgentInitProfile;
    readonly initDryRun: boolean;
    readonly language?: AgentResponseLanguage;
};

type CliBatchRun = {
    readonly index: number;
    readonly cwd: string;
    readonly goalText: string;
    readonly mode: AgentMode;
    readonly patchFile?: string;
    readonly patchFileMode: "apply" | "rollback";
    readonly saveRunDir?: string;
};

type CliRunResult = {
    readonly run: CliBatchRun;
    readonly state: AgentState;
    readonly exitCode: number;
};

type ResolvedCliArgs = ParsedCliArgs & {
    readonly config: AgentConfig;
    readonly workspaceDiscovery: ReturnType<typeof discoverNodeWorkspaceRoot>;
    readonly resolvedConfigPath?: string;
    readonly batchRuns: readonly CliBatchRun[];
    readonly batchStopOnFailureResolved: boolean;
    readonly envFileLoad: AgentEnvFileLoadResult;
};

const parseOptionalNumber = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim() === "") return undefined;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const isAgentMode = (value: string): value is AgentMode =>
    value === "read-only" || value === "propose" || value === "write" || value === "autonomous";

const isCliApprovalMode = (value: string): value is CliApprovalMode =>
    value === "auto" || value === "interactive" || value === "approve" || value === "deny";

const isAgentInitProfile = (value: string): value is AgentInitProfile =>
    value === "default" || value === "google" || value === "openai-compatible" || value === "fake";

const isAgentResponseLanguage = (value: string): value is AgentResponseLanguage =>
    ["auto", "match-user", "en", "es", "pt", "fr", "de", "it", "custom"].includes(value);

const readFlagValue = (argv: readonly string[], index: number, flag: string): readonly [string, number] => {
    const current = argv[index];
    const inlineValue = current.startsWith(`${flag}=`) ? current.slice(flag.length + 1) : undefined;

    if (inlineValue !== undefined && inlineValue !== "") return [inlineValue, index];

    const next = argv[index + 1];
    if (!next) throw new Error(`${flag} requires a value`);

    return [next, index + 1];
};

const parseCliArgs = (argv: readonly string[]): ParsedCliArgs => {
    let cwd = process.cwd();
    let discoverWorkspace = true;
    let where = false;
    let mode: AgentMode = "propose";
    let modeSpecified = false;
    let showHelp = false;
    let output: CliOutputMode = "human";
    let approval: CliApprovalMode = "auto";
    let approvalSpecified = false;
    let configPath: string | undefined;
    let noConfig = false;
    let envFile: string | undefined;
    let noEnvFile = false;
    let protocolFullPatches = false;
    let patchFile: string | undefined;
    let patchFileMode: "apply" | "rollback" = "apply";
    let saveRunDir: string | undefined;
    let ci = false;
    let failOnPatchProposed = false;
    let preset: CliPreset | undefined;
    let batchFile: string | undefined;
    let batchStopOnFailure: boolean | undefined;
    let doctor = false;
    let init = false;
    let initForce = false;
    let initProfile: AgentInitProfile = "default";
    let initDryRun = false;
    let language: AgentResponseLanguage | undefined;
    const goalParts: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "--") {
            goalParts.push(...argv.slice(index + 1));
            break;
        }

        if (arg === "--help" || arg === "-h") {
            showHelp = true;
            continue;
        }

        if (arg === "--doctor") {
            doctor = true;
            continue;
        }

        if (arg === "--where" || arg === "--print-workspace") {
            where = true;
            continue;
        }

        if (arg === "--no-discover-workspace") {
            discoverWorkspace = false;
            continue;
        }

        if (arg === "--init") {
            init = true;
            continue;
        }

        if (arg === "--force" || arg === "--init-force") {
            initForce = true;
            continue;
        }

        if (arg === "--init-dry-run") {
            initDryRun = true;
            continue;
        }

        if (arg === "--init-profile" || arg.startsWith("--init-profile=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--init-profile");
            if (!isAgentInitProfile(value)) {
                throw new Error("--init-profile requires one of: default, google, openai-compatible, fake");
            }
            initProfile = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--init-provider" || arg.startsWith("--init-provider=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--init-provider");
            if (value === "auto") {
                initProfile = "default";
            } else if (isAgentInitProfile(value)) {
                initProfile = value;
            } else {
                throw new Error("--init-provider requires one of: auto, fake, google, openai-compatible");
            }
            index = nextIndex;
            continue;
        }


        if (arg === "--language" || arg.startsWith("--language=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--language");
            if (!isAgentResponseLanguage(value)) {
                throw new Error("--language requires one of: auto, match-user, en, es, pt, fr, de, it, custom");
            }
            language = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--json") {
            output = "json";
            continue;
        }

        if (arg === "--events-json") {
            output = "events-json";
            continue;
        }

        if (arg === "--protocol-json") {
            output = "protocol-json";
            continue;
        }

        if (arg === "--protocol-full-patches") {
            protocolFullPatches = true;
            continue;
        }

        if (arg === "--preset" || arg.startsWith("--preset=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--preset");
            if (!isAgentPreset(value)) {
                throw new Error("--preset requires one of: fix-tests, inspect, typecheck, lint");
            }
            preset = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--batch-file" || arg.startsWith("--batch-file=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--batch-file");
            batchFile = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--batch-stop-on-failure") {
            batchStopOnFailure = true;
            continue;
        }

        if (arg === "--batch-continue-on-failure") {
            batchStopOnFailure = false;
            continue;
        }

        if (arg === "--ci") {
            ci = true;
            continue;
        }

        if (arg === "--fail-on-patch-proposed") {
            failOnPatchProposed = true;
            continue;
        }

        if (arg === "--yes" || arg === "-y") {
            approval = "approve";
            approvalSpecified = true;
            continue;
        }

        if (arg === "--no-input") {
            approval = "deny";
            approvalSpecified = true;
            continue;
        }

        if (arg === "--approval" || arg.startsWith("--approval=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--approval");
            if (!isCliApprovalMode(value)) {
                throw new Error("--approval requires one of: auto, interactive, approve, deny");
            }
            approval = value;
            approvalSpecified = true;
            index = nextIndex;
            continue;
        }

        if (arg === "--apply") {
            mode = "write";
            modeSpecified = true;
            continue;
        }

        if (arg === "--patch-file" || arg.startsWith("--patch-file=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--patch-file");
            patchFile = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--apply-patch-file" || arg.startsWith("--apply-patch-file=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--apply-patch-file");
            patchFile = value;
            patchFileMode = "apply";
            mode = "write";
            modeSpecified = true;
            index = nextIndex;
            continue;
        }

        if (arg === "--rollback-patch-file" || arg.startsWith("--rollback-patch-file=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--rollback-patch-file");
            patchFile = value;
            patchFileMode = "rollback";
            mode = "write";
            modeSpecified = true;
            index = nextIndex;
            continue;
        }

        if (arg === "--mode" || arg.startsWith("--mode=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--mode");
            if (!isAgentMode(value)) {
                throw new Error("--mode requires one of: read-only, propose, write, autonomous");
            }
            mode = value;
            modeSpecified = true;
            index = nextIndex;
            continue;
        }

        if (arg === "--cwd" || arg.startsWith("--cwd=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--cwd");
            cwd = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--save-run" || arg.startsWith("--save-run=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--save-run");
            saveRunDir = value;
            index = nextIndex;
            continue;
        }

        if (arg === "--config" || arg.startsWith("--config=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--config");
            configPath = value;
            noConfig = false;
            index = nextIndex;
            continue;
        }

        if (arg === "--no-config") {
            configPath = undefined;
            noConfig = true;
            continue;
        }

        if (arg === "--env-file" || arg.startsWith("--env-file=")) {
            const [value, nextIndex] = readFlagValue(argv, index, "--env-file");
            envFile = value;
            noEnvFile = false;
            index = nextIndex;
            continue;
        }

        if (arg === "--no-env-file") {
            envFile = undefined;
            noEnvFile = true;
            continue;
        }

        if (arg.startsWith("--")) {
            throw new Error(`Unknown option: ${arg}`);
        }

        goalParts.push(arg);
    }

    return {
        cwd,
        discoverWorkspace,
        where,
        goalText: goalParts.join(" ").trim(),
        mode,
        modeSpecified,
        showHelp,
        output,
        approval,
        approvalSpecified,
        ...(configPath ? { configPath } : {}),
        noConfig,
        ...(envFile ? { envFile } : {}),
        noEnvFile,
        protocolFullPatches,
        patchFileMode,
        ci,
        failOnPatchProposed,
        ...(preset ? { preset } : {}),
        ...(batchFile ? { batchFile } : {}),
        ...(batchStopOnFailure !== undefined ? { batchStopOnFailure } : {}),
        doctor,
        init,
        initForce,
        initProfile,
        initDryRun,
        ...(language ? { language } : {}),
        ...(saveRunDir ? { saveRunDir } : {}),
        ...(patchFile ? { patchFile } : {}),
    };
};


const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const parseBatchGoal = (value: unknown, path: string): AgentBatchGoal => {
    if (typeof value === "string") return value;
    if (!isRecord(value)) throw new Error(`${path} must be a string or object.`);

    const goal = value.goal;
    const preset = value.preset;
    const mode = value.mode;
    const cwd = value.cwd;
    const patchFile = value.patchFile;
    const patchFileMode = value.patchFileMode;
    const saveRunDir = value.saveRunDir;

    if (goal !== undefined && typeof goal !== "string") throw new Error(`${path}.goal must be a string.`);
    if (cwd !== undefined && typeof cwd !== "string") throw new Error(`${path}.cwd must be a string.`);
    if (patchFile !== undefined && typeof patchFile !== "string") throw new Error(`${path}.patchFile must be a string.`);
    if (saveRunDir !== undefined && typeof saveRunDir !== "string") throw new Error(`${path}.saveRunDir must be a string.`);

    if (preset !== undefined && (typeof preset !== "string" || !isAgentPreset(preset))) {
        throw new Error(`${path}.preset must be one of: fix-tests, inspect, typecheck, lint.`);
    }

    if (mode !== undefined && (typeof mode !== "string" || !isAgentMode(mode))) {
        throw new Error(`${path}.mode must be one of: read-only, propose, write, autonomous.`);
    }

    if (patchFileMode !== undefined && patchFileMode !== "apply" && patchFileMode !== "rollback") {
        throw new Error(`${path}.patchFileMode must be apply or rollback.`);
    }

    if (goal === undefined && preset === undefined && patchFile === undefined) {
        throw new Error(`${path} must include goal, preset, or patchFile.`);
    }

    return {
        ...(goal ? { goal } : {}),
        ...(preset ? { preset } : {}),
        ...(mode ? { mode } : {}),
        ...(cwd ? { cwd } : {}),
        ...(patchFile ? { patchFile } : {}),
        ...(patchFileMode ? { patchFileMode } : {}),
        ...(saveRunDir ? { saveRunDir } : {}),
    };
};

const parseBatchGoalsJson = (value: unknown): readonly AgentBatchGoal[] => {
    const rawGoals = Array.isArray(value)
        ? value
        : isRecord(value) && Array.isArray(value.goals)
            ? value.goals
            : undefined;

    if (!rawGoals) throw new Error("Batch file must be a JSON array or an object with a goals array.");
    return rawGoals.map((goal, index) => parseBatchGoal(goal, `goals[${index}]`));
};

const readBatchFile = async (cwd: string, batchFile: string): Promise<readonly AgentBatchGoal[]> => {
    const nodePath = await dynamicImport("node:path");
    const nodeFs = await dynamicImport("node:fs/promises");
    const path = nodePath.isAbsolute(batchFile) ? batchFile : nodePath.resolve(cwd, batchFile);
    const raw = String(await nodeFs.readFile(path, "utf8")).replace(/^\uFEFF/, "");

    try {
        return parseBatchGoalsJson(JSON.parse(raw));
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;

        const goals = raw
            .split(/\r?\n/g)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));

        if (goals.length === 0) throw new Error(`Batch file has no goals: ${path}`);
        return goals;
    }
};

const resolveBatchGoalText = (item: AgentBatchGoal, fallbackPatchFile: string | undefined): string => {
    if (typeof item === "string") return item;
    if (item.goal) return item.goal;
    if (item.preset) return goalForAgentPreset(item.preset);
    if (item.patchFile ?? fallbackPatchFile) return "apply supplied patch";
    return "";
};

const resolveBatchMode = (item: AgentBatchGoal, parsed: ParsedCliArgs, config: AgentConfig): AgentMode => {
    if (typeof item !== "string" && item.mode) return item.mode;
    if (typeof item !== "string" && item.preset === "inspect" && !parsed.modeSpecified) return "read-only";
    return parsed.modeSpecified ? parsed.mode : config.mode ?? parsed.mode;
};

const resolveBatchRuns = (
    items: readonly AgentBatchGoal[],
    parsed: ParsedCliArgs,
    config: AgentConfig
): readonly CliBatchRun[] => items.map((item, index) => {
    const goalText = resolveBatchGoalText(item, parsed.patchFile);
    const cwd = typeof item === "string" ? parsed.cwd : item.cwd ?? parsed.cwd;
    const patchFile = typeof item === "string" ? parsed.patchFile : item.patchFile ?? parsed.patchFile;
    const patchFileMode = typeof item === "string" ? parsed.patchFileMode : item.patchFileMode ?? parsed.patchFileMode;
    const saveRunDir = typeof item === "string" ? parsed.saveRunDir : item.saveRunDir ?? parsed.saveRunDir;

    if (!goalText) throw new Error(`Batch goal ${index + 1} resolved to an empty goal.`);

    return {
        index,
        cwd,
        goalText,
        mode: resolveBatchMode(item, parsed, config),
        patchFileMode,
        ...(patchFile ? { patchFile } : {}),
        ...(saveRunDir ? { saveRunDir } : {}),
    };
});

const resolveParsedConfig = async (parsed: ParsedCliArgs): Promise<ResolvedCliArgs> => {
    const workspaceDiscovery = discoverNodeWorkspaceRoot(parsed.cwd, {
        enabled: parsed.discoverWorkspace,
    });
    const cwdResolved = workspaceDiscovery.cwd;
    const parsedAtWorkspace = {
        ...parsed,
        cwd: cwdResolved,
    };

    const loaded = await loadNodeAgentConfig({
        cwd: cwdResolved,
        configPath: parsed.configPath,
        noConfig: parsed.noConfig,
    });
    const envFileLoad = loadAgentEnvFile({
        cwd: cwdResolved,
        envFile: parsed.envFile,
        noEnvFile: parsed.noEnvFile,
        allowedExtraKeys: loaded.config.llm?.apiKeyEnv ? [loaded.config.llm.apiKeyEnv] : [],
    });

    const shouldUseConfigBatch = !parsed.goalText && !parsed.preset && !parsed.patchFile;
    const batchItems = parsed.batchFile
        ? await readBatchFile(cwdResolved, parsed.batchFile)
        : shouldUseConfigBatch ? loaded.config.batch?.goals ?? [] : [];
    const batchRuns = resolveBatchRuns(batchItems, parsedAtWorkspace, loaded.config);

    return {
        ...parsedAtWorkspace,
        goalText: parsed.goalText || (parsed.preset ? goalForAgentPreset(parsed.preset) : parsed.patchFile ? "apply supplied patch" : parsed.goalText),
        mode: parsed.modeSpecified ? parsed.mode : parsed.preset === "inspect" ? "read-only" : loaded.config.mode ?? parsed.mode,
        approval: parsed.approvalSpecified ? parsed.approval : loaded.config.approval ?? parsed.approval,
        config: loaded.config,
        workspaceDiscovery,
        batchRuns,
        batchStopOnFailureResolved: parsed.batchStopOnFailure ?? loaded.config.batch?.stopOnFailure ?? parsed.ci,
        envFileLoad,
        ...(loaded.path ? { resolvedConfigPath: loaded.path } : {}),
    };
};

const printHelp = () => {
    console.log([
        'Usage: brass-agent [options] "goal"',
        "",
        "Options:",
        "  --mode read-only|propose|write|autonomous",
        "      Agent permission mode. Default: propose, or config.mode if present.",
        "  --preset fix-tests|inspect|typecheck|lint",
        "      Use a built-in goal preset when no explicit goal text is provided.",
        "  --apply",
        "      Alias for --mode write.",
        "  --cwd PATH",
        "      Starting directory for workspace discovery. Default: current directory.",
        "  --no-discover-workspace",
        "      Use --cwd exactly instead of searching upward for package.json, .brass-agent.json, or .git.",
        "  --where, --print-workspace",
        "      Print the resolved workspace root and exit.",
        "  --config PATH",
        "      Load a specific .brass-agent.json policy/config file.",
        "  --save-run DIR",
        "      Write final run JSON and Markdown artifacts to DIR.",
        "  --batch-file PATH",
        "      Run multiple goals sequentially from a JSON or line-based file.",
        "  --batch-stop-on-failure",
        "      Stop a batch after the first failed run.",
        "  --batch-continue-on-failure",
        "      Continue a batch even when a run fails.",
        "  --doctor",
        "      Check local CLI, workspace, VS Code, package manager, and LLM setup.",
        "  --init",
        "      Initialize this workspace with .brass-agent.json, brass-agent.batch.json, .env.example, and BRASS_AGENT.md.",
        "  --force, --init-force",
        "      Overwrite files generated by --init when they already exist.",
        "  --init-profile default|google|openai-compatible|fake",
        "      Initialization profile. Default: default, which leaves provider auto-detection enabled.",
        "  --init-provider auto|fake|google|openai-compatible",
        "      Alias for choosing an LLM-oriented init profile. auto maps to default.",
        "  --init-dry-run",
        "      Preview generated files without writing them.",
        "  --no-config",
        "      Do not discover or load an agent config file.",
        "  --language auto|match-user|en|es|pt|fr|de|it",
        "      Response language for LLM summaries. Default: config.language or auto-match the user goal.",
        "  --env-file PATH",
        "      Load Brass Agent environment variables from a specific env file.",
        "  --no-env-file",
        "      Do not auto-load .brass-agent.env, .env.local, or .env from --cwd.",
        "  --json",
        "      Print the full final AgentState JSON. Suppresses live event output.",
        "  --ci",
        "      Preserve output mode but set process exit codes from the final run status.",
        "  --fail-on-patch-proposed",
        "      In --ci mode, exit 2 when a patch was proposed but not applied.",
        "  --events-json",
        "      Stream AgentEvent objects as JSON Lines. Does not print the final AgentState.",
        "  --protocol-json",
        "      Stream Brass Agent protocol JSON Lines, including events and a final-state message.",
        "  --protocol-full-patches",
        "      Keep patch payloads untruncated in protocol/event JSON output for trusted local integrations.",
        "  --patch-file PATH",
        "      Supply a precomputed unified diff to the agent. Respects --mode.",
        "  --apply-patch-file PATH",
        "      Supply and apply a precomputed unified diff. Alias for --patch-file PATH --mode write.",
        "  --rollback-patch-file PATH",
        "      Reverse-apply a precomputed unified diff through PatchService. Requires write mode approvals.",
        "  --yes, -y",
        "      Auto-approve approval prompts. Useful for CI and smoke tests.",
        "  --no-input",
        "      Do not prompt; reject any action that requires approval.",
        "  --approval auto|interactive|approve|deny",
        "      Approval strategy. Default: auto, or config.approval if present.",
        "  --help, -h",
        "      Show this help message.",
        "",
        "Config files:",
        "  brass-agent first resolves a workspace root by searching upward from --cwd.",
        "  It looks for .brass-agent.json, brass-agent.config.json, package.json, workspace markers, or .git.",
        "  brass-agent then searches upward from that workspace root for .brass-agent.json or brass-agent.config.json.",
        "  config.batch.goals can define a default batch when --batch-file is not provided.",
        "",
        "Examples:",
        '  brass-agent "fix the failing tests"',
        '  brass-agent --preset fix-tests',
        '  brass-agent --preset inspect',
        '  brass-agent --batch-file ./brass-agent.batch.json --ci',
        '  brass-agent --where',
        '  brass-agent --doctor',
        '  brass-agent --doctor --json',
        '  brass-agent --env-file .env --doctor',
        '  brass-agent --init',
        '  brass-agent --init --init-profile google',
        '  brass-agent --init --init-profile fake --init-dry-run',
        '  brass-agent --config ./agent.policy.json "fix the failing tests"',
        '  brass-agent --no-config "fix the failing tests"',
        '  brass-agent --json "fix the failing tests"',
        '  brass-agent --events-json "fix the failing tests"',
        '  brass-agent --protocol-json "fix the failing tests"',
        '  brass-agent --protocol-json --protocol-full-patches "fix the failing tests"',
        '  brass-agent --apply-patch-file ./approved.diff --yes "apply approved patch"',
        '  brass-agent --apply "fix the failing tests"',
        '  brass-agent --apply --yes "fix the failing tests"',
        '  brass-agent --mode read-only --cwd ./repo "inspect the test failure"',
        "",
        "LLM providers:",
        "  BRASS_LLM_PROVIDER=fake",
        "  BRASS_LLM_PROVIDER=google GEMINI_API_KEY=...",
        "  BRASS_LLM_PROVIDER=openai-compatible BRASS_LLM_ENDPOINT=... BRASS_LLM_API_KEY=...",
    ].join("\n"));
};

const envByName = (name: string | undefined): string | undefined => name ? process.env[name] : undefined;

const makeGoogleLLMFromEnv = (config?: AgentLLMConfig): LLM | undefined => {
    const apiKey = envByName(config?.apiKeyEnv)
        ?? process.env.BRASS_GOOGLE_API_KEY
        ?? process.env.GOOGLE_API_KEY
        ?? process.env.GEMINI_API_KEY;

    if (!apiKey) return undefined;

    return makeGoogleGenerativeAILLM({
        apiKey,
        model: process.env.BRASS_GOOGLE_MODEL ?? process.env.BRASS_LLM_MODEL ?? config?.model ?? "gemini-2.5-flash",
        apiVersion: process.env.BRASS_GOOGLE_API_VERSION ?? config?.apiVersion ?? "v1beta",
        baseUrl: process.env.BRASS_GOOGLE_BASE_URL ?? config?.baseUrl,
        endpoint: process.env.BRASS_GOOGLE_ENDPOINT ?? config?.endpoint,
        systemInstruction: process.env.BRASS_GOOGLE_SYSTEM_INSTRUCTION ?? config?.systemInstruction,
        temperature: parseOptionalNumber(process.env.BRASS_GOOGLE_TEMPERATURE) ?? config?.temperature,
        topP: parseOptionalNumber(process.env.BRASS_GOOGLE_TOP_P) ?? config?.topP,
        topK: parseOptionalNumber(process.env.BRASS_GOOGLE_TOP_K) ?? config?.topK,
        maxOutputTokens: parseOptionalNumber(process.env.BRASS_GOOGLE_MAX_OUTPUT_TOKENS) ?? config?.maxOutputTokens,
    });
};

const makeOpenAICompatibleLLMFromEnv = (config?: AgentLLMConfig): LLM | undefined => {
    const endpoint = process.env.BRASS_LLM_ENDPOINT ?? config?.endpoint;
    const apiKey = envByName(config?.apiKeyEnv) ?? process.env.BRASS_LLM_API_KEY;
    const model = process.env.BRASS_LLM_MODEL ?? config?.model ?? "gpt-4.1";

    if (!endpoint || !apiKey) return undefined;
    return makeOpenAICompatibleLLM({ endpoint, apiKey, model });
};

const makeLLMFromEnv = (config?: AgentLLMConfig): LLM => {
    const provider = (process.env.BRASS_LLM_PROVIDER ?? config?.provider)?.trim().toLowerCase();
    const fakeResponse = process.env.BRASS_FAKE_LLM_RESPONSE ?? config?.fakeResponse;

    if (provider === "fake") return makeFakeLLM({ content: fakeResponse });

    if (provider === "google" || provider === "gemini") {
        const google = makeGoogleLLMFromEnv(config);
        if (!google) {
            throw new Error(
                "Google LLM provider requires BRASS_GOOGLE_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY, or config.llm.apiKeyEnv."
            );
        }
        return google;
    }

    if (provider === "openai" || provider === "openai-compatible") {
        const openAICompatible = makeOpenAICompatibleLLMFromEnv(config);
        if (!openAICompatible) {
            throw new Error(
                "OpenAI-compatible LLM provider requires BRASS_LLM_ENDPOINT/config.llm.endpoint and BRASS_LLM_API_KEY/config.llm.apiKeyEnv."
            );
        }
        return openAICompatible;
    }

    if (provider) {
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    return makeGoogleLLMFromEnv(config)
        ?? makeOpenAICompatibleLLMFromEnv(config)
        ?? makeFakeLLM({ content: fakeResponse });
};

const parseApprovalModeFromEnv = (): CliApprovalMode | undefined => {
    const raw = process.env.BRASS_AGENT_APPROVAL?.trim().toLowerCase();
    if (!raw) return undefined;
    if (isCliApprovalMode(raw)) return raw;
    throw new Error("BRASS_AGENT_APPROVAL must be one of: auto, interactive, approve, deny");
};

const envTruthy = (value: string | undefined): boolean =>
    value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";

const canPromptInteractively = (): boolean => Boolean(process.stdin?.isTTY && (process.stderr?.isTTY ?? process.stdout?.isTTY));

const resolveApprovalMode = (parsed: ResolvedCliArgs): Exclude<CliApprovalMode, "auto"> => {
    if (parsed.approvalSpecified && parsed.approval !== "auto") return parsed.approval;
    if (envTruthy(process.env.BRASS_AGENT_AUTO_APPROVE)) return "approve";

    const fromEnv = parseApprovalModeFromEnv();
    if (fromEnv && fromEnv !== "auto") return fromEnv;

    if (parsed.approval !== "auto") return parsed.approval;
    if (parsed.output === "human" && canPromptInteractively()) return "interactive";
    return "deny";
};

const makeApprovalServiceFromCli = (parsed: ResolvedCliArgs): ApprovalService => {
    const mode = resolveApprovalMode(parsed);

    switch (mode) {
        case "approve":
            return autoApproveApprovals;
        case "deny":
            return makeAutoDenyApprovals("Approval rejected because the CLI is running without interactive input. Use --yes to auto-approve.");
        case "interactive":
            return makeCliApprovalService();
    }
};

const truncate = (value: string, max = 2_000): string => {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n… truncated ${value.length - max} chars`;
};

const compactText = (value: string, max = 1_000): string => {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}… truncated ${value.length - max} chars`;
};

type CompactOptions = {
    readonly fullPatches?: boolean;
};

const compactPatchText = (value: string, options: CompactOptions): string =>
    options.fullPatches ? value : compactText(value);

const compactGoal = (goal: AgentState["goal"], options: CompactOptions): unknown => ({
    ...goal,
    ...(goal.initialPatch ? { initialPatch: compactPatchText(goal.initialPatch, options) } : {}),
});

const compactAction = (action: AgentAction, options: CompactOptions = {}): unknown => {
    switch (action.type) {
        case "llm.complete":
            return { ...action, prompt: compactText(action.prompt) };
        case "patch.apply":
        case "patch.rollback":
        case "patch.propose":
            return { ...action, patch: compactPatchText(action.patch, options) };
        default:
            return action;
    }
};

const compactObservation = (observation: Observation, options: CompactOptions = {}): unknown => {
    switch (observation.type) {
        case "fs.fileRead":
            return { ...observation, content: compactText(observation.content) };
        case "llm.response":
            return { ...observation, content: compactText(observation.content) };
        case "shell.result":
            return {
                ...observation,
                stdout: compactText(observation.stdout),
                stderr: compactText(observation.stderr),
            };
        case "fs.searchResult":
            return {
                ...observation,
                matches: observation.matches.slice(0, 30),
                omittedMatches: Math.max(0, observation.matches.length - 30),
            };
        case "patch.proposed":
            return { ...observation, patch: compactPatchText(observation.patch, options) };
        case "patch.applied":
        case "patch.rolledBack":
            return observation.patch
                ? { ...observation, patch: compactPatchText(observation.patch, options) }
                : observation;
        default:
            return observation;
    }
};

const compactAgentEvent = (event: AgentEvent, options: CompactOptions = {}): unknown => {
    switch (event.type) {
        case "agent.run.started":
        case "agent.run.completed":
            return { ...event, goal: compactGoal(event.goal, options) };
        case "agent.action.started":
            return { ...event, action: compactAction(event.action, options) };
        case "agent.action.completed":
            return { ...event, action: compactAction(event.action, options), observation: compactObservation(event.observation, options) };
        case "agent.action.failed":
            return { ...event, action: compactAction(event.action, options) };
        case "agent.observation.recorded":
            return { ...event, observation: compactObservation(event.observation, options) };
        case "agent.tool.timeout":
        case "agent.permission.denied":
        case "agent.approval.requested":
        case "agent.approval.resolved":
            return { ...event, action: compactAction(event.action, options) };
        default:
            return event;
    }
};

const compactAgentState = (state: AgentState, options: CompactOptions = {}): unknown => ({
    ...state,
    goal: compactGoal(state.goal, options),
    observations: state.observations.map((observation) => compactObservation(observation, options)),
    errors: state.errors.map((error) => {
        switch (error._tag) {
            case "PermissionDenied":
            case "ApprovalRejected":
                return { ...error, action: compactAction(error.action, options) };
            case "PatchError":
                return {
                    ...error,
                    cause: String(error.cause),
                    ...(error.patch ? { patch: compactPatchText(error.patch, options) } : {}),
                };
            case "FsError":
            case "ShellError":
            case "LLMError":
                return { ...error, cause: String(error.cause) };
            default:
                return error;
        }
    }),
});

const protocolEnvelope = (message: { readonly type: "event" | "final-state" | "batch-summary"; readonly event?: unknown; readonly state?: unknown; readonly summary?: unknown }): unknown => ({
    protocol: "brass-agent",
    version: 1,
    ...message,
});

const statusIcon = (status: "ok" | "warn" | "fail"): string => {
    switch (status) {
        case "ok":
            return "✓";
        case "warn":
            return "!";
        case "fail":
            return "✗";
    }
};

const formatDuration = (durationMs: number): string => `${Math.max(0, durationMs)}ms`;

const latestObservation = <T extends Observation["type"]>(
    state: AgentState,
    type: T
): Extract<Observation, { type: T }> | undefined =>
    [...state.observations].reverse().find((obs): obs is Extract<Observation, { type: T }> => obs.type === type);

const createHumanEventSink = (configPath: string | undefined): AgentEventSink => ({
    emit(event) {
        switch (event.type) {
            case "agent.run.started":
                console.log(`brass-agent ${event.goal.mode}`);
                console.log(`workspace: ${event.goal.cwd}`);
                if (configPath) console.log(`config: ${configPath}`);
                console.log(`goal: ${event.goal.text}`);
                console.log("");
                break;

            case "agent.action.started":
                console.log(`→ ${summarizeAgentAction(event.action)}`);
                break;

            case "agent.action.completed": {
                const status = observationStatus(event.observation);
                console.log(`${statusIcon(status)} ${summarizeAgentObservation(event.observation)} ${formatDuration(event.durationMs)}`);
                break;
            }

            case "agent.action.failed":
                if (event.error._tag !== "ToolTimeout" && event.error._tag !== "PermissionDenied" && event.error._tag !== "ApprovalRejected") {
                    console.log(`✗ ${summarizeAgentAction(event.action)} failed with ${event.error._tag} ${formatDuration(event.durationMs)}`);
                }
                break;

            case "agent.tool.timeout":
                console.log(`! ${summarizeAgentAction(event.action)} timed out after ${event.timeoutMs}ms`);
                break;

            case "agent.permission.denied":
                console.log(`✗ ${summarizeAgentAction(event.action)} denied: ${event.reason}`);
                break;

            case "agent.approval.requested":
                console.log(`? approval required for ${summarizeAgentAction(event.action)} (${event.risk})`);
                break;

            case "agent.approval.resolved":
                if (event.approved) {
                    console.log(`✓ approval granted for ${summarizeAgentAction(event.action)}`);
                } else {
                    console.log(`✗ approval rejected for ${summarizeAgentAction(event.action)}${event.reason ? `: ${event.reason}` : ""}`);
                }
                break;

            case "agent.patch.applied":
                break;

            case "agent.patch.rolledBack":
                if (event.automatic) {
                    console.log(`✓ automatic rollback completed (${event.changedFiles.join(", ") || "no files reported"})`);
                }
                break;

            case "agent.observation.recorded":
            case "agent.run.completed":
                break;
        }
    },
});

const createJsonEventSink = (options: CompactOptions = {}): AgentEventSink => ({
    emit(event) {
        console.log(JSON.stringify(compactAgentEvent(event, options)));
    },
});

const createProtocolEventSink = (options: CompactOptions = {}): AgentEventSink => ({
    emit(event) {
        console.log(JSON.stringify(protocolEnvelope({ type: "event", event: compactAgentEvent(event, options) })));
    },
});


const safeFilePart = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";

const markdownEscape = (value: string): string =>
    value
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`");

const writeRunArtifacts = async (state: AgentState, outputDir: string, options: CompactOptions): Promise<void> => {
    const nodePath = await dynamicImport("node:path");
    const nodeFs = await dynamicImport("node:fs/promises");
    const dir = nodePath.isAbsolute(outputDir) ? outputDir : nodePath.resolve(state.goal.cwd, outputDir);
    await nodeFs.mkdir(dir, { recursive: true });

    const id = safeFilePart(state.goal.id);
    const base = `${id}-${safeFilePart(state.goal.text)}`;
    const jsonPath = nodePath.join(dir, `${base}.json`);
    const mdPath = nodePath.join(dir, `${base}.md`);
    const done = latestObservation(state, "agent.done");
    const error = latestObservation(state, "agent.error");
    const appliedPatch = latestObservation(state, "patch.applied");
    const rolledBackPatch = latestObservation(state, "patch.rolledBack");

    await nodeFs.writeFile(jsonPath, `${JSON.stringify(compactAgentState(state, options), null, 2)}\n`, "utf8");
    await nodeFs.writeFile(mdPath, [
        `# Brass Agent Run ${markdownEscape(state.goal.id)}`,
        "",
        `- Goal: ${markdownEscape(state.goal.text)}`,
        `- Workspace: ${markdownEscape(state.goal.cwd)}`,
        `- Mode: ${state.goal.mode}`,
        `- Phase: ${state.phase}`,
        `- Steps: ${state.steps}`,
        appliedPatch ? `- Changed files: ${appliedPatch.changedFiles.join(", ") || "none reported"}` : undefined,
        rolledBackPatch ? `- Rolled back files: ${rolledBackPatch.changedFiles.join(", ") || "none reported"}` : undefined,
        "",
        "## Summary",
        "",
        done?.summary?.trim() || (error ? `Error: ${error.error._tag}` : "No summary recorded."),
    ].filter(Boolean).join("\n"), "utf8");

    if (process.stderr?.isTTY) {
        console.error(`saved run artifacts: ${jsonPath} ${mdPath}`);
    }
};


const latestShellResult = (state: AgentState): Extract<Observation, { type: "shell.result" }> | undefined =>
    latestObservation(state, "shell.result");

const computeCiExitCode = (state: AgentState, options: { readonly failOnPatchProposed: boolean }): number => {
    if (latestObservation(state, "agent.error")) return 1;
    const latestShell = latestShellResult(state);
    if (latestShell && latestShell.exitCode !== 0) return 1;
    if (options.failOnPatchProposed && latestObservation(state, "patch.proposed") && !latestObservation(state, "patch.applied")) {
        return 2;
    }
    return 0;
};

const printHumanFinalSummary = (state: AgentState) => {
    const done = latestObservation(state, "agent.done");
    const error = latestObservation(state, "agent.error");
    const proposedPatch = latestObservation(state, "patch.proposed");
    const appliedPatch = latestObservation(state, "patch.applied");
    const rolledBackPatch = latestObservation(state, "patch.rolledBack");
    const llmResponse = latestObservation(state, "llm.response");

    console.log("");
    console.log(`phase: ${state.phase}`);
    console.log(`steps: ${state.steps}`);

    if (rolledBackPatch) {
        console.log(`rolled back files: ${rolledBackPatch.changedFiles.join(", ") || "(none reported)"}`);
    } else if (appliedPatch) {
        console.log(`changed files: ${appliedPatch.changedFiles.join(", ") || "(none reported)"}`);
    } else if (proposedPatch) {
        console.log("patch: proposed only; rerun with --apply to apply it");
    }

    if (done) {
        console.log("");
        console.log("summary:");
        console.log(truncate(done.summary.trim() || "Agent completed."));
    } else if (error) {
        console.log("");
        console.log("error:");
        console.log(JSON.stringify(error.error, null, 2));
    } else if (llmResponse) {
        console.log("");
        console.log("llm response:");
        console.log(truncate(llmResponse.content.trim()));
    }
};


const makeEventsSink = (parsed: ResolvedCliArgs, compactOptions: CompactOptions): AgentEventSink | undefined =>
    parsed.output === "human"
        ? createHumanEventSink(parsed.resolvedConfigPath)
        : parsed.output === "events-json"
            ? createJsonEventSink(compactOptions)
            : parsed.output === "protocol-json"
                ? createProtocolEventSink(compactOptions)
                : undefined;

const makeAgentEnv = (parsed: ResolvedCliArgs, events: AgentEventSink | undefined): AgentEnv => {
    const shell = NodeShell;

    return {
        shell,
        fs: makeNodeFileSystem(shell),
        patch: makeNodePatchService(shell),
        llm: makeLLMFromEnv(parsed.config.llm),
        permissions: makeConfiguredPermissions(parsed.config.permissions),
        approvals: makeApprovalServiceFromCli(parsed),
        ...(events ? { events } : {}),
        ...(parsed.config.tools ? { toolPolicies: parsed.config.tools } : {}),
    };
};

const singleRunFromParsed = (parsed: ResolvedCliArgs): CliBatchRun => ({
    index: 0,
    cwd: parsed.cwd,
    goalText: parsed.goalText,
    mode: parsed.mode,
    patchFileMode: parsed.patchFileMode,
    ...(parsed.patchFile ? { patchFile: parsed.patchFile } : {}),
    ...(parsed.saveRunDir ? { saveRunDir: parsed.saveRunDir } : {}),
});

const runCliAgent = async (
    parsed: ResolvedCliArgs,
    run: CliBatchRun,
    compactOptions: CompactOptions,
    events: AgentEventSink | undefined
): Promise<CliRunResult> => {
    const env = makeAgentEnv(parsed, events);
    const runtime = new Runtime<AgentEnv>({ env });
    const initialPatch = run.patchFile
        ? await readPatchFile(run.cwd, run.patchFile)
        : undefined;

    const state = await runtime.toPromise(
        runAgent(runtime, {
            id: `agent-${Date.now()}-${run.index + 1}`,
            cwd: run.cwd,
            text: run.goalText,
            mode: run.mode,
            ...(parsed.config.project ? { project: parsed.config.project } : {}),
            ...(parsed.config.context ? { context: parsed.config.context } : {}),
            ...(parsed.config.patchQuality ? { patchQuality: parsed.config.patchQuality } : {}),
            ...(parsed.config.rollback ? { rollback: parsed.config.rollback } : {}),
            ...(parsed.config.redaction ? { redaction: parsed.config.redaction } : {}),
            ...(parsed.language ? { language: { response: parsed.language } } : parsed.config.language ? { language: parsed.config.language } : {}),
            ...(initialPatch ? { initialPatch, initialPatchMode: run.patchFileMode } : {}),
        })
    );

    if (run.saveRunDir) {
        await writeRunArtifacts(state, run.saveRunDir, compactOptions);
    }

    return {
        run,
        state,
        exitCode: computeCiExitCode(state, { failOnPatchProposed: parsed.failOnPatchProposed }),
    };
};

const computeBatchExitCode = (results: readonly CliRunResult[]): number => {
    if (results.some((result) => result.exitCode === 1)) return 1;
    if (results.some((result) => result.exitCode === 2)) return 2;
    return 0;
};

const batchSummary = (
    runs: readonly CliBatchRun[],
    results: readonly CliRunResult[]
): { readonly total: number; readonly completed: number; readonly failed: number; readonly exitCode: number; readonly stoppedEarly: boolean } => ({
    total: runs.length,
    completed: results.length,
    failed: results.filter((result) => result.exitCode !== 0).length,
    exitCode: computeBatchExitCode(results),
    stoppedEarly: results.length < runs.length,
});

const printHumanBatchSummary = (runs: readonly CliBatchRun[], results: readonly CliRunResult[]): void => {
    const summary = batchSummary(runs, results);
    console.log("");
    console.log("batch summary:");
    console.log(`completed: ${summary.completed}/${summary.total}`);
    console.log(`failed: ${summary.failed}`);
    if (summary.stoppedEarly) console.log("stopped early: yes");
    console.log(`exit code: ${summary.exitCode}`);
};


const printWorkspaceWhere = (parsed: ResolvedCliArgs): void => {
    const result = {
        cwd: parsed.cwd,
        inputCwd: parsed.workspaceDiscovery.inputCwd,
        changed: parsed.workspaceDiscovery.changed,
        disabled: Boolean(parsed.workspaceDiscovery.disabled),
        marker: parsed.workspaceDiscovery.marker,
        markerPath: parsed.workspaceDiscovery.markerPath,
        configPath: parsed.resolvedConfigPath,
        envFiles: parsed.envFileLoad.paths,
    };

    if (parsed.output === "json" || parsed.output === "protocol-json") {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log("brass-agent workspace");
    console.log(`input: ${result.inputCwd}`);
    console.log(`workspace: ${result.cwd}`);
    if (result.disabled) console.log("discovery: disabled");
    else if (result.marker) console.log(`marker: ${result.marker} (${result.markerPath})`);
    else console.log("marker: none found; using input cwd");
    if (result.configPath) console.log(`config: ${result.configPath}`);
    if (result.envFiles.length > 0) console.log(`env: ${result.envFiles.join(", ")}`);
};

const main = async () => {
    const parsed = await resolveParsedConfig(parseCliArgs(process.argv.slice(2)));
    const isBatch = parsed.batchRuns.length > 0;

    if (parsed.showHelp) {
        printHelp();
        process.exit(0);
    }

    if (parsed.where) {
        printWorkspaceWhere(parsed);
        return;
    }

    if (parsed.init) {
        const result = await initializeAgentWorkspace({
            cwd: parsed.cwd,
            force: parsed.initForce,
            dryRun: parsed.initDryRun,
            profile: parsed.initProfile,
        });

        if (parsed.output === "json") {
            console.log(JSON.stringify(result, null, 2));
        } else {
            printAgentInitResult(result);
        }

        return;
    }

    if (parsed.doctor) {
        const report = await runAgentDoctor({
            cwd: parsed.cwd,
            config: parsed.config,
            configPath: parsed.resolvedConfigPath,
            envFileLoad: parsed.envFileLoad,
            workspaceDiscovery: parsed.workspaceDiscovery,
        });

        if (parsed.output === "json") {
            console.log(JSON.stringify(report, null, 2));
        } else {
            printAgentDoctorReport(report);
        }

        process.exitCode = report.status === "fail" ? 1 : 0;
        return;
    }

    if (!parsed.goalText && !isBatch) {
        printHelp();
        process.exit(1);
    }

    const compactOptions: CompactOptions = {
        fullPatches: parsed.protocolFullPatches,
    };
    const events = makeEventsSink(parsed, compactOptions);
    const runs = isBatch ? parsed.batchRuns : [singleRunFromParsed(parsed)];
    const results: CliRunResult[] = [];

    for (const run of runs) {
        const result = await runCliAgent(parsed, run, compactOptions, events);
        results.push(result);

        if (parsed.output === "protocol-json") {
            console.log(JSON.stringify(protocolEnvelope({ type: "final-state", state: compactAgentState(result.state, compactOptions) })));
        } else if (parsed.output === "human") {
            printHumanFinalSummary(result.state);
        }

        if (isBatch && parsed.batchStopOnFailureResolved && result.exitCode !== 0) {
            break;
        }
    }

    if (isBatch) {
        const summary = batchSummary(runs, results);

        if (parsed.output === "json") {
            console.log(JSON.stringify({
                type: "batch",
                summary,
                results: results.map((result) => ({
                    index: result.run.index,
                    goal: result.run.goalText,
                    cwd: result.run.cwd,
                    mode: result.run.mode,
                    exitCode: result.exitCode,
                    state: compactAgentState(result.state, compactOptions),
                })),
            }, null, 2));
        } else if (parsed.output === "protocol-json") {
            console.log(JSON.stringify(protocolEnvelope({ type: "batch-summary", summary })));
        } else if (parsed.output === "human") {
            printHumanBatchSummary(runs, results);
        }

        if (parsed.ci) {
            process.exitCode = summary.exitCode;
        }

        return;
    }

    const result = results[0];
    if (!result) throw new Error("Agent run did not produce a result.");

    if (parsed.output === "json") {
        console.log(JSON.stringify(result.state, null, 2));
    }

    if (parsed.ci) {
        process.exitCode = result.exitCode;
    }
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
