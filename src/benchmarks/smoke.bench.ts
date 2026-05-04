/**
 * Smoke-test benchmark — validates the runner infrastructure works end-to-end.
 *
 * This file exercises the runner with a trivial workload.  It will be
 * superseded by the real benchmarks (flatmap-chain, scheduler-throughput,
 * queue-throughput, stream-pipeline) in tasks 7.2–7.5.
 */

import type { BenchmarkDef } from "./runner";
import { asyncSucceed, asyncFlatMap } from "../core/types/asyncEffect";
import { Runtime } from "../core/runtime/runtime";

export const benchmarks: BenchmarkDef[] = [
  {
    name: "smoke: 100 flatMap chain",
    iterations: 200,
    warmup: 20,
    fn: () => {
      let eff = asyncSucceed(0);
      for (let i = 0; i < 100; i++) {
        eff = asyncFlatMap(eff, (n) => asyncSucceed(n + 1));
      }

      return new Promise<void>((resolve) => {
        const rt = Runtime.make({});
        rt.unsafeRunAsync(eff, () => resolve());
      });
    },
  },
];
