import { describe, expect, it, vi } from "vitest";
import { emitRuntimeBoundaryEvent } from "../boundaryDiagnostics";

describe("runtime boundary diagnostics", () => {
  it("freezes payload-free events and isolates sink failures", () => {
    let received: unknown;
    emitRuntimeBoundaryEvent({ emit: (event) => { received = event; } }, {
      version: 1,
      type: "runtime.boundary",
      boundary: "ts-ipc",
      operation: "search",
      at: 1,
      durationMs: 2,
      requestBytes: 3,
      responseBytes: 4,
      result: "success",
    });
    expect(Object.isFrozen(received)).toBe(true);
    expect(received).not.toHaveProperty("prompt");
    expect(received).not.toHaveProperty("path");

    const failing = vi.fn(() => { throw new Error("sink failed"); });
    expect(() => emitRuntimeBoundaryEvent({ emit: failing }, received as any)).not.toThrow();
    expect(failing).toHaveBeenCalledOnce();
  });
});
