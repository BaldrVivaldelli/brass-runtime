// src/http/compression/environment.ts

/**
 * Detects whether the current runtime is Node.js.
 * Returns true when `process.versions.node` is defined.
 */
export function isNodeEnvironment(): boolean {
  return (
    typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null
  );
}
