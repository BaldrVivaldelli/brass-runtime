import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Exit } from "../../types/effect";
import {
  fromPromiseAbortable,
  resetAbortablePromiseStats,
} from "../runtime";

/**
 * Unit test: No timeout → no setTimeout call
 *
 * **Validates: Requirement 3.2**
 *
 * When `fromPromiseAbortable` is called without a timeout (no `timeoutMs` in options
 * or `timeoutMs <= 0`), it should use the `registerWithoutTimeout` path which does
 * NOT call `setTimeout`. This verifies the no-timeout fast path optimization.
 */
describe("fromPromiseAbortable – no timeout fast path", () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAbortablePromiseStats();
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it("does not call setTimeout when no timeoutMs is provided", async () => {
    const effect = fromPromiseAbortable<string, string>(
      (_signal) => Promise.resolve("ok"),
      (u) => String(u),
    );

    const result = await new Promise<Exit<string, string>>((resolve) => {
      effect.register(undefined as unknown, (exit) => {
        resolve(exit);
      });
    });

    expect(result).toEqual(Exit.succeed("ok"));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("does not call setTimeout when timeoutMs is undefined", async () => {
    const effect = fromPromiseAbortable<string, string>(
      (_signal) => Promise.resolve("value"),
      (u) => String(u),
      { timeoutMs: undefined },
    );

    const result = await new Promise<Exit<string, string>>((resolve) => {
      effect.register(undefined as unknown, (exit) => {
        resolve(exit);
      });
    });

    expect(result).toEqual(Exit.succeed("value"));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("does not call setTimeout when timeoutMs is 0", async () => {
    const effect = fromPromiseAbortable<string, string>(
      (_signal) => Promise.resolve("zero"),
      (u) => String(u),
      { timeoutMs: 0 },
    );

    const result = await new Promise<Exit<string, string>>((resolve) => {
      effect.register(undefined as unknown, (exit) => {
        resolve(exit);
      });
    });

    expect(result).toEqual(Exit.succeed("zero"));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("does not call setTimeout when timeoutMs is negative", async () => {
    const effect = fromPromiseAbortable<string, string>(
      (_signal) => Promise.resolve("negative"),
      (u) => String(u),
      { timeoutMs: -100 },
    );

    const result = await new Promise<Exit<string, string>>((resolve) => {
      effect.register(undefined as unknown, (exit) => {
        resolve(exit);
      });
    });

    expect(result).toEqual(Exit.succeed("negative"));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("does not call setTimeout when promise rejects without timeout", async () => {
    const effect = fromPromiseAbortable<string, string>(
      (_signal) => Promise.reject(new Error("fail")),
      (u) => (u as Error).message,
    );

    const result = await new Promise<Exit<string, string>>((resolve) => {
      effect.register(undefined as unknown, (exit) => {
        resolve(exit);
      });
    });

    expect(result._tag).toBe("Failure");
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
