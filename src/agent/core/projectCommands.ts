import type {
    AgentAction,
    AgentPackageManager,
    AgentProjectConfig,
    AgentState,
    Observation,
} from "./types";
import {
    describeProjectProfile,
    discoverProjectProfile,
    projectProfileProbePending,
} from "./projectProfile";

export type ProjectCommand = readonly string[];

export type ProjectCommandDiscovery = {
    readonly packageManager: AgentPackageManager;
    readonly validationCommands: readonly ProjectCommand[];
    readonly source: "config" | "package-json" | "fallback";
    readonly notes: readonly string[];
    readonly profileSummary?: string;
};

export const PROJECT_LOCKFILE_PROBES = [
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "package-lock.json",
    "npm-shrinkwrap.json",
] as const;

const DEFAULT_TEST_SCRIPT_NAMES = ["test", "test:ci", "test:unit"] as const;
const TYPECHECK_SCRIPT_NAMES = ["typecheck", "type-check", "check-types", "tsc", "check"] as const;
const LINT_SCRIPT_NAMES = ["lint", "lint:ci"] as const;
const HEALTH_SCRIPT_NAME_PATTERNS = [
    /^repo:check$/,
    /^check$/,
    /(^|:)check($|:)/,
    /(^|:)doctor($|:)/,
    /(^|:)health($|:)/,
    /(^|:)verify($|:)/,
    /(^|:)validate($|:)/,
    /(^|:)ci($|:)/,
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readPackageJsonObservation = (state: AgentState): Extract<Observation, { type: "fs.fileRead" }> | undefined =>
    [...state.observations]
        .reverse()
        .find((obs): obs is Extract<Observation, { type: "fs.fileRead" }> => obs.type === "fs.fileRead" && obs.path === "package.json");

export const parseProjectPackageJson = (state: AgentState): Record<string, unknown> | undefined => {
    const observation = readPackageJsonObservation(state);
    if (!observation) return undefined;

    try {
        const parsed = JSON.parse(observation.content) as unknown;
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

const packageScripts = (pkg: Record<string, unknown> | undefined): Record<string, string> => {
    if (!pkg || !isRecord(pkg.scripts)) return {};

    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(pkg.scripts)) {
        if (typeof value === "string") scripts[name] = value;
    }
    return scripts;
};

const hasFsExistsObservation = (state: AgentState, path: string): boolean =>
    state.observations.some((obs) => obs.type === "fs.exists" && obs.path === path);

export const nextProjectProbeAction = (state: AgentState): AgentAction | undefined => {
    const project = state.goal.project;

    if (!project?.validationCommands && (!project?.packageManager || project.packageManager === "auto")) {
        for (const path of PROJECT_LOCKFILE_PROBES) {
            if (!hasFsExistsObservation(state, path)) return { type: "fs.exists", path };
        }
    }

    const profileProbe = projectProfileProbePending(state);
    return profileProbe ? { type: "fs.exists", path: profileProbe } : undefined;
};

const packageManagerFromPackageJson = (pkg: Record<string, unknown> | undefined): AgentPackageManager | undefined => {
    const raw = typeof pkg?.packageManager === "string" ? pkg.packageManager : undefined;
    if (!raw) return undefined;

    const name = raw.split("@")[0]?.trim();
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
    return undefined;
};

const lockfileExists = (state: AgentState, path: string): boolean =>
    state.observations.some((obs) => obs.type === "fs.exists" && obs.path === path && obs.exists);

const packageManagerFromLockfiles = (state: AgentState): AgentPackageManager | undefined => {
    if (lockfileExists(state, "pnpm-lock.yaml")) return "pnpm";
    if (lockfileExists(state, "yarn.lock")) return "yarn";
    if (lockfileExists(state, "bun.lockb") || lockfileExists(state, "bun.lock")) return "bun";
    if (lockfileExists(state, "package-lock.json") || lockfileExists(state, "npm-shrinkwrap.json")) return "npm";
    return undefined;
};

export const discoverPackageManager = (state: AgentState): AgentPackageManager => {
    const configured = state.goal.project?.packageManager;
    if (configured && configured !== "auto") return configured;

    return packageManagerFromPackageJson(parseProjectPackageJson(state))
        ?? packageManagerFromLockfiles(state)
        ?? "npm";
};

const isPlaceholderTestScript = (script: string): boolean =>
    /no test specified/i.test(script) && /exit\s+1/.test(script);

const firstExistingScript = (
    scripts: Record<string, string>,
    names: readonly string[],
    options: { readonly skipPlaceholderTest?: boolean } = {}
): string | undefined => {
    for (const name of names) {
        const script = scripts[name];
        if (script === undefined) continue;
        if (options.skipPlaceholderTest && name === "test" && isPlaceholderTestScript(script)) continue;
        return name;
    }
    return undefined;
};

const firstScriptMatching = (scripts: Record<string, string>, patterns: readonly RegExp[]): string | undefined => {
    for (const name of Object.keys(scripts)) {
        if (patterns.some((pattern) => pattern.test(name))) return name;
    }
    return undefined;
};

const goalMentionsAny = (goal: string, words: readonly string[]): boolean => {
    const lower = goal.toLowerCase();
    return words.some((word) => lower.includes(word));
};

export const splitCommand = (value: string): readonly string[] => {
    const out: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let escaping = false;

    for (const char of value.trim()) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === "\\") {
            escaping = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = undefined;
            } else {
                current += char;
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                out.push(current);
                current = "";
            }
            continue;
        }

        current += char;
    }

    if (current) out.push(current);
    return out;
};

