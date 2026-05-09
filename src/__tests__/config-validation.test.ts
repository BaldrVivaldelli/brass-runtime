import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../core/runtime/runtime";
import { makeDefaultHttpClient } from "../http/defaultClient";
import { makeObservability } from "../observability/setup";
import { ConfigValidationError } from "../schema";

describe("schema-driven config validation", () => {
  const expectConfigIssue = (
    build: () => unknown,
    path: readonly (string | number)[],
  ) => {
    try {
      build();
      throw new Error("Expected config validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validationError = error as ConfigValidationError;
      expect(validationError.issues.map((issue) => issue.path)).toContainEqual(path);
    }
  };

  it("validates runtime options at construction", () => {
    expect(() => new Runtime({ env: {}, engine: "auto" as any })).toThrow(ConfigValidationError);
    expect(() => new Runtime({ env: {}, lane: "" })).toThrow(ConfigValidationError);
  });

  it("validates HTTP config before constructing clients", () => {
    expect(() => makeDefaultHttpClient({ preset: "fast" as any })).toThrow(ConfigValidationError);
    expect(() => makeDefaultHttpClient({ timeoutMs: -1 })).toThrow(ConfigValidationError);
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { minLimit: 0 } }),
      ["adaptiveLimiter", "minLimit"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { preset: "turbo" as any } }),
      ["adaptiveLimiter", "preset"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { probeJitterRatio: 2 } }),
      ["adaptiveLimiter", "probeJitterRatio"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { baselineStrategy: "median" as any } }),
      ["adaptiveLimiter", "baselineStrategy"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { decreaseCooldownSamples: -1 } }),
      ["adaptiveLimiter", "decreaseCooldownSamples"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { historySize: -1 } }),
      ["adaptiveLimiter", "historySize"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { windowDecayFactor: 0 } }),
      ["adaptiveLimiter", "windowDecayFactor"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { errorWeight: 2 } }),
      ["adaptiveLimiter", "errorWeight"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { queueStrategy: "lifo" as any } }),
      ["adaptiveLimiter", "queueStrategy"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { rejectionBackoffMs: 0 } }),
      ["adaptiveLimiter", "rejectionBackoffMs"],
    );
    expectConfigIssue(
      () => makeDefaultHttpClient({ adaptiveLimiter: { headroomStrategy: { type: "proportional", ratio: 0 } } }),
      ["adaptiveLimiter", "headroomStrategy", "ratio"],
    );
  });

  it("validates observability config at construction", () => {
    expect(() => makeObservability({ serviceName: "" })).toThrow(ConfigValidationError);
    expectConfigIssue(() => makeObservability({ sampling: { ratio: 2 } }), ["sampling", "ratio"]);
    expectConfigIssue(
      () => makeObservability({ otlp: { pipeline: { batchSize: 0 } } }),
      ["otlp", "pipeline", "batchSize"],
    );
  });

  it("keeps valid observability configs constructible", async () => {
    const write = vi.fn();
    const obs = makeObservability({
      serviceName: "api",
      logs: { write },
      sampling: { ratio: 0.5 },
      otlp: { pipeline: { batchSize: 1 } },
      autoStart: false,
    });

    await expect(obs.shutdown()).resolves.toMatchObject({ errors: [] });
  });
});
