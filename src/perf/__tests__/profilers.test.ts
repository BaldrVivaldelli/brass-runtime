import { describe, expect, it } from "vitest";
import { profileHttpLayers } from "../httpProfiler";
import { profileRuntimePrimitives } from "../runtimeProfiler";
import { formatPerformanceReport, runBrassPerformanceProfile } from "../report";

describe("profileRuntimePrimitives", () => {
  it("profiles a small runtime sample", async () => {
    const report = await profileRuntimePrimitives({ iterations: 20, chainDepth: 5 });

    expect(report.results.map((result) => result.name)).toContain("flatMap-chain");
    expect(report.results.every((result) => result.operationsPerSecond > 0)).toBe(true);
  });
});

describe("profileHttpLayers", () => {
  it("profiles a tiny local HTTP run", async () => {
    const report = await profileHttpLayers({
      calls: 4,
      concurrency: 2,
      delayMs: 0,
      warmupCalls: 0,
      variants: ["default-minimal-json"],
    });

    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.successCount).toBe(4);
    expect(report.results[0]?.errorCount).toBe(0);
    expect(report.results[0]?.httpPerSec).toBeGreaterThan(0);
  });
});

describe("runBrassPerformanceProfile", () => {
  it("formats a combined runtime-only report", async () => {
    const report = await runBrassPerformanceProfile({
      runtime: { iterations: 20, chainDepth: 5 },
      http: false,
      memory: { forceGc: false },
    });

    expect(report.runtime?.results.length).toBeGreaterThan(0);
    expect(formatPerformanceReport(report)).toContain("Brass Performance Profile");
  });
});
