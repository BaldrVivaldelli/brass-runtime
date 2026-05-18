import type { ConfidenceSignals } from "./types";

/**
 * Hedging phrases that indicate uncertainty in an LLM response.
 */
const HEDGING_PHRASES: readonly string[] = [
    "i think",
    "maybe",
    "perhaps",
    "not sure",
    "might be",
    "could be",
];

/**
 * Detects whether the response contains a fenced diff block or starts with
 * unified diff markers (--- / +++).
 */
const hasDiffBlock = (response: string): boolean => {
    if (response.includes("```diff")) return true;
    const lines = response.split("\n");
    return lines.some(
        (line) => line.startsWith("---") || line.startsWith("+++"),
    );
};

/**
 * Detects whether the response is concise (< 2000 characters).
 */
const isConcise = (response: string): boolean => response.length < 2000;

/**
 * Detects whether the response references at least one word (3+ chars) from
 * the goal text.
 */
const referencesGoal = (response: string, goal: string): boolean => {
    const words = goal
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .map((w) => w.toLowerCase());
    const responseLower = response.toLowerCase();
    return words.some((word) => responseLower.includes(word));
};

/**
 * Detects whether the response mentions any file paths from read observations.
 */
const referencesReadFiles = (
    response: string,
    readFiles: readonly string[],
): boolean => {
    if (readFiles.length === 0) return false;
    return readFiles.some((filePath) => response.includes(filePath));
};

/**
 * Counts the number of hedging phrases present in the response.
 */
const countHedgingPhrases = (response: string): number => {
    const responseLower = response.toLowerCase();
    let count = 0;
    for (const phrase of HEDGING_PHRASES) {
        // Count all occurrences of each phrase
        let idx = 0;
        while (true) {
            const found = responseLower.indexOf(phrase, idx);
            if (found === -1) break;
            count++;
            idx = found + phrase.length;
        }
    }
    return count;
};

/**
 * Extracts the individual confidence signal values for event reporting.
 */
export const extractConfidenceSignals = (
    response: string,
    goal: string,
    readFiles: readonly string[],
): ConfidenceSignals => ({
    hasDiffBlock: hasDiffBlock(response),
    isConcise: isConcise(response),
    referencesGoal: referencesGoal(response, goal),
    referencesReadFiles: referencesReadFiles(response, readFiles),
    hedgingCount: countHedgingPhrases(response),
});

/**
 * Pure function that estimates confidence in an LLM response based on
 * structural heuristics. Returns a score in [0.0, 1.0] and the signals used.
 *
 * Scoring:
 * - Base score: 0.35
 * - +0.20 for valid fenced diff block
 * - +0.15 for concise response (length < 2000 chars)
 * - +0.15 for referencing goal text
 * - +0.15 for referencing previously-read files
 * - -0.10 per hedging phrase (capped at -0.30)
 *
 * Final score is clamped to [0.0, 1.0].
 */
export const estimateConfidence = (
    response: string,
    goal: string,
    readFiles: readonly string[],
): { score: number; signals: ConfidenceSignals } => {
    const signals = extractConfidenceSignals(response, goal, readFiles);

    let score = 0.35;

    if (signals.hasDiffBlock) score += 0.20;
    if (signals.isConcise) score += 0.15;
    if (signals.referencesGoal) score += 0.15;
    if (signals.referencesReadFiles) score += 0.15;

    const hedgingPenalty = Math.min(signals.hedgingCount * 0.10, 0.30);
    score -= hedgingPenalty;

    // Clamp to [0.0, 1.0]
    score = Math.max(0.0, Math.min(1.0, score));

    return { score, signals };
};
