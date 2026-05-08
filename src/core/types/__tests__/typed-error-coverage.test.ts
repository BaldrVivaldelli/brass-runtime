import { describe, expect, it } from "vitest";
import { Runtime } from "../../runtime/runtime";
import { asyncFail, asyncSucceed } from "../asyncEffect";
import { catchTag, catchTags, mapError, orElse, tagError } from "../typedError";

type AppError =
  | { readonly _tag: "NotFound"; readonly id: string }
  | { readonly _tag: "Timeout"; readonly ms: number }
  | { readonly _tag: "Unknown"; readonly reason: string };

const rt = Runtime.make({});
const run = <A>(effect: any) => rt.toPromise(effect) as Promise<A>;

describe("typed error helpers", () => {
  it("catches one matching tag and passes through successes and other errors", async () => {
    await expect(
      run(catchTag(
        asyncFail<AppError>({ _tag: "NotFound", id: "u1" }),
        "NotFound",
        (error) => asyncSucceed(`missing:${error.id}`),
      )),
    ).resolves.toBe("missing:u1");

    await expect(
      run(catchTag(
        asyncFail<AppError>({ _tag: "Timeout", ms: 50 }),
        "NotFound",
        () => asyncSucceed("never"),
      )),
    ).rejects.toEqual({ _tag: "Timeout", ms: 50 });

    await expect(
      run(catchTag(asyncSucceed("ok"), "NotFound", () => asyncSucceed("never"))),
    ).resolves.toBe("ok");
  });

  it("catches multiple tags and passes through unmatched errors", async () => {
    await expect(
      run(catchTags(asyncFail<AppError>({ _tag: "Timeout", ms: 10 }), {
        NotFound: (error) => asyncSucceed(error.id),
        Timeout: (error) => asyncSucceed(`timeout:${error.ms}`),
      })),
    ).resolves.toBe("timeout:10");

    await expect(
      run(catchTags(asyncFail<AppError>({ _tag: "Unknown", reason: "x" }), {
        Timeout: () => asyncSucceed("never"),
      })),
    ).rejects.toEqual({ _tag: "Unknown", reason: "x" });
  });

  it("maps, tags, and falls back from error channels", async () => {
    await expect(
      run(mapError(asyncFail("boom"), (message) => ({ _tag: "Unknown", reason: message }))),
    ).rejects.toEqual({ _tag: "Unknown", reason: "boom" });

    await expect(
      run(mapError(asyncSucceed(3), () => "never")),
    ).resolves.toBe(3);

    await expect(
      run(tagError(asyncFail("denied"), "Unknown", (reason) => ({ reason }))),
    ).rejects.toEqual({ _tag: "Unknown", reason: "denied" });

    await expect(
      run(tagError(asyncFail("plain"), "Unknown")),
    ).rejects.toEqual({ _tag: "Unknown" });

    await expect(
      run(orElse(asyncFail("primary"), (error) => asyncSucceed(`fallback:${error}`))),
    ).resolves.toBe("fallback:primary");

    await expect(
      run(orElse(asyncSucceed("primary"), () => asyncSucceed("fallback"))),
    ).resolves.toBe("primary");
  });
});
