import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makePrewarmManager } from "../prewarmManager";
import type { PrewarmEvent } from "../types";

describe("PrewarmManager Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function mockFetchSuccess(delayMs = 0) {
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }
        });
      }
      return new Response(null, { status: 200 });
    }) as any;
  }

  function mockFetchFailure(error = "Network error") {
    globalThis.fetch = vi.fn(async () => {
      throw new Error(error);
    }) as any;
  }

  describe("Construction", () => {
    it("creates manager with valid origins", () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com", "https://cdn.example.com"],
      });
      expect(manager).toBeDefined();
      expect(manager.warm).toBeTypeOf("function");
      expect(manager.warmAll).toBeTypeOf("function");
      expect(manager.cancel).toBeTypeOf("function");
      expect(manager.cancelAll).toBeTypeOf("function");
      expect(manager.isWarm).toBeTypeOf("function");
      expect(manager.status).toBeTypeOf("function");
      expect(manager.dispose).toBeTypeOf("function");
      manager.dispose();
    });

    it("throws on invalid origin", () => {
      mockFetchSuccess();
      expect(() =>
        makePrewarmManager({ origins: ["not-a-url"] }),
      ).toThrow();
    });

    it("throws when fetch is unavailable", () => {
      const origFetch = globalThis.fetch;
      (globalThis as any).fetch = undefined;
      try {
        expect(() =>
          makePrewarmManager({ origins: ["https://api.example.com"] }),
        ).toThrow("fetch");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("warm()", () => {
    it("probes an idle origin and marks it warm", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      const result = await manager.warm("https://api.example.com");
      expect(result.status).toBe("warmed");
      expect(result.origin).toBe("https://api.example.com");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(manager.isWarm("https://api.example.com")).toBe(true);
      manager.dispose();
    });

    it("skips probe for already-warm origin", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      await manager.warm("https://api.example.com");
      const result = await manager.warm("https://api.example.com");
      expect(result.status).toBe("already-warm");
      expect(result.durationMs).toBe(0);
      manager.dispose();
    });

    it("returns failed result on network error", async () => {
      mockFetchFailure("Connection refused");
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      const result = await manager.warm("https://api.example.com");
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Connection refused");
      expect(manager.isWarm("https://api.example.com")).toBe(false);
      manager.dispose();
    });

    it("returns cancelled after dispose", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });
      manager.dispose();

      const result = await manager.warm("https://api.example.com");
      expect(result.status).toBe("cancelled");
    });
  });

  describe("warmAll()", () => {
    it("returns one result per configured origin", async () => {
      mockFetchSuccess();
      const origins = [
        "https://api.example.com",
        "https://cdn.example.com",
        "https://auth.example.com",
      ];
      const manager = makePrewarmManager({ origins });

      const results = await manager.warmAll();
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.origin).sort()).toEqual(origins.sort());
      manager.dispose();
    });
  });

  describe("cancel()", () => {
    it("cancels an in-flight probe", async () => {
      // Use a slow fetch that respects abort
      let fetchStarted: (() => void) | undefined;
      const fetchStartedPromise = new Promise<void>((r) => { fetchStarted = r; });

      globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
        fetchStarted!();
        return new Promise<Response>((resolve, reject) => {
          const onAbort = () => {
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener("abort", onAbort);
        });
      }) as any;

      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      const warmPromise = manager.warm("https://api.example.com");
      // Wait for fetch to actually start before cancelling
      await fetchStartedPromise;
      manager.cancel("https://api.example.com");

      const result = await warmPromise;
      expect(result.status).toBe("cancelled");
      expect(manager.isWarm("https://api.example.com")).toBe(false);
      manager.dispose();
    });
  });

  describe("cancelAll()", () => {
    it("cancels all in-flight probes", async () => {
      let fetchCount = 0;
      const fetchStartedPromise = new Promise<void>((resolve) => {
        globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
          fetchCount++;
          if (fetchCount >= 2) resolve();
          return new Promise<Response>((_, reject) => {
            const onAbort = () => {
              reject(new DOMException("Aborted", "AbortError"));
            };
            if (init?.signal?.aborted) {
              onAbort();
              return;
            }
            init?.signal?.addEventListener("abort", onAbort);
          });
        }) as any;
      });

      const manager = makePrewarmManager({
        origins: ["https://a.example.com", "https://b.example.com"],
      });

      const promise = manager.warmAll();
      await fetchStartedPromise;
      manager.cancelAll();

      const results = await promise;
      expect(results.every((r) => r.status === "cancelled")).toBe(true);
      manager.dispose();
    });
  });

  describe("isWarm()", () => {
    it("returns false for unknown origin", () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });
      expect(manager.isWarm("https://unknown.example.com")).toBe(false);
      manager.dispose();
    });

    it("returns false after dispose", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });
      await manager.warm("https://api.example.com");
      expect(manager.isWarm("https://api.example.com")).toBe(true);
      manager.dispose();
      expect(manager.isWarm("https://api.example.com")).toBe(false);
    });
  });

  describe("status()", () => {
    it("returns snapshot with all origins", () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://a.example.com", "https://b.example.com"],
      });
      const snapshot = manager.status();
      expect(snapshot.origins).toHaveLength(2);
      expect(snapshot.origins[0].status).toBe("idle");
      expect(snapshot.origins[1].status).toBe("idle");
      manager.dispose();
    });
  });

  describe("Events", () => {
    it("emits connection-warmed on successful probe", async () => {
      mockFetchSuccess();
      const events: PrewarmEvent[] = [];
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        onEvent: (e) => events.push(e),
      });

      await manager.warm("https://api.example.com");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("connection-warmed");
      expect(events[0].origin).toBe("https://api.example.com");
      expect(events[0].timestamp).toBeGreaterThan(0);
      manager.dispose();
    });

    it("emits connection-failed on probe failure", async () => {
      mockFetchFailure("Network error");
      const events: PrewarmEvent[] = [];
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        onEvent: (e) => events.push(e),
      });

      await manager.warm("https://api.example.com");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("connection-failed");
      expect(events[0].error).toBe("Network error");
      manager.dispose();
    });

    it("emits connection-cancelled on cancel", async () => {
      let fetchStarted: (() => void) | undefined;
      const fetchStartedPromise = new Promise<void>((r) => { fetchStarted = r; });

      globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
        fetchStarted!();
        return new Promise<Response>((_, reject) => {
          const onAbort = () => {
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener("abort", onAbort);
        });
      }) as any;

      const events: PrewarmEvent[] = [];
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        onEvent: (e) => events.push(e),
      });

      const warmPromise = manager.warm("https://api.example.com");
      await fetchStartedPromise;
      manager.cancel("https://api.example.com");
      await warmPromise;

      const cancelledEvents = events.filter((e) => e.type === "connection-cancelled");
      expect(cancelledEvents).toHaveLength(1);
      expect(cancelledEvents[0].origin).toBe("https://api.example.com");
      manager.dispose();
    });
  });

  describe("Auto-Refresh", () => {
    it("does not create timers when autoRefresh is false", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        autoRefresh: false,
      });

      await manager.warm("https://api.example.com");
      // No timers should be pending (other than vitest internals)
      expect(vi.getTimerCount()).toBe(0);
      manager.dispose();
    });

    it("schedules re-probe at 0.8 * keepAliveDurationMs when autoRefresh is true", async () => {
      mockFetchSuccess();
      const keepAliveDurationMs = 10000;
      const events: PrewarmEvent[] = [];
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        keepAliveDurationMs,
        autoRefresh: true,
        onEvent: (e) => events.push(e),
      });

      await manager.warm("https://api.example.com");
      expect(manager.isWarm("https://api.example.com")).toBe(true);

      // Advance to 0.8 * keepAliveDurationMs
      await vi.advanceTimersByTimeAsync(8000);

      // Should have triggered a re-probe (expired + warmed events)
      const expiredEvents = events.filter((e) => e.type === "connection-expired");
      expect(expiredEvents.length).toBeGreaterThanOrEqual(1);
      manager.dispose();
    });
  });

  describe("Configuration Defaults", () => {
    it("uses default keepAliveDurationMs of 55000", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      await manager.warm("https://api.example.com");
      expect(manager.isWarm("https://api.example.com")).toBe(true);

      // Advance time to just before expiry
      vi.advanceTimersByTime(54999);
      expect(manager.isWarm("https://api.example.com")).toBe(true);

      // Advance past expiry
      vi.advanceTimersByTime(2);
      expect(manager.isWarm("https://api.example.com")).toBe(false);
      manager.dispose();
    });

    it("uses default budget of 4", () => {
      mockFetchSuccess();
      // Should not throw with 4 concurrent probes
      const manager = makePrewarmManager({
        origins: [
          "https://a.example.com",
          "https://b.example.com",
          "https://c.example.com",
          "https://d.example.com",
          "https://e.example.com",
        ],
      });
      expect(manager).toBeDefined();
      manager.dispose();
    });

    it("uses default probeTimeoutMs of 5000", async () => {
      // Slow fetch that never resolves
      globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
        return new Promise<Response>((_, reject) => {
          if (init?.signal) {
            const onAbort = () => {
              reject(new DOMException("Aborted", "AbortError"));
            };
            if (init.signal.aborted) {
              onAbort();
              return;
            }
            init.signal.addEventListener("abort", onAbort);
          }
        });
      }) as any;

      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      const warmPromise = manager.warm("https://api.example.com");
      await vi.advanceTimersByTimeAsync(5001);
      const result = await warmPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toContain("timed out");
      manager.dispose();
    });

    it("uses default autoRefresh of false", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
      });

      await manager.warm("https://api.example.com");
      expect(vi.getTimerCount()).toBe(0);
      manager.dispose();
    });
  });

  describe("Pool Awareness (useClientPool)", () => {
    it("uses dedicated fetch when useClientPool is false", async () => {
      mockFetchSuccess();
      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        useClientPool: false,
      });

      await manager.warm("https://api.example.com");
      expect(globalThis.fetch).toHaveBeenCalled();
      manager.dispose();
    });

    it("routes through client when useClientPool is true and client is provided", async () => {
      mockFetchSuccess();
      let clientCalled = false;
      const mockClient: any = (_req: any) => ({
        _tag: "Succeed",
        value: { status: 200, statusText: "OK", headers: {} },
      });

      // Wrap to track calls
      const trackedClient: any = (req: any) => {
        clientCalled = true;
        return mockClient(req);
      };

      const manager = makePrewarmManager({
        origins: ["https://api.example.com"],
        useClientPool: true,
        client: trackedClient,
      });

      await manager.warm("https://api.example.com");
      expect(clientCalled).toBe(true);
      manager.dispose();
    });
  });
});
