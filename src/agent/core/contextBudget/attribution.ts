import type { AttributionLogEntry, BanditState } from "./types";

/** Default maximum attribution log entries. */
export const DEFAULT_MAX_LOG_ENTRIES = 200;

/**
 * Builds an attribution log entry from run data.
 */
export const buildAttributionEntry = (
  pulledArms: readonly string[],
  filesPerArm: Readonly<Record<string, readonly string[]>>,
  reward: number,
  timestamp: number,
): AttributionLogEntry => ({
  timestamp,
  pulledArms,
  filesPerArm,
  reward,
});

/**
 * Appends a log entry to the state, enforcing the FIFO cap.
 * Returns a new BanditState with the updated log (does not mutate input).
 */
export const appendAttributionLog = (
  state: BanditState,
  entry: AttributionLogEntry,
  maxEntries: number = DEFAULT_MAX_LOG_ENTRIES,
): BanditState => {
  const newLog = [...state.log, entry];
  const evicted =
    newLog.length > maxEntries ? newLog.slice(newLog.length - maxEntries) : newLog;
  return { ...state, log: evicted };
};
