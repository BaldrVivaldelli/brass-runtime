import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeServiceClient } from "../client";
import {
  NativeServiceError,
  parseNativeServiceMessage,
  parseNativeServiceRequest,
  type NativeServiceRequest,
  type NativeServiceTransport,
} from "../protocol";
import { NativeSearchPilot, TypeScriptSearchIndex } from "../searchPilot";

class FakeNativeTransport implements NativeServiceTransport {
  private readonly frames = new Set<(frame: string) => void>();
  private readonly exits = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private readonly documents = new Map<string, string>();
  private readonly held = new Map<string, NativeServiceRequest>();
  readonly requests: NativeServiceRequest[] = [];

  send(frame: string): void {
    const request = JSON.parse(frame) as NativeServiceRequest;
    this.requests.push(request);
    queueMicrotask(() => this.handle(request));
  }

  onFrame(listener: (frame: string) => void): () => void {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  close(): void {
    this.crash(0, null);
  }

  crash(code: number | null = 1, signal: string | null = null): void {
    for (const listener of [...this.exits]) listener({ code, signal });
  }

  emitNativeEvent(event: unknown): void {
    this.event(event);
  }

  private handle(request: NativeServiceRequest): void {
    switch (request.method) {
      case "hello":
        this.response(request, {
          protocolVersion: 1,
          serviceBuild: "fake",
          capabilities: ["health", "index.replace", "search", "cancel", "shutdown"],
          maxMessageBytes: 1_048_576,
          maxDocuments: 4_096,
          maxActiveRequests: 16,
          readOnly: true,
        });
        return;
      case "health":
        this.response(request, { ok: true, activeRequests: this.held.size, readOnly: true });
        return;
      case "index.replace": {
        const params = request.params as { documents: readonly { id: string; text: string }[] };
        this.documents.clear();
        for (const document of params.documents) this.documents.set(document.id, document.text.toLowerCase());
        this.response(request, { documentCount: this.documents.size });
        return;
      }
      case "search": {
        const params = request.params as { query: string; limit: number };
        if (params.query === "hold") {
          this.held.set(request.id, request);
          return;
        }
        const hits = [...this.documents]
          .map(([id, text]) => ({ id, score: text.split(params.query.toLowerCase()).length - 1 }))
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
          .slice(0, params.limit);
        this.boundary(request, "success");
        this.response(request, { hits });
        this.event({
          version: 1,
          type: "native.terminal",
          requestId: request.id,
          outcome: "success",
        });
        return;
      }
      case "cancel": {
        const target = (request.params as { targetRequestId: string }).targetRequestId;
        const held = this.held.get(target);
        this.response(request, { accepted: held !== undefined });
        if (held) {
          this.held.delete(target);
          this.response(held, undefined, { code: "CANCELLED", message: "request cancelled" });
          this.event({
            version: 1,
            type: "native.terminal",
            requestId: target,
            outcome: "cancelled",
            errorCode: "CANCELLED",
          });
        }
        return;
      }
      case "shutdown":
        this.response(request, { shuttingDown: true });
        return;
    }
  }

  private response(
    request: NativeServiceRequest,
    result?: unknown,
    error?: { code: string; message: string },
  ): void {
    this.emit({
      protocolVersion: 1,
      type: "response",
      id: request.id,
      sessionId: request.sessionId,
      ...(error ? { error } : { result }),
    });
  }

  private boundary(request: NativeServiceRequest, result: "success" | "error" | "cancelled"): void {
    this.event({
      version: 1,
      type: "runtime.boundary",
      boundary: "ipc-rust",
      operation: request.method,
      at: 1,
      durationMs: 1,
      requestBytes: 10,
      responseBytes: 10,
      result,
      correlationId: request.id,
      queueDepth: 0,
    });
  }

  private event(event: unknown): void {
    this.emit({ protocolVersion: 1, type: "event", event });
  }

  private emit(value: unknown): void {
    const frame = JSON.stringify(value);
    for (const listener of [...this.frames]) listener(frame);
  }
}

describe("native service client and read-only pilot", () => {
  it("round-trips every canonical IPC v1 request and message", () => {
    const fixture = JSON.parse(readFileSync(
      resolve(process.cwd(), "fixtures", "native-ipc-v1.json"),
      "utf8",
    )) as { requests: unknown[]; messages: unknown[] };
    for (const request of fixture.requests) {
      expect(parseNativeServiceRequest(JSON.stringify(request))).toEqual(request);
    }
    for (const message of fixture.messages) {
      expect(parseNativeServiceMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it("uses UTF-8 limits, ASCII folding, and byte-order ties deterministically", () => {
    const index = new TypeScriptSearchIndex();
    index.replace([
      { id: "virtual:\u{10000}", text: "marker CAFÉ" },
      { id: "virtual:\u{e000}", text: "marker café" },
    ]);
    expect(index.search("marker", 10).map((hit) => hit.id)).toEqual([
      "virtual:\u{e000}",
      "virtual:\u{10000}",
    ]);
    expect(index.search("café", 10)).toEqual([{ id: "virtual:\u{e000}", score: 1 }]);
    expect(index.search("marker", Number.NaN)).toHaveLength(2);
    expect(() => index.replace([{ id: "large", text: "😀".repeat(70_000) }]))
      .toThrow(/byte limit/i);
  });

  it("closes its event stream even when shutdown happens before connection", async () => {
    const client = new NativeServiceClient({
      workspaceId: "workspace",
      clientBuild: "test",
      transportFactory: () => new FakeNativeTransport(),
      nonce: nonceSequence(),
    });

    await client.shutdown();

    await expect(client.eventStream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("negotiates v1, indexes/searches, and emits both redacted boundary legs", async () => {
    const transport = new FakeNativeTransport();
    const boundaryEvents: unknown[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace-1",
      clientBuild: "test",
      transportFactory: () => transport,
      nonce: nonceSequence(),
      diagnostics: { sink: { emit: (event) => boundaryEvents.push(event) } },
    });

    await expect(client.replaceIndex([
      { id: "a", text: "brass brass" },
      { id: "b", text: "runtime" },
    ])).resolves.toEqual({ documentCount: 2 });
    await expect(client.search("brass", 10)).resolves.toEqual({ hits: [{ id: "a", score: 2 }] });

    expect(client.negotiatedHandshake).toMatchObject({ protocolVersion: 1, readOnly: true });
    expect(boundaryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "ts-ipc", operation: "search", result: "success" }),
      expect.objectContaining({ boundary: "ipc-rust", operation: "search", result: "success" }),
    ]));
    expect(JSON.stringify(boundaryEvents)).not.toMatch(/brass brass|workspace-1/);
    await client.shutdown();
  });

  it("propagates abort, sends idempotent cancel, and observes a terminal cancellation", async () => {
    const transport = new FakeNativeTransport();
    const events: unknown[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace",
      clientBuild: "test",
      transportFactory: () => transport,
      nonce: nonceSequence(),
      onEvent: (event) => events.push(event),
    });
    const controller = new AbortController();
    const pending = client.search("hold", 10, { signal: controller.signal, timeoutMs: 5_000 });
    await new Promise((resolveReady) => setTimeout(resolveReady, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "native.terminal",
      outcome: "cancelled",
      errorCode: "CANCELLED",
    }));
    const cancelRequests = transport.requests.filter((request) => request.method === "cancel");
    expect(cancelRequests).toHaveLength(1);
    await client.shutdown();
  });

  it("bounds pending work, preserves terminals, and drains timed-out requests", async () => {
    const transport = new FakeNativeTransport();
    const terminalEvents: unknown[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace",
      clientBuild: "test",
      transportFactory: () => transport,
      nonce: nonceSequence(),
      onEvent: (event) => {
        if (event.type === "native.terminal") terminalEvents.push(event);
      },
    });
    await client.connect();
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const held = controllers.map((controller) =>
      client.search("hold", 10, { signal: controller.signal, timeoutMs: 5_000 }));
    await new Promise((resolveReady) => setTimeout(resolveReady, 0));
    await expect(client.search("hold", 10, { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    for (const controller of controllers) controller.abort();
    const outcomes = await Promise.allSettled(held);
    expect(outcomes.every((outcome) => outcome.status === "rejected"
      && (outcome.reason as { code?: string }).code === "CANCELLED")).toBe(true);
    expect(terminalEvents.filter((event) =>
      (event as { outcome?: string }).outcome === "cancelled")).toHaveLength(16);
    await expect(client.health()).resolves.toMatchObject({ activeRequests: 0 });

    const timedOut = client.search("hold", 10, { timeoutMs: 1 });
    await expect(timedOut).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    await new Promise((resolveCancel) => setTimeout(resolveCancel, 0));
    await expect(client.health()).resolves.toMatchObject({ activeRequests: 0 });
    await client.shutdown();
  });

  it("exposes a bounded progress stream that coalesces before dropping terminals", async () => {
    const transport = new FakeNativeTransport();
    const client = new NativeServiceClient({
      workspaceId: "workspace",
      clientBuild: "test",
      transportFactory: () => transport,
      nonce: nonceSequence(),
      eventBufferCapacity: 16,
    });
    await client.connect();
    for (let completed = 0; completed < 20; completed += 1) {
      transport.emitNativeEvent({
        version: 1,
        type: "native.progress",
        requestId: "request:coalesced",
        phase: "indexing",
        completed,
        total: 20,
      });
    }
    transport.emitNativeEvent({
      version: 1,
      type: "native.terminal",
      requestId: "request:coalesced",
      outcome: "success",
    });

    expect(client.eventStream.stats()).toMatchObject({
      capacity: 16,
      size: 2,
      offered: 21,
      coalescedProgress: 19,
      droppedTerminal: 0,
    });
    await expect(client.eventStream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "native.progress", completed: 19 },
    });
    await expect(client.eventStream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "native.terminal", outcome: "success" },
    });
    await client.shutdown();
    await expect(client.eventStream.next()).resolves.toMatchObject({ done: true });
  });

