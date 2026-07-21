import {
  emitRuntimeBoundaryEvent,
  type RuntimeBoundaryDiagnosticsOptions,
} from "../../core/runtime/boundaryDiagnostics";
import { NativeServiceClient, type NativeRequestOptions } from "./client";
import {
  NativeServiceError,
  NativeServiceTransportError,
  serviceErrorCode,
  type NativeIndexDocument,
  type NativeSearchHit,
} from "./protocol";

const MAX_DOCUMENTS = 4_096;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_BYTES = 4_096;
const MAX_RESULTS = 100;

export type NativeSearchPilotMode = "native" | "auto" | "ts";

export type NativeSearchPilotOptions = {
  readonly mode?: NativeSearchPilotMode;
  readonly client: NativeServiceClient;
  readonly isWorkspaceTrusted: () => boolean | Promise<boolean>;
  readonly diagnostics?: RuntimeBoundaryDiagnosticsOptions;
  readonly restartBackoffMs?: number;
};

export type NativePilotResult<T> = {
  readonly engine: "rust-native" | "ts";
  readonly fallbackUsed: boolean;
  readonly value: T;
};

export class NativeSearchPilot {
  private readonly fallback = new TypeScriptSearchIndex();
  private readonly mode: NativeSearchPilotMode;
  private documents: readonly NativeIndexDocument[] = [];
  private indexedEpoch = 0;

  constructor(private readonly options: NativeSearchPilotOptions) {
    this.mode = options.mode ?? "auto";
  }

  async replaceIndex(
    documents: readonly NativeIndexDocument[],
    request: NativeRequestOptions = {},
  ): Promise<NativePilotResult<{ readonly documentCount: number }>> {
    await this.requireTrust();
    const copied = documents.map((document) => Object.freeze({ ...document }));
    const fallbackValue = this.fallback.replace(copied, request.signal);
    this.documents = Object.freeze(copied);
    if (this.mode === "ts") {
      return { engine: "ts", fallbackUsed: false, value: fallbackValue };
    }
    const startedAt = Date.now();
    try {
      const value = await this.withRestart(() => this.options.client.replaceIndex(copied, request), request.signal);
      this.indexedEpoch = this.options.client.connectionEpoch;
      return { engine: "rust-native", fallbackUsed: false, value };
    } catch (error) {
      return this.fallbackOrThrow("index.replace", startedAt, error, fallbackValue);
    }
  }

  async search(
    query: string,
    limit = 20,
    request: NativeRequestOptions = {},
  ): Promise<NativePilotResult<{ readonly hits: readonly NativeSearchHit[] }>> {
    await this.requireTrust();
    if (this.mode === "ts") {
      return {
        engine: "ts",
        fallbackUsed: false,
        value: { hits: this.fallback.search(query, limit, request.signal) },
      };
    }
    const startedAt = Date.now();
    try {
      const value = await this.withRestart(async () => {
        await this.options.client.health(request);
        if (this.indexedEpoch !== this.options.client.connectionEpoch) {
          await this.options.client.replaceIndex(this.documents, request);
          this.indexedEpoch = this.options.client.connectionEpoch;
        }
        return this.options.client.search(query, limit, request);
      }, request.signal);
      return { engine: "rust-native", fallbackUsed: false, value };
    } catch (error) {
      return this.fallbackOrThrow(
        "search",
        startedAt,
        error,
        { hits: this.fallback.search(query, limit, request.signal) },
      );
    }
  }

  shutdown(): Promise<void> {
    return this.options.client.shutdown();
  }

  private async withRestart<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof NativeServiceTransportError) || signal?.aborted) throw error;
      const backoff = Math.max(0, Math.min(1_000, this.options.restartBackoffMs ?? 25));
      if (backoff > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, backoff));
      return operation();
    }
  }

  private fallbackOrThrow<T>(
    operation: string,
    startedAt: number,
    error: unknown,
    value: T,
  ): NativePilotResult<T> {
    if (isCancellation(error)) throw error;
    if (this.mode === "native") throw error;
    emitRuntimeBoundaryEvent(this.options.diagnostics?.sink, {
      version: 1,
      type: "runtime.boundary",
      boundary: "ts-ipc",
      operation,
      at: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      requestBytes: 0,
      responseBytes: 0,
      result: "fallback",
      errorCode: serviceErrorCode(error),
    });
    return { engine: "ts", fallbackUsed: true, value };
  }

  private async requireTrust(): Promise<void> {
    if (await this.options.isWorkspaceTrusted()) return;
    throw new NativeServiceError(
      "WORKSPACE_UNTRUSTED",
      "native indexing/search requires a trusted workspace",
    );
  }
}

export class TypeScriptSearchIndex {
  private documents = new Map<string, string>();

  replace(
    documents: readonly NativeIndexDocument[],
    signal?: AbortSignal,
  ): { readonly documentCount: number } {
    if (documents.length > MAX_DOCUMENTS) {
      throw new NativeServiceError("RESOURCE_LIMIT", "document count exceeds fallback limit");
    }
    const next = new Map<string, string>();
    let totalBytes = 0;
    for (const document of documents) {
      throwIfAborted(signal);
      if (!document.id || utf8Bytes(document.id) > 512) {
        throw new NativeServiceError("INVALID_INPUT", "document id is empty or too large");
      }
      if (utf8Bytes(document.text) > MAX_DOCUMENT_BYTES) {
        throw new NativeServiceError("RESOURCE_LIMIT", "document exceeds fallback byte limit");
      }
      const normalizedText = asciiLower(document.text);
      const normalizedBytes = utf8Bytes(normalizedText);
      if (normalizedBytes > MAX_DOCUMENT_BYTES) {
        throw new NativeServiceError("RESOURCE_LIMIT", "normalized document exceeds fallback byte limit");
      }
      totalBytes += normalizedBytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new NativeServiceError("RESOURCE_LIMIT", "workspace documents exceed fallback byte limit");
      }
      next.set(document.id, normalizedText);
    }
    this.documents = next;
    return Object.freeze({ documentCount: next.size });
  }

  search(query: string, limit = 20, signal?: AbortSignal): readonly NativeSearchHit[] {
    if (!query || utf8Bytes(query) > MAX_QUERY_BYTES) {
      throw new NativeServiceError("INVALID_INPUT", "query is empty or too large");
    }
    const terms = asciiLower(query).trim().split(/[\t\n\v\f\r ]+/u).filter(Boolean).slice(0, 64);
    if (terms.length === 0) throw new NativeServiceError("INVALID_INPUT", "query has no terms");
    const hits: NativeSearchHit[] = [];
    for (const [id, text] of this.documents) {
      throwIfAborted(signal);
      let score = 0;
      for (const term of terms) score += occurrences(text, term);
      if (score > 0) hits.push(Object.freeze({ id, score }));
    }
    hits.sort((left, right) => right.score - left.score || compareUtf8(left.id, right.id));
    return Object.freeze(hits.slice(0, normalizeSearchLimit(limit)));
  }
}

function normalizeSearchLimit(limit: number): number {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(limit)))
    : 20;
}

function occurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - term.length) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, term.length);
  }
  return count;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Native search pilot aborted", "AbortError");
}

function isCancellation(error: unknown): boolean {
  return (error instanceof NativeServiceError && error.code === "CANCELLED")
    || (error instanceof DOMException && error.name === "AbortError");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
