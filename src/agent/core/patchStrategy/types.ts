// src/agent/core/patchStrategy/types.ts

export type PatchStrategy = "direct-patch" | "multi-step-patch" | "propose-then-refine";

export const PATCH_STRATEGIES: readonly PatchStrategy[] = [
    "direct-patch",
    "multi-step-patch",
    "propose-then-refine",
] as const;

export const DEFAULT_STRATEGY: PatchStrategy = "direct-patch";

export type GoalLengthCategory = "short" | "medium" | "long";

export type GoalSignals = {
    readonly goalLengthCategory: GoalLengthCategory;
    readonly hasFilePaths: boolean;
    readonly keywords: {
        readonly refactor: boolean;
        readonly rename: boolean;
        readonly bug: boolean;
        readonly fix: boolean;
        readonly add: boolean;
        readonly create: boolean;
        readonly move: boolean;
        readonly delete: boolean;
    };
    readonly contextSignals: {
        readonly hasProjectProfile: boolean;
        readonly searchResultCount: number;
        readonly discoveredFileCount: number;
    };
};

export type ThompsonArmState = {
    readonly alpha: number; // >= 1
    readonly beta: number; // >= 1
};

export type EXP3ArmState = {
    readonly weight: number; // > 0
};

export type ThompsonState = {
    readonly algorithm: "thompson";
    readonly arms: Record<PatchStrategy, ThompsonArmState>;
};

export type EXP3State = {
    readonly algorithm: "exp3";
    readonly arms: Record<PatchStrategy, EXP3ArmState>;
    readonly gamma: number; // exploration parameter, (0, 1]
    readonly totalRounds: number;
};

export type StrategyState = ThompsonState | EXP3State;

export type BanditAlgorithm = "thompson" | "exp3";

export type PatchStrategyConfig = {
    readonly algorithm?: BanditAlgorithm;
    readonly gamma?: number; // EXP3 exploration parameter, default 0.3
    readonly enabled?: boolean; // default true
};

export type RewardEntry = {
    readonly arm: PatchStrategy;
    readonly reward: number; // [0, 1]
    readonly timestamp: number;
};

export type StoredRewardData = {
    readonly version: 1;
    readonly entries: readonly RewardEntry[];
};

export type ThompsonRng = {
    readonly sampleBeta: (alpha: number, beta: number) => number;
};

export type EXP3Rng = {
    readonly random: () => number;
};

export type StrategyRng = {
    readonly sampleBeta: (alpha: number, beta: number) => number;
    readonly random: () => number;
};
