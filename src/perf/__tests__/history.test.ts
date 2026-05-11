import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparePerfToBaseline,
  createPerfHistoryEntry,
  formatPerfBaselineComparison,
  loadPerfBaseline,
  readPerfHistory,
  recordPerfHistoryRun,
  savePerfBaseline,
} from "../history";
import type { RuntimePrimitiveProfileReport } from "../runtimeProfiler";

describe("perf history and baseline store", () => {
  it("records JSONL history, saves a baseline, and detects regressions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brass-perf-history-"));
    const baselineEntry = createPerfHistoryEntry("runtime", makeRuntimeReport(1000));
    const saved = await savePerfBaseline("runtime-main", baselineEntry, { directory });

    await recordPerfHistoryRun("runtime", makeRuntimeReport(1000), { directory });
    await recordPerfHistoryRun("runtime", makeRuntimeReport(800), { directory });

    const history = await readPerfHistory({ directory });
    expect(history).toHaveLength(2);
    expect(saved.path).toContain("runtime-main.json");

    const loaded = await loadPerfBaseline("runtime-main", { directory });
    expect(loaded?.entry.metrics.some((metric) => metric.name === "runtime.ops_per_second")).toBe(true);

    const current = createPerfHistoryEntry("runtime", makeRuntimeReport(800));
    const comparison = comparePerfToBaseline(current, loaded!, { maxRegressionPercent: 10 });
    expect(comparison.status).toBe("fail");
    expect(formatPerfBaselineComparison(comparison)).toContain("status=fail");
  });

  it("can prune old history entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brass-perf-history-"));

    await recordPerfHistoryRun("runtime", makeRuntimeReport(1), { directory, maxEntries: 1 });
    await recordPerfHistoryRun("runtime", makeRuntimeReport(2), { directory, maxEntries: 1 });

    const history = await readPerfHistory({ directory });
    expect(history).toHaveLength(1);
    expect(history[0]?.metrics.find((metric) => metric.name === "runtime.ops_per_second")?.value).toBe(2);
  });
});

function makeRuntimeReport(opsPerSecond: number): RuntimePrimitiveProfileReport {
  return {
    variant: "default",
    label: "test",
    iterations: 1,
    chainDepth: 1,
    hooksActive: false,
    scheduler: {
      laneMode: "fair",
      initialCapacity: 1,
      maxCapacity: 1,
      flushBudget: 1,
    },
    results: [{
      name: "async-succeed/top-level",
      units: 1,
      unit: "effect",
      durationMs: 1,
      nsPerOperation: 1_000_000 / Math.max(opsPerSecond, 1),
      operationsPerSecond: opsPerSecond,
      fibersStarted: 0,
      fibersPerThousandOps: 0,
    }],
  };
}
