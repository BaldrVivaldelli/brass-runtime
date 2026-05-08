// src/http/prewarm/probe.ts — Probe request execution for connection pre-warming.

import type { HttpClientFn } from "../client";

/**
 * Outcome of a probe request.
 */
export type ProbeOutcome = {
  /** Whether the probe succeeded (connection established). */
  ok: boolean;
  /** Duration of the probe in milliseconds. */
  durationMs: number;
  /** Error message if the probe failed. */
  error?: string;
};

/**
 * Options for executing a probe request.
 */
export type ProbeOptions = {
  /** Probe timeout in milliseconds. */
  timeoutMs: number;
  /** AbortSignal for external cancellation. */
  signal: AbortSignal;
  /** Runtime platform. */
  platform: "browser" | "node";
  /** Optional Wire_Client to route through (when useClientPool is true). */
  client?: HttpClientFn;
};

/**
 * Executes a HEAD probe request to the root path of the given origin.
 *
 * The probe is a lightweight HEAD request to `${origin}/` designed to trigger
 * TCP+TLS connection establishment in the platform's connection pool.
 *
 * @param origin - The validated origin to probe (e.g., "https://api.example.com").
 * @param options - Probe configuration options.
 * @returns A ProbeOutcome indicating success or failure.
 */
export async function executeProbe(origin: string, options: ProbeOptions): Promise<ProbeOutcome> {
  const { timeoutMs, signal, platform } = options;
  const url = `${origin}/`;
  const start = Date.now();

  // Create a timeout abort controller linked to the external signal
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Abort if external signal fires
  const onExternalAbort = () => timeoutController.abort();
  signal.addEventListener("abort", onExternalAbort);

  try {
    // When a client is provided (useClientPool=true), route through the Wire_Client
    if (options.client) {
      const result = await executeProbeViaClient(options.client, url, timeoutController.signal);
      const durationMs = Date.now() - start;
      if (result.ok) {
        return { ok: true, durationMs };
      }
      return { ok: false, durationMs, error: result.error };
    }

    const fetchOptions: RequestInit = {
      method: "HEAD",
      signal: timeoutController.signal,
      // Prevent caching of probe requests
      cache: "no-store" as RequestCache,
    };

    // In browser environments, use no-cors mode for cross-origin probes
    if (platform === "browser") {
      (fetchOptions as any).mode = "no-cors";
    }

    await globalThis.fetch(url, fetchOptions);

    const durationMs = Date.now() - start;
    return { ok: true, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;

    // Check if it was cancelled externally
    if (signal.aborted) {
      return { ok: false, durationMs, error: "cancelled" };
    }

    // Check if it was a timeout
    if (timeoutController.signal.aborted && !signal.aborted) {
      return { ok: false, durationMs, error: `Probe timed out after ${timeoutMs}ms` };
    }

    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, durationMs, error: message };
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Executes a probe via the Wire_Client (HttpClientFn).
 * Used when useClientPool is true to route probes through the same connection pool.
 */
async function executeProbeViaClient(
  client: HttpClientFn,
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  // Dynamically import to avoid circular dependency issues
  const { registerHttpEffect } = await import("../effectRunner");

  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const effect = client({
      method: "HEAD",
      url,
      init: { signal } as any,
    });

    const cancel = registerHttpEffect(effect, {}, (exit) => {
      if (exit._tag === "Success") {
        resolve({ ok: true });
      } else {
        const cause = exit.cause;
        if (cause?._tag === "Fail") {
          const err = (cause as any).error;
          resolve({ ok: false, error: err?.message ?? err?._tag ?? "Unknown error" });
        } else {
          resolve({ ok: false, error: "cancelled" });
        }
      }
    });

    // If signal is already aborted, cancel immediately
    if (signal.aborted) {
      cancel();
    } else {
      signal.addEventListener("abort", () => {
        cancel();
      }, { once: true });
    }
  });
}
