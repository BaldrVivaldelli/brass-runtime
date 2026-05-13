import { describe, expect, it, vi } from "vitest";

import { isConfigValidationError } from "../../schema";
import { withHttpObservability } from "../../observability";
import { makeDefaultHttpClient } from "../defaultClient";

describe("HTTP config validation", () => {
  it("rejects invalid policy preset fields at construction time", () => {
    expect(() =>
      makeDefaultHttpClient({
        policyPresets: {
          readModel: {
            priority: 42,
          },
        },
      } as any),
    ).toThrowError(expect.objectContaining({
      _tag: "ConfigValidationError",
      configName: "DefaultHttpClientConfig",
    }));

    try {
      makeDefaultHttpClient({
        policyPresets: {
          readModel: { priority: 42 },
        },
      } as any);
    } catch (error) {
      expect(isConfigValidationError(error)).toBe(true);
      expect(isConfigValidationError(error) ? error.issues[0]?.path : undefined).toEqual([
        "policyPresets",
        "readModel",
        "priority",
      ]);
    }
  });

  it("rejects unsupported compression encodings", () => {
    expect(() =>
      makeDefaultHttpClient({
        compression: { encodings: ["gzip", "zstd"] },
      } as any),
    ).toThrowError(expect.objectContaining({
      _tag: "ConfigValidationError",
      configName: "DefaultHttpClientConfig",
    }));
  });

  it("accepts valid policy presets with object and function entries", () => {
    vi.stubGlobal("fetch", vi.fn());

    expect(() =>
      makeDefaultHttpClient({
        preset: "minimal",
        compression: false,
        policyPresets: {
          readModel: { lane: "read-model", poolKey: "users-api", priority: 2 },
          dynamic: () => ({ lane: "dynamic" }),
        },
      }),
    ).not.toThrow();

    vi.unstubAllGlobals();
  });

  it("validates HTTP observability policy label keys", () => {
    expect(() =>
      withHttpObservability({
        policy: { labelKeys: ["pool_key"] },
      } as any),
    ).toThrowError(expect.objectContaining({
      _tag: "ConfigValidationError",
      configName: "HttpObservabilityOptions",
    }));
  });
});
