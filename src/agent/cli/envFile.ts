import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_AGENT_ENV_FILE_NAMES = [".brass-agent.env", ".env.local", ".env"] as const;

const BASE_ALLOWED_ENV_KEYS = new Set([
    "BRASS_LLM_PROVIDER",
    "BRASS_FAKE_LLM_RESPONSE",

    "BRASS_GOOGLE_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "BRASS_GOOGLE_MODEL",
    "BRASS_GOOGLE_API_VERSION",
    "BRASS_GOOGLE_BASE_URL",
    "BRASS_GOOGLE_ENDPOINT",
    "BRASS_GOOGLE_SYSTEM_INSTRUCTION",
    "BRASS_GOOGLE_TEMPERATURE",
    "BRASS_GOOGLE_TOP_P",
    "BRASS_GOOGLE_TOP_K",
    "BRASS_GOOGLE_MAX_OUTPUT_TOKENS",

    "BRASS_LLM_ENDPOINT",
    "BRASS_LLM_API_KEY",
    "BRASS_LLM_MODEL",

    "BRASS_AGENT_APPROVAL",
    "BRASS_AGENT_AUTO_APPROVE",
    "BRASS_CODE_CMD",
]);

export type AgentEnvFileLoadResult = {
    readonly cwd: string;
    readonly disabled: boolean;
    readonly explicitPath?: string;
    readonly filesChecked: readonly string[];
    readonly paths: readonly string[];
    readonly loadedKeys: readonly string[];
    readonly alreadySetKeys: readonly string[];
    readonly emptyKeys: readonly string[];
    readonly ignoredKeys: readonly string[];
    readonly invalidLines: readonly string[];
    readonly errors: readonly string[];
};

export type LoadAgentEnvFileOptions = {
    readonly cwd: string;
    readonly envFile?: string;
    readonly noEnvFile?: boolean;
    readonly allowedExtraKeys?: readonly string[];
};

type ParsedEnvLine =
    | { readonly type: "skip" }
    | { readonly type: "invalid" }
    | { readonly type: "assignment"; readonly key: string; readonly value: string };

const unique = (values: readonly string[]): readonly string[] => Array.from(new Set(values));

const parseQuotedValue = (value: string): string | undefined => {
    if (value.length < 2) return undefined;

    const quote = value[0];
    if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return undefined;

    const inner = value.slice(1, -1);
    if (quote === "'") return inner;

    return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
};

const parseEnvLine = (line: string): ParsedEnvLine => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return { type: "skip" };

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(withoutExport);
    if (!match) return { type: "invalid" };

    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    const compact = rawValue.trim();
    const quoted = parseQuotedValue(compact);
    const value = quoted ?? compact.replace(/\s+#.*$/u, "").trim();

    return { type: "assignment", key, value };
};

const candidatePaths = (cwd: string, envFile: string | undefined): readonly string[] => {
    if (envFile) return [isAbsolute(envFile) ? envFile : resolve(cwd, envFile)];
    return DEFAULT_AGENT_ENV_FILE_NAMES.map((name) => join(cwd, name));
};

export const loadAgentEnvFile = (options: LoadAgentEnvFileOptions): AgentEnvFileLoadResult => {
    const cwd = resolve(options.cwd);
    const extraKeys = options.allowedExtraKeys?.filter(Boolean) ?? [];
    const allowedKeys = new Set([...BASE_ALLOWED_ENV_KEYS, ...extraKeys]);
    const files = options.noEnvFile ? [] : candidatePaths(cwd, options.envFile);
    const paths: string[] = [];
    const loadedKeys: string[] = [];
    const alreadySetKeys: string[] = [];
    const emptyKeys: string[] = [];
    const ignoredKeys: string[] = [];
    const invalidLines: string[] = [];
    const errors: string[] = [];

    if (options.noEnvFile) {
        return {
            cwd,
            disabled: true,
            filesChecked: [],
            paths: [],
            loadedKeys: [],
            alreadySetKeys: [],
            emptyKeys: [],
            ignoredKeys: [],
            invalidLines: [],
            errors: [],
        };
    }

    for (const path of files) {
        if (!existsSync(path)) {
            if (options.envFile) errors.push(`Env file does not exist: ${path}`);
            continue;
        }

        paths.push(path);

        let raw: string;
        try {
            raw = readFileSync(path, "utf8").replace(/^\uFEFF/u, "");
        } catch (error) {
            errors.push(`Could not read env file ${path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
            const parsed = parseEnvLine(line);
            if (parsed.type === "skip") continue;
            if (parsed.type === "invalid") {
                invalidLines.push(`${path}:${index + 1}`);
                continue;
            }

            if (!allowedKeys.has(parsed.key)) {
                ignoredKeys.push(parsed.key);
                continue;
            }

            if (!parsed.value) {
                emptyKeys.push(parsed.key);
                continue;
            }

            if (process.env[parsed.key] !== undefined) {
                alreadySetKeys.push(parsed.key);
                continue;
            }

            process.env[parsed.key] = parsed.value;
            loadedKeys.push(parsed.key);
        }
    }

    return {
        cwd,
        disabled: false,
        ...(options.envFile ? { explicitPath: isAbsolute(options.envFile) ? options.envFile : resolve(cwd, options.envFile) } : {}),
        filesChecked: files,
        paths,
        loadedKeys: unique(loadedKeys),
        alreadySetKeys: unique(alreadySetKeys),
        emptyKeys: unique(emptyKeys),
        ignoredKeys: unique(ignoredKeys),
        invalidLines: unique(invalidLines),
        errors: unique(errors),
    };
};
