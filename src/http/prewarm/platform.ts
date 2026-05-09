// src/http/prewarm/platform.ts — Platform detection utilities.

/**
 * Detects the current runtime platform.
 *
 * @returns "browser" if running in a browser environment, "node" otherwise.
 */
export function detectPlatform(): "browser" | "node" {
  return typeof window !== "undefined" && typeof window.document !== "undefined"
    ? "browser"
    : "node";
}

/**
 * Validates that the global `fetch` API is available.
 *
 * @throws Error if `fetch` or `AbortController` is not available.
 */
export function validateFetchAvailable(): void {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "makePrewarmManager: global fetch is not available. Requires Node.js 18+ or modern browser.",
    );
  }
  if (typeof globalThis.AbortController !== "function") {
    throw new Error(
      "makePrewarmManager: global AbortController is not available.",
    );
  }
}
