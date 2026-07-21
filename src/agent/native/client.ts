import {
  emitRuntimeBoundaryEvent,
  type RuntimeBoundaryResult,
} from "../../core/runtime/boundaryDiagnostics";
import {
  isRuntimeBoundaryEvent,
  NATIVE_SERVICE_MAX_MESSAGE_BYTES,
  NATIVE_SERVICE_MAX_CONTROL_REQUESTS,
  NATIVE_SERVICE_MAX_PENDING_REQUESTS,
  NATIVE_SERVICE_PROTOCOL_VERSION,
  NativeServiceError,
  NativeServiceTransportError,
  parseNativeServiceMessage,
  type NativeIndexDocument,
  type NativeSearchHit,
  type NativeServiceClientOptions,
  type NativeServiceEvent,
  type NativeServiceMethod,
  type NativeServiceRequest,
  type NativeServiceResponse,
  type NativeServiceTransport,
} from "./protocol";
import { NativeServiceEventStream } from "./eventStream";

type PendingRequest = {
  readonly method: NativeServiceMethod;
  readonly startedAt: number;
  readonly requestBytes: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort?: () => void;
};

export type NativeRequestOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly priority?: number;
};

export type NativeServiceHandshake = {
  readonly protocolVersion: 1;
  readonly serviceBuild: string;
  readonly capabilities: readonly string[];
  readonly maxMessageBytes: number;
  readonly maxDocuments: number;
  readonly maxActiveRequests: number;
  readonly readOnly: true;
};

export class NativeServiceClient {
  readonly eventStream: NativeServiceEventStream;
  private transport?: NativeServiceTransport;
  private connecting?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly now: () => number;
  private readonly sessionId: string;
  private readonly nonce: string;
  private nextRequestId = 1;
  private negotiatedMaxMessageBytes: number;
  private removeFrame?: () => void;
  private removeExit?: () => void;
  private closed = false;
  private epoch = 0;
  private handshake?: NativeServiceHandshake;

  constructor(private readonly options: NativeServiceClientOptions) {
    this.eventStream = new NativeServiceEventStream(options.eventBufferCapacity ?? 128);
    if (!options.workspaceId.trim() || options.workspaceId.length > 128) {
      throw new NativeServiceError("INVALID_CONFIG", "native service workspaceId is empty or too large");
    }
    if (!options.clientBuild.trim() || options.clientBuild.length > 128) {
      throw new NativeServiceError("INVALID_CONFIG", "native service clientBuild is empty or too large");
    }
    this.now = options.now ?? Date.now;
    const makeNonce = options.nonce ?? defaultNonce;
    this.sessionId = makeNonce();
    this.nonce = makeNonce();
    if (!this.sessionId || !this.nonce) {
      throw new NativeServiceError("INVALID_CONFIG", "native service nonce generator returned an empty value");
    }
    this.negotiatedMaxMessageBytes = Math.min(
      options.maxMessageBytes ?? NATIVE_SERVICE_MAX_MESSAGE_BYTES,
      NATIVE_SERVICE_MAX_MESSAGE_BYTES,
    );
  }

  get connectionEpoch(): number {
    return this.epoch;
  }

  get negotiatedHandshake(): NativeServiceHandshake | undefined {
    return this.handshake;
  }

