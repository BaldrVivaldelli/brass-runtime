import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeServiceClient } from "../../native/client";
import type { NativeServiceTransport } from "../../native/protocol";
import { NativeSearchPilot } from "../../native/searchPilot";
import { createNodeNativeServiceTransport } from "../nativeServiceProcess";

const binary = resolve(
  process.cwd(),
  "target",
  "debug",
  process.platform === "win32" ? "brass-native-service.exe" : "brass-native-service",
);

describe.runIf(existsSync(binary))("real native search service process", () => {
  it("handshakes, stays read-only, searches, restarts and rehydrates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brass-native-pilot-"));
    const canary = join(directory, "must-not-change.txt");
    writeFileSync(canary, "unchanged", "utf8");
    const transports: NativeServiceTransport[] = [];
    const events: unknown[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace-real",
      clientBuild: "integration-test",
      transportFactory: () => {
        const transport = createNodeNativeServiceTransport({ command: binary });
        transports.push(transport);
        return transport;
      },
      onEvent: (event) => events.push(event),
    });
    const pilot = new NativeSearchPilot({
      mode: "native",
      client,
      restartBackoffMs: 0,
      isWorkspaceTrusted: () => true,
    });

    await expect(pilot.replaceIndex([
      { id: canary, text: "brass native brass" },
      { id: "virtual:second", text: "runtime rust" },
    ])).resolves.toMatchObject({
      engine: "rust-native",
      value: { documentCount: 2 },
    });
    await expect(pilot.search("brass", 10)).resolves.toMatchObject({
      engine: "rust-native",
      value: { hits: [{ id: canary, score: 2 }] },
    });
    expect(readFileSync(canary, "utf8")).toBe("unchanged");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "native.progress" }),
      expect.objectContaining({ type: "native.terminal", outcome: "success" }),
      expect.objectContaining({ type: "runtime.boundary", boundary: "ipc-rust" }),
    ]));

    await transports[0].close();
    await expect(pilot.search("runtime", 10)).resolves.toMatchObject({
      engine: "rust-native",
      fallbackUsed: false,
      value: { hits: [{ id: "virtual:second", score: 1 }] },
    });
    expect(transports).toHaveLength(2);
    expect(readFileSync(canary, "utf8")).toBe("unchanged");
    const finalPid = transports[1].processId;
    await pilot.shutdown();
    if (finalPid !== undefined) {
      await expect(waitUntil(() => !isProcessAlive(finalPid), 1_000)).resolves.toBe(true);
    }
  });

  it("confirms cooperative cancellation and leaves no active request", async () => {
    const documents = Array.from({ length: 4_000 }, (_, index) => ({
      id: `doc:${index}`,
      text: `${"brass-runtime ".repeat(130)}${index}`,
    }));
    const controller = new AbortController();
    let cancellationStartedAt = 0;
    const terminalEvents: unknown[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace-cancel",
      clientBuild: "integration-test",
      transportFactory: () => createNodeNativeServiceTransport({ command: binary }),
      defaultTimeoutMs: 30_000,
      onEvent: (event) => {
        if (event.type === "native.progress" && event.phase === "searching" && !controller.signal.aborted) {
          cancellationStartedAt = performance.now();
          controller.abort();
        }
        if (event.type === "native.terminal") terminalEvents.push(event);
      },
    });
    await client.replaceIndex(documents, { timeoutMs: 30_000 });

    await expect(client.search("missing-term", 100, {
      signal: controller.signal,
      timeoutMs: 30_000,
    })).rejects.toMatchObject({ code: "CANCELLED" });
    const cancellationMs = performance.now() - cancellationStartedAt;
    expect(cancellationStartedAt).toBeGreaterThan(0);
    expect(cancellationMs).toBeLessThanOrEqual(50);
    expect(terminalEvents).toContainEqual(expect.objectContaining({
      outcome: "cancelled",
      errorCode: "CANCELLED",
    }));
    await expect(client.health()).resolves.toMatchObject({ ok: true, activeRequests: 0, readOnly: true });
    await client.shutdown();
  }, 45_000);

  it("orders shutdown after active work reaches a terminal event", async () => {
    const documents = Array.from({ length: 4_000 }, (_, index) => ({
      id: `shutdown:${index}`,
      text: `${"structured-concurrency ".repeat(90)}${index}`,
    }));
    const terminalEvents: unknown[] = [];
    let shutdown: Promise<void> | undefined;
    const client = new NativeServiceClient({
      workspaceId: "workspace-shutdown",
      clientBuild: "integration-test",
      transportFactory: () => createNodeNativeServiceTransport({ command: binary }),
      defaultTimeoutMs: 30_000,
      onEvent: (event) => {
        if (event.type === "native.progress" && event.phase === "searching" && !shutdown) {
          shutdown = client.shutdown();
        }
        if (event.type === "native.terminal") terminalEvents.push(event);
      },
    });
    await client.replaceIndex(documents, { timeoutMs: 30_000 });

    await expect(client.search("missing-on-purpose", 100, { timeoutMs: 30_000 }))
      .rejects.toMatchObject({ code: "CANCELLED" });
    await expect(shutdown).resolves.toBeUndefined();
    expect(terminalEvents).toContainEqual(expect.objectContaining({
      outcome: "cancelled",
      errorCode: "CANCELLED",
    }));
  }, 45_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  return predicate();
}
