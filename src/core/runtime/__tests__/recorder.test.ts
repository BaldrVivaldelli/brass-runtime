import { describe, expect, it } from "vitest";

import { Runtime } from "../runtime";
import { makeRuntimeRecorder } from "../recorder";
import { async } from "../../types/asyncEffect";
import { Cause } from "../../types/effect";

describe("Runtime flight recorder", () => {
  it("records runtime events in order and explains fiber suspension", async () => {
    const recorder = makeRuntimeRecorder({ maxEvents: 16 });
    const runtime = new Runtime({ env: {}, hooks: recorder.hooks });

    await runtime.toPromise(async((_env, cb) => {
      setTimeout(() => cb({ _tag: "Success", value: "ok" }), 0);
    }));

    const events = recorder.snapshot();
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "fiber.start",
      "fiber.suspend",
      "fiber.resume",
      "fiber.end",
    ]));
    expect(recorder.stats()).toMatchObject({
      size: events.length,
      capacity: 16,
      dropped: 0,
      firstSeq: 1,
      lastSeq: events.length,
    });
    expect(recorder.explain()).toContain("fiber#");
    expect(recorder.explain()).toContain("suspended awaiting");
    expect(recorder.explain()).toContain("ended success");
  });

  it("keeps a bounded ring buffer and reports dropped events", () => {
    const recorder = makeRuntimeRecorder({ maxEvents: 2 });

    recorder.emit({ type: "log", level: "info", message: "one" }, {});
    recorder.emit({ type: "log", level: "warn", message: "two" }, {});
    recorder.emit({ type: "log", level: "error", message: "three" }, {});

    expect(recorder.snapshot().map((event) => event.message)).toEqual(["two", "three"]);
    expect(recorder.stats()).toMatchObject({
      size: 2,
      capacity: 2,
      dropped: 1,
      firstSeq: 2,
      lastSeq: 3,
    });
    expect(recorder.explain()).toContain("1 dropped");

    recorder.clear();
    expect(recorder.snapshot()).toEqual([]);
    expect(recorder.stats()).toMatchObject({ size: 0, dropped: 0 });
  });

  it("explains scopes, supervisors, logs, spans, and unusual errors", () => {
    const recorder = makeRuntimeRecorder({ maxEvents: 32 });
    const circular: any = { label: "circular" };
    circular.self = circular;

    recorder.emit({ type: "fiber.start", fiberId: 1, name: "root", parentFiberId: 0 }, {});
    recorder.emit({ type: "fiber.resume", fiberId: 99 }, {});
    recorder.emit({ type: "fiber.suspend", fiberId: 2 }, {});
    recorder.emit({ type: "fiber.end", fiberId: 2, status: "failure", error: circular }, {});
    recorder.emit({
      type: "fiber.end",
      fiberId: 3,
      status: "failure",
      error: Cause.both(Cause.fail("domain"), Cause.die(new Error("defect"))),
    }, {});
    recorder.emit({ type: "scope.open", scopeId: 10, parentScopeId: 9 }, {});
    recorder.emit({ type: "scope.close", scopeId: 10, status: "failure", error: new Error("scope failed") }, {});
    recorder.emit({
      type: "supervisor.child.restart",
      supervisorId: 1,
      childId: 2,
      restartCount: 3,
      delayMs: 25,
      reason: "boom",
    }, {});
    recorder.emit({
      type: "supervisor.child.escalate",
      supervisorId: 1,
      childId: 2,
      reason: "exhausted",
      error: "bad child",
    }, {});
    recorder.emit({ type: "log", level: "info", message: "ignored" }, {});
    recorder.emit({ type: "log", level: "warn", message: "careful", fields: { id: 1 } }, {});
    recorder.emit({ type: "span.start", name: "work" }, { traceId: "trace" });
    recorder.emit({ type: "span.event", name: "middle" }, {});
    recorder.emit({ type: "span.end", name: "work", status: "failure", error: "span failed" }, {});

    const explanation = recorder.explain({ maxEvents: 20 });
    expect(explanation).toContain('fiber#1 started "root" parent=fiber#0');
    expect(explanation).toContain("fiber#99 resumed");
    expect(explanation).toContain("fiber#2 ended failure");
    expect(explanation).toContain("error=[object Object]");
    expect(explanation).toContain('fiber#3 ended failure');
    expect(explanation).toContain('error=Both; left: Fail("domain"); right: Die(Error: defect)');
    expect(explanation).toContain("scope#10 opened parent=scope#9");
    expect(explanation).toContain("scope#10 closed failure error=scope failed");
    expect(explanation).toContain("supervisor#1 restarting child#2 attempt=3 delay=25ms reason=boom");
    expect(explanation).toContain("supervisor#1 escalated child#2 reason=exhausted error=bad child");
    expect(explanation).toContain('warn: careful {"id":1}');
    expect(explanation).toContain('span started "work" trace=trace');
    expect(explanation).toContain('span ended failure "work" error=span failed');
  });

  it("explains currently suspended fibers", () => {
    const recorder = makeRuntimeRecorder();

    recorder.emit({ type: "fiber.suspend", fiberId: 7, reason: "queue.take" }, {});

    expect(recorder.explain()).toContain("fiber#7 still suspended for");
    expect(recorder.explain()).toContain("awaiting queue.take");
  });
});
