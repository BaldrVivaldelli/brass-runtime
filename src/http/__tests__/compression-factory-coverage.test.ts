import { afterEach, describe, expect, it, vi } from "vitest";

describe("compression factory environment selection", () => {
  afterEach(() => {
    vi.doUnmock("../compression/environment");
    vi.resetModules();
  });

  it("uses the noop decompressor outside Node-like environments", async () => {
    vi.doMock("../compression/environment", () => ({
      isNodeEnvironment: () => false,
    }));

    const { createDecompressor } = await import("../compression/decompressor");
    const decompressor = createDecompressor();

    expect(decompressor.isPassthrough).toBe(true);
    expect(decompressor.decompress(new Uint8Array([1, 2]), "gzip")).toEqual({
      ok: true,
      data: Buffer.from([1, 2]),
    });
  });
});
