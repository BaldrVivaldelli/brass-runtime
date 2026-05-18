import type { Arm, BanditState } from "./types";
import { groupByArm } from "./armExtraction";
import { selectArms } from "./banditEngine";

/**
 * Determines whether bandit reordering should be applied.
 * Returns false when:
 * - BanditState has no arm history (empty arms map)
 * - Context discovery is disabled
 * - initialPatch is present
 */
export const shouldApplyBandit = (
  state: BanditState,
  contextEnabled: boolean,
  hasInitialPatch: boolean
): boolean => {
  if (Object.keys(state.arms).length === 0) return false;
  if (!contextEnabled) return false;
  if (hasInitialPatch) return false;
  return true;
};

/**
 * Reorders candidate file paths based on bandit arm priorities.
 * When state is empty or has no arm history, returns candidates unchanged.
 *
 * This is the primary integration point — called by contextDiscovery.ts
 * before selecting the next file to read.
 */
export const reorderCandidates = (
  candidates: readonly string[],
  state: BanditState,
  rng: () => number
): readonly string[] => {
  try {
    // If state has no arm history, return original order
    if (Object.keys(state.arms).length === 0) {
      return candidates;
    }

    // Group candidates by arm
    const armGroups = groupByArm(candidates);

    // Create Arm objects for each unique arm ID found
    const uniqueArms: Arm[] = [];
    for (const armId of armGroups.keys()) {
      uniqueArms.push({ id: armId, pattern: armId });
    }

    // Get priority-ordered arms from bandit engine
    const prioritizedArms = selectArms(state, uniqueArms, rng);

    // Flatten: for each arm in priority order, append its candidate paths
    const result: string[] = [];
    const includedArmIds = new Set<string>();

    for (const arm of prioritizedArms) {
      const paths = armGroups.get(arm.id);
      if (paths) {
        for (const p of paths) {
          result.push(p);
        }
        includedArmIds.add(arm.id);
      }
    }

    // Append any candidates from arms not in the priority list at the end
    for (const [armId, paths] of armGroups) {
      if (!includedArmIds.has(armId)) {
        for (const p of paths) {
          result.push(p);
        }
      }
    }

    return result;
  } catch (error) {
    // Graceful degradation — log warning and return original order on error
    console.warn(
      "[contextBudget] reorderCandidates failed, returning original order:",
      error instanceof Error ? error.message : String(error)
    );
    return candidates;
  }
};
