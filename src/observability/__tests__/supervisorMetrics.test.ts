import { describe, expect, it } from "vitest";

import { asyncSucceed } from "../../core/types/asyncEffect";
import { EventBus } from "../../core/runtime/eventBus";
import { makeMetrics } from "../../core/runtime/metrics";
import { Runtime } from "../../core/runtime/runtime";
import { joinSupervised, makeSupervisor } from "../../core/runtime/supervisor";
import { makeRuntimeMetricsSink } from "../metrics";

describe("supervisor metrics integration", () => {
  it("feeds supervisor runtime events into the observability metrics sink", async () => {
    const bus = new EventBus();
    const metrics = makeMetrics();
    bus.subscribeHooks(makeRuntimeMetricsSink(metrics));
    const runtime = new Runtime({ env: {}, hooks: bus });
    const supervisor = makeSupervisor(runtime, { restart: "never" });

    const child = supervisor.start({ effect: asyncSucceed("done") });
    await expect(runtime.toPromise(joinSupervised(child))).resolves.toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(metrics.snapshot().counters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "brass_runtime_events_total",
          labels: { type: "supervisor.child.start" },
          value: 1,
        }),
        expect.objectContaining({
          name: "brass_runtime_events_total",
          labels: { type: "supervisor.child.end" },
          value: 1,
        }),
      ]),
    );
  });
});
