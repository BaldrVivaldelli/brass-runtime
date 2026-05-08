import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeProbe } from "../probe";

describe("Probe Unit Tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("browser cross-origin uses mode: no-cors", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as any;

    const controller = new AbortController();
    await executeProbe("https://api.example.com", {
      timeoutMs: 5000,
      signal: controller.signal,
      platform: "browser",
    });

    expect(capturedInit).toBeDefined();
    expect((capturedInit as any).mode).toBe("no-cors");
    expect(capturedInit!.method).toBe("HEAD");
  });

  it("Node.js uses standard HEAD without browser options", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as any;

    const controller = new AbortController();
    await executeProbe("https://api.example.com", {
      timeoutMs: 5000,
      signal: controller.signal,
      platform: "node",
    });

    expect(capturedInit).toBeDefined();
    expect(capturedInit!.method).toBe("HEAD");
    expect((capturedInit as any).mode).toBeUndefined();
  });

  it("timeout aborts probe", async () => {
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      // Simulate a slow request that respects abort signal
      return new Promise<Response>((_, reject) => {
        const onAbort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort);
      });
    }) as any;

    const controller = new AbortController();
    const result = await executeProbe("https://api.example.com", {
      timeoutMs: 50,
      signal: controller.signal,
      platform: "node",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Probe timed out after 50ms");
  });

  it("AbortSignal cancels probe", async () => {
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      return new Promise<Response>((_, reject) => {
        const onAbort = () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort);
      });
    }) as any;

    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10);

    const result = await executeProbe("https://api.example.com", {
      timeoutMs: 5000,
      signal: controller.signal,
      platform: "node",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("cancelled");
  });

  it("successful probe returns ok with duration", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 200 });
    }) as any;

    const controller = new AbortController();
    const result = await executeProbe("https://api.example.com", {
      timeoutMs: 5000,
      signal: controller.signal,
      platform: "node",
    });

    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("network error returns failure with message", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network unreachable");
    }) as any;

    const controller = new AbortController();
    const result = await executeProbe("https://api.example.com", {
      timeoutMs: 5000,
      signal: controller.signal,
      platform: "node",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network unreachable");
  });
});
