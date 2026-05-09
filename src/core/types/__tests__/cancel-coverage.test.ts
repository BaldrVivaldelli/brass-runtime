import { describe, expect, it } from "vitest";
import { linkAbortController, makeCancelToken } from "../cancel";

describe("cancel token coverage", () => {
  it("unsubscribes listeners and aborts linked controllers", () => {
    const token = makeCancelToken();
    const calls: string[] = [];
    const unsubscribe = token.onCancel(() => calls.push("removed"));
    token.onCancel(() => calls.push("kept"));
    unsubscribe();

    const controller = new AbortController();
    const unlink = linkAbortController(token, controller);
    expect(controller.signal.aborted).toBe(false);

    token.cancel();
    token.cancel();

    expect(calls).toEqual(["kept"]);
    expect(controller.signal.aborted).toBe(true);
    unlink();
  });

  it("runs late listeners immediately and swallows their errors", () => {
    const token = makeCancelToken();
    token.cancel();

    let called = false;
    const lateUnsubscribe = token.onCancel(() => {
      called = true;
      throw new Error("ignored");
    });

    expect(called).toBe(true);
    expect(lateUnsubscribe()).toBeUndefined();
  });
});