  it("restarts after exit, rehydrates the index, and keeps trust in TypeScript", async () => {
    const transports: FakeNativeTransport[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace",
      clientBuild: "test",
      transportFactory: () => {
        const transport = new FakeNativeTransport();
        transports.push(transport);
        return transport;
      },
      nonce: nonceSequence(),
    });
    const pilot = new NativeSearchPilot({
      client,
      mode: "native",
      restartBackoffMs: 0,
      isWorkspaceTrusted: () => true,
    });
    await pilot.replaceIndex([{ id: "a", text: "native restart" }]);
    transports[0].crash();

    await expect(pilot.search("restart")).resolves.toMatchObject({
      engine: "rust-native",
      fallbackUsed: false,
      value: { hits: [{ id: "a", score: 1 }] },
    });
    expect(transports).toHaveLength(2);
    expect(transports[1].requests.filter((request) => request.method === "index.replace")).toHaveLength(1);
    await pilot.shutdown();

    const untrustedTransport = new FakeNativeTransport();
    const untrusted = new NativeSearchPilot({
      mode: "auto",
      client: new NativeServiceClient({
        workspaceId: "workspace",
        clientBuild: "test",
        transportFactory: () => untrustedTransport,
        nonce: nonceSequence(),
      }),
      isWorkspaceTrusted: () => false,
    });
    await expect(untrusted.replaceIndex([{ id: "a", text: "secret" }]))
      .rejects.toMatchObject({ code: "WORKSPACE_UNTRUSTED" });
    expect(untrustedTransport.requests).toHaveLength(0);
  });

  it("uses the deterministic TypeScript fallback only in explicit auto mode", async () => {
    const fallbackEvents: unknown[] = [];
    const client = new NativeServiceClient({
      workspaceId: "workspace",
      clientBuild: "test",
      transportFactory: () => {
        throw new Error("service unavailable at /sensitive/path");
      },
      nonce: nonceSequence(),
    });
    const pilot = new NativeSearchPilot({
      client,
      mode: "auto",
      restartBackoffMs: 0,
      isWorkspaceTrusted: () => true,
      diagnostics: { sink: { emit: (event) => fallbackEvents.push(event) } },
    });

    await expect(pilot.replaceIndex([{ id: "a", text: "fallback fallback" }]))
      .resolves.toMatchObject({ engine: "ts", fallbackUsed: true, value: { documentCount: 1 } });
    await expect(pilot.search("fallback"))
      .resolves.toMatchObject({ engine: "ts", fallbackUsed: true, value: { hits: [{ id: "a", score: 2 }] } });
    expect(fallbackEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "ts-ipc", result: "fallback" }),
    ]));
    expect(JSON.stringify(fallbackEvents)).not.toContain("sensitive/path");
  });

  it("rejects malformed and future protocol messages", () => {
    expect(() => parseNativeServiceMessage("not-json")).toThrow(/invalid JSON/i);
    expect(() => parseNativeServiceMessage(JSON.stringify({ protocolVersion: 2, type: "response" })))
      .toThrow(/version mismatch/i);
    expect(() => parseNativeServiceMessage(JSON.stringify({
      protocolVersion: 1,
      type: "event",
      event: {
        version: 1,
        type: "runtime.boundary",
        boundary: "ipc-rust",
        operation: "search",
        at: 1,
        durationMs: 1,
        requestBytes: 1,
        responseBytes: 1,
        result: "success",
        path: "/sensitive/workspace",
      },
    }))).toThrow(/invalid message envelope/i);
    expect(() => parseNativeServiceMessage(JSON.stringify({
      protocolVersion: 1,
      type: "event",
      event: {
        version: 1,
        type: "native.progress",
        requestId: "request",
        phase: "searching",
        completed: 2,
        total: 1,
      },
    }))).toThrow(/invalid message envelope/i);
    expect(() => new NativeServiceClient({
      workspaceId: "",
      clientBuild: "test",
      transportFactory: () => new FakeNativeTransport(),
    })).toThrow(NativeServiceError);
  });
});

function nonceSequence(): () => string {
  let id = 0;
  return () => `nonce-${++id}`;
}
