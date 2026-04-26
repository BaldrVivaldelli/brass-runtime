import type { AgentAction, AgentContextConfig, AgentState, Observation, SearchMatch } from "./types";

const DEFAULT_CONTEXT_GLOBS = [
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.mts",
    "*.cts",
    "*.mjs",
    "*.cjs",
    "*.json",
    "*.md",
    "*.yml",
    "*.yaml",
] as const;

const DEFAULT_MAX_SEARCH_QUERIES = 3;
const DEFAULT_MAX_FILES = 4;
const DEFAULT_MAX_SEARCH_RESULTS = 40;

const PATH_EXTENSIONS = [
    "tsx",
    "jsx",
    "mts",
    "cts",
    "mjs",
    "cjs",
    "json",
    "yaml",
    "html",
    "scss",
    "ts",
    "js",
    "md",
    "yml",
    "css",
] as const;

const PATH_EXTENSION_PATTERN = [...PATH_EXTENSIONS]
    .sort((a, b) => b.length - a.length)
    .join("|");

const STOP_WORDS = new Set([
    "about",
    "after",
    "agent",
    "because",
    "before",
    "brass",
    "cannot",
    "console",
    "could",
    "describe",
    "error",
    "expect",
    "expected",
    "exit",
    "fail",
    "failed",
    "failing",
    "failure",
    "find",
    "from",
    "goal",
    "have",
    "into",
    "name",
    "node",
    "only",
    "package",
    "please",
    "process",
    "repo",
    "runtime",
    "script",
    "scripts",
    "should",
    "test",
    "tests",
    "that",
    "this",
    "throw",
    "throws",
    "undefined",
    "using",
    "with",
    "previous",
    "user",
    "unrelated",
    "validation",
    "validacion",
    "validación",
    "discovered",
    "remaining",
    "rollback",
    "rollbacks",
    "strategy",
    "proposed",
    "request",
    "relevant",
    "context",
    "summary",
    "latest",
    "patch",
    "applied",
    "configured",
    "package",
    "manager",
    "commands",
    "none",
    "notes",
    "usable",
    "script",
    "found",
    "quality",
    "loop",
    "repairs",
    "attempts",
    "enabled",
    "depth",
    "workspace",
    "inspect",
    "inspection",
    "diagnosis",
    "diagnostic",
    "diagnóstico",
    "plan",
    "technology",
    "stack",
    "deployment",
    "configuration",
    "management",
    "dependencies",
    "observability",
    "plugin",
    "plugins",
    "framework",
    "serverless",
    "commonjs",
    "typescript",
    "javascript",
    "nodejs",
]);

export type ContextDiscoverySummary = {
    readonly enabled: boolean;
    readonly searchedQueries: readonly string[];
    readonly pendingQueries: readonly string[];
    readonly discoveredPaths: readonly string[];
    readonly readPaths: readonly string[];
    readonly remainingFileBudget: number;
};

const clampPositiveInteger = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
};

const configFor = (state: AgentState): Required<Pick<AgentContextConfig, "enabled" | "maxSearchQueries" | "maxFiles" | "maxSearchResults" | "globs" | "excludeGlobs">> => ({
    enabled: state.goal.context?.enabled ?? true,
    maxSearchQueries: clampPositiveInteger(state.goal.context?.maxSearchQueries, DEFAULT_MAX_SEARCH_QUERIES),
    maxFiles: clampPositiveInteger(state.goal.context?.maxFiles, DEFAULT_MAX_FILES),
    maxSearchResults: clampPositiveInteger(state.goal.context?.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS),
    globs: state.goal.context?.globs ?? DEFAULT_CONTEXT_GLOBS,
    excludeGlobs: state.goal.context?.excludeGlobs ?? [],
});

const normalizeSlashes = (value: string): string => value.replace(/\\/g, "/");

const trimLeadingDotSlash = (value: string): string => value.replace(/^(?:\.\/)+/, "");

const stripLocationSuffix = (value: string): string =>
    value.replace(/(?:\d+){1,2}$/, "");

