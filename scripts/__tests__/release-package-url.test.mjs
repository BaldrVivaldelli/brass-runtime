import { describe, expect, it } from "vitest";
import { packageUrl } from "../release-package-url.mjs";

describe("release package URLs", () => {
  it("encodes scoped npm packages by namespace segment", () => {
    expect(packageUrl({ ecosystem: "npm", name: "@scope/package", version: "1.2.3" }))
      .toBe("pkg:npm/%40scope/package@1.2.3");
  });

  it("percent-encodes every reserved character within a component", () => {
    expect(packageUrl({ ecosystem: "npm", name: "@scope/package!()", version: "1.2.3+build" }))
      .toBe("pkg:npm/%40scope/package%21%28%29@1.2.3%2Bbuild");
  });
});
