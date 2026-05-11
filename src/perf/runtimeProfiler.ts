import { asyncFlatMap, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import type { Exit } from "../core/types/effect";
import { EventBus } from "../core/runtime/eventBus";
import { makeFiberRef } from "../core/runtime/fiberRef";
import { makeRuntimeRecorder, type RuntimeRecorder } from "../core/runtime/recorder";
import { Runtime } from "../core/runtime/runtime";
import { Scheduler } from "../core/runtime/scheduler";
import type { PerfRecorder } from "./recorder";

export type RuntimeProfileVariant =
  | "default"
  | "fiber-only"
  | "active-hooks"
  | "recorder"
  | "wide-scheduler";

export type RuntimePrimitiveProfile = {
  readonly name: string;
  readonly units: number;
  readonly unit: "effect" | "operation";
  readonly durationMs: number;
  readonly nsPerOperation: number;
  readonly operationsPerSecond: number;
  readonly fibersStarted: number;
  readonly fibersPerThousandOps: number;
};

export type RuntimePrimitiveProfileReport = {
  readonly variant: RuntimeProfileVariant;
  readonly label: string;
  readonly iterations: number;
  readonly chainDepth: number;
  readonly hooksActive: boolean;
  readonly recorderEvents?: number;
  readonly scheduler: {
    readonly laneMode: "single" | "fair";
    readonly initialCapacity: number;
    readonly maxCapacity: number;
    readonly flushBudget: number;
  };
  readonly results: readonly RuntimePrimitiveProfile[];
};

export type RuntimePrimitiveProfileOptions = {
  readonly iterations?: number;
  readonly chainDepth?: number;
  readonly variant?: RuntimeProfileVariant;
  readonly recorder?: PerfRecorder;
};

export async function profileRuntimePrimitives(
  options: RuntimePrimitiveProfileOptions = {},
): Promise<RuntimePrimitiveProfileReport> {
  const iterations = positiveInt(options.iterations, 5_000);
  const chainDepth = positiveInt(options.chainDepth, 1_000);
  const variant = options.variant ?? "default";
  const runtimeCase = makeRuntimeCase(variant, chainDepth);
  const runtime = runtimeCase.runtime;
  const runMode = variant === "fiber-only" ? "fiber" : "auto";

  const results: RuntimePrimitiveProfile[] = [];
  results.push(await measureEffect("async-succeed/top-level", iterations, "effect", runtime, runMode, "success", () => asyncSucceed(1)));
  results.push(await measureEffect("async-fail/top-level", iterations, "effect", runtime, runMode, "failure", () => asyncFailProgram()));
  results.push(await measureEffect("async-sync/top-level", iterations, "effect", runtime, runMode, "success", () => asyncSync(() => 1)));

  const flatMapRounds = Math.max(1, Math.floor(iterations / Math.max(1, chainDepth)));
  results.push(await measureEffect(
    "flatMap-chain",
    flatMapRounds * chainDepth,
    "operation",
    runtime,
    runMode,
    "success",
    () => makeFlatMapChain(chainDepth),
  ));

  const fiberRefRounds = Math.max(1, Math.floor(iterations / Math.max(1, chainDepth)));
  results.push(await measureEffect(
    "fiberRef-update-get",
    fiberRefRounds * chainDepth,
    "operation",
    runtime,
    runMode,
    "success",
    () => makeFiberRefProgram(chainDepth),
  ));

  for (const result of results) {
    options.recorder?.gauge("runtime.ops-per-sec", result.operationsPerSecond, "ops/s", { primitive: result.name });
  }

  await runtime.shutdown();

  return Object.freeze({
    variant,
    label: runtimeCase.label,
    iterations,
    chainDepth,
    hooksActive: runtime.hasActiveHooks(),
    recorderEvents: runtimeCase.recorder?.stats().size,
    scheduler: runtimeCase.scheduler,
    results: Object.freeze(results),
  });
}

type RuntimeCase = {
  readonly runtime: Runtime<any>;
  readonly label: string;
  readonly scheduler: RuntimePrimitiveProfileReport["scheduler"];
  readonly recorder?: RuntimeRecorder;
};

type RunMode = "auto" | "fiber";

async function measureEffect<A>(
  name: string,
  units: number,
  unit: RuntimePrimitiveProfile["unit"],
  runtime: Runtime<any>,
  runMode: RunMode,
  expected: "success" | "failure",
  makeEffect: () => Async<any, unknown, A>,
): Promise<RuntimePrimitiveProfile> {
  const fibersBefore = startedFibers(runtime);
  const startedAt = performance.now();
  if (unit === "effect") {
    for (let i = 0; i < units; i++) {
      await runExpectedEffect(runtime, makeEffect(), runMode, expected);
    }
  } else {
    await runExpectedEffect(runtime, makeEffect(), runMode, expected);
  }
  const durationMs = round(performance.now() - startedAt);
  const fibersStarted = Math.max(0, startedFibers(runtime) - fibersBefore);
  return Object.freeze({
    name,
    units,
    unit,
    durationMs,
    nsPerOperation: round((durationMs * 1_000_000) / Math.max(units, 1)),
    operationsPerSecond: round(units / Math.max(durationMs / 1000, 0.001)),
    fibersStarted,
    fibersPerThousandOps: round((fibersStarted / Math.max(units, 1)) * 1_000),
  });
}

async function runExpectedEffect<A>(
  runtime: Runtime<any>,
  effect: Async<any, unknown, A>,
  runMode: RunMode,
  expected: "success" | "failure",
): Promise<void> {
  try {
    await runMeasuredEffect(runtime, effect, runMode);
    if (expected === "failure") throw new Error("Expected measured effect to fail");
  } catch (error) {
    if (expected === "success") throw error;
  }
}

function makeRuntimeCase(variant: RuntimeProfileVariant, chainDepth: number): RuntimeCase {
  const schedulerConfig = variant === "wide-scheduler"
    ? {
        laneMode: "single" as const,
        initialCapacity: Math.max(65_536, chainDepth * 8),
        maxCapacity: Math.max(65_536, chainDepth * 8),
        flushBudget: 16_384,
      }
    : {
        laneMode: "fair" as const,
        initialCapacity: 8_192,
        maxCapacity: 8_192,
        flushBudget: 2_048,
      };
  const scheduler = variant === "wide-scheduler" ? new Scheduler(schedulerConfig) : undefined;
  const recorder = variant === "recorder" ? makeRuntimeRecorder({ maxEvents: 10_000 }) : undefined;
  const hooks = recorder?.hooks ?? (variant === "active-hooks" ? new EventBus() : undefined);
  const runtime = Runtime.makeWithEngine(hooks ? {} : {}, "ts", {
    hooks,
    ...(scheduler ? { scheduler } : {}),
    inferLane: false,
  });

  return {
    runtime,
    label: labelForVariant(variant),
    scheduler: schedulerConfig,
    recorder,
  };
}

function labelForVariant(variant: RuntimeProfileVariant): string {
  switch (variant) {
    case "default":
      return "default runtime with native top-level fast path";
    case "fiber-only":
      return "forced fiber execution for every measured effect";
    case "active-hooks":
      return "runtime with active EventBus hooks";
    case "recorder":
      return "runtime with bounded flight recorder hooks";
    case "wide-scheduler":
      return "runtime with larger single-lane scheduler queues";
  }
}

async function runMeasuredEffect<A>(
  runtime: Runtime<any>,
  effect: Async<any, unknown, A>,
  runMode: RunMode,
): Promise<A> {
  if (runMode === "auto") return runtime.toPromise(effect);
  return new Promise<A>((resolve, reject) => {
    const fiber = runtime.fork(effect);
    fiber.join((exit: Exit<unknown, A>) => {
      if (exit._tag === "Success") resolve(exit.value);
      else reject(exit.cause);
    });
  });
}

function asyncFailProgram(): Async<unknown, string, never> {
  return { _tag: "Fail", error: "expected-profile-failure" };
}

function makeFlatMapChain(depth: number): Async<unknown, never, number> {
  let effect: Async<unknown, never, number> = asyncSucceed(0);
  for (let i = 0; i < depth; i++) {
    effect = asyncFlatMap(effect, (n) => asyncSucceed(n + 1));
  }
  return effect;
}

function makeFiberRefProgram(depth: number): Async<unknown, unknown, number> {
  const ref = makeFiberRef(0);
  let effect: Async<unknown, unknown, unknown> = ref.set(0);
  for (let i = 0; i < depth; i++) {
    effect = asyncFlatMap(effect, () => ref.update((n) => n + 1));
  }
  return asyncFlatMap(effect, () => ref.get());
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function startedFibers(runtime: Runtime<any>): number {
  return runtime.stats().data.startedFibers ?? 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
