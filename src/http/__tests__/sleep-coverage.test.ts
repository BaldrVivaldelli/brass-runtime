import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../../core/runtime/runtime";
import { sleepMs } from "../sleep";

const rt = Runtime.make({});

describe("sleepMs error normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves structured HTTP errors thrown by the timer host", async () => {
    const error = { _tag: "BadUrl", message: "bad timer host" };
    vi.stubGlobal("setTimeout", (() => {
      throw error;
    }) as any);

    await expect(rt.toPromise(sleepMs(1))).rejects.toEqual(error);
  });

  it("maps DOM AbortError rejections to Http Abort", async () => {
    vi.stubGlobal("setTimeout", (() => {
      throw new DOMException("aborted", "AbortError");
    }) as any);

    await expect(rt.toPromise(sleepMs(1))).rejects.toEqual({ _tag: "Abort" });
  });

  it("maps unknown timer failures to FetchError", async () => {
    vi.stubGlobal("setTimeout", (() => {
      throw new Error("timer exploded");
    }) as any);

    await expect(rt.toPromise(sleepMs(1))).rejects.toEqual({
      _tag: "FetchError",
      message: "Error: timer exploded",
    });
  });
});
