import type {
  RuntimeBoundaryDiagnosticsOptions,
  RuntimeBoundaryEvent,
} from "../../core/runtime/boundaryDiagnostics";

export const NATIVE_SERVICE_PROTOCOL_VERSION = 1 as const;
export const NATIVE_SERVICE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const NATIVE_SERVICE_MAX_PENDING_REQUESTS = 16;
export const NATIVE_SERVICE_MAX_CONTROL_REQUESTS = 16;

export type NativeServiceMethod =
  | "hello"
  | "health"
  | "index.replace"
  | "search"
  | "cancel"
  | "shutdown";

export type NativeIndexDocument = {
  readonly id: string;
  readonly text: string;
};

export type NativeSearchHit = {
  readonly id: string;
  readonly score: number;
};

export type NativeServiceRequest = {
  readonly protocolVersion: typeof NATIVE_SERVICE_PROTOCOL_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly nonce: string;
  readonly deadlineMs: number;
  readonly priority: number;
  readonly method: NativeServiceMethod;
  readonly params: unknown;
};

export type NativeServiceErrorPayload = {
  readonly code: string;
  readonly message: string;
};

export type NativeServiceResponse = {
  readonly protocolVersion: typeof NATIVE_SERVICE_PROTOCOL_VERSION;
  readonly type: "response";
  readonly id: string;
  readonly sessionId: string;
  readonly result?: unknown;
  readonly error?: NativeServiceErrorPayload;
};

export type NativeProgressEvent = {
  readonly version: 1;
  readonly type: "native.progress";
  readonly requestId: string;
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
};

export type NativeTerminalEvent = {
  readonly version: 1;
  readonly type: "native.terminal";
  readonly requestId: string;
  readonly outcome: "success" | "error" | "cancelled";
  readonly errorCode?: string;
};

export type NativeServiceEvent = RuntimeBoundaryEvent | NativeProgressEvent | NativeTerminalEvent;

export type NativeServiceEventEnvelope = {
  readonly protocolVersion: typeof NATIVE_SERVICE_PROTOCOL_VERSION;
  readonly type: "event";
  readonly event: NativeServiceEvent;
};

export type NativeServiceMessage = NativeServiceResponse | NativeServiceEventEnvelope;

export type NativeServiceTransport = {
  readonly processId?: number;
  readonly send: (frame: string) => Promise<void> | void;
  readonly onFrame: (listener: (frame: string) => void) => () => void;
  readonly onExit: (listener: (info: { readonly code: number | null; readonly signal: string | null }) => void) => () => void;
  readonly close: () => Promise<void> | void;
};

export type NativeServiceTransportFactory = () => Promise<NativeServiceTransport> | NativeServiceTransport;

export type NativeServiceClientOptions = {
  readonly workspaceId: string;
  readonly clientBuild: string;
  readonly transportFactory: NativeServiceTransportFactory;
  readonly nonce?: () => string;
  readonly now?: () => number;
  readonly defaultTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly eventBufferCapacity?: number;
  readonly diagnostics?: RuntimeBoundaryDiagnosticsOptions;
  readonly onEvent?: (event: NativeServiceEvent) => void;
};

export class NativeServiceError extends Error {
  readonly _tag: "NativeServiceError" | "NativeServiceTransportError" = "NativeServiceError";

  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "NativeServiceError";
  }
}

export class NativeServiceTransportError extends NativeServiceError {
  readonly _tag = "NativeServiceTransportError" as const;

  constructor(code: string, message: string, requestId?: string) {
    super(code, message, requestId);
    this.name = "NativeServiceTransportError";
  }
}

export function parseNativeServiceMessage(frame: string): NativeServiceMessage {
  if (utf8Bytes(frame) > NATIVE_SERVICE_MAX_MESSAGE_BYTES) {
    throw new NativeServiceTransportError("MESSAGE_TOO_LARGE", "native service message exceeds the client limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new NativeServiceTransportError("INVALID_JSON", "native service returned invalid JSON");
  }
  if (!isRecord(value) || value.protocolVersion !== NATIVE_SERVICE_PROTOCOL_VERSION) {
    throw new NativeServiceTransportError("UNSUPPORTED_PROTOCOL", "native service protocol version mismatch");
  }
  if (isNativeServiceResponse(value)) {
    return value as NativeServiceResponse;
  }
  if (
    value.type === "event"
    && hasOnlyKeys(value, ["protocolVersion", "type", "event"])
    && isNativeServiceEvent(value.event)
  ) {
    return value as NativeServiceEventEnvelope;
  }
  throw new NativeServiceTransportError("INVALID_MESSAGE", "native service returned an invalid message envelope");
}

export function parseNativeServiceRequest(frame: string): NativeServiceRequest {
  if (utf8Bytes(frame) > NATIVE_SERVICE_MAX_MESSAGE_BYTES) {
    throw new NativeServiceTransportError("MESSAGE_TOO_LARGE", "native service request exceeds the protocol limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new NativeServiceTransportError("INVALID_JSON", "native service request contains invalid JSON");
  }
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      "protocolVersion", "id", "sessionId", "workspaceId", "nonce", "deadlineMs",
      "priority", "method", "params",
    ])
    || value.protocolVersion !== NATIVE_SERVICE_PROTOCOL_VERSION
    || !isBoundedString(value.id, 128)
    || !isBoundedString(value.sessionId, 128)
    || typeof value.workspaceId !== "string"
    || utf8Bytes(value.workspaceId) > 128
    || !isBoundedString(value.nonce, 256)
    || !isNonNegativeInteger(value.deadlineMs)
    || typeof value.priority !== "number"
    || !Number.isSafeInteger(value.priority)
    || value.priority < -1_000
    || value.priority > 1_000
    || !isNativeMethod(value.method)
    || (value.method !== "hello" && value.workspaceId.length === 0)
    || !isMethodParams(value.method, value.params)
  ) {
    throw new NativeServiceTransportError("INVALID_REQUEST", "native service request does not match protocol v1");
  }
  return value as NativeServiceRequest;
}

