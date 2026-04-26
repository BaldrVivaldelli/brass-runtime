const FENCED_DIFF_BLOCK = /```(?:diff|patch)?\s*\n([\s\S]*?)```/g;

const stripGitPrefix = (path: string): string => path.replace(/^[ab]\//, "");
const normalizePatch = (patch: string): string => patch.replace(/\r\n/g, "\n").trim();

const looksLikeUnifiedDiff = (content: string): boolean => {
    const normalized = normalizePatch(content);
    return normalized.includes("+++ ") && normalized.includes("--- ");
};

const firstRawDiff = (content: string): string | undefined => {
    const normalized = normalizePatch(content);
    const diffIndex = normalized.indexOf("diff --git ");
    const plainIndex = normalized.indexOf("--- ");
    const start = [diffIndex, plainIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (start === undefined) return undefined;

    const candidate = normalized.slice(start).trim();
    return looksLikeUnifiedDiff(candidate) ? candidate : undefined;
};

export const extractUnifiedDiff = (content: string): string | undefined => {
    const normalized = normalizePatch(content);
    if (!normalized) return undefined;

    const matches = normalized.matchAll(FENCED_DIFF_BLOCK);
    for (const match of matches) {
        const candidate = normalizePatch(match[1] ?? "");
        if (looksLikeUnifiedDiff(candidate)) {
            return candidate;
        }
    }

    return firstRawDiff(normalized);
};

const extractPathToken = (line: string): string | undefined => {
    const token = line.trim().split(/\s+/)[0];
    if (!token || token === "/dev/null") return undefined;
    return stripGitPrefix(token);
};

export const extractPatchPaths = (patch: string): readonly string[] => {
    const normalized = normalizePatch(patch);
    if (!normalized) return [];

    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const line of normalized.split("\n")) {
        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
            const path = extractPathToken(line.slice(4));
            if (!path || seen.has(path)) continue;
            seen.add(path);
            ordered.push(path);
        }
    }

    return ordered;
};
