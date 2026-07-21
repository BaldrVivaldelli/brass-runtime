import { describe, expect, it } from "vitest";
import { asyncInterruptible, asyncSucceed } from "../../types/asyncEffect";
import { Runtime } from "../runtime";
import { RuntimeRegistry } from "../registry";
import { Scope } from "../scope";

describe("compact runtime diagnostics", () => {
  it("reports live scopes/finalizers and finalizer duration with registry detail", async () => {
    const registry = new RuntimeRegistry();
    const runtime = new Runtime({ env: {}, hooks: registry });
    const scope = new Scope(runtime);
    scope.addFinalizer(() => asyncSucceed(undefined));

    const pending = runtime.diagnostics();
    expect(pending).toMatchObject({
      version: 1,
      engine: "ts",
      scopes: { total: 1, pending: 1, pendingFinalizers: 1 },
      fibers: { live: 0, suspended: 0 },
      scheduler: { lanes: expect.any(Array) },
    });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.fibers)).toBe(true);

    await runtime.toPromise(scope.closeAsync());
    const closed = runtime.diagnostics();
    expect(closed.scopes.pending).toBe(0);
    expect(closed.scopes.pendingFinalizers).toBe(0);
    expect(closed.scopes.lastFinalizerDurationMs).toBeGreaterThanOrEqual(0);
    expect(closed.scopes.maxFinalizerDurationMs).toBeGreaterThanOrEqual(closed.scopes.lastFinalizerDurationMs);
    expect(registry.scopes.get(scope.id)?.finalizers).toEqual([
      expect.objectContaining({ id: 1, status: "done" }),
    ]);
  });

  it("tracks scope and finalizer counters without hooks", async () => {
    const runtime = new Runtime({ env: {} });
    const scope = new Scope(runtime);
    scope.addFinalizer(() => asyncSucceed(undefined));
    expect(runtime.diagnostics().scopes).toMatchObject({ pending: 1, pendingFinalizers: 1 });

    await runtime.toPromise(scope.closeAsync());
    expect(runtime.diagnostics().scopes).toMatchObject({ pending: 0, pendingFinalizers: 0 });
  });

  it("tracks completed, failed, and interrupted TypeScript fibers", async () => {
    const runtime = new Runtime({ env: {} });
    await runtime.toPromise(asyncSucceed("ok"));
    const diagnostics = runtime.diagnostics();
    expect(diagnostics.fibers.completed).toBeGreaterThanOrEqual(1);
    expect(diagnostics.fibers.live).toBe(0);
  });

  it("counts suspended fibers without runtime hooks", async () => {
    const runtime = new Runtime({ env: {} });
    const fiber = runtime.fork(asyncInterruptible(() => () => undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.diagnostics().fibers).toMatchObject({ live: 1, suspended: 1 });

    const ended = new Promise<void>((resolve) => fiber.join(() => resolve()));
    fiber.interrupt();
    await ended;
    expect(runtime.diagnostics().fibers.live).toBe(0);
    expect(runtime.diagnostics().fibers.interrupted).toBe(1);
  });
});
