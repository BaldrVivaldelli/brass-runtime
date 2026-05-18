import type { TokenUsage } from "./types";

/**
 * Estimates token usage from character lengths when the provider does not
 * report actual usage. Uses ceil(length / 4) as a rough approximation.
 */
export const estimateTokens = (promptLength: number, responseLength: number): TokenUsage => ({
    inputTokens: Math.ceil(promptLength / 4),
    outputTokens: Math.ceil(responseLength / 4),
});
