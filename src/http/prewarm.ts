import { fromPromiseAbortable } from "../core/runtime/runtime";
import type { Async } from "../core/types/asyncEffect";
import type { HttpError, HttpMethod, HttpMiddleware, HttpRequest } from "./client";
import { asyncFail, asyncFold } from "../core/types/asyncEffect";

export type ConnectionPrewarmAttempt = {
  url: string;
  origin: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: HttpError;
};

export type ConnectionPrewarmResult = {
  attempted: number;
  warmed: number;
  failed: number;
  skipped: number;
  attempts: readonly ConnectionPrewarmAttempt[];
};

export type ConnectionPrewarmEvent =
  | { type: "prewarm-start"; url: string; origin: string }
  | { type: "prewarm-success"; url: string; origin: string; status: number; ms: number }
  | { type: "prewarm-failure"; url: string; origin: string; error: HttpError; ms: number };

export type ConnectionPrewarmConfig = {
  baseUrl?: string;
  urls?: readonly string[];
  origins?: readonly string[];
  path?: string;
  method?: Extract<HttpMethod, "HEAD" | "GET" | "OPTIONS">;
  headers?: Record<string, string>;
  timeoutMs?: number;
  failFast?: boolean;
  fetchImpl?: typeof fetch;
  onEvent?: (event: ConnectionPrewarmEvent) => void;
};

export type ConnectionPrewarmingMiddlewareConfig = ConnectionPrewarmConfig & {
  once?: boolean;
  shouldPrewarm?: (req: HttpRequest) => boolean;
  target?: (req: HttpRequest) => string | undefined | null;
};

export function prewarmConnections(config: ConnectionPrewarmConfig = {}): Async<unknown, HttpError, ConnectionPrewarmResult> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const method = config.method ?? "HEAD";
  const targets = resolveTargets(config);

  return fromPromiseAbortable<HttpError, ConnectionPrewarmResult>(
    async (signal) => {
      if (typeof fetchImpl !== "function" || targets.length === 0) {
        return { attempted: 0, warmed: 0, failed: 0, skipped: targets.length, attempts: [] };
      }

      const attempts: ConnectionPrewarmAttempt[] = [];

      for (const url of targets) {
        const origin = new URL(url).origin;
        const started = performance.now();
        emit(config, { type: "prewarm-start", url, origin });

        try {
          const res = await fetchImpl(url, {
            method,
            headers: config.headers,
            cache: "no-store" as any,
            signal,
          } as any);
          const ms = Math.round(performance.now() - started);
          attempts.push({ url, origin, ok: true, status: res.status, ms });
          emit(config, { type: "prewarm-success", url, origin, status: res.status, ms });
        } catch (e) {
          const ms = Math.round(performance.now() - started);
          const error = normalizePrewarmError(e);
          attempts.push({ url, origin, ok: false, error, ms });
          emit(config, { type: "prewarm-failure", url, origin, error, ms });
          if (config.failFast) throw error;
        }
      }

      return {
        attempted: attempts.length,
        warmed: attempts.filter((attempt) => attempt.ok).length,
        failed: attempts.filter((attempt) => !attempt.ok).length,
        skipped: 0,
        attempts,
      };
    },
    normalizePrewarmError,
    {
      label: "http:prewarm",
      timeoutMs: config.timeoutMs,
      timeoutReason: config.timeoutMs
        ? () => ({
          _tag: "Timeout",
          timeoutMs: config.timeoutMs!,
          phase: "request",
          message: `HTTP prewarm timed out after ${config.timeoutMs}ms`,
        })
        : undefined,
    },
  );
}

export const prewarmHttpConnections = prewarmConnections;

export function withConnectionPrewarming(config: ConnectionPrewarmingMiddlewareConfig = {}): HttpMiddleware {
  const once = config.once ?? true;
  const warmed = new Set<string>();
  const warming = new Set<string>();

  return (next) => (req) => {
    if (config.shouldPrewarm && !config.shouldPrewarm(req)) return next(req);

    const target = config.target?.(req) ?? req.url;
    if (!target) return next(req);

    const resolved = resolveUrl(target, config.baseUrl);
    if (!resolved) return next(req);

    const key = resolved.origin;
    if (once && (warmed.has(key) || warming.has(key))) return next(req);
    warming.add(key);

    return asyncFold(
      prewarmConnections({
        ...config,
        urls: [resolved.toString()],
        origins: undefined,
        onEvent: (event) => {
          if (event.type === "prewarm-success") warmed.add(key);
          config.onEvent?.(event);
        },
      }),
      (error) => {
        warming.delete(key);
        if (config.failFast || error._tag === "Abort") return asyncFail(error);
        return next(req);
      },
      () => {
        warming.delete(key);
        return next(req);
      },
    );
  };
}

function resolveTargets(config: ConnectionPrewarmConfig): string[] {
  const out: string[] = [];
  const path = config.path ?? "/";

  for (const url of config.urls ?? []) {
    const resolved = resolveUrl(url, config.baseUrl);
    if (resolved) out.push(resolved.toString());
  }

  for (const origin of config.origins ?? []) {
    const resolved = resolveUrl(path, origin);
    if (resolved) out.push(resolved.toString());
  }

  if (out.length === 0 && config.baseUrl) {
    const resolved = resolveUrl(path, config.baseUrl);
    if (resolved) out.push(resolved.toString());
  }

  return Array.from(new Set(out));
}

function resolveUrl(value: string, baseUrl?: string): URL | undefined {
  try {
    return new URL(value, baseUrl || undefined);
  } catch {
    return undefined;
  }
}

function normalizePrewarmError(error: unknown): HttpError {
  if (isHttpError(error)) return error;
  if (typeof error === "object" && error !== null && (error as any).name === "AbortError") {
    return { _tag: "Abort" };
  }
  return { _tag: "FetchError", message: error instanceof Error ? error.message : String(error) };
}

function isHttpError(error: unknown): error is HttpError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  const tag = (error as any)._tag;
  return tag === "Abort" || tag === "BadUrl" || tag === "FetchError" || tag === "Timeout" || tag === "PoolRejected" || tag === "PoolTimeout";
}

function emit(config: ConnectionPrewarmConfig, event: ConnectionPrewarmEvent): void {
  if (!config.onEvent) return;
  try {
    config.onEvent(event);
  } catch {
    // observer only
  }
}
