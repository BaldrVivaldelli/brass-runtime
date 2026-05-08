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
 * - If gradient < 1.0: newLimit = floor(currentLimit * gradient)
 * - If gradient >= 1.0: newLimit = currentLimit + headroom
 *
 * The result is clamped to [minBound, maxBound].
 */
export function computeNewLimit(
  currentLimit: number,
  gradient: number,
  headroom: number,
  minBound: number,
  maxBound: number,
): number {
  let newLimit: number;
  if (gradient < 1.0) {
    newLimit = Math.floor(currentLimit * gradient);
  } else {
    newLimit = currentLimit + headroom;
  }
  return Math.max(minBound, Math.min(maxBound, newLimit));
}
