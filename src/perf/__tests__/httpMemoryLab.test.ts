import { describe, expect, it } from "vitest";
import { formatHttpMemoryLabReport, profileHttpMemoryLab } from "../httpMemoryLab";

describe("profileHttpMemoryLab", () => {
  it("summarizes a tiny local HTTP memory run", async () => {
    const report = await profileHttpMemoryLab({
      calls: 4,
      concurrency: 2,
      delayMs: 0,
      warmupCalls: 0,
      rounds: 1,
      forceGc: false,
      variants: ["default-minimal-json"],
    });

    expect(report.summaries).toHaveLength(1);
    expect(report.summaries[0]?.variant).toBe("default-minimal-json");
    expect(report.summaries[0]?.totalCalls).toBe(4);
    expect(report.summaries[0]?.meanHttpPerSec).toBeGreaterThan(0);
    expect(formatHttpMemoryLabReport(report)).toContain("HTTP Long-Run Memory Lab");
  });
});
