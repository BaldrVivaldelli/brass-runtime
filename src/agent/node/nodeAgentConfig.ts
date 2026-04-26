import {
    AGENT_CONFIG_FILE_NAMES,
    isAgentConfigApprovalMode,
    isAgentConfigLLMProvider,
    isAgentConfigMode,
    type AgentConfig,
    type LoadedAgentConfig,
} from "../core/config";
import { isAgentPreset } from "../core/batch";

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const assertStringArray = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`${path} must be an array of strings.`);
    }
};

const assertNumber = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number.`);
    }
};

const assertBoolean = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
};

const assertString = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
};


const validateBatchGoal = (value: unknown, path: string): void => {
    if (typeof value === "string") return;
    if (!isRecord(value)) throw new Error(`${path} must be a string or object.`);

    assertString(value.goal, `${path}.goal`);
    assertString(value.cwd, `${path}.cwd`);
    assertString(value.patchFile, `${path}.patchFile`);
    assertString(value.saveRunDir, `${path}.saveRunDir`);

    if (value.preset !== undefined) {
        if (typeof value.preset !== "string" || !isAgentPreset(value.preset)) {
            throw new Error(`${path}.preset must be one of: fix-tests, inspect, typecheck, lint.`);
        }
    }

    if (value.mode !== undefined) {
        if (typeof value.mode !== "string" || !isAgentConfigMode(value.mode)) {
            throw new Error(`${path}.mode must be one of: read-only, propose, write, autonomous.`);
        }
    }

    if (value.patchFileMode !== undefined && value.patchFileMode !== "apply" && value.patchFileMode !== "rollback") {
        throw new Error(`${path}.patchFileMode must be apply or rollback.`);
    }

    if (value.goal === undefined && value.preset === undefined && value.patchFile === undefined) {
        throw new Error(`${path} must include goal, preset, or patchFile.`);
    }
};

const validateAgentConfig = (config: unknown, sourcePath: string): AgentConfig => {
    if (!isRecord(config)) throw new Error(`Agent config at ${sourcePath} must be a JSON object.`);

    if (config.mode !== undefined) {
        if (typeof config.mode !== "string" || !isAgentConfigMode(config.mode)) {
            throw new Error("config.mode must be one of: read-only, propose, write, autonomous.");
        }
    }

    if (config.approval !== undefined) {
        if (typeof config.approval !== "string" || !isAgentConfigApprovalMode(config.approval)) {
            throw new Error("config.approval must be one of: auto, interactive, approve, deny.");
        }
    }

    if (config.llm !== undefined) {
        if (!isRecord(config.llm)) throw new Error("config.llm must be an object.");
        if (config.llm.provider !== undefined) {
            if (typeof config.llm.provider !== "string" || !isAgentConfigLLMProvider(config.llm.provider)) {
                throw new Error("config.llm.provider must be one of: fake, google, gemini, openai, openai-compatible.");
            }
        }
        if ("apiKey" in config.llm) {
            throw new Error("config.llm.apiKey is not supported. Store secrets in environment variables and use config.llm.apiKeyEnv instead.");
        }
        assertString(config.llm.model, "config.llm.model");
        assertString(config.llm.endpoint, "config.llm.endpoint");
        assertString(config.llm.baseUrl, "config.llm.baseUrl");
        assertString(config.llm.apiVersion, "config.llm.apiVersion");
        assertString(config.llm.apiKeyEnv, "config.llm.apiKeyEnv");
        assertString(config.llm.systemInstruction, "config.llm.systemInstruction");
        assertString(config.llm.fakeResponse, "config.llm.fakeResponse");
        assertNumber(config.llm.temperature, "config.llm.temperature");
        assertNumber(config.llm.topP, "config.llm.topP");
        assertNumber(config.llm.topK, "config.llm.topK");
        assertNumber(config.llm.maxOutputTokens, "config.llm.maxOutputTokens");
    }

    if (config.project !== undefined) {
        if (!isRecord(config.project)) throw new Error("config.project must be an object.");

        if (config.project.packageManager !== undefined) {
            if (
                typeof config.project.packageManager !== "string" ||
                !["auto", "npm", "pnpm", "yarn", "bun"].includes(config.project.packageManager)
            ) {
                throw new Error("config.project.packageManager must be one of: auto, npm, pnpm, yarn, bun.");
            }
        }

        assertStringArray(config.project.validationCommands, "config.project.validationCommands");
        assertStringArray(config.project.testScriptNames, "config.project.testScriptNames");
        assertBoolean(config.project.includeTypecheck, "config.project.includeTypecheck");
        assertBoolean(config.project.includeLint, "config.project.includeLint");
        assertNumber(config.project.maxValidationCommands, "config.project.maxValidationCommands");
    }

    if (config.context !== undefined) {
        if (!isRecord(config.context)) throw new Error("config.context must be an object.");
        assertBoolean(config.context.enabled, "config.context.enabled");
        assertNumber(config.context.maxSearchQueries, "config.context.maxSearchQueries");
        assertNumber(config.context.maxFiles, "config.context.maxFiles");
        assertNumber(config.context.maxSearchResults, "config.context.maxSearchResults");
        assertStringArray(config.context.globs, "config.context.globs");
        assertStringArray(config.context.excludeGlobs, "config.context.excludeGlobs");
    }

    if (config.patchQuality !== undefined) {
        if (!isRecord(config.patchQuality)) throw new Error("config.patchQuality must be an object.");
        assertBoolean(config.patchQuality.enabled, "config.patchQuality.enabled");
        assertNumber(config.patchQuality.maxRepairAttempts, "config.patchQuality.maxRepairAttempts");
        if (typeof config.patchQuality.maxRepairAttempts === "number" && config.patchQuality.maxRepairAttempts < 0) {
            throw new Error("config.patchQuality.maxRepairAttempts must be greater than or equal to 0.");
        }
    }

    if (config.rollback !== undefined) {
        if (!isRecord(config.rollback)) throw new Error("config.rollback must be an object.");
        assertBoolean(config.rollback.enabled, "config.rollback.enabled");
        assertBoolean(config.rollback.onFinalValidationFailure, "config.rollback.onFinalValidationFailure");
        assertBoolean(config.rollback.runValidationAfterRollback, "config.rollback.runValidationAfterRollback");
        assertBoolean(config.rollback.allowForSuppliedPatches, "config.rollback.allowForSuppliedPatches");
        assertNumber(config.rollback.maxRollbackDepth, "config.rollback.maxRollbackDepth");
        if (typeof config.rollback.maxRollbackDepth === "number" && config.rollback.maxRollbackDepth < 0) {
            throw new Error("config.rollback.maxRollbackDepth must be greater than or equal to 0.");
        }
        if (config.rollback.strategy !== undefined && config.rollback.strategy !== "last" && config.rollback.strategy !== "all") {
            throw new Error("config.rollback.strategy must be one of: last, all.");
        }
    }

    if (config.redaction !== undefined) {
        if (!isRecord(config.redaction)) throw new Error("config.redaction must be an object.");
        assertBoolean(config.redaction.enabled, "config.redaction.enabled");
        assertStringArray(config.redaction.additionalPatterns, "config.redaction.additionalPatterns");
    }


    if (config.language !== undefined) {
        if (!isRecord(config.language)) throw new Error("config.language must be an object.");
        if (config.language.response !== undefined) {
            if (
                typeof config.language.response !== "string" ||
                !["auto", "match-user", "en", "es", "pt", "fr", "de", "it", "custom"].includes(config.language.response)
            ) {
                throw new Error("config.language.response must be one of: auto, match-user, en, es, pt, fr, de, it, custom.");
            }
        }
        assertString(config.language.custom, "config.language.custom");
    }

    if (config.permissions !== undefined) {
        if (!isRecord(config.permissions)) throw new Error("config.permissions must be an object.");

        if (config.permissions.shell !== undefined) {
            if (!isRecord(config.permissions.shell)) throw new Error("config.permissions.shell must be an object.");
            assertBoolean(config.permissions.shell.inheritDefaults, "config.permissions.shell.inheritDefaults");
            assertStringArray(config.permissions.shell.allow, "config.permissions.shell.allow");
            assertStringArray(config.permissions.shell.deny, "config.permissions.shell.deny");

            if (config.permissions.shell.ask !== undefined) {
                if (!Array.isArray(config.permissions.shell.ask)) throw new Error("config.permissions.shell.ask must be an array.");
                for (const [index, rule] of config.permissions.shell.ask.entries()) {
                    if (typeof rule === "string") continue;
                    if (!isRecord(rule)) throw new Error(`config.permissions.shell.ask[${index}] must be a string or object.`);
                    assertString(rule.pattern, `config.permissions.shell.ask[${index}].pattern`);
                    assertString(rule.reason, `config.permissions.shell.ask[${index}].reason`);
                    if (rule.risk !== undefined && rule.risk !== "low" && rule.risk !== "medium" && rule.risk !== "high") {
                        throw new Error(`config.permissions.shell.ask[${index}].risk must be one of: low, medium, high.`);
                    }
                    if (rule.defaultAnswer !== undefined && rule.defaultAnswer !== "approve" && rule.defaultAnswer !== "reject") {
                        throw new Error(`config.permissions.shell.ask[${index}].defaultAnswer must be approve or reject.`);
                    }
                }
            }
        }

        if (config.permissions.patchApply !== undefined) {
            const patchApply = config.permissions.patchApply;
            if (typeof patchApply === "string") {
                if (patchApply !== "allow" && patchApply !== "ask" && patchApply !== "deny") {
                    throw new Error("config.permissions.patchApply must be allow, ask, deny, or an object.");
                }
            } else if (isRecord(patchApply)) {
                if (patchApply.decision !== undefined && patchApply.decision !== "allow" && patchApply.decision !== "ask" && patchApply.decision !== "deny") {
                    throw new Error("config.permissions.patchApply.decision must be allow, ask, or deny.");
                }
                assertString(patchApply.reason, "config.permissions.patchApply.reason");
                if (patchApply.risk !== undefined && patchApply.risk !== "low" && patchApply.risk !== "medium" && patchApply.risk !== "high") {
                    throw new Error("config.permissions.patchApply.risk must be one of: low, medium, high.");
                }
                if (patchApply.defaultAnswer !== undefined && patchApply.defaultAnswer !== "approve" && patchApply.defaultAnswer !== "reject") {
                    throw new Error("config.permissions.patchApply.defaultAnswer must be approve or reject.");
                }
            } else {
                throw new Error("config.permissions.patchApply must be allow, ask, deny, or an object.");
            }
        }
    }

    if (config.tools !== undefined) {
        if (!isRecord(config.tools)) throw new Error("config.tools must be an object.");
        for (const [name, value] of Object.entries(config.tools)) {
            if (!isRecord(value)) throw new Error(`config.tools.${name} must be an object.`);
            assertNumber(value.timeoutMs, `config.tools.${name}.timeoutMs`);
            assertNumber(value.retries, `config.tools.${name}.retries`);
        }
    }



    if (config.batch !== undefined) {
        if (!isRecord(config.batch)) throw new Error("config.batch must be an object.");
        assertBoolean(config.batch.stopOnFailure, "config.batch.stopOnFailure");
        if (config.batch.goals !== undefined) {
            if (!Array.isArray(config.batch.goals)) throw new Error("config.batch.goals must be an array.");
            config.batch.goals.forEach((goal, index) => validateBatchGoal(goal, `config.batch.goals[${index}]`));
        }
    }

    return config as AgentConfig;
};

const isFile = async (path: string): Promise<boolean> => {
    const { stat } = await dynamicImport("node:fs/promises");
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
};

const findConfigPath = async (cwd: string): Promise<string | undefined> => {
    const nodePath = await dynamicImport("node:path");
    let current = nodePath.resolve(cwd);

    while (true) {
        for (const fileName of AGENT_CONFIG_FILE_NAMES) {
            const candidate = nodePath.join(current, fileName);
            if (await isFile(candidate)) return candidate;
        }

        const parent = nodePath.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
};

const readConfigFile = async (path: string): Promise<AgentConfig> => {
    const { readFile } = await dynamicImport("node:fs/promises");
    const raw = String(await readFile(path, "utf8")).replace(/^\uFEFF/, "");
    try {
        return validateAgentConfig(JSON.parse(raw), path);
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSON in agent config ${path}: ${error.message}`);
        }
        throw error;
    }
};

export const loadNodeAgentConfig = async (options: {
    readonly cwd: string;
    readonly configPath?: string;
    readonly noConfig?: boolean;
}): Promise<LoadedAgentConfig> => {
    if (options.noConfig) return { config: {} };

    const nodePath = await dynamicImport("node:path");

    if (options.configPath) {
        const path = nodePath.isAbsolute(options.configPath)
            ? options.configPath
            : nodePath.resolve(options.cwd, options.configPath);

        if (!(await isFile(path))) throw new Error(`Agent config not found or not a file: ${path}`);
        return { path, config: await readConfigFile(path) };
    }

    const path = await findConfigPath(options.cwd);
    if (!path) return { config: {} };
    return { path, config: await readConfigFile(path) };
};
