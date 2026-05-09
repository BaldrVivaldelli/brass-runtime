// src/http/adaptiveLimiter/gradient.ts

/**
 * Computes the gradient as the ratio of minimum latency to current (smoothed) latency.
 * A gradient < 1.0 indicates latency is increasing (saturation).
 * A gradient >= 1.0 indicates latency is stable or decreasing.
 */
export function computeGradient(minLatency: number, currentLatency: number): number {
  if (currentLatency <= 0) return 1.0;
  return minLatency / currentLatency;
}

/**
 * Computes the new concurrency limit based on the gradient.
 *
 * - If gradient < decreaseThreshold: decrease toward `currentLimit * gradient`
 * - If gradient >= increaseThreshold: newLimit = currentLimit + headroom
 * - Otherwise: hold the current limit
 *
 * Decreases are capped by `maxDecreaseRatio` so a single noisy latency sample
 * cannot collapse concurrency.
 *
 * The result is clamped to [minBound, maxBound].
 */
export function computeNewLimit(
  currentLimit: number,
  gradient: number,
  headroom: number,
  minBound: number,
  maxBound: number,
  options: {
    readonly decreaseThreshold?: number;
    readonly increaseThreshold?: number;
    readonly maxDecreaseRatio?: number;
  } = {},
): number {
  const decreaseThreshold = options.decreaseThreshold ?? 1.0;
  const increaseThreshold = options.increaseThreshold ?? 1.0;
  const maxDecreaseRatio = options.maxDecreaseRatio ?? 1.0;
  let newLimit: number;
  if (gradient < decreaseThreshold) {
    const rawLimit = Math.floor(currentLimit * gradient);
    const maxDecrease = Math.max(1, Math.floor(currentLimit * maxDecreaseRatio));
    newLimit = Math.max(rawLimit, currentLimit - maxDecrease);
  } else if (gradient >= increaseThreshold) {
    newLimit = currentLimit + headroom;
  } else {
    newLimit = currentLimit;
  }
  return Math.max(minBound, Math.min(maxBound, newLimit));
}
