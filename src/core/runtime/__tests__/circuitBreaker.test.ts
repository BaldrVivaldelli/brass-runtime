import { describe, it, expect } from "vitest";
import { makeCircuitBreaker } from "../circuitBreaker";
import { async, asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { Runtime } from "../runtime";

const rt = Runtime.make({});
function run<A>(effect: any): Promise<A> { return rt.toPromise(effect); }

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = makeCircuitBreaker();
    expect(cb.state()).toBe("closed");
  });

  it("passes through on success", async () => {
    const cb = makeCircuitBreaker({ failureThreshold: 3 });
    const result = await run<number>(cb.protect(asyncSucceed(42)));
    expect(result).toBe(42);
    expect(cb.state()).toBe("closed");
  });

  it("opens after failureThreshold consecutive failures", async () => {
    const cb = makeCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

    for (let i = 0; i < 3; i++) {
      try { await run(cb.protect(asyncFail("err"))); } catch { }
    }

    expect(cb.state()).toBe("open");
  });

  it("rejects requests when open", async () => {
    const cb = makeCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5000 });

    // Trip the breaker
    try { await run(cb.protect(asyncFail("e1"))); } catch { }
    try { await run(cb.protect(asyncFail("e2"))); } catch { }
    expect(cb.state()).toBe("open");

    // Next request should be rejected immediately
    try {
      await run(cb.protect(asyncSucceed("should-not-run")));
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e._tag).toBe("CircuitBreakerOpen");
    }
  });

  it("transitions to half-open after resetTimeout", async () => {
    const cb = makeCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30 });

    // Trip
    try { await run(cb.protect(asyncFail("err"))); } catch { }
    expect(cb.state()).toBe("open");

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 50));

    // Next request should be allowed (half-open probe)
    const result = await run<string>(cb.protect(asyncSucceed("recovered")));
    expect(result).toBe("recovered");
    expect(cb.state()).toBe("closed");
  });

  it("goes back to open if half-open probe fails", async () => {
    const cb = makeCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });

    // Trip
    try { await run(cb.protect(asyncFail("err"))); } catch { }
    expect(cb.state()).toBe("open");

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 30));

    // Probe fails
    try { await run(cb.protect(asyncFail("still-broken"))); } catch { }
    expect(cb.state()).toBe("open");
  });

  it("respects isFailure predicate", async () => {
    const cb = makeCircuitBreaker({
      failureThreshold: 2,
      isFailure: (e) => e !== "not-a-failure",
    });

    // These don't count as failures
    try { await run(cb.protect(asyncFail("not-a-failure"))); } catch { }
    try { await run(cb.protect(asyncFail("not-a-failure"))); } catch { }
    try { await run(cb.protect(asyncFail("not-a-failure"))); } catch { }
    expect(cb.state()).toBe("closed");

    // These do count
    try { await run(cb.protect(asyncFail("real-error"))); } catch { }
    try { await run(cb.protect(asyncFail("real-error"))); } catch { }
    expect(cb.state()).toBe("open");
  });

  it("tracks stats correctly", async () => {
    const cb = makeCircuitBreaker({ failureThreshold: 3 });

    await run(cb.protect(asyncSucceed(1)));
    await run(cb.protect(asyncSucceed(2)));
    try { await run(cb.protect(asyncFail("e"))); } catch { }

    const stats = cb.stats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalSuccesses).toBe(2);
    expect(stats.totalFailures).toBe(1);
    expect(stats.state).toBe("closed");
  });

  it("reset() returns to closed state", () => {
    const cb = makeCircuitBreaker({ failureThreshold: 1 });
    // Manually set state (via internal mechanism)
    // Trip it
    rt.unsafeRunAsync(cb.protect(asyncFail("x")) as any, () => {});
    // Give it a tick
    cb.reset();
    expect(cb.state()).toBe("closed");
  });

  it("onStateChange callback fires on transitions", async () => {
    const transitions: string[] = [];
    const cb = makeCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 20,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });

    try { await run(cb.protect(asyncFail("err"))); } catch { }
    expect(transitions).toEqual(["closed->open"]);

    await new Promise(r => setTimeout(r, 30));
    await run(cb.protect(asyncSucceed("ok")));
    expect(transitions).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
  });
});
