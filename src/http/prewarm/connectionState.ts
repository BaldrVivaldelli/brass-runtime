// src/http/prewarm/connectionState.ts — Per-origin connection state tracking.

import type { PrewarmOriginState, PrewarmOriginStatus, PrewarmStatusSnapshot } from "./types";

/**
 * Internal per-origin entry tracking connection state.
 */
type OriginEntry = {
  origin: string;
  status: PrewarmOriginStatus;
  lastProbeAt: number | undefined;
  warmUntil: number | undefined;
};

/**
 * Interface for the connection state map.
 */
export type ConnectionStateMap = {
  /** Mark an origin as warm with the current timestamp. */
  markWarm: (origin: string, now?: number) => void;
  /** Mark an origin as expired. */
  markExpired: (origin: string) => void;
  /** Mark an origin as idle (reset state). */
  markIdle: (origin: string) => void;
  /** Mark an origin as probing. */
  markProbing: (origin: string) => void;
  /** Check if an origin is currently warm (not expired). */
  isWarm: (origin: string, now?: number) => boolean;
  /** Get the current state of an origin. */
  getState: (origin: string) => PrewarmOriginState | undefined;
  /** Get a snapshot of all managed origins. */
  snapshot: () => PrewarmStatusSnapshot;
};

/**
 * Creates a connection state map for tracking per-origin warm/expired/idle states.
 *
 * @param origins - Array of origin strings to manage.
 * @param keepAliveDurationMs - Duration in ms after which a warm connection expires.
 * @returns A ConnectionStateMap instance.
 */
export function makeConnectionStateMap(origins: string[], keepAliveDurationMs: number): ConnectionStateMap {
  const entries = new Map<string, OriginEntry>();

  for (const origin of origins) {
    entries.set(origin, {
      origin,
      status: "idle",
      lastProbeAt: undefined,
      warmUntil: undefined,
    });
  }

  function markWarm(origin: string, now?: number): void {
    const entry = entries.get(origin);
    if (!entry) return;
    const timestamp = now ?? Date.now();
    entry.status = "warm";
    entry.lastProbeAt = timestamp;
    entry.warmUntil = timestamp + keepAliveDurationMs;
  }

  function markExpired(origin: string): void {
    const entry = entries.get(origin);
    if (!entry) return;
    entry.status = "expired";
  }

  function markIdle(origin: string): void {
    const entry = entries.get(origin);
    if (!entry) return;
    entry.status = "idle";
    entry.lastProbeAt = undefined;
    entry.warmUntil = undefined;
  }

  function markProbing(origin: string): void {
    const entry = entries.get(origin);
    if (!entry) return;
    entry.status = "probing";
  }

  function isWarm(origin: string, now?: number): boolean {
    const entry = entries.get(origin);
    if (!entry) return false;
    if (entry.status !== "warm") return false;
    if (entry.lastProbeAt === undefined || entry.warmUntil === undefined) return false;
    const currentTime = now ?? Date.now();
    if (currentTime >= entry.warmUntil) {
      // Auto-transition to expired
      entry.status = "expired";
      return false;
    }
    return true;
  }

  function getState(origin: string): PrewarmOriginState | undefined {
    const entry = entries.get(origin);
    if (!entry) return undefined;
    return {
      origin: entry.origin,
      status: entry.status,
      lastProbeAt: entry.lastProbeAt,
      warmUntil: entry.warmUntil,
    };
  }

  function snapshot(): PrewarmStatusSnapshot {
    const result: PrewarmOriginState[] = [];
    for (const entry of entries.values()) {
      result.push({
        origin: entry.origin,
        status: entry.status,
        lastProbeAt: entry.lastProbeAt,
        warmUntil: entry.warmUntil,
      });
    }
    return { origins: result };
  }

  return { markWarm, markExpired, markIdle, markProbing, isWarm, getState, snapshot };
}
