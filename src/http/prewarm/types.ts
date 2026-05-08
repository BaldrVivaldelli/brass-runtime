// src/http/prewarm/types.ts — Public types for the HTTP Connection Pre-warming module.

import type { HttpClientFn } from "../client";

/**
 * Status of a pre-warm probe result.
 */
export type PrewarmResultStatus = "warmed" | "already-warm" | "failed" | "cancelled";

/**
 * Result of a single pre-warm probe operation.
 */
export type PrewarmResult = {
  /** The origin that was probed. */
  origin: string;
  /** Outcome of the probe operation. */
  status: PrewarmResultStatus;
  /** Duration of the probe in milliseconds (0 for "already-warm"). */
  durationMs: number;
  /** Error information if status is "failed". */
  error?: string;
};

/**
 * Event types emitted by the PrewarmManager during connection state changes.
 */
export type PrewarmEventType =
  | "connection-warmed"
  | "connection-expired"
  | "connection-failed"
  | "connection-cancelled";

/**
 * An event emitted by the PrewarmManager to notify observers of connection state changes.
 */
export type PrewarmEvent = {
  /** The type of prewarm event. */
  type: PrewarmEventType;
  /** The origin associated with the event. */
  origin: string;
  /** Timestamp (ms) when the event occurred. */
  timestamp: number;
  /** Duration of the probe in milliseconds, if applicable. */
  durationMs?: number;
  /** Error information, if applicable. */
  error?: string;
};

/**
 * Per-origin connection state in the state machine.
 */
export type PrewarmOriginStatus = "idle" | "probing" | "warm" | "expired";

/**
 * State information for a single managed origin.
 */
export type PrewarmOriginState = {
  /** The origin string. */
  origin: string;
  /** Current state of the origin. */
  status: PrewarmOriginStatus;
  /** Timestamp of the last successful probe, if any. */
  lastProbeAt?: number;
  /** Timestamp until which the connection is considered warm. */
  warmUntil?: number;
};

/**
 * Snapshot of all managed origins and their current states.
 */
export type PrewarmStatusSnapshot = {
  /** State of each managed origin. */
  origins: PrewarmOriginState[];
};

/**
 * Configuration for creating a PrewarmManager.
 */
export type PrewarmConfig = {
  /** Origins to pre-warm. Each must be a valid URL origin (scheme + host + optional port). */
  origins: string[];
  /** Keep-alive duration in ms. Default: 55000. */
  keepAliveDurationMs?: number;
  /** Max concurrent in-flight probes. Default: 4. */
  budget?: number;
  /** Probe timeout in ms. Default: 5000. */
  probeTimeoutMs?: number;
  /** Auto-refresh expired connections. Default: false. */
  autoRefresh?: boolean;
  /** Route probes through the Wire_Client pool. Default: false. */
  useClientPool?: boolean;
  /** Optional Wire_Client to use when useClientPool is true. */
  client?: HttpClientFn;
  /** Event observer callback. */
  onEvent?: (event: PrewarmEvent) => void;
};