const stripWrappingPunctuation = (value: string): string =>
    value
        .replace(/^[\s('"`<[]+/, "")
        .replace(/[\s)'">,\]]+$/, "");

const PROSE_FILE_LIKE_WORDS = new Set([
    "Node.js",
    "CommonJS.js",
    "TypeScript.ts",
    "JavaScript.js",
]);

const isProseFileLikeWord = (path: string): boolean => PROSE_FILE_LIKE_WORDS.has(path);

const isIgnoredPath = (path: string): boolean => {
    const segments = path.split("/");
    return segments.some((segment) =>
        segment === "node_modules" ||
        segment === ".git" ||
        segment === "dist" ||
        segment === "build" ||
        segment === "coverage" ||
        segment === ".next" ||
        segment === ".turbo" ||
        segment === ".cache"
    );
};

const hasSupportedExtension = (path: string): boolean =>
    PATH_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(`.${ext}`));

const toWorkspaceRelativePath = (cwd: string, raw: string): string | undefined => {
    const cwdNormalized = normalizeSlashes(cwd).replace(/\/+$/, "");
    let path = stripLocationSuffix(stripWrappingPunctuation(normalizeSlashes(raw.trim())));

    if (path.startsWith("file://")) path = path.slice("file://".length);
    if (path.startsWith(`${cwdNormalized}/`)) path = path.slice(cwdNormalized.length + 1);
    if (path === cwdNormalized) return undefined;

    path = trimLeadingDotSlash(path);

    if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
    if (path.includes("\0") || path.split("/").includes("..")) return undefined;
    if (isProseFileLikeWord(path)) return undefined;
    if (isIgnoredPath(path)) return undefined;
    if (!hasSupportedExtension(path)) return undefined;

    return path;
};


const globToRegExp = (glob: string): RegExp => {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLE_STAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLE_STAR::/g, ".*");
    return new RegExp(`^${escaped}$`);
};

const matchesAnyExclude = (path: string, excludeGlobs: readonly string[]): boolean =>
    excludeGlobs.some((glob) => globToRegExp(trimLeadingDotSlash(normalizeSlashes(glob))).test(path));

const searchGlobsFor = (config: ReturnType<typeof configFor>): readonly string[] => [
    ...config.globs,
    ...config.excludeGlobs.map((glob) => `!${glob}`),
];

const unique = <A>(values: readonly A[]): readonly A[] => {
    const seen = new Set<A>();
    const out: A[] = [];

    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }

    return out;
};

const shellText = (state: AgentState): string =>
    state.observations
        .filter((obs): obs is Extract<Observation, { type: "shell.result" }> => obs.type === "shell.result")
        .map((obs) => [obs.command.join(" "), obs.stdout.slice(-12_000), obs.stderr.slice(-12_000)].join("\n"))
        .join("\n");

const discoveryCorpus = (state: AgentState): string =>
    [state.goal.text, shellText(state)].filter(Boolean).join("\n");

export const extractLikelyFilePaths = (state: AgentState): readonly string[] => {
    const config = configFor(state);
    const corpus = discoveryCorpus(state);
    const pathPattern = new RegExp(
        `(?:file://)?(?:[A-Za-z]:)?[./\\\\]?(?:[A-Za-z0-9_@.-]+[/\\\\])*[A-Za-z0-9_@.-]+\\.(?:${PATH_EXTENSIONS.join("|")})(?::\\d+){0,2}`,
        "g"
    );

    const matches = corpus.match(pathPattern) ?? [];
    return unique(matches
        .map((match) => toWorkspaceRelativePath(state.goal.cwd, match))
        .filter((path): path is string => Boolean(path))
        .filter((path) => !matchesAnyExclude(path, config.excludeGlobs)));
};

const searchedQueries = (state: AgentState): readonly string[] =>
    unique(state.observations
        .filter((obs): obs is Extract<Observation, { type: "fs.searchResult" }> => obs.type === "fs.searchResult")
        .map((obs) => obs.query));

const readPaths = (state: AgentState): readonly string[] =>
    unique(state.observations
        .filter((obs): obs is Extract<Observation, { type: "fs.fileRead" }> => obs.type === "fs.fileRead")
        .map((obs) => obs.path));

const existsObservations = (state: AgentState): readonly Extract<Observation, { type: "fs.exists" }>[] =>
    state.observations.filter((obs): obs is Extract<Observation, { type: "fs.exists" }> => obs.type === "fs.exists");

const alreadyRead = (state: AgentState, path: string): boolean => readPaths(state).includes(path);

const knownMissing = (state: AgentState, path: string): boolean =>
    existsObservations(state).some((obs) => obs.path === path && !obs.exists);

const knownExisting = (state: AgentState, path: string): boolean =>
    existsObservations(state).some((obs) => obs.path === path && obs.exists);

const hasExistenceProbe = (state: AgentState, path: string): boolean =>
    existsObservations(state).some((obs) => obs.path === path);

const searchMatches = (state: AgentState, maxSearchResults: number): readonly SearchMatch[] =>
    state.observations
        .filter((obs): obs is Extract<Observation, { type: "fs.searchResult" }> => obs.type === "fs.searchResult")
        .flatMap((obs) => obs.matches)
        .slice(0, maxSearchResults);

const pathsFromSearchResults = (state: AgentState, maxSearchResults: number): readonly string[] => {
    const config = configFor(state);
    return unique(searchMatches(state, maxSearchResults)
        .map((match) => toWorkspaceRelativePath(state.goal.cwd, match.path))
        .filter((path): path is string => Boolean(path))
        .filter((path) => !matchesAnyExclude(path, config.excludeGlobs)));
};

const tokenScore = (token: string): number => {
    let score = token.length;
    if (/^[A-Z][A-Za-z0-9_]+$/.test(token)) score += 8;
    if (/[A-Z][a-z]+[A-Z]/.test(token)) score += 6;
    if (/^[a-z]+[A-Z]/.test(token)) score += 6;
    if (/Error$/.test(token)) score += 4;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) score += 2;
    return score;
};