const commandText = (command: readonly string[]): string => command.join(" ");

const dedupeCommands = (commands: readonly ProjectCommand[]): readonly ProjectCommand[] => {
    const seen = new Set<string>();
    const out: ProjectCommand[] = [];

    for (const command of commands) {
        const key = commandText(command);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(command);
    }

    return out;
};

export const commandForScript = (packageManager: AgentPackageManager, scriptName: string): ProjectCommand => {
    switch (packageManager) {
        case "npm":
            return scriptName === "test" ? ["npm", "test"] : ["npm", "run", scriptName];
        case "pnpm":
            return scriptName === "test" ? ["pnpm", "test"] : ["pnpm", "run", scriptName];
        case "yarn":
            return scriptName === "test" ? ["yarn", "test"] : ["yarn", "run", scriptName];
        case "bun":
            return ["bun", "run", scriptName];
    }
};

const configuredValidationCommands = (project: AgentProjectConfig | undefined): readonly ProjectCommand[] | undefined => {
    if (!project?.validationCommands) return undefined;
    return project.validationCommands
        .map((command) => splitCommand(command))
        .filter((command) => command.length > 0);
};

export const discoverValidationCommands = (state: AgentState): ProjectCommandDiscovery => {
    const project = state.goal.project;
    const configured = configuredValidationCommands(project);
    if (configured) {
        const packageManager = discoverPackageManager(state);
        const profile = discoverProjectProfile(state, packageManager);
        return {
            packageManager,
            validationCommands: configured,
            source: "config",
            notes: configured.length > 0
                ? ["Using validation commands from project config."]
                : ["Project config explicitly disables validation commands."],
            profileSummary: describeProjectProfile(profile),
        };
    }

    const pkg = parseProjectPackageJson(state);
    const scripts = packageScripts(pkg);
    const packageManager = discoverPackageManager(state);
    const profile = discoverProjectProfile(state, packageManager);
    const commands: ProjectCommand[] = [];
    const notes: string[] = [];

    const testScript = firstExistingScript(
        scripts,
        project?.testScriptNames ?? DEFAULT_TEST_SCRIPT_NAMES,
        { skipPlaceholderTest: true }
    );

    if (testScript) {
        commands.push(commandForScript(packageManager, testScript));
        notes.push(`Selected test script: ${testScript}.`);
    } else {
        notes.push("No usable test script found in package.json.");

        const healthScript = firstScriptMatching(scripts, HEALTH_SCRIPT_NAME_PATTERNS);
        if (healthScript) {
            commands.push(commandForScript(packageManager, healthScript));
            notes.push(`Selected project health script: ${healthScript}.`);
        }
    }

    const includeTypecheck = project?.includeTypecheck === true
        || goalMentionsAny(state.goal.text, ["typecheck", "type-check", "type check", "types", "tsc"])
        || commands.length === 0;

    if (includeTypecheck) {
        const typecheckScript = firstExistingScript(scripts, TYPECHECK_SCRIPT_NAMES);
        if (typecheckScript) {
            commands.push(commandForScript(packageManager, typecheckScript));
            notes.push(`Selected typecheck script: ${typecheckScript}.`);
        }
    }

    const includeLint = project?.includeLint === true
        || goalMentionsAny(state.goal.text, ["lint", "eslint"])
        || commands.length === 0;

    if (includeLint) {
        const lintScript = firstExistingScript(scripts, LINT_SCRIPT_NAMES);
        if (lintScript) {
            commands.push(commandForScript(packageManager, lintScript));
            notes.push(`Selected lint script: ${lintScript}.`);
        }
    }

    if (commands.length === 0 && profile.stacks.includes("rust") && profile.markers.includes("Cargo.toml")) {
        commands.push(["cargo", "check"]);
        notes.push("Selected Cargo check because a root Cargo.toml was detected.");
    }

    const max = project?.maxValidationCommands ?? 2;
    const validationCommands = dedupeCommands(commands).slice(0, Math.max(0, max));

    return {
        packageManager,
        validationCommands,
        source: validationCommands.length > 0 ? "package-json" : "fallback",
        notes,
        profileSummary: describeProjectProfile(profile),
    };
};

const commandsEqual = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((part, index) => part === b[index]);

const shellResultMatches = (
    observation: Observation,
    command: readonly string[]
): observation is Extract<Observation, { type: "shell.result" }> =>
    observation.type === "shell.result" && commandsEqual(observation.command, command);

export const nextUnrunValidationCommand = (
    commands: readonly ProjectCommand[],
    observations: readonly Observation[]
): ProjectCommand | undefined =>
    commands.find((command) => !observations.some((observation) => shellResultMatches(observation, command)));

export const describeCommandDiscovery = (discovery: ProjectCommandDiscovery): string => {
    const commands = discovery.validationCommands.map(commandText).join("; ") || "none";
    const notes = discovery.notes.length > 0 ? ` Notes: ${discovery.notes.join(" ")}` : "";
    const profile = discovery.profileSummary ? ` ${discovery.profileSummary}` : "";
    return `Package manager: ${discovery.packageManager}. Validation commands: ${commands}.${notes}${profile}`;
};
