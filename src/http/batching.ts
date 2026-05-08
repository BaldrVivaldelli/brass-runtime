import type { Async } from "../core/types/asyncEffect";
import type { Exit } from "../core/types/effect";
import { Cause } from "../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "./client";

export type RequestBatchingEvent =
  | { type: "batch-enqueue"; key: string; size: number; request: HttpRequest }
  | { type: "batch-flush"; key: string; size: number; reason: "size" | "timer" | "manual" }
  | { type: "batch-cancel"; key: string; remaining: number }
  | { type: "batch-error"; key: string; size: number; error: HttpError };

export type RequestBatchingConfig = {
  /**
   * Groups requests into independent batches. Return undefined/null/empty string
   * to bypass batching for a request.
   *
   * Default: `${method}:${url}`.
   */
  key?: (req: HttpRequest) => string | undefined | null;
  /** Extra predicate for per-request opt-in/out. Default: batch all keyed requests. */
  shouldBatch?: (req: HttpRequest) => boolean;
  /** Maximum requests per batch. Default: 16. */
  maxBatchSize?: number;
  /** Maximum time to wait before flushing a non-full batch. Default: 5ms. */
  maxWaitMs?: number;
  /** Builds the actual wire request sent to the batch endpoint. */
  encode: (requests: readonly HttpRequest[]) => HttpRequest;
  /**
   * Splits the batch endpoint response back into one response per original
   * request. The returned array must have the same length and order.
   */
  decode: (response: HttpWireResponse, requests: readonly HttpRequest[]) => readonly HttpWireResponse[];
  /** Optional observability hook. Exceptions are swallowed. */
  onEvent?: (event: RequestBatchingEvent) => void;
};

type BatchEntry = {
  readonly req: HttpRequest;
  readonly env: unknown;
  readonly cb: (exit: Exit<HttpError, HttpWireResponse>) => void;
  cancelled: boolean;
  done: boolean;
  group?: ActiveBatch;
};

type PendingBatch = {
  readonly key: string;
  entries: BatchEntry[];
  timer?: ReturnType<typeof setTimeout>;
};

type ActiveBatch = {
  readonly key: string;
  readonly entries: BatchEntry[];
  cancel?: () => void;
  cancelled: boolean;
};

const DEFAULT_MAX_BATCH_SIZE = 16;
const DEFAULT_MAX_WAIT_MS = 5;

export function withRequestBatching(config: RequestBatchingConfig): HttpMiddleware {
  const maxBatchSize = Math.max(1, Math.floor(config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE));
  const maxWaitMs = Math.max(0, Math.floor(config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS));
  const keyOf = config.key ?? ((req: HttpRequest) => `${req.method}:${req.url}`);
  const pending = new Map<string, PendingBatch>();

  return (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
      let key: string | undefined;

      try {
        if (config.shouldBatch && !config.shouldBatch(req)) return next(req);
        key = keyOf(req) ?? undefined;
      } catch {
        return next(req);
      }

      if (!key) return next(req);

      return {
        _tag: "Async",
        register: (env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
          const entry: BatchEntry = { req, env, cb, cancelled: false, done: false };
          const batch = getOrCreatePending(key!);
          batch.entries.push(entry);
          emit(config, { type: "batch-enqueue", key: key!, size: batch.entries.length, request: req });

          if (batch.entries.length >= maxBatchSize) {
            flush(key!, next, "size");
          } else if (batch.timer === undefined) {
            batch.timer = setTimeout(() => flush(key!, next, "timer"), maxWaitMs);
          }

          return () => cancelEntry(key!, entry);
        },
      };
    };

    function getOrCreatePending(key: string): PendingBatch {
      const existing = pending.get(key);
      if (existing) return existing;
      const created: PendingBatch = { key, entries: [] };
      pending.set(key, created);
      return created;
    }

    function cancelEntry(key: string, entry: BatchEntry): void {
      if (entry.done || entry.cancelled) return;

      entry.cancelled = true;
      complete(entry, { _tag: "Failure", cause: Cause.interrupt() });

      const queued = pending.get(key);
      if (queued) {
        queued.entries = queued.entries.filter((e) => e !== entry);
        emit(config, { type: "batch-cancel", key, remaining: queued.entries.length });

        if (queued.entries.length === 0) {
          if (queued.timer !== undefined) clearTimeout(queued.timer);
          pending.delete(key);
        }
        return;
      }

      const group = entry.group;
      if (!group || group.cancelled) return;
      if (group.entries.every((e) => e.cancelled || e.done)) {
        group.cancelled = true;
        group.cancel?.();
      }
    }

    function flush(key: string, downstream: HttpClientFn, reason: "size" | "timer" | "manual"): void {
      const batch = pending.get(key);
      if (!batch) return;
      pending.delete(key);
      if (batch.timer !== undefined) clearTimeout(batch.timer);

      const entries = batch.entries.filter((entry) => !entry.cancelled && !entry.done);
      if (entries.length === 0) return;

      emit(config, { type: "batch-flush", key, size: entries.length, reason });

      let batchReq: HttpRequest;
      try {
        batchReq = config.encode(entries.map((entry) => entry.req));
      } catch (e) {
        failEntries(config, key, entries, toFetchError(e));
        return;
      }

      const group: ActiveBatch = { key, entries, cancelled: false };
      for (const entry of entries) entry.group = group;

      const effect = downstream(batchReq);
      group.cancel = runEffect(effect, entries[0]!.env, (exit) => {
        if (exit._tag === "Failure") {
          const err = exit.cause._tag === "Fail"
            ? exit.cause.error
            : exit.cause._tag === "Interrupt"
              ? ({ _tag: "Abort" } satisfies HttpError)
              : toFetchError((exit.cause as any).defect);
          failEntries(config, key, entries, err);
          return;
        }

        let decoded: readonly HttpWireResponse[];
        try {
          decoded = config.decode(exit.value, entries.map((entry) => entry.req));
          if (decoded.length !== entries.length) {
            throw new Error(`batch decoder returned ${decoded.length} responses for ${entries.length} requests`);
          }
        } catch (e) {
          failEntries(config, key, entries, toFetchError(e));
          return;
        }

        for (let i = 0; i < entries.length; i++) {
          complete(entries[i]!, { _tag: "Success", value: decoded[i]! });
        }
      });
    }
  };
}