const extractQuotedSignals = (text: string): readonly string[] => {
    const out: string[] = [];
    const regex = /["'`]([^"'`\n]{4,80})["'`]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text))) {
        const value = match[1]?.trim();
        if (!value) continue;
        if (/\s{3,}/.test(value)) continue;
        if (/^[A-Za-z0-9_./:-]+$/.test(value)) out.push(value);
    }

    return out;
};

export const deriveContextSearchQueries = (state: AgentState): readonly string[] => {
    const corpus = discoveryCorpus(state);
    const quoted = extractQuotedSignals(corpus);
    const tokens = corpus.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
    const candidates = unique([...quoted, ...tokens])
        .map((value) => value.trim())
        .filter((value) => value.length >= 4 && value.length <= 80)
        .filter((value) => !value.includes("/"))
        .filter((value) => !STOP_WORDS.has(value.toLowerCase()))
        .filter((value) => !/^\d+$/.test(value))
        .filter((value) => /^[A-Za-z0-9_]+$/.test(value));

    return [...candidates]
        .sort((a, b) => tokenScore(b) - tokenScore(a))
        .slice(0, 8);
};

const contextFileReadCount = (state: AgentState): number =>
    readPaths(state).filter((path) => path !== "package.json").length;

export const describeContextDiscovery = (state: AgentState): string => {
    const summary = summarizeContextDiscovery(state);
    if (!summary.enabled) return "Context discovery: disabled.";

    const searched = summary.searchedQueries.join(", ") || "none";
    const pending = summary.pendingQueries.slice(0, 5).join(", ") || "none";
    const paths = summary.discoveredPaths.slice(0, 8).join(", ") || "none";
    const read = summary.readPaths.filter((path) => path !== "package.json").join(", ") || "none";

    return [
        `Context discovery: searched queries: ${searched}.`,
        `Pending queries: ${pending}.`,
        `Discovered paths: ${paths}.`,
        `Read context files: ${read}.`,
        `Remaining file budget: ${summary.remainingFileBudget}.`,
    ].join(" ");
};

export const summarizeContextDiscovery = (state: AgentState): ContextDiscoverySummary => {
    const config = configFor(state);
    const searched = searchedQueries(state);
    const queries = deriveContextSearchQueries(state);
    const directPaths = extractLikelyFilePaths(state);
    const resultPaths = pathsFromSearchResults(state, config.maxSearchResults);
    const read = readPaths(state);
    const remainingFileBudget = Math.max(0, config.maxFiles - contextFileReadCount(state));

    return {
        enabled: config.enabled,
        searchedQueries: searched,
        pendingQueries: queries.filter((query) => !searched.includes(query)),
        discoveredPaths: unique([...directPaths, ...resultPaths]),
        readPaths: read,
        remainingFileBudget,
    };
};

export const nextContextDiscoveryAction = (state: AgentState): AgentAction | undefined => {
    const config = configFor(state);
    if (!config.enabled) return undefined;
    if (state.goal.initialPatch?.trim()) return undefined;

    const searched = searchedQueries(state);
    const readsRemaining = Math.max(0, config.maxFiles - contextFileReadCount(state));
    const directPaths = extractLikelyFilePaths(state);
    const resultPaths = pathsFromSearchResults(state, config.maxSearchResults);

    if (readsRemaining > 0) {
        const nextPath = [...directPaths, ...resultPaths].find((path) =>
            path !== "package.json" &&
            !alreadyRead(state, path) &&
            !knownMissing(state, path)
        );

        if (nextPath) {
            // Paths discovered from logs can be stale, truncated, or approximate. Probe
            // before reading so context discovery does not stop the whole agent with FsError.
            if (!hasExistenceProbe(state, nextPath)) {
                return { type: "fs.exists", path: nextPath };
            }

            if (knownExisting(state, nextPath)) {
                return { type: "fs.readFile", path: nextPath };
            }
        }
    }

    if (searched.length >= config.maxSearchQueries) return undefined;

    const nextQuery = deriveContextSearchQueries(state).find((query) => !searched.includes(query));
    if (!nextQuery) return undefined;

    return {
        type: "fs.searchText",
        query: nextQuery,
        globs: searchGlobsFor(config),
    };
};
