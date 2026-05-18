import type { AgentState, Observation } from "../types";
import type { GoalSignals, GoalLengthCategory } from "./types";

/**
 * File path detection supports common path patterns including:
 * - Unix-style paths: ./src/foo.ts, /home/user/file.js
 * - Windows-style paths: C:\Users\file.ts, src\foo.js
 * - Bare file references with extensions: foo.ts, bar/baz.tsx
 *
 * Keep this as a bounded linear scan rather than a nested path regex; goal text
 * is user-controlled and CodeQL flags the regex form as a potential ReDoS risk.
 */
const FILE_EXTENSIONS = [
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

const ASCII_CASE_BIT = 32;
const MAX_FILE_PATH_CANDIDATE_LENGTH = 512;

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

const isAsciiAlpha = (code: number): boolean =>
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

const isAsciiDigit = (code: number): boolean => code >= 48 && code <= 57;

const isPathCandidateChar = (code: number): boolean =>
    isAsciiAlpha(code) ||
    isAsciiDigit(code) ||
    code === 95 || // _
    code === 64 || // @
    code === 46 || // .
    code === 45 || // -
    code === 47 || // /
    code === 92 || // \
    code === 58; // :

const matchesExtension = (
    text: string,
    start: number,
    end: number,
    extension: string
): boolean => {
    if (end - start !== extension.length) return false;

    for (let offset = 0; offset < extension.length; offset++) {
        const textCode = text.charCodeAt(start + offset) | ASCII_CASE_BIT;
        if (textCode !== extension.charCodeAt(offset)) {
            return false;
        }
    }

    return true;
};

const matchesKnownExtension = (text: string, start: number, end: number): boolean => {
    for (const extension of FILE_EXTENSIONS) {
        if (matchesExtension(text, start, end, extension)) {
            return true;
        }
    }

    return false;
};

const stripTrailingPathPunctuation = (
    text: string,
    start: number,
    end: number
): number => {
    let currentEnd = end;
    while (currentEnd > start) {
        const code = text.charCodeAt(currentEnd - 1);
        if (code !== 46 && code !== 58) break;
        currentEnd--;
    }
    return currentEnd;
};

const stripLineSuffixes = (text: string, start: number, end: number): number => {
    let currentEnd = end;

    for (let suffixCount = 0; suffixCount < 2; suffixCount++) {
        let cursor = currentEnd - 1;
        if (cursor < start || !isAsciiDigit(text.charCodeAt(cursor))) break;

        while (cursor >= start && isAsciiDigit(text.charCodeAt(cursor))) {
            cursor--;
        }

        if (cursor < start || text.charCodeAt(cursor) !== 58) break;
        currentEnd = cursor;
    }

    return currentEnd;
};

const findLastDot = (text: string, start: number, end: number): number => {
    for (let index = end - 1; index >= start; index--) {
        if (text.charCodeAt(index) === 46) {
            return index;
        }
    }

    return -1;
};

const findFilenameStart = (text: string, start: number, dotIndex: number): number => {
    let filenameStart = start;

    for (let index = start; index < dotIndex; index++) {
        const code = text.charCodeAt(index);
        if (code === 47 || code === 92) {
            filenameStart = index + 1;
        }
    }

    return filenameStart;
};

const isFilePathCandidate = (text: string, start: number, end: number): boolean => {
    const punctuationEnd = stripTrailingPathPunctuation(text, start, end);
    const pathEnd = stripLineSuffixes(text, start, punctuationEnd);
    const dotIndex = findLastDot(text, start, pathEnd);

    if (dotIndex < 0 || dotIndex + 1 >= pathEnd) return false;
    if (!matchesKnownExtension(text, dotIndex + 1, pathEnd)) return false;

    return dotIndex > findFilenameStart(text, start, dotIndex);
};

/**
 * Detect whether the goal text contains file path references.
 */
const detectFilePaths = (text: string): boolean => {
    let candidateStart = -1;
    let candidateTooLong = false;

    for (let index = 0; index <= text.length; index++) {
        const isCandidateChar =
            index < text.length && isPathCandidateChar(text.charCodeAt(index));

        if (isCandidateChar) {
            if (candidateStart < 0) {
                candidateStart = index;
            }
            if (index + 1 - candidateStart > MAX_FILE_PATH_CANDIDATE_LENGTH) {
                candidateTooLong = true;
            }
            continue;
        }

        if (candidateStart >= 0) {
            if (
                !candidateTooLong &&
                isFilePathCandidate(text, candidateStart, index)
            ) {
                return true;
            }
            candidateStart = -1;
            candidateTooLong = false;
        }
    }

    return false;
};

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
