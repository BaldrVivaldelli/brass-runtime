import type { BenchmarkDef } from "./runner";
import { asyncFlatMap, asyncSucceed, asyncSync, type Async } from "../core/types/asyncEffect";
import { uninterruptibleMask } from "../core/types/effect";
import { makeFiberRef } from "../core/runtime/fiberRef";
import {
  Layer,
  compose as composeLayer,
  layer,
  layerEffect,
  makeServiceTag,
  mapLayer,
  merge as mergeLayer,
  provideLayer,
  provideLayerContext,
} from "../core/runtime/layer";
import { makeRuntimeRecorder } from "../core/runtime/recorder";
import { Runtime } from "../core/runtime/runtime";
import { Schedule } from "../core/runtime/schedule";
import type { RuntimeClock } from "../core/runtime/clock";

const runtime = Runtime.make({});

const FLATMAP_BATCH = Number(process.env.BRASS_RUNTIME_BENCH_FLATMAP_BATCH ?? "1000");
const FIBER_REF_BATCH = Number(process.env.BRASS_RUNTIME_BENCH_FIBER_REF_BATCH ?? "1000");
const INTERRUPTIBILITY_BATCH = Number(process.env.BRASS_RUNTIME_BENCH_INTERRUPTIBILITY_BATCH ?? "500");
const LAYER_BUILDS = Number(process.env.BRASS_RUNTIME_BENCH_LAYER_BUILDS ?? "100");
const SCHEDULE_STEPS = Number(process.env.BRASS_RUNTIME_BENCH_SCHEDULE_STEPS ?? "50000");
const OBSERVED_SCHEDULE_STEPS = Number(process.env.BRASS_RUNTIME_BENCH_OBSERVED_SCHEDULE_STEPS ?? "10000");

const ConfigTag = makeServiceTag<{ readonly url: string }>("BenchConfig");
const DbTag = makeServiceTag<{ readonly query: (sql: string) => number }>("BenchDb");
const RepoTag = makeServiceTag<{ readonly find: (id: number) => number }>("BenchRepo");

const ConfigLayer = Layer.value(ConfigTag, { url: "bench://local" });
const DbLayer = layerEffect(DbTag, (ctx) => {
  const config = ctx.unsafeGet(ConfigTag);
  return asyncSucceed({ query: (sql: string) => config.url.length + sql.length });
});
const RepoLayer = layerEffect(RepoTag, (ctx) => {
  const db = ctx.unsafeGet(DbTag);
  return asyncSucceed({ find: (id: number) => db.query(`select:${id}`) + id });
});
const AppLayer = composeLayer(composeLayer(ConfigLayer, DbLayer), RepoLayer);
const expectedLayerBuildSum = expectedLayerBatchSum(LAYER_BUILDS);

const sharedLayerEvents = { acquire: 0, release: 0 };
const sharedBaseLayer = layer(
  () => asyncSync(() => {
    sharedLayerEvents.acquire++;
    return { value: 41 };
  }) as Async<unknown, never, { readonly value: number }>,
  () => asyncSync(() => {
    sharedLayerEvents.release++;
  }) as Async<unknown, never, void>,
);
const DiamondLayer = mergeLayer(
  mapLayer(sharedBaseLayer, (svc) => ({ left: svc.value + 1 })),
  mapLayer(sharedBaseLayer, (svc) => ({ right: svc.value + 2 })),
);

const benchClockState = { now: 0 };
const benchClock: RuntimeClock = {
  now: () => benchClockState.now,
  setTimeout: (task) => {
    task();
    return 0;
  },
  clearTimeout: () => undefined,
};

function flatMapBatch(length: number): Async<unknown, never, number> {
  let effect: Async<unknown, never, number> = asyncSucceed(0);
  for (let i = 0; i < length; i++) {
    effect = asyncFlatMap(effect, (value) => asyncSucceed(value + 1));
  }
  return effect;
}

function fiberRefBatch(length: number): Async<unknown, never, number> {
  const ref = makeFiberRef(0);
  let effect: Async<unknown, never, unknown> = ref.set(0);
  for (let i = 0; i < length; i++) {
    effect = asyncFlatMap(effect, () => ref.update((value) => value + 1));
  }
  return asyncFlatMap(effect, () => ref.get());
}

function interruptibilityBatch(length: number): Async<unknown, never, number> {
  let effect: Async<unknown, never, number> = asyncSucceed(0);
  for (let i = 0; i < length; i++) {
    const current = effect;
    effect = uninterruptibleMask((restore) =>
      restore(asyncFlatMap(current, (value) => asyncSucceed(value + 1)))
    );
  }
  return effect;
}

function layerBuildBatch(count: number): Async<unknown, never, number> {
  let effect: Async<unknown, never, number> = asyncSucceed(0);
  for (let i = 0; i < count; i++) {
    effect = asyncFlatMap(effect, (sum) =>
      asyncFlatMap(
        provideLayerContext(AppLayer, (ctx) => asyncSucceed(ctx.unsafeGet(RepoTag).find(i))),
        (value) => asyncSucceed(sum + value)
      )
    );
  }
  return effect;
}

