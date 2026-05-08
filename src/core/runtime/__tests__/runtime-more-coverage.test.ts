import { afterEach, describe, expect, it, vi } from "vitest";
import { async, asyncFail, asyncSucceed, asyncSync } from "../../types/asyncEffect";
import { DefaultHostExecutor } from "../hostAction";
import { RuntimeRegistry } from "../registry";
import { dumpAllFibers } from "../dump";
import { gracefulShutdown, registerShutdownHooks } from "../shutdown";
import { Runtime } from "../runtime";
import { retryN, retryWithBackoff, sleep, timeout } from "../combinators";

const rt = Runtime.make({});
const run = <A>(effect: any) => rt.toPromise(effect) as Promise<A>;
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("host action and fiber dump details", () => {
  it("default host executor returns an actionable error result", async () => {
    await expect(DefaultHostExecutor.execute({
      kind: "custom",
      actionId: "a1",
      target: "target",
    }, {
      fiberId: 1,
      env: {},
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: "error",
      actionId: "a1",
      error: expect.any(Error),
    });
  });

  it("renders awaiting details and final errors in fiber dumps", () => {
    const registry = new RuntimeRegistry();
    registry.emit({ type: "fiber.start", fiberId: 1, name: "one" }, { traceId: "t1", spanId: "s1" });
    registry.emit({ type: "fiber.suspend", fiberId: 1, reason: "sleep", detail: "10ms" }, {});
    registry.emit({ type: "fiber.end", fiberId: 1, status: "failure", error: "boom" }, {});
    registry.emit({ type: "fiber.start", fiberId: 2, name: "two" }, {});

    const dump = dumpAllFibers(registry);
    expect(dump).toContain("awaiting: sleep");
    expect(dump).toContain("end.error: boom");
    expect(dump.indexOf("fiber#1")).toBeGreaterThanOrEqual(0);
  });
});

describe("shutdown hook signal paths", () => {
  it("treats runtime shutdown errors as best-effort completion", async () => {
    const onComplete = vi.fn();

    const stats = await gracefulShutdown({
      shutdown: () => {
        throw new Error("shutdown failed");
      },
    } as any, { timeoutMs: 5, onComplete });

    expect(stats.timedOut).toBe(false);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("handles a signal with custom completion callback and forces exit on second signal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const onComplete = vi.fn();
    const cleanup = registerShutdownHooks({ shutdown: () => undefined } as any, { timeoutMs: 5, onComplete });

    process.emit("SIGTERM");
    await wait();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Received SIGTERM"));
    expect(onComplete).toHaveBeenCalledOnce();

    process.emit("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
    cleanup();
  });

  it("uses default completion logging and exit code when no completion callback is provided", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let resolveExit!: (code: string | number | null | undefined) => void;
    const exited = new Promise<string | number | null | undefined>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code) => {
      resolveExit(code);
      return undefined as never;
    }) as typeof process.exit);
    const cleanup = registerShutdownHooks({ shutdown: () => undefined } as any, { timeoutMs: 5 });

    process.emit("SIGTERM");
    await expect(exited).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Shutdown complete"));
    expect(exit).toHaveBeenCalledWith(0);
    cleanup();
  });

  it("uses default timeout logging and exit code when shutdown times out", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let resolveExit!: (code: string | number | null | undefined) => void;
    const exited = new Promise<string | number | null | undefined>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code) => {
      resolveExit(code);
      return undefined as never;
    }) as typeof process.exit);
    const cleanup = registerShutdownHooks({
      shutdown: () => new Promise(() => undefined),
    } as any, { timeoutMs: 1 });

    process.emit("SIGINT");
    await expect(exited).resolves.toBe(1);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Shutdown timed out"));
    expect(exit).toHaveBeenCalledWith(1);
    cleanup();
  });
});

describe("generic combinators", () => {
  it("sleeps, times out, retries with predicates, and cancels timeout fibers", async () => {
    await expect(run(sleep(-1))).resolves.toBeUndefined();
    await expect(run(timeout(asyncSucceed("fast"), 50))).resolves.toBe("fast");
    await expect(run(timeout(async(() => () => undefined), 1))).rejects.toEqual({ _tag: "TimeoutError", ms: 1 });

    let cancelled = false;
    const slow = timeout(async(() => () => { cancelled = true; }), 100);
    const fiber = rt.fork(slow);
    await wait();
    fiber.interrupt();
    await wait();
    expect(cancelled).toBe(true);

    let attempts = 0;
    await expect(run(retryN(asyncSync(() => {
      attempts++;
      if (attempts < 2) throw "again";
      return "ok";
    }) as any, 2))).resolves.toBe("ok");

    await expect(run(retryWithBackoff(asyncFail("stop"), {
      maxRetries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      shouldRetry: () => false,
    }))).rejects.toBe("stop");
  });
});
