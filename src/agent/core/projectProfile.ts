import type { AgentPackageManager, AgentState, Observation } from "./types";

export type AgentProjectStack =
    | "node"
    | "rust"
    | "tauri"
    | "desktop"
    | "bridge"
    | "monorepo";

export type AgentWorkspaceStyle = "single-package" | "monorepo" | "mixed" | "unknown";

export type AgentProjectProfile = {
    readonly kind: "unknown" | "node" | "rust" | "tauri" | "mixed";
    readonly packageManager: AgentPackageManager;
    readonly stacks: readonly AgentProjectStack[];
    readonly workspaceStyle: AgentWorkspaceStyle;
    readonly markers: readonly string[];
    readonly scripts: readonly string[];
    readonly candidateValidationScripts: readonly string[];
    readonly candidateValidationCommands: readonly string[];
    readonly notes: readonly string[];
};

export const PROJECT_PROFILE_PROBES = [
    "Cargo.toml",
    "Cargo.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
    "apps/desktop/src-tauri/Cargo.toml",
    "bridges/whatsmeow-bridge/Cargo.toml",
    "bridges/whatsmeow-bridge/package.json",
    "apps",
    "packages",
    "bridges",
    "turbo.json",
    "nx.json",
    "pnpm-workspace.yaml",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readPackageJsonObservation = (state: AgentState): Extract<Observation, { type: "fs.fileRead" }> | undefined =>
    [...state.observations]
        .reverse()
        .find((obs): obs is Extract<Observation, { type: "fs.fileRead" }> => obs.type === "fs.fileRead" && obs.path === "package.json");

const parsePackageJson = (state: AgentState): Record<string, unknown> | undefined => {
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

const markerExists = (state: AgentState, path: string): boolean =>
    state.observations.some((obs) => obs.type === "fs.exists" && obs.path === path && obs.exists);

const hasDependencyName = (pkg: Record<string, unknown> | undefined, dependency: string): boolean => {
    const collections = [pkg?.dependencies, pkg?.devDependencies, pkg?.optionalDependencies];
    return collections.some((collection) => isRecord(collection) && typeof collection[dependency] === "string");
};

const hasAnyDependency = (pkg: Record<string, unknown> | undefined, dependencies: readonly string[]): boolean =>
    dependencies.some((dependency) => hasDependencyName(pkg, dependency));

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

const scriptNamesMatching = (scripts: Record<string, string>, patterns: readonly RegExp[]): readonly string[] => {
    const matches: string[] = [];
    for (const name of Object.keys(scripts)) {
        if (patterns.some((pattern) => pattern.test(name))) matches.push(name);
    }
    return matches;
};

export const projectProfileProbePending = (state: AgentState): string | undefined =>
    PROJECT_PROFILE_PROBES.find((path) => !state.observations.some((obs) => obs.type === "fs.exists" && obs.path === path));

export const discoverProjectProfile = (
    state: AgentState,
    packageManager: AgentPackageManager
): AgentProjectProfile => {
    const pkg = parsePackageJson(state);
    const scripts = packageScripts(pkg);
    const scriptNames = Object.keys(scripts);
    const markers = PROJECT_PROFILE_PROBES.filter((path) => markerExists(state, path));
    const stacks: AgentProjectStack[] = [];
    const notes: string[] = [];

    if (pkg) stacks.push("node");

    const rustPresent = markerExists(state, "Cargo.toml")
        || markerExists(state, "Cargo.lock")
        || markerExists(state, "src-tauri/Cargo.toml")
        || markerExists(state, "apps/desktop/src-tauri/Cargo.toml")
        || markerExists(state, "bridges/whatsmeow-bridge/Cargo.toml");
    if (rustPresent) stacks.push("rust");

    const tauriPresent = markerExists(state, "src-tauri/tauri.conf.json")
        || markerExists(state, "apps/desktop/src-tauri/tauri.conf.json")
        || hasAnyDependency(pkg, ["@tauri-apps/api", "@tauri-apps/cli"])
        || scriptNames.some((name) => name.includes("tauri"));
    if (tauriPresent) stacks.push("tauri");

    const desktopPresent = markerExists(state, "apps/desktop/package.json")
        || scriptNames.some((name) => name.includes("desktop"));
    if (desktopPresent) stacks.push("desktop");

    const bridgePresent = markerExists(state, "bridges")
        || markerExists(state, "bridges/whatsmeow-bridge/Cargo.toml")
        || markerExists(state, "bridges/whatsmeow-bridge/package.json")
        || scriptNames.some((name) => name.includes("bridge"));
    if (bridgePresent) stacks.push("bridge");

    const monorepoPresent = markerExists(state, "pnpm-workspace.yaml")
        || markerExists(state, "turbo.json")
        || markerExists(state, "nx.json")
        || markerExists(state, "apps")
        || markerExists(state, "packages")
        || markerExists(state, "bridges")
        || Array.isArray(pkg?.workspaces);
    if (monorepoPresent) stacks.push("monorepo");

    const candidateValidationScripts = unique([
        ...scriptNamesMatching(scripts, [
            /^repo:check$/,
            /^check$/,
            /(^|:)check($|:)/,
            /(^|:)doctor($|:)/,
            /(^|:)health($|:)/,
            /(^|:)verify($|:)/,
            /(^|:)validate($|:)/,
            /(^|:)ci($|:)/,
        ]),
    ]);

    const candidateValidationCommands: string[] = candidateValidationScripts.map((script) => {
        if (packageManager === "npm" && script === "test") return "npm test";
        if (packageManager === "pnpm" && script === "test") return "pnpm test";
        if (packageManager === "yarn" && script === "test") return "yarn test";
        if (packageManager === "bun") return `bun run ${script}`;
        return `${packageManager} run ${script}`;
    });

    if (rustPresent && markerExists(state, "Cargo.toml")) {
        candidateValidationCommands.push("cargo check");
    }

    if (candidateValidationScripts.length > 0) {
        notes.push(`Likely health/check scripts: ${candidateValidationScripts.slice(0, 5).join(", ")}.`);
    }
    if (tauriPresent) notes.push("Tauri markers detected; desktop validation may involve npm scripts plus Cargo checks.");
    if (bridgePresent) notes.push("Bridge markers detected; bridge-specific doctor/check scripts may be relevant.");
    if (monorepoPresent) notes.push("Workspace/monorepo markers detected; prefer repo-level check scripts when available.");

    const kind: AgentProjectProfile["kind"] = tauriPresent && rustPresent && pkg
        ? "tauri"
        : pkg && rustPresent
            ? "mixed"
            : rustPresent
                ? "rust"
                : pkg
                    ? "node"
                    : "unknown";

    const workspaceStyle: AgentWorkspaceStyle = monorepoPresent && pkg && rustPresent
        ? "mixed"
        : monorepoPresent
            ? "monorepo"
            : pkg
                ? "single-package"
                : "unknown";

    return {
        kind,
        packageManager,
        stacks: unique(stacks),
        workspaceStyle,
        markers,
        scripts: scriptNames,
        candidateValidationScripts,
        candidateValidationCommands: unique(candidateValidationCommands),
        notes,
    };
};

export const describeProjectProfile = (profile: AgentProjectProfile): string => {
    const stacks = profile.stacks.length > 0 ? profile.stacks.join(", ") : "none detected";
    const markers = profile.markers.length > 0 ? profile.markers.slice(0, 8).join(", ") : "none";
    const commands = profile.candidateValidationCommands.length > 0
        ? profile.candidateValidationCommands.slice(0, 6).join("; ")
        : "none";
    const notes = profile.notes.length > 0 ? ` Notes: ${profile.notes.join(" ")}` : "";

    return `Project profile: ${profile.kind}; workspace: ${profile.workspaceStyle}; stacks: ${stacks}; markers: ${markers}; likely validation: ${commands}.${notes}`;
};
