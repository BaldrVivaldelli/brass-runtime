import type { BenchmarkDef } from "./runner";
import { asyncInterruptible, asyncSucceed, type Async } from "../core/types/asyncEffect";
import { Exit } from "../core/types/effect";
import { Runtime } from "../core/runtime/runtime";
import { Scheduler, type SchedulerEngine } from "../core/runtime/scheduler";

const BATCH = Number(process.env.BRASS_RUNTIME_PRIMITIVE_BATCH ?? "500");
const FAIRNESS_TASKS_PER_LANE = Number(process.env.BRASS_RUNTIME_FAIRNESS_TASKS ?? "500");

function runtimeFor(engine: SchedulerEngine): Runtime<unknown> {
  return new Runtime({ env: {}, engine });
}

function join<A>(fiber: ReturnType<Runtime<unknown>["fork"]>): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    fiber.join((exit) => {
      if (exit._tag === "Success") resolve(exit.value as A);
      else reject(exit.cause);
    });
  });
}

async function forkBatch(engine: SchedulerEngine): Promise<Record<string, unknown>> {
  const runtime = runtimeFor(engine);
  try {
    const fibers = Array.from({ length: BATCH }, (_, value) => runtime.fork(asyncSucceed(value)));
    const values = await Promise.all(fibers.map((fiber) => join<number>(fiber)));
    return {
      engine,
      units: BATCH,
      unit: "fiber",
      completed: values.length,
      liveFibers: runtime.diagnostics().fibers.live,
    };
  } finally {
    await runtime.shutdown();
  }
}

function oneAsyncResume(): Async<unknown, never, number> {
  return asyncInterruptible((_env, callback) => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      active = false;
      callback(Exit.succeed(1));
    });
    return () => { active = false; };
  });
}

async function suspendResumeBatch(engine: SchedulerEngine): Promise<Record<string, unknown>> {
  const runtime = runtimeFor(engine);
  try {
    const fibers = Array.from({ length: BATCH }, () => runtime.fork(oneAsyncResume()));
    const values = await Promise.all(fibers.map((fiber) => join<number>(fiber)));
    const diagnostics = runtime.diagnostics();
    return {
      engine,
      units: BATCH,
      unit: "suspendResume",
      resumed: values.reduce((sum, value) => sum + value, 0),
      liveFibers: diagnostics.fibers.live,
      suspendedFibers: diagnostics.fibers.suspended,
    };
  } finally {
    await runtime.shutdown();
  }
}

function fairnessBatch(engine: SchedulerEngine): Promise<Record<string, unknown>> {
  const total = FAIRNESS_TASKS_PER_LANE * 2;
  const scheduler = new Scheduler({
    engine,
    laneCapacity: FAIRNESS_TASKS_PER_LANE + 8,
    laneBudget: 2,
    flushBudget: total + 8,
    microThreshold: total + 8,
  });
  return new Promise((resolve, reject) => {
    const order: string[] = [];
    let dropped = 0;
    const task = (lane: string) => () => {
      order.push(lane);
      if (order.length !== total) return;
      let maximumConsecutive = 0;
      let currentRun = 0;
      let previous = "";
      for (const item of order) {
        currentRun = item === previous ? currentRun + 1 : 1;
        previous = item;
        maximumConsecutive = Math.max(maximumConsecutive, currentRun);
      }
      resolve({
        engine,
        units: total,
        unit: "scheduledTask",
        maximumConsecutive,
        laneBudget: 2,
        dropped,
      });
    };
    for (let index = 0; index < FAIRNESS_TASKS_PER_LANE; index += 1) {
      if (scheduler.schedule(task("a"), `lane:a|${index}`) === "dropped") dropped += 1;
      if (scheduler.schedule(task("b"), `lane:b|${index}`) === "dropped") dropped += 1;
    }
    if (dropped > 0) reject(new Error(`fairness workload dropped ${dropped} tasks`));
  });
}

const definitions = (engine: SchedulerEngine): BenchmarkDef[] => [
  {
    name: `RuntimePrimitive v1 fork/complete ${engine} (${BATCH} fibers)`,
    iterations: 40,
    warmup: 5,
    unitsPerRun: BATCH,
    unit: "fiber",
    fn: () => forkBatch(engine),
  },
  {
    name: `RuntimePrimitive v1 suspend/resume ${engine} (${BATCH} fibers)`,
    iterations: 40,
    warmup: 5,
    unitsPerRun: BATCH,
    unit: "suspendResume",
    fn: () => suspendResumeBatch(engine),
  },
  {
    name: `RuntimePrimitive v1 lane fairness ${engine} (${FAIRNESS_TASKS_PER_LANE} per lane)`,
    iterations: 40,
    warmup: 5,
    unitsPerRun: FAIRNESS_TASKS_PER_LANE * 2,
    unit: "scheduledTask",
    fn: () => fairnessBatch(engine),
  },
];

export const benchmarks: BenchmarkDef[] = [...definitions("ts"), ...definitions("wasm")];

export default benchmarks;
