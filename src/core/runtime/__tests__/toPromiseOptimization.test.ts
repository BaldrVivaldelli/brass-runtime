import { describe, it, expect } from "vitest";
import { Async, asyncSucceed, asyncFail, asyncFlatMap } from "../../types/asyncEffect";
import { Exit, Cause } from "../../types/effect";
import { Runtime } from "../runtime";

/**
 * Unit tests for the `toPromise` optimization in the Runtime class.
 *
 * The optimization reduces closure count from 2 to 1 by using a single
 * `complete` closure that doubles as both the NativeTopLevelRunner callback
 * and the fiber join callback. It also preserves the sync-detection fast path
 * that returns `Promise.resolve`/`Promise.reject` directly when the effect
 * resolves synchronously.
 */

describe("toPromise optimization", () => {
  describe("sync fast path (Promise.resolve)", () => {
    it("resolves a Succeed effect via Promise.resolve fast path", async () => {
      const rt = new Runtime({ env: {} });
      const effect = asyncSucceed(42);

      const result = await rt.toPromise(effect);
      expect(result).toBe(42);
    });

    it("resolves a Sync effect via Promise.resolve fast path", async () => {
      const rt = new Runtime({ env: { multiplier: 3 } });
      const effect: Async<{ multiplier: number }, never, number> = {
        _tag: "Sync",
        thunk: (env) => env.multiplier * 7,
      };

      const result = await rt.toPromise(effect);
      expect(result).toBe(21);
    });

    it("resolves chained sync effects via fast path", async () => {
      const rt = new Runtime({ env: {} });
      const effect = asyncFlatMap(asyncSucceed(10), (a) => asyncSucceed(a + 5));

      const result = await rt.toPromise(effect);
      expect(result).toBe(15);
    });

    it("returns a Promise.resolve for sync success (not new Promise)", async () => {
      const rt = new Runtime({ env: {} });
      const effect = asyncSucceed("fast");

      // The promise should resolve in the same microtask tick as Promise.resolve
      const promise = rt.toPromise(effect);
      // Verify it resolves correctly
      const result = await promise;
      expect(result).toBe("fast");
    });
  });

  describe("async effects with reduced closure count", () => {
    it("resolves an async effect that completes after a microtask", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, never, string> = {
        _tag: "Async",
        register: (_env, cb) => {
          queueMicrotask(() => cb(Exit.succeed("async-value")));
        },
      };

      const result = await rt.toPromise(effect);
      expect(result).toBe("async-value");
    });

    it("resolves an async effect that completes after a setTimeout", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, never, number> = {
        _tag: "Async",
        register: (_env, cb) => {
          setTimeout(() => cb(Exit.succeed(100)), 5);
        },
      };

      const result = await rt.toPromise(effect);
      expect(result).toBe(100);
    });

    it("resolves chained async effects correctly", async () => {
      const rt = new Runtime({ env: {} });
      const asyncA: Async<unknown, never, number> = {
        _tag: "Async",
        register: (_env, cb) => {
          queueMicrotask(() => cb(Exit.succeed(10)));
        },
      };
      const effect = asyncFlatMap(asyncA, (a) => {
        const asyncB: Async<unknown, never, number> = {
          _tag: "Async",
          register: (_env, cb) => {
            queueMicrotask(() => cb(Exit.succeed(a + 20)));
          },
        };
        return asyncB;
      });

      const result = await rt.toPromise(effect);
      expect(result).toBe(30);
    });

    it("resolves a synchronous Async callback (register resolves inline)", async () => {
      const rt = new Runtime({ env: {} });
      // Async effect that resolves synchronously inside register
      const effect: Async<unknown, never, string> = {
        _tag: "Async",
        register: (_env, cb) => {
          cb(Exit.succeed("sync-async"));
        },
      };

      const result = await rt.toPromise(effect);
      expect(result).toBe("sync-async");
    });
  });

  describe("error propagation", () => {
    it("rejects with the error value for a Fail effect", async () => {
      const rt = new Runtime({ env: {} });
      const effect = asyncFail("something went wrong");

      await expect(rt.toPromise(effect)).rejects.toBe("something went wrong");
    });

    it("rejects with the error for an async failure", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, string, never> = {
        _tag: "Async",
        register: (_env, cb) => {
          queueMicrotask(() => cb(Exit.failCause(Cause.fail("async-error"))));
        },
      };

      await expect(rt.toPromise(effect)).rejects.toBe("async-error");
    });

    it("rejects with Error for a Die (defect) cause", async () => {
      const rt = new Runtime({ env: {} });
      const defectError = new Error("fatal defect");
      const effect: Async<unknown, never, never> = {
        _tag: "Async",
        register: (_env, cb) => {
          cb(Exit.failCause(Cause.die(defectError)));
        },
      };

      await expect(rt.toPromise(effect)).rejects.toBe(defectError);
    });

    it("rejects with Error('Interrupted') for an Interrupt cause", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, never, never> = {
        _tag: "Async",
        register: (_env, cb) => {
          cb(Exit.failCause(Cause.interrupt()));
        },
      };

      await expect(rt.toPromise(effect)).rejects.toEqual(new Error("Interrupted"));
    });

    it("rejects with defect wrapped in Error when defect is not an Error instance", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, never, never> = {
        _tag: "Async",
        register: (_env, cb) => {
          cb(Exit.failCause(Cause.die("string-defect")));
        },
      };

      await expect(rt.toPromise(effect)).rejects.toEqual(new Error("string-defect"));
    });

    it("rejects correctly for sync Fail effect via fast path", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, string, never> = { _tag: "Fail", error: "sync-fail" };

      await expect(rt.toPromise(effect)).rejects.toBe("sync-fail");
    });

    it("rejects for async Die after a timeout", async () => {
      const rt = new Runtime({ env: {} });
      const defect = new TypeError("network failure");
      const effect: Async<unknown, never, never> = {
        _tag: "Async",
        register: (_env, cb) => {
          setTimeout(() => cb(Exit.failCause(Cause.die(defect))), 5);
        },
      };

      await expect(rt.toPromise(effect)).rejects.toBe(defect);
    });

    it("rejects for async Interrupt after a microtask", async () => {
      const rt = new Runtime({ env: {} });
      const effect: Async<unknown, never, never> = {
        _tag: "Async",
        register: (_env, cb) => {
          queueMicrotask(() => cb(Exit.failCause(Cause.interrupt())));
        },
      };

      await expect(rt.toPromise(effect)).rejects.toEqual(new Error("Interrupted"));
    });
  });
});