function complete(entry: BatchEntry, exit: Exit<HttpError, HttpWireResponse>): void {
  if (entry.done) return;
  entry.done = true;
  entry.cb(exit);
}

function failEntries(config: RequestBatchingConfig, key: string, entries: readonly BatchEntry[], error: HttpError): void {
  emit(config, { type: "batch-error", key, size: entries.length, error });
  for (const entry of entries) {
    complete(entry, { _tag: "Failure", cause: Cause.fail(error) });
  }
}

function toFetchError(error: unknown): HttpError {
  if (isHttpError(error)) return error;
  return { _tag: "FetchError", message: error instanceof Error ? error.message : String(error) };
}

function isHttpError(error: unknown): error is HttpError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  const tag = (error as any)._tag;
  return tag === "Abort" || tag === "BadUrl" || tag === "FetchError" || tag === "Timeout" || tag === "PoolRejected" || tag === "PoolTimeout";
}

function emit(config: RequestBatchingConfig, event: RequestBatchingEvent): void {
  if (!config.onEvent) return;
  try {
    config.onEvent(event);
  } catch {
    // observer only
  }
}

function runEffect<E, A>(
  effect: Async<unknown, E, A>,
  env: unknown,
  cb: (exit: Exit<E, A>) => void,
): (() => void) | undefined {
  let cancelled = false;
  let currentCancel: (() => void) | undefined;

  const finish = (exit: Exit<E, A>) => {
    if (cancelled) return;
    cb(exit);
  };

  const run = (eff: Async<unknown, any, any>, k: (exit: Exit<any, any>) => void): void => {
    if (cancelled) return;

    switch (eff._tag) {
      case "Succeed":
        k({ _tag: "Success", value: eff.value });
        return;
      case "Fail":
        k({ _tag: "Failure", cause: Cause.fail(eff.error) });
        return;
      case "Sync":
        try {
          k({ _tag: "Success", value: eff.thunk(env) });
        } catch (e) {
          k({ _tag: "Failure", cause: Cause.die(e) as any });
        }
        return;
      case "Async": {
        const cancel = eff.register(env, (exit: Exit<any, any>) => {
          currentCancel = undefined;
          k(exit);
        });
        currentCancel = typeof cancel === "function" ? cancel : undefined;
        return;
      }
      case "FlatMap":
        run(eff.first, (exit) => {
          if (exit._tag === "Failure") {
            k(exit);
            return;
          }
          try {
            run(eff.andThen(exit.value), k);
          } catch (e) {
            k({ _tag: "Failure", cause: Cause.die(e) as any });
          }
        });
        return;
      case "Fold":
        run(eff.first, (exit) => {
          try {
            if (exit._tag === "Success") {
              run(eff.onSuccess(exit.value), k);
            } else if (exit.cause._tag === "Fail") {
              run(eff.onFailure(exit.cause.error), k);
            } else {
              k(exit);
            }
          } catch (e) {
            k({ _tag: "Failure", cause: Cause.die(e) as any });
          }
        });
        return;
      case "Fork":
        k({ _tag: "Success", value: undefined });
        return;
    }
  };

  run(effect, finish as any);

  return () => {
    if (cancelled) return;
    cancelled = true;
    currentCancel?.();
  };
}
