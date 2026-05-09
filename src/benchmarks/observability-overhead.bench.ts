import { Runtime } from "../core/runtime/runtime";
import { asyncFlatMap, asyncSucceed } from "../core/types/asyncEffect";
import {
  logEffect,
  makeObservability,
  spanEvent,
  withSpan,
  type StructuredLogRecord,
} from "../observability";
import type { BenchmarkDef } from "./runner";

const baselineRuntime = new Runtime({ env: {} });

const spanObs = makeObservability({
  logs: false,
  metrics: false,
  sampling: 1,
});
const spanRuntime = new Runtime({ env: spanObs.env, hooks: spanObs.hooks });
let spanRuns = 0;

const logs: StructuredLogRecord[] = [];
const logObs = makeObservability({
  metrics: false,
  traces: false,
  logs: { write: (record) => logs.push(record) },
});
const logRuntime = new Runtime({ env: logObs.env, hooks: logObs.hooks });
let logRuns = 0;

export const benchmarks: BenchmarkDef[] = [
  {
    name: "Observability baseline asyncSucceed",
    iterations: 1_000,
    warmup: 100,
    fn: () => baselineRuntime.toPromise(asyncSucceed("ok")),
  },
  {
    name: "Observability withSpan start/end",
    iterations: 1_000,
    warmup: 100,
    fn: async () => {
      await spanRuntime.toPromise(withSpan("bench.span", asyncSucceed("ok"), { component: "benchmark" }));
      spanObs.eventBus.flush();
      if (++spanRuns % 100 === 0) spanObs.tracer.spans.clear();
    },
  },
  {
    name: "Observability logEffect structured sink",
    iterations: 1_000,
    warmup: 100,
    fn: async () => {
      await logRuntime.toPromise(logEffect("info", "bench.log", {
        route: "/bench/:id",
        requestId: `req-${logRuns}`,
        token: "redacted",
      }));
      logObs.eventBus.flush();
      if (++logRuns % 100 === 0) logs.length = 0;
    },
  },
  {
    name: "Observability span+event+log composition",
    iterations: 500,
    warmup: 50,
    fn: async () => {
      await spanRuntime.toPromise(
        withSpan(
          "bench.composed",
          asyncFlatMap(spanEvent("checkpoint", { ok: true }), () =>
            logEffect("info", "bench.composed.log", { route: "/bench/:id" })
          ),
          { component: "benchmark" }
        )
      );
      spanObs.eventBus.flush();
      if (++spanRuns % 100 === 0) spanObs.tracer.spans.clear();
    },
  },
  {
    name: "Observability OTLP trace flush 25 spans",
    iterations: 50,
    warmup: 5,
    fn: async () => {
      const obs = makeObservability({
        logs: false,
        metrics: false,
        sampling: 1,
        otlp: {
          tracesUrl: "http://collector.local/v1/traces",
          fetch: async () => ({ ok: true, status: 202 }),
          retry: { attempts: 1 },
          pipeline: { batchSize: 64, maxQueueSize: 256 },
        },
      });
      const runtime = new Runtime({ env: obs.env, hooks: obs.hooks });

      for (let i = 0; i < 25; i++) {
        await runtime.toPromise(withSpan("bench.export", asyncSucceed(i), { index: i }));
      }

      obs.eventBus.flush();
      await obs.flush();
      await obs.shutdown();
    },
  },
];

export default benchmarks;
