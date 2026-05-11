import { describe, expect, it } from "vitest";
import { runRuntimePerfBudget } from "../budget";
import { profileRuntimeAb } from "../runtimeAb";
import { diagnoseRuntimeProfile } from "../runtimeDiagnostics";
import { profileRuntimeSoak } from "../runtimeSoak";

describe("runtime A/B profiler", () => {
  it("compares fiber-only baseline against default runtime", async () => {
    const report = await profileRuntimeAb({
      baseline: "fiber-only",
      candidate: "default",
      runtime: { iterations: 20, chainDepth: 5 },
    });

    expect(report.comparisons.map((comparison) => comparison.primitive)).toContain("async-succeed/top-level");
    expect(report.diagnostics.candidate.notes.some((note) => note.includes("fast path"))).toBe(true);
  });
});

describe("runtime diagnostics", () => {
  it("summarizes hot primitives and fiber pressure", async () => {
    const report = await profileRuntimeAb({
      baseline: "fiber-only",
      candidate: "default",
      runtime: { iterations: 20, chainDepth: 5 },
    });

    const diagnostics = diagnoseRuntimeProfile(report.candidate);
    expect(diagnostics.hotPrimitives.length).toBeGreaterThan(0);
    expect(diagnostics.totalMeasuredUnits).toBeGreaterThan(0);
  });
});

describe("runtime soak profiler", () => {
  it("runs a tiny runtime-only soak", async () => {
    const report = await profileRuntimeSoak({
      rounds: 2,
      runtime: { iterations: 20, chainDepth: 5 },
    });

    expect(report.rounds).toHaveLength(2);
    expect(report.rounds[0]?.diagnostics.slowest.name).toBeTypeOf("string");
  });
});

describe("runtime perf budget", () => {
  it("passes a tiny conservative budget", async () => {
    const report = await runRuntimePerfBudget({
      runtime: { iterations: 20, chainDepth: 5 },
      minOpsPerSecond: 1,
      maxHeapDeltaMb: 256,
      thresholds: { maxRegressionPercent: 100 },
    });

    expect(report.passed).toBe(true);
  });
});