function expectedLayerBatchSum(count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += "bench://local".length + `select:${i}`.length + i;
  }
  return sum;
}

function runRuntimeEffect<A>(effect: Async<unknown, unknown, A>, expected: A): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    runtime.unsafeRunAsync(effect, (exit) => {
      if (exit._tag === "Success" && Object.is(exit.value, expected)) {
        resolve();
        return;
      }
      reject(new Error(`Unexpected runtime benchmark exit: ${JSON.stringify(exit)}`));
    });
  });
}

function runScheduleDriver(steps: number): Record<string, unknown> {
  benchClockState.now = 0;
  const driver = Schedule.driver(
    Schedule.named("bench.schedule", Schedule.maxElapsed(Schedule.linear(1, 100), 1_000_000)),
    { clock: benchClock },
  );
  let continued = 0;
  let delayTotal = 0;
  for (let i = 0; i < steps; i++) {
    benchClockState.now++;
    const decision = driver.next({ attempt: i });
    if (decision.continue) continued++;
    delayTotal += decision.delayMs;
  }
  return {
    units: steps,
    unit: "decision",
    continued,
    delayTotal,
  };
}

function runObservedScheduleDriver(steps: number): Record<string, unknown> {
  benchClockState.now = 0;
  const recorder = makeRuntimeRecorder({ maxEvents: 1024 });
  let observed = 0;
  const driver = Schedule.driver(
    Schedule.named("bench.schedule.observed", Schedule.fixed(1)),
    {
      clock: benchClock,
      hooks: recorder.hooks,
      onDecision: () => {
        observed++;
      },
    },
  );
  for (let i = 0; i < steps; i++) {
    benchClockState.now++;
    driver.next(i);
  }
  const stats = recorder.stats();
  recorder.clear();
  return {
    units: steps,
    unit: "decision",
    observed,
    recorderSize: stats.size,
    recorderDropped: stats.dropped,
  };
}

export const benchmarks: BenchmarkDef[] = [
  {
    name: `RuntimeTrack flatMap chain (${FLATMAP_BATCH} effects)`,
    iterations: 500,
    warmup: 50,
    unitsPerRun: FLATMAP_BATCH,
    unit: "effect",
    fn: () => runRuntimeEffect(flatMapBatch(FLATMAP_BATCH), FLATMAP_BATCH),
  },
  {
    name: `RuntimeTrack FiberRef update/get (${FIBER_REF_BATCH} ops)`,
    iterations: 500,
    warmup: 50,
    unitsPerRun: FIBER_REF_BATCH,
    unit: "fiberRefOp",
    fn: () => runRuntimeEffect(fiberRefBatch(FIBER_REF_BATCH), FIBER_REF_BATCH),
  },
  {
    name: `RuntimeTrack interruptibility mask/restore (${INTERRUPTIBILITY_BATCH} regions)`,
    iterations: 500,
    warmup: 50,
    unitsPerRun: INTERRUPTIBILITY_BATCH,
    unit: "region",
    fn: () => runRuntimeEffect(interruptibilityBatch(INTERRUPTIBILITY_BATCH), INTERRUPTIBILITY_BATCH),
  },
  {
    name: `RuntimeTrack Layer 2 typed provideContext (${LAYER_BUILDS} builds)`,
    iterations: 300,
    warmup: 30,
    unitsPerRun: LAYER_BUILDS,
    unit: "layerBuild",
    fn: () => runRuntimeEffect(layerBuildBatch(LAYER_BUILDS), expectedLayerBuildSum),
  },
  {
    name: "RuntimeTrack LayerScope memoized diamond graph",
    iterations: 500,
    warmup: 50,
    unitsPerRun: 2,
    unit: "sharedEdge",
    fn: async () => {
      const beforeAcquire = sharedLayerEvents.acquire;
      const beforeRelease = sharedLayerEvents.release;
      await runtime.toPromise(provideLayer(DiamondLayer, (svc) => asyncSucceed(svc.left + svc.right)));
      return {
        units: 2,
        unit: "sharedEdge",
        acquiredOnce: sharedLayerEvents.acquire - beforeAcquire === 1,
        releasedOnce: sharedLayerEvents.release - beforeRelease === 1,
      };
    },
  },
  {
    name: `RuntimeTrack ScheduleDriver pure (${SCHEDULE_STEPS} decisions)`,
    iterations: 200,
    warmup: 20,
    unitsPerRun: SCHEDULE_STEPS,
    unit: "decision",
    fn: () => runScheduleDriver(SCHEDULE_STEPS),
  },
  {
    name: `RuntimeTrack ScheduleDriver observed (${OBSERVED_SCHEDULE_STEPS} decisions)`,
    iterations: 200,
    warmup: 20,
    unitsPerRun: OBSERVED_SCHEDULE_STEPS,
    unit: "decision",
    fn: () => runObservedScheduleDriver(OBSERVED_SCHEDULE_STEPS),
  },
];

export default benchmarks;