  async connect(): Promise<NativeServiceHandshake> {
    if (this.closed) throw new NativeServiceTransportError("CLIENT_CLOSED", "native service client is closed");
    if (this.transport && this.handshake) return this.handshake;
    if (!this.connecting) {
      this.connecting = this.openTransport().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
    if (!this.handshake) throw new NativeServiceTransportError("HANDSHAKE_FAILED", "native service handshake failed");
    return this.handshake;
  }

  async health(options: NativeRequestOptions = {}): Promise<{ readonly ok: true; readonly activeRequests: number; readonly readOnly: true }> {
    return this.request("health", {}, options);
  }

  async replaceIndex(
    documents: readonly NativeIndexDocument[],
    options: NativeRequestOptions = {},
  ): Promise<{ readonly documentCount: number }> {
    return this.request("index.replace", { documents }, options);
  }

  async search(
    query: string,
    limit = 20,
    options: NativeRequestOptions = {},
  ): Promise<{ readonly hits: readonly NativeSearchHit[] }> {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.floor(limit)))
      : 20;
    return this.request("search", { query, limit: normalizedLimit }, options);
  }

  async cancel(targetRequestId: string): Promise<boolean> {
    const result = await this.request<{ readonly accepted: boolean }>(
      "cancel",
      { targetRequestId },
      { timeoutMs: 1_000, priority: 1_000 },
    );
    return result.accepted;
  }

  async shutdown(): Promise<void> {
    if (!this.transport) {
      this.closed = true;
      this.eventStream.close();
      return;
    }
    try {
      await this.request("shutdown", {}, { timeoutMs: 2_000, priority: 1_000 });
    } finally {
      this.closed = true;
      this.eventStream.close();
      const transport = this.transport;
      this.detachTransport();
      await transport?.close();
      this.rejectAll(new NativeServiceTransportError("CLIENT_CLOSED", "native service client shut down"));
    }
  }

  async request<T>(
    method: NativeServiceMethod,
    params: unknown,
    options: NativeRequestOptions = {},
  ): Promise<T> {
    await this.connect();
    return this.requestOnTransport<T>(method, params, options);
  }

  private async openTransport(): Promise<void> {
    let transport: NativeServiceTransport;
    try {
      transport = await this.options.transportFactory();
    } catch {
      throw new NativeServiceTransportError("START_FAILED", "native service failed to start");
    }
    this.transport = transport;
    this.removeFrame = transport.onFrame((frame) => this.handleFrame(frame));
    this.removeExit = transport.onExit((info) => {
      const code = info.signal ? "PROCESS_SIGNAL" : "PROCESS_EXIT";
      this.failTransport(new NativeServiceTransportError(
        code,
        `native service exited (${info.code ?? "none"}/${info.signal ?? "none"})`,
      ));
    });
    try {
      const handshake = await this.requestOnTransport<NativeServiceHandshake>(
        "hello",
        {
          clientBuild: this.options.clientBuild,
          maxMessageBytes: this.negotiatedMaxMessageBytes,
        },
        { timeoutMs: this.options.defaultTimeoutMs ?? 5_000, priority: 1_000 },
      );
      if (
        handshake.protocolVersion !== NATIVE_SERVICE_PROTOCOL_VERSION
        || handshake.readOnly !== true
        || !Array.isArray(handshake.capabilities)
        || !handshake.capabilities.includes("search")
        || !handshake.capabilities.includes("cancel")
      ) {
        throw new NativeServiceTransportError("HANDSHAKE_FAILED", "native service handshake lacks required capabilities");
      }
      this.negotiatedMaxMessageBytes = Math.min(
        this.negotiatedMaxMessageBytes,
        handshake.maxMessageBytes,
      );
      this.handshake = Object.freeze({ ...handshake });
      this.epoch += 1;
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new NativeServiceTransportError("HANDSHAKE_FAILED", "native service handshake failed");
      this.failTransport(failure);
      await transport.close();
      throw failure;
    }
  }

  private requestOnTransport<T>(
    method: NativeServiceMethod,
    params: unknown,
    options: NativeRequestOptions,
  ): Promise<T> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new NativeServiceTransportError("NOT_CONNECTED", "native service is not connected"));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const isControl = method === "cancel" || method === "shutdown";
    const pendingLimit = NATIVE_SERVICE_MAX_PENDING_REQUESTS
      + (isControl ? NATIVE_SERVICE_MAX_CONTROL_REQUESTS : 0);
    if (this.pending.size >= pendingLimit) {
      return Promise.reject(new NativeServiceError("RESOURCE_LIMIT", "native service pending-request limit reached"));
    }
    const requestId = `${this.sessionId}:${this.nextRequestId++}`;
    const timeoutMs = clampTimeout(options.timeoutMs ?? this.options.defaultTimeoutMs ?? 10_000);
    const request: NativeServiceRequest = {
      protocolVersion: NATIVE_SERVICE_PROTOCOL_VERSION,
      id: requestId,
      sessionId: this.sessionId,
      workspaceId: method === "hello" ? "" : this.options.workspaceId,
      nonce: this.nonce,
      deadlineMs: this.now() + timeoutMs,
      priority: clampPriority(options.priority ?? 0),
      method,
      params,
    };
    const frame = JSON.stringify(request);
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    if (frameBytes > this.negotiatedMaxMessageBytes) {
      return Promise.reject(new NativeServiceError("MESSAGE_TOO_LARGE", "native service request exceeds negotiated limit", requestId));
    }

    return new Promise<T>((resolve, reject) => {
      let removeAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.removeAbort?.();
        pending.reject(new NativeServiceError("DEADLINE_EXCEEDED", "native service request deadline exceeded", requestId));
        this.emitTsBoundary(pending, "error", 0, "DEADLINE_EXCEEDED", requestId);
        if (method !== "cancel" && method !== "shutdown") void this.cancel(requestId).catch(() => undefined);
      }, timeoutMs);

      if (options.signal) {
        const onAbort = () => {
          if (this.pending.has(requestId) && method !== "cancel" && method !== "shutdown") {
            void this.cancel(requestId).catch(() => undefined);
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.pending.set(requestId, {
        method,
        startedAt: this.now(),
        requestBytes: frameBytes,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        removeAbort,
      });
      Promise.resolve(transport.send(frame)).catch((error) => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        const transportError = new NativeServiceTransportError(
          "SEND_FAILED",
          error instanceof Error ? error.message : "native service send failed",
          requestId,
        );
        pending.reject(transportError);
        this.emitTsBoundary(pending, "error", 0, transportError.code, requestId);
      });
    });
  }

  private handleFrame(frame: string): void {
    let message;
    try {
      message = parseNativeServiceMessage(frame);
    } catch (error) {
      this.failTransport(error instanceof Error
        ? error
        : new NativeServiceTransportError("INVALID_MESSAGE", "native service message failed validation"));
      return;
    }
    if (message.type === "event") {
      const event = message.event;
      this.eventStream.push(event);
      if (isRuntimeBoundaryEvent(event)) {
        emitRuntimeBoundaryEvent(this.options.diagnostics?.sink, event);
      }
      try {
        this.options.onEvent?.(Object.freeze({ ...event }));
      } catch {
        // Event observers cannot affect protocol progress.
      }
      return;
    }
    this.handleResponse(message, new TextEncoder().encode(frame).byteLength);
  }

  private handleResponse(response: NativeServiceResponse, responseBytes: number): void {
    if (response.sessionId !== this.sessionId) {
      this.failTransport(new NativeServiceTransportError("AUTH_FAILED", "native service response session mismatch"));
      return;
    }
    const pending = this.takePending(response.id);
    if (!pending) return;
    if (response.error) {
      const error = new NativeServiceError(response.error.code, response.error.message, response.id);
      pending.reject(error);
      this.emitTsBoundary(
        pending,
        response.error.code === "CANCELLED" ? "cancelled" : "error",
        responseBytes,
        response.error.code,
        response.id,
      );
      return;
    }
    pending.resolve(response.result);
    this.emitTsBoundary(pending, "success", responseBytes, undefined, response.id);
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    return pending;
  }

  private emitTsBoundary(
    pending: PendingRequest,
    result: RuntimeBoundaryResult,
    responseBytes: number,
    errorCode: string | undefined,
    correlationId: string,
  ): void {
    const endedAt = this.now();
    emitRuntimeBoundaryEvent(this.options.diagnostics?.sink, {
      version: 1,
      type: "runtime.boundary",
      boundary: "ts-ipc",
      operation: pending.method,
      at: pending.startedAt,
      durationMs: Math.max(0, endedAt - pending.startedAt),
      requestBytes: pending.requestBytes,
      responseBytes,
      result,
      correlationId,
      queueDepth: this.pending.size,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private failTransport(error: Error): void {
    const wrapped = error instanceof NativeServiceError
      ? error
      : new NativeServiceTransportError("TRANSPORT_FAILED", error.message);
    const transport = this.transport;
    this.rejectAll(wrapped);
    this.detachTransport();
    if (transport) void Promise.resolve(transport.close()).catch(() => undefined);
  }

  private rejectAll(error: NativeServiceError): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(new NativeServiceTransportError(error.code, error.message, requestId));
      this.emitTsBoundary(pending, "error", 0, error.code, requestId);
    }
    this.pending.clear();
  }

  private detachTransport(): void {
    this.removeFrame?.();
    this.removeExit?.();
    this.removeFrame = undefined;
    this.removeExit = undefined;
    this.transport = undefined;
    this.handshake = undefined;
  }
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 10_000;
  return Math.max(1, Math.min(300_000, Math.floor(value)));
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1_000, Math.min(1_000, Math.floor(value)));
}

function defaultNonce(): string {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) {
    throw new NativeServiceError(
      "INVALID_CONFIG",
      "native service requires Web Crypto to generate secure nonces",
    );
  }
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortError(): DOMException {
  return new DOMException("Native service request aborted", "AbortError");
}
