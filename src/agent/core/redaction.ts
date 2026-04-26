import type { AgentRedactionConfig } from "./types";

const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
    /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_\-]{16,}\b/g,
    /\bAIza[0-9A-Za-z_\-]{20,}\b/g,
    /\b(?:xoxb|xoxp|xoxa|xoxr)-[A-Za-z0-9\-]{20,}\b/g,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    /((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)(["']?)[^\s"']{8,}\2/gi,
    /(Bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi,
];

const toRegExp = (pattern: string): RegExp | undefined => {
    try {
        return new RegExp(pattern, "gi");
    } catch {
        return undefined;
    }
};

const configuredPatterns = (config: AgentRedactionConfig | undefined): readonly RegExp[] =>
    (config?.additionalPatterns ?? [])
        .map(toRegExp)
        .filter((pattern): pattern is RegExp => Boolean(pattern));

export const isRedactionEnabled = (config: AgentRedactionConfig | undefined): boolean => config?.enabled ?? true;

export const redactText = (value: string, config?: AgentRedactionConfig): string => {
    if (!isRedactionEnabled(config) || !value) return value;

    return [...DEFAULT_SECRET_PATTERNS, ...configuredPatterns(config)].reduce(
        (current, pattern) => current.replace(pattern, (match, prefix?: string) => {
            if (typeof prefix === "string" && prefix.length > 0 && match.startsWith(prefix)) {
                return `${prefix}[REDACTED]`;
            }
            return "[REDACTED]";
        }),
        value
    );
};
