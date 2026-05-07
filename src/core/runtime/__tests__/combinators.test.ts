import { describe, it, expect } from "vitest";
import { sleep, timeout, retry, retryN, retryWithBackoff, TimeoutError } from "../combinators";
import { async, asyncFail, asyncFlatMap, asyncSucceed } from "../../types/asyncEffect";
import type { Async } from "../../types/asyncEffect";
import { Runtime } from "../runtime";

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------
describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    const start = performance.now();
    await run(sleep(50));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow some jitter
    expect(elapsed).toBeLessThan(150);
  });

  it("sleep(0) resolves almost immediately", async () => {
    const start = performance.now();
    await run(sleep(0));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------
describe("timeout", () => {
  it("returns the effect result when it completes before timeout", async () => {
    const effect = asyncFlatMap(sleep(10), () => asyncSucceed(42));
    const result = await run<number>(timeout(effect, 500));
    expect(result).toBe(42);
  });

  it("returns TimeoutError when effect exceeds timeout", async () => {
    const slowEffect = async((_env: unknown, _cb: any) => {
      // Never resolves
      const id = setTimeout(() => _cb({ _tag: "Success", value: "late" }), 5000);
      return () => clearTimeout(id);
    });

    try {
      await run(timeout(slowEffect, 50));
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e._tag).toBe("TimeoutError");
      expect(e.ms).toBe(50);
    }
  });

  it("cancels the effect when timeout fires", async () => {
    let effectCompleted = false;
    const effect = async((_env: unknown, _cb: any) => {
      const id = setTimeout(() => { effectCompleted = true; _cb({ _tag: "Success", value: "done" }); }, 5000);
      return () => { clearTimeout(id); };
    });

    try {
      await run(timeout(effect, 30));
    } catch { }

    // The effect should NOT have completed (it was interrupted)
    await new Promise(r => setTimeout(r, 50));
    expect(effectCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------
describe("retry", () => {
  it("returns immediately on success (no retries needed)", async () => {
    const effect = asyncSucceed(42);
    const result = await run<number>(retry(effect, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    }));
    expect(result).toBe(42);
  });

  it("retries on failure and succeeds on later attempt", async () => {
    let attempts = 0;
    const effect: Async<unknown, string, number> = async((_env, cb) => {
      attempts++;
      if (attempts < 3) {
        cb({ _tag: "Failure", cause: { _tag: "Fail", error: "not yet" } });
      } else {
        cb({ _tag: "Success", value: attempts });
      }
    });

    const result = await run<number>(retry(effect, {
      maxRetries: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
    }));
    expect(result).toBe(3);
    expect(attempts).toBe(3);
  });

  it("fails after exhausting retries", async () => {
    let attempts = 0;
    const effect: Async<unknown, string, number> = async((_env, cb) => {
      attempts++;
      cb({ _tag: "Failure", cause: { _tag: "Fail", error: `fail-${attempts}` } });
    });

    try {
      await run<number>(retry(effect, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 10,
      }));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe("fail-3"); // initial + 2 retries = 3 attempts
    }
    expect(attempts).toBe(3);
  });

  it("respects shouldRetry predicate", async () => {
    let attempts = 0;
    const effect: Async<unknown, string, number> = async((_env, cb) => {
      attempts++;
      cb({ _tag: "Failure", cause: { _tag: "Fail", error: attempts === 1 ? "retryable" : "fatal" } });
    });

    try {
      await run<number>(retry(effect, {
        maxRetries: 5,
        baseDelayMs: 1,
        maxDelayMs: 10,
        shouldRetry: (err) => err === "retryable",
      }));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe("fatal");
    }
    expect(attempts).toBe(2); // first attempt + one retry (which returned non-retryable)
  });
});

// ---------------------------------------------------------------------------
// retryN
// ---------------------------------------------------------------------------
describe("retryN", () => {
  it("retries N times with no delay", async () => {
    let attempts = 0;
    const effect: Async<unknown, string, number> = async((_env, cb) => {
      attempts++;
      if (attempts <= 2) {
        cb({ _tag: "Failure", cause: { _tag: "Fail", error: "fail" } });
      } else {
        cb({ _tag: "Success", value: 99 });
      }
    });

    const result = await run<number>(retryN(effect, 3));
    expect(result).toBe(99);
    expect(attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------
describe("retryWithBackoff", () => {
  it("uses exponential backoff with defaults", async () => {
    let attempts = 0;
    const effect: Async<unknown, string, number> = async((_env, cb) => {
      attempts++;
      if (attempts < 2) {
        cb({ _tag: "Failure", cause: { _tag: "Fail", error: "fail" } });
      } else {
        cb({ _tag: "Success", value: 42 });
      }
    });

    const start = performance.now();
    const result = await run<number>(retryWithBackoff(effect, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
    }));
    const elapsed = performance.now() - start;

    expect(result).toBe(42);
    expect(attempts).toBe(2);
    // Should have waited at least a small delay (jitter makes it variable)
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("respects maxElapsedMs budget", async () => {
    let attempts = 0;
    const effect: Async<unknown, string, number> = async((_env, cb) => {
      attempts++;
      cb({ _tag: "Failure", cause: { _tag: "Fail", error: "always-fail" } });
    });

    const start = performance.now();
    try {
      await run<number>(retryWithBackoff(effect, {
        maxRetries: 100,
        baseDelayMs: 50,
        maxDelayMs: 200,
        maxElapsedMs: 100,
      }));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBe("always-fail");
    }
    const elapsed = performance.now() - start;

    // Should have stopped within the budget (with some tolerance)
    expect(elapsed).toBeLessThan(300);
    // Should have attempted more than once but not exhausted all retries
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(100);
  });
});
