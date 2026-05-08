// src/http/lifecycle/timing.ts

/**
 * Isomorphic timing utility for the HTTP lifecycle module.
 *
 * Uses `performance.now()` when available (sub-millisecond precision),
 * falling back to `Date.now()` (millisecond precision) for environments
 * where the Performance API is not available.
 *
 * This module does NOT reference `window`, `process`, or `global` —
 * it only checks for the existence of `performance` as a typeof guard.
 *
 * @see Requirements 7.3, 7.4, 7.6
 */
export const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();
