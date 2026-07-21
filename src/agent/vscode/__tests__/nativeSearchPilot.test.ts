import { describe, expect, it } from "vitest";
import { makeAgentLifecycle } from "../../core/agentHost";
import type { NativeServiceRequest, NativeServiceTransport } from "../../native/protocol";
import { makeVsCodeNativeSearchPilot } from "../nativeSearchPilot";

class FixtureTransport implements NativeServiceTransport {
  readonly requests: NativeServiceRequest[] = [];
  private readonly frames = new Set<(frame: string) => void>();

  send(frame: string): void {
    const request = JSON.parse(frame) as NativeServiceRequest;
    this.requests.push(request);
    queueMicrotask(() => this.respond(request));
  }

  onFrame(listener: (frame: string) => void): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onExit(): () => void {
    return () => undefined;
  }

  close(): void {}

  private respond(request: NativeServiceRequest): void {
    const result = request.method === "hello"
      ? {
          protocolVersion: 1,
          serviceBuild: "fixture",
          capabilities: ["health", "index.replace", "search", "cancel", "shutdown"],
          maxMessageBytes: 16_777_216,
          maxDocuments: 4_096,
          maxActiveRequests: 16,
          readOnly: true,
        }
      : request.method === "index.replace"
        ? { documentCount: (request.params as { documents: unknown[] }).documents.length }
        : request.method === "search"
          ? { hits: [{ id: "virtual:a", score: 1 }] }
          : request.method === "health"
            ? { ok: true, activeRequests: 0, readOnly: true }
            : { shuttingDown: true, drained: true, activeRequests: 0 };
    const response = JSON.stringify({
      protocolVersion: 1,
      type: "response",
      id: request.id,
      sessionId: request.sessionId,
      result,
    });
    for (const listener of [...this.frames]) listener(response);
  }
}

describe("VS Code native search composition", () => {
  it("rechecks trust and drains the private service with host lifecycle", async () => {
    let trusted = false;
    const lifecycle = makeAgentLifecycle();
    const transport = new FixtureTransport();
    const pilot = makeVsCodeNativeSearchPilot({
      host: {
        workspace: {
          id: "workspace-vscode",
          root: "/workspace",
          get trusted() { return trusted; },
        },
        lifecycle,
      },
      clientBuild: "vscode-test",
      mode: "native",
      transportFactory: () => transport,
    });

    await expect(pilot.replaceIndex([{ id: "virtual:a", text: "brass" }]))
      .rejects.toMatchObject({ code: "WORKSPACE_UNTRUSTED" });
    expect(transport.requests).toHaveLength(0);

    trusted = true;
    await expect(pilot.replaceIndex([{ id: "virtual:a", text: "brass" }]))
      .resolves.toMatchObject({ engine: "rust-native", fallbackUsed: false });
    await expect(pilot.search("brass"))
      .resolves.toMatchObject({ engine: "rust-native", fallbackUsed: false });

    lifecycle.shutdown();
    await new Promise((resolveShutdown) => setTimeout(resolveShutdown, 0));
    expect(transport.requests.at(-1)?.method).toBe("shutdown");
  });
});
