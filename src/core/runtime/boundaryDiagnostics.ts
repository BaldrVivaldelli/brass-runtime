export const RUNTIME_BOUNDARY_EVENT_VERSION = 1 as const;

export type RuntimeBoundary = "ts-wasm" | "ts-ipc" | "ipc-rust";
export type RuntimeBoundaryResult = "success" | "error" | "cancelled" | "fallback";

/**
 * Payload-free, versioned event shared by runtime, agent IPC, and native
 * service boundaries. Prompts, paths, source text, patches, and secrets are
 * deliberately not representable here.
 */
export type RuntimeBoundaryEvent = {
  readonly version: typeof RUNTIME_BOUNDARY_EVENT_VERSION;
  readonly type: "runtime.boundary";
  readonly boundary: RuntimeBoundary;
  readonly operation: string;
  readonly at: number;
  readonly durationMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly result: RuntimeBoundaryResult;
  readonly correlationId?: string;
  readonly subjectId?: number;
  readonly queueDepth?: number;
  /** Monotonic engine allocation units observed at this boundary. */
  readonly allocations?: number;
  /** Live portable-engine fibers observed at this boundary. */
  readonly liveFibers?: number;
  readonly errorCode?: string;
};

export type RuntimeBoundaryEventSink = {
  readonly emit: (event: RuntimeBoundaryEvent) => void;
};

export type RuntimeBoundaryDiagnosticsOptions = {
  readonly sink?: RuntimeBoundaryEventSink;
  readonly correlationId?: () => string | undefined;
  readonly now?: () => number;
};

export function emitRuntimeBoundaryEvent(
  sink: RuntimeBoundaryEventSink | undefined,
  event: RuntimeBoundaryEvent,
): void {
  if (!sink) return;
  try {
    sink.emit(Object.freeze({ ...event }));
  } catch {
    // Diagnostics must never alter runtime semantics.
  }
}
