// src/http/sleep.ts
import { fromPromiseAbortable } from "../core/runtime/runtime";
import type { Async } from "../core/types/asyncEffect";
import type { HttpError } from "./client";

const isHttpError = (e: unknown): e is HttpError =>
  typeof e === "object" && e !== null && "_tag" in (e as any);

const normalizeHttpError = (e: unknown): HttpError => {
  if (isHttpError(e)) return e;

  if (typeof e === "object" && e !== null && (e as any).name === "AbortError") {
    return { _tag: "Abort" } satisfies HttpError;
  }

  return { _tag: "FetchError", message: String(e) } satisfies HttpError;
};

export const sleepMs = (ms: number): Async<unknown, HttpError, void> =>
  fromPromiseAbortable<HttpError, void>(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject({ _tag: "Abort" } satisfies HttpError);

        const delay = Math.max(0, Math.floor(ms));
        let done = false;
        let id: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (id !== undefined) {
            clearTimeout(id);
            id = undefined;
          }
          signal.removeEventListener("abort", onAbort);
        };

        const finish = (f: () => void) => {
          if (done) return;
          done = true;
          cleanup();
          f();
        };

        const onAbort = () => finish(() => reject({ _tag: "Abort" } satisfies HttpError));

        signal.addEventListener("abort", onAbort, { once: true });
        id = setTimeout(() => finish(resolve), delay);
      }),
    normalizeHttpError,
    { label: "sleep" }
  );
