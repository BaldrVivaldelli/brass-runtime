import type { AgentState, Observation } from "../types";
import type { GoalSignals, GoalLengthCategory } from "./types";

/**
 * File path detection regex.
 * Matches common path patterns including:
 * - Unix-style paths: ./src/foo.ts, /home/user/file.js
 * - Windows-style paths: C:\Users\file.ts, src\foo.js
 * - Bare file references with extensions: foo.ts, bar/baz.tsx
 */
const FILE_PATH_PATTERN =
    /(?:file:\/\/)?(?:[A-Za-z]:)?[./\\]?(?:[A-Za-z0-9_@.-]+[/\\])*[A-Za-z0-9_@.-]+\.(?:tsx|jsx|mts|cts|mjs|cjs|json|yaml|html|scss|ts|js|md|yml|css)(?::\d+){0,2}/i;

/**
 * Keywords to detect in goal text (case-insensitive, word-boundary match).
 */
const KEYWORDS = [
    "refactor",
    "rename",
    "bug",
    "fix",
    "add",
    "create",
    "move",
    "delete",
] as const;

type Keyword = (typeof KEYWORDS)[number];

/**
 * Pre-compiled keyword patterns for efficient matching.
 */
const KEYWORD_PATTERNS: ReadonlyMap<Keyword, RegExp> = new Map(
    KEYWORDS.map((kw) => [kw, new RegExp(`\\b${kw}\\b`, "i")])
);

/**
 * Categorize goal text length.
 * - short: < 80 characters
 * - medium: 80–300 characters
 * - long: > 300 characters
 */
const categorizeGoalLength = (text: string): GoalLengthCategory => {
    const len = text.length;
    if (len < 80) return "short";
    if (len <= 300) return "medium";
    return "long";
};

/**
 * Detect whether the goal text contains file path references.
 */
const detectFilePaths = (text: string): boolean => FILE_PATH_PATTERN.test(text);

/**
 * Detect keyword presence in goal text (case-insensitive, word-boundary).
 */
const detectKeywords = (
    text: string
): GoalSignals["keywords"] => {
    const result: Record<string, boolean> = {};
    for (const kw of KEYWORDS) {
        result[kw] = KEYWORD_PATTERNS.get(kw)!.test(text);
    }
    return result as GoalSignals["keywords"];
};

/**
 * Extract context signals from observations collected before planning.
 * - hasProjectProfile: true if a package.json file was read
 * - searchResultCount: total number of search matches across all search observations
 * - discoveredFileCount: number of distinct file read observations
 */
const extractContextSignals = (
    observations: readonly Observation[]
): GoalSignals["contextSignals"] => {
    let hasProjectProfile = false;
    let searchResultCount = 0;
    let discoveredFileCount = 0;

    for (const obs of observations) {
        switch (obs.type) {
            case "fs.fileRead":
                discoveredFileCount++;
                if (obs.path.endsWith("package.json")) {
                    hasProjectProfile = true;
                }
                break;
            case "fs.searchResult":
                searchResultCount += obs.matches.length;
                break;
        }
    }

    return {
        hasProjectProfile,
        searchResultCount,
        discoveredFileCount,
    };
};

/**
 * Pure function that extracts goal signals from agent state.
 * Uses only data available before the planning LLM call:
 * - Goal text (always available)
 * - Observations collected during discovery phase
 *
 * No I/O, no network, no LLM calls.
 */
export const extractSignals = (state: AgentState): GoalSignals => {
    const goalText = state.goal.text;

    return {
        goalLengthCategory: categorizeGoalLength(goalText),
        hasFilePaths: detectFilePaths(goalText),
        keywords: detectKeywords(goalText),
        contextSignals: extractContextSignals(state.observations),
    };
};
