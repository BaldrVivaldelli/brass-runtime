export type RuntimeTimerId = unknown;

export type RuntimeClock = {
  readonly now: () => number;
  readonly setTimeout: (task: () => void, ms: number) => RuntimeTimerId;
  readonly clearTimeout: (timer: RuntimeTimerId) => void;
};

export type RuntimeClockEnv = {
  readonly brass?: {
    readonly clock?: RuntimeClock;
  };
};

export const liveClock: RuntimeClock = {
  now: () => {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  },
  setTimeout: (task, ms) => setTimeout(task, Math.max(0, Math.floor(ms))),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function runtimeClockFromEnv(env: unknown): RuntimeClock {
  return (env as RuntimeClockEnv | undefined)?.brass?.clock ?? liveClock;
}