function isNativeMethod(value: unknown): value is NativeServiceMethod {
  return value === "hello" || value === "health" || value === "index.replace"
    || value === "search" || value === "cancel" || value === "shutdown";
}

function isMethodParams(method: NativeServiceMethod, params: unknown): boolean {
  if (!isRecord(params)) return false;
  switch (method) {
    case "hello":
      return hasOnlyKeys(params, ["clientBuild", "maxMessageBytes"])
        && isBoundedString(params.clientBuild, 128)
        && isNonNegativeInteger(params.maxMessageBytes)
        && params.maxMessageBytes > 0;
    case "health":
    case "shutdown":
      return hasOnlyKeys(params, []);
    case "cancel":
      return hasOnlyKeys(params, ["targetRequestId"])
        && isBoundedString(params.targetRequestId, 128);
    case "search":
      return hasOnlyKeys(params, ["query", "limit"])
        && isBoundedString(params.query, 4_096)
        && isNonNegativeInteger(params.limit)
        && params.limit > 0
        && params.limit <= 100;
    case "index.replace":
      return isIndexParams(params);
  }
}

function isIndexParams(params: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(params, ["documents"]) || !Array.isArray(params.documents)
    || params.documents.length > 4_096) return false;
  let totalBytes = 0;
  for (const document of params.documents) {
    if (!isRecord(document)
      || !hasOnlyKeys(document, ["id", "text"])
      || !isBoundedString(document.id, 512)
      || typeof document.text !== "string") return false;
    const bytes = utf8Bytes(document.text);
    if (bytes > 256 * 1_024) return false;
    totalBytes += bytes;
    if (totalBytes > 8 * 1_024 * 1_024) return false;
  }
  return true;
}

function isNativeServiceResponse(value: Record<string, unknown>): boolean {
  if (
    value.type !== "response"
    || !hasOnlyKeys(value, ["protocolVersion", "type", "id", "sessionId", "result", "error"])
    || !isBoundedString(value.id, 128)
    || typeof value.sessionId !== "string"
  ) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) return false;
  return !hasError || (
    isRecord(value.error)
    && hasOnlyKeys(value.error, ["code", "message"])
    && isBoundedString(value.error.code, 128)
    && isBoundedString(value.error.message, 1_024)
  );
}

function isNativeServiceEvent(value: unknown): value is NativeServiceEvent {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return false;
  switch (value.type) {
    case "runtime.boundary":
      return hasOnlyKeys(value, [
        "version", "type", "boundary", "operation", "at", "durationMs",
        "requestBytes", "responseBytes", "result", "correlationId", "subjectId",
        "queueDepth", "allocations", "liveFibers", "errorCode",
      ])
        && (value.boundary === "ts-wasm" || value.boundary === "ts-ipc" || value.boundary === "ipc-rust")
        && isBoundedString(value.operation, 128)
        && isNonNegativeNumber(value.at)
        && isNonNegativeNumber(value.durationMs)
        && isNonNegativeInteger(value.requestBytes)
        && isNonNegativeInteger(value.responseBytes)
        && (value.result === "success" || value.result === "error" || value.result === "cancelled" || value.result === "fallback")
        && isOptionalBoundedString(value.correlationId, 128)
        && (value.subjectId === undefined || isNonNegativeInteger(value.subjectId))
        && (value.queueDepth === undefined || isNonNegativeInteger(value.queueDepth))
        && (value.allocations === undefined || isNonNegativeInteger(value.allocations))
        && (value.liveFibers === undefined || isNonNegativeInteger(value.liveFibers))
        && isOptionalBoundedString(value.errorCode, 128);
    case "native.progress":
      return hasOnlyKeys(value, ["version", "type", "requestId", "phase", "completed", "total"])
        && isBoundedString(value.requestId, 128)
        && isBoundedString(value.phase, 64)
        && isNonNegativeInteger(value.completed)
        && isNonNegativeInteger(value.total)
        && value.completed <= value.total;
    case "native.terminal":
      return hasOnlyKeys(value, ["version", "type", "requestId", "outcome", "errorCode"])
        && isBoundedString(value.requestId, 128)
        && (value.outcome === "success" || value.outcome === "error" || value.outcome === "cancelled")
        && isOptionalBoundedString(value.errorCode, 128);
    default:
      return false;
  }
}

export function isRuntimeBoundaryEvent(event: NativeServiceEvent): event is RuntimeBoundaryEvent {
  return event.type === "runtime.boundary";
}

export function isNativeTerminalEvent(event: NativeServiceEvent): event is NativeTerminalEvent {
  return event.type === "native.terminal";
}

export function serviceErrorCode(error: unknown): string {
  if (error instanceof NativeServiceError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "CANCELLED";
  return "NATIVE_SERVICE_FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= maximum;
}

function isOptionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || isBoundedString(value, maximum);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isSafeInteger(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
