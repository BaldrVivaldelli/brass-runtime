// src/http/sleep.ts
import { fromPromiseAbortable } from "../core/runtime/runtime";
import type { Async } from "../core/types/asyncEffect";
import { HttpError } from "./client";

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

        const id = setTimeout(resolve, ms);

        const onAbort = () => {
          clearTimeout(id);
          reject({ _tag: "Abort" } satisfies HttpError);
        };

        signal.addEventListener("abort", onAbort, { once: true });
      }),
    normalizeHttpError
  );
