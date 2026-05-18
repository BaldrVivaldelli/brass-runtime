import type { Arm, ArmStats, BanditState } from "./types";

/**
 * Returns the default prior stats for a new arm (Beta(1,1) = uniform).
 */
export const defaultArmStats = (): ArmStats => ({
  alpha: 1,
  beta: 1,
  pulls: 0,
  lastPulledAt: 0,
});

/**
 * Samples from a Beta distribution using the ratio of Gamma variates.
 * Uses the Marsaglia-Tsang method for Gamma sampling.
 * Pure function with explicit RNG injection.
 *
 * Clamps alpha/beta to minimum 0.001 to avoid degenerate distributions.
 */
export const sampleBeta = (
  alpha: number,
  beta: number,
  rng: () => number
): number => {
  const a = Math.max(alpha, 0.001);
  const b = Math.max(beta, 0.001);

  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);

  // Avoid division by zero
  if (x + y === 0) return 0.5;
  return x / (x + y);
};

/**
 * Samples from a Gamma(shape, 1) distribution using the Marsaglia-Tsang method.
 * For shape < 1, uses the Ahrens-Dieter boost: Gamma(a) = Gamma(a+1) * U^(1/a).
 */
const sampleGamma = (shape: number, rng: () => number): number => {
  if (shape < 1) {
    // Boost for shape < 1
    const sample = sampleGamma(shape + 1, rng);
    const u = rng();
    return sample * Math.pow(u === 0 ? 1e-10 : u, 1 / shape);
  }

  // Marsaglia-Tsang method for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;

    // Generate a standard normal using Box-Muller
    do {
      const u1 = rng();
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1 === 0 ? 1e-10 : u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = rng();

    // Squeeze test
    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }

    if (Math.log(u === 0 ? 1e-10 : u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
};

/**
 * Thompson Sampling arm selection. Samples from each arm's Beta(alpha, beta)
 * distribution and returns arms sorted by sampled value (descending).
 *
 * Pure function — requires explicit RNG for testability.
 * Arms not present in state use the default prior Beta(1,1).
 */
export const selectArms = (
  state: BanditState,
  candidateArms: readonly Arm[],
  rng: () => number
): readonly Arm[] => {
  if (candidateArms.length === 0) return [];

  const sampled = candidateArms.map((arm) => {
    const stats = state.arms[arm.id] ?? defaultArmStats();
    const value = sampleBeta(stats.alpha, stats.beta, rng);
    return { arm, value };
  });

  // Sort descending by sampled value
  sampled.sort((a, b) => b.value - a.value);

  return sampled.map((s) => s.arm);
};

/**
 * Updates bandit state after observing a reward for a set of pulled arms.
 * For Thompson Sampling with graded rewards:
 *   alpha += reward
 *   beta  += (1 - reward)
 *   pulls += 1
 *   lastPulledAt = Date.now()
 *
 * Returns a new BanditState (no mutation).
 */
export const updateBanditState = (
  state: BanditState,
  pulledArms: readonly Arm[],
  reward: number
): BanditState => {
  if (pulledArms.length === 0) return state;

  const now = Date.now();
  const updatedArms = { ...state.arms };

  for (const arm of pulledArms) {
    const existing = updatedArms[arm.id] ?? defaultArmStats();
    updatedArms[arm.id] = {
      alpha: existing.alpha + reward,
      beta: existing.beta + (1 - reward),
      pulls: existing.pulls + 1,
      lastPulledAt: now,
    };
  }

  return {
    ...state,
    arms: updatedArms,
  };
};
