import type { Arm } from "./types";

/** The fallback arm ID for paths that match no derivable pattern. */
export const FALLBACK_ARM_ID = "__fallback__" as const;

/**
 * Known compound extensions ordered longest-first so the greedy match
 * picks the most specific suffix.
 */
const COMPOUND_EXTENSIONS = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".spec.ts",
  ".spec.tsx",
  ".spec.js",
  ".spec.jsx",
  ".pbt.test.ts",
  ".pbt.test.js",
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".config.ts",
  ".config.js",
  ".config.mjs",
  ".config.cjs",
  ".module.ts",
  ".module.css",
  ".stories.tsx",
  ".stories.ts",
] as const;

/**
 * Extracts the compound or simple extension from a filename.
 * Returns the extension including the leading dot, or empty string if none.
 *
 * Examples:
 *   "decide.test.ts" → ".test.ts"
 *   "batch.ts"       → ".ts"
 *   "Makefile"       → ""
 */
const extractExtension = (filename: string): string => {
  // Check compound extensions first (longest match wins)
  const lower = filename.toLowerCase();
  for (const ext of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(ext) && filename.length > ext.length) {
      return filename.slice(filename.length - ext.length);
    }
  }

  // Fall back to simple extension
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < filename.length - 1) {
    return filename.slice(dotIndex);
  }

  return "";
};

/**
 * Normalizes path separators to forward slashes.
 */
const normalizePath = (filePath: string): string =>
  filePath.replace(/\\/g, "/");

/**
 * Derives a stable arm ID from a file path based on directory structure
 * and file extension. The pattern generalizes the specific filename to
 * a glob representing its structural group.
 *
 * Examples:
 *   "src/agent/core/decide.ts"                    → "src/agent/core/*.ts"
 *   "package.json"                                 → "*.json"
 *   "src/http/lifecycle/batch.ts"                 → "src/http/lifecycle/*.ts"
 *   "src/agent/core/__tests__/decide.test.ts"     → "src/agent/core/__tests__/*.test.ts"
 *   "README.md"                                    → "*.md"
 *   "docs/ai/PROJECT_MAP.md"                      → "docs/ai/*.md"
 */
export const deriveArmId = (filePath: string): string => {
  try {
    if (!filePath || typeof filePath !== "string") {
      return FALLBACK_ARM_ID;
    }

    const normalized = normalizePath(filePath.trim());
    if (!normalized) {
      return FALLBACK_ARM_ID;
    }

    // Split into directory and filename
    const lastSlash = normalized.lastIndexOf("/");
    const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
    const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

    if (!filename) {
      return FALLBACK_ARM_ID;
    }

    const extension = extractExtension(filename);
    if (!extension) {
      return FALLBACK_ARM_ID;
    }

    // Build arm ID: directory/* + extension, or just *.extension for root files
    const glob = `*${extension}`;
    return directory ? `${directory}/${glob}` : glob;
  } catch {
    return FALLBACK_ARM_ID;
  }
};

/**
 * Assigns a file path to an Arm. Always returns exactly one arm.
 * Paths that cannot be parsed fall into the "__fallback__" arm.
 * Never throws.
 */
export const assignArm = (filePath: string): Arm => {
  const id = deriveArmId(filePath);
  return { id, pattern: id };
};

/**
 * Assigns multiple candidate paths to their arms, grouping paths by arm.
 * Returns a map from arm ID to the list of candidate paths in that arm.
 */
export const groupByArm = (
  candidates: readonly string[],
): ReadonlyMap<string, readonly string[]> => {
  const map = new Map<string, string[]>();

  for (const path of candidates) {
    const arm = assignArm(path);
    const existing = map.get(arm.id);
    if (existing) {
      existing.push(path);
    } else {
      map.set(arm.id, [path]);
    }
  }

  return map;
};
