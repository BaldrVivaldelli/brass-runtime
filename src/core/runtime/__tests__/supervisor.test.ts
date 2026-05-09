import { describe, expect, it, vi } from "vitest";

import { async, asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { fixed } from "../schedule";
import { EventBus } from "../eventBus";
import { makeMetrics } from "../metrics";
import { makeRuntimeMetricsSink } from "../../../observability/metrics";
import { Runtime } from "../runtime";
import { joinSupervised, makeSupervisor } from "../supervisor";

const run = <A>(effect: any) => new Runtime({ env: {} }).toPromise(effect) as Promise<A>;

describe("Supervisor", () => {
  it("restarts a failing child with one-for-one policy", async () => {
    const events: string[] = [];
    const runtime = new Runtime({ env: {} });
    const supervisor = makeSupervisor(runtime, {
      restart: { mode: "on-failure", maxRestarts: 3 },
      onEvent: (event) => events.push(event.type),
    });
    let attempts = 0;

    const child = supervisor.start({
      name: "worker",
      effect: () => {
        attempts++;
        return attempts < 2 ? asyncFail("boom") : asyncSucceed("ok");
      },
    });

    await expect(runtime.toPromise(joinSupervised(child))).resolves.toBe("ok");
    expect(attempts).toBe(2);
    expect(child.restartCount()).toBe(1);
    expect(events).toEqual([
      "child-start",
      "child-end",
      "child-restart",
      "child-start",
      "child-end",
    ]);
  });

  it("restarts siblings with all-for-one policy", async () => {
    const runtime = new Runtime({ env: {} });
    const supervisor = makeSupervisor(runtime, {
      strategy: "all-for-one",
      restart: { mode: "on-failure", maxRestarts: 2 },
    });
    let crashingAttempts = 0;
    let siblingStarts = 0;

    const sibling = supervisor.start({
      name: "sibling",
      effect: () => async((_env, _cb) => {
        siblingStarts++;
        return () => undefined;
      }),
    });
    const crashing = supervisor.start({
      name: "crashing",
      effect: () => {
        crashingAttempts++;
        return crashingAttempts < 2 ? asyncFail("boom") : asyncSucceed("recovered");
      },
    });

    await expect(runtime.toPromise(joinSupervised(crashing))).resolves.toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(siblingStarts).toBeGreaterThanOrEqual(2);
    expect(sibling.status()).toBe("running");
    await runtime.toPromise(supervisor.shutdown());
  });

  it("escalates when restart budget is exhausted", async () => {
    const runtime = new Runtime({ env: {} });
    const escalations: string[] = [];
    const supervisor = makeSupervisor(runtime, {
      restart: { mode: "on-failure", maxRestarts: 1, withinMs: 1_000 },
      escalation: "ignore",
      onEvent: (event) => {
        if (event.type === "child-escalate") escalations.push(event.reason ?? "");
      },
    });

    const child = supervisor.start({
      name: "bad",
      effect: () => asyncFail("still-bad"),
    });

    await expect(runtime.toPromise(joinSupervised(child))).rejects.toBe("still-bad");
    expect(child.restartCount()).toBe(1);
    expect(escalations).toEqual(["restart policy exhausted"]);
  });

  it("uses schedule delays for restarts", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new Runtime({ env: {} });
      const supervisor = makeSupervisor(runtime, {
        restart: { mode: "on-failure", maxRestarts: 2, schedule: fixed(50) as any },
      });
      let attempts = 0;
      const child = supervisor.start({
        effect: () => {
          attempts++;
          return attempts < 2 ? asyncFail("boom") : asyncSucceed("ok");
        },
      });

      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(runtime.toPromise(joinSupervised(child))).resolves.toBe("ok");
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits runtime events that feed existing metrics sinks", async () => {
    const bus = new EventBus();
    const metrics = makeMetrics();
    bus.subscribeHooks(makeRuntimeMetricsSink(metrics));
    const runtime = new Runtime({ env: {}, hooks: bus });
    const supervisor = makeSupervisor(runtime, {
      restart: "never",
    });

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

  it("shuts down running children", async () => {
    const runtime = new Runtime({ env: {} });
    const supervisor = makeSupervisor(runtime);
    const child = supervisor.start({
      effect: async((_env, _cb) => () => undefined),
    });

    await runtime.toPromise(supervisor.shutdown());

    await expect(run(joinSupervised(child))).rejects.toThrow(/Interrupted/);
    expect(child.status()).toBe("interrupted");
    expect(child.current()).toBeUndefined();
  });

  it("does not restart interrupted children", async () => {
    const runtime = new Runtime({ env: {} });
    const supervisor = makeSupervisor(runtime, { restart: "always" });
    const child = supervisor.start({
      effect: async((_env, _cb) => () => undefined),
    });

    child.interrupt();

    await expect(runtime.toPromise(joinSupervised(child))).rejects.toThrow(/Interrupted/);
    expect(child.restartCount()).toBe(0);
    expect(child.status()).toBe("interrupted");
  });

  it("interrupts pending restart timers and completes joiners", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new Runtime({ env: {} });
      const supervisor = makeSupervisor(runtime, {
        restart: { mode: "on-failure", maxRestarts: 2, schedule: fixed(1_000) as any },
      });
      let attempts = 0;
      const child = supervisor.start({
        effect: () => {
          attempts++;
          return asyncFail("boom");
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(child.status()).toBe("restarting");
      child.interrupt();

      await expect(runtime.toPromise(joinSupervised(child))).rejects.toThrow(/Interrupted/);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(1);
      expect(child.status()).toBe("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts explicit Exit values in joins", async () => {
    const runtime = new Runtime({ env: {} });
    const supervisor = makeSupervisor(runtime, { restart: "never" });
    const child = supervisor.start({
      effect: async((_env, cb) => cb(Exit.succeed(42))),
    });

    await expect(runtime.toPromise(joinSupervised(child))).resolves.toBe(42);
  });
});
