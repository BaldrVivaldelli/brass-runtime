import { describe, expect, it } from "vitest";
import { async, asyncSucceed } from "../../types/asyncEffect";
import { Runtime } from "../runtime";
import { Scheduler, type SchedulerEngine } from "../scheduler";

function wait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function availableEngines(): SchedulerEngine[] {
  const engines: SchedulerEngine[] = ["ts"];
  try {
    const scheduler = new Scheduler({ engine: "wasm", laneCapacity: 2, laneBudget: 1, flushBudget: 4 });
    void scheduler.stats();
    engines.push("wasm");
  } catch {
    // WASM package is optional in source checkouts. The Rust source still
    // exercises this path once npm run build:wasm has generated wasm/pkg.
  }
  return engines;
}

describe("Scheduler lanes, bounded queues and budgets", () => {
  it("runtime lane labels TS fiber schedules", async () => {
    const scheduler = new Scheduler({ engine: "ts", laneCapacity: 8 });
    const runtime = Runtime.makeWithEngine({}, "ts", { scheduler }).withLane("bff-security/generate");

    await expect(runtime.toPromise(asyncSucceed("ok"))).resolves.toBe("ok");

    const lane = scheduler.stats().data.lanes?.find((entry) => entry.key === "bff-security/generate");
    expect(lane?.executedTasks).toBeGreaterThan(0);
  });

  it("runtime lane labels TS async resumes", async () => {
    const scheduler = new Scheduler({ engine: "ts", laneCapacity: 8 });
    const runtime = Runtime.makeWithEngine({}, "ts", { scheduler }).withLane("bff-security/async");

    await expect(runtime.toPromise(async((_env, cb) => {
      setTimeout(() => cb({ _tag: "Success", value: "later" }), 0);
    }))).resolves.toBe("later");

    const lane = scheduler.stats().data.lanes?.find((entry) => entry.key === "bff-security/async");
    expect(lane?.executedTasks).toBeGreaterThanOrEqual(2);
  });

  it("infers a caller lane from the first top-level runtime task", async () => {
    const scheduler = new Scheduler({ engine: "ts", laneCapacity: 8 });
    const runtime = Runtime.make({}, scheduler);

    await expect(runtime.toPromise(asyncSucceed("ok"))).resolves.toBe("ok");

    const lanes = scheduler.stats().data.lanes ?? [];
    expect(lanes.some((entry) => entry.key.includes("scheduler-lanes.test"))).toBe(true);
    expect(lanes.every((entry) => entry.key !== "fiber")).toBe(true);
  });

  it("rejects the dropped fiber instead of leaving its promise hanging", async () => {
    const scheduler = new Scheduler({ engine: "ts", laneCapacity: 2, laneBudget: 8, flushBudget: 8 });
    const runtime = Runtime.make({}, scheduler).withLane("bounded-runtime");

    const p1 = runtime.toPromise(asyncSucceed(1));
    const p2 = runtime.toPromise(asyncSucceed(2));
    const p3 = runtime.toPromise(asyncSucceed(3));

    await expect(p3).rejects.toThrow(/scheduler dropped/i);
    await expect(Promise.all([p1, p2])).resolves.toEqual([1, 2]);

    const lane = scheduler.stats().data.lanes?.find((entry) => entry.key === "bounded-runtime");
    expect(lane?.droppedTasks).toBe(1);
  });

  it("single-lane mode runs accepted tasks without creating caller lanes", async () => {
    const scheduler = new Scheduler({ engine: "ts", laneMode: "single", initialCapacity: 4, maxCapacity: 4, flushBudget: 8 });
    const ran: number[] = [];

    expect(scheduler.schedule(() => ran.push(1), "lane:A|1")).toBe("accepted");
    expect(scheduler.schedule(() => ran.push(2), "lane:B|2")).toBe("accepted");

    await wait();

    expect(ran).toEqual([1, 2]);
    expect(scheduler.stats().data.lanes).toEqual([
      expect.objectContaining({
        key: "single",
        enqueuedTasks: 2,
        executedTasks: 2,
        droppedTasks: 0,
      }),
    ]);
  });

  it("single-lane mode drops tasks when its direct queue is full", async () => {
    const scheduler = new Scheduler({ engine: "ts", laneMode: "single", initialCapacity: 2, maxCapacity: 2, flushBudget: 8 });
    const ran: number[] = [];

    const r1 = scheduler.schedule(() => ran.push(1), "lane:A|1");
    const r2 = scheduler.schedule(() => ran.push(2), "lane:B|2");
    const r3 = scheduler.schedule(() => ran.push(3), "lane:C|3");

    expect([r1, r2, r3]).toEqual(["accepted", "accepted", "dropped"]);

    await wait();

    expect(ran).toEqual([1, 2]);
    expect(scheduler.stats().data.droppedTasks).toBe(1);
    expect(scheduler.stats().data.lanes?.[0]).toMatchObject({
      key: "single",
      enqueuedTasks: 3,
      executedTasks: 2,
      droppedTasks: 1,
    });
  });

  for (const engine of availableEngines()) {
    it(`${engine}: rotates lanes after the per-lane budget`, async () => {
      const scheduler = new Scheduler({ engine, laneBudget: 2, laneCapacity: 8, flushBudget: 8 });
      const order: string[] = [];

      scheduler.schedule(() => order.push("a1"), "lane:A|a1");
      scheduler.schedule(() => order.push("a2"), "lane:A|a2");
      scheduler.schedule(() => order.push("a3"), "lane:A|a3");
      scheduler.schedule(() => order.push("a4"), "lane:A|a4");
      scheduler.schedule(() => order.push("b1"), "lane:B|b1");

      await wait();

      expect(order).toEqual(["a1", "a2", "b1", "a3", "a4"]);
      const lanes = scheduler.stats().data.lanes ?? [];
      expect(lanes.find((lane) => lane.key === "A")?.executedTasks).toBe(4);
      expect(lanes.find((lane) => lane.key === "B")?.executedTasks).toBe(1);
    });

    it(`${engine}: drops new tasks when a lane is full`, async () => {
      const scheduler = new Scheduler({ engine, laneCapacity: 2, laneBudget: 8, flushBudget: 8 });
      const ran: number[] = [];

      const r1 = scheduler.schedule(() => ran.push(1), "lane:bounded|1");
      const r2 = scheduler.schedule(() => ran.push(2), "lane:bounded|2");
      const r3 = scheduler.schedule(() => ran.push(3), "lane:bounded|3");

      expect([r1, r2, r3]).toEqual(["accepted", "accepted", "dropped"]);

      await wait();

      expect(ran).toEqual([1, 2]);
      const boundedLane = scheduler.stats().data.lanes?.find((lane) => lane.key === "bounded");
      expect(boundedLane?.enqueuedTasks).toBe(3);
      expect(boundedLane?.executedTasks).toBe(2);
      expect(boundedLane?.droppedTasks).toBe(1);
      expect(scheduler.stats().data.droppedTasks).toBe(1);
    });
  }
});
