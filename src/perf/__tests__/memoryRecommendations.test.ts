import { describe, expect, it } from "vitest";
import { captureMemorySnapshot, diffMemorySnapshots } from "../memory";
import { recommendPerformance } from "../recommendations";

describe("memory profiler helpers", () => {
  it("captures snapshots and computes rounded deltas", () => {
    const before = captureMemorySnapshot({ clock: () => 1 });
    const after = {
      ...before,
      timestamp: 2,
      heapUsedMb: before.heapUsedMb + 1.25,
      rssMb: before.rssMb + 2.5,
    };

    expect(diffMemorySnapshots(before, after)).toMatchObject({
      heapUsedMb: 1.25,
      rssMb: 2.5,
    });
  });
});

describe("recommendPerformance", () => {
  it("warns when observed HTTP is much slower than default", () => {
    const recommendations = recommendPerformance({
      http: {
        calls: 100,
        concurrency: 10,
        delayMs: 1,
        timeoutMs: 1000,
        warmupCalls: 0,
        variants: ["default-json", "default-json-observed"],
        results: [
          {
            variant: "default-json",
            label: "default",
            calls: 100,
            warmupCalls: 0,
            concurrency: 10,
            delayMs: 1,
            timeoutMs: 1000,
            successCount: 100,
            errorCount: 0,
            durationMs: 10,
            warmupDurationMs: 0,
            httpPerSec: 10_000,
            requestP50Ms: 1,
            requestP90Ms: 2,
            requestP95Ms: 2,
            requestP99Ms: 3,
            serverRequests: 100,
            serverMaxInFlight: 10,
            clientMaxInFlight: 10,
            clientWireMaxInFlight: 10,
            gcAvailable: false,
            memory: {
              before: snapshot(1),
              after: snapshot(1),
              delta: { heapUsedMb: 0, heapTotalMb: 0, rssMb: 0, externalMb: 0, arrayBuffersMb: 0 },
            },
          },
          {
            variant: "default-json-observed",
            label: "observed",
            calls: 100,
            warmupCalls: 0,
            concurrency: 10,
            delayMs: 1,
            timeoutMs: 1000,
            successCount: 100,
            errorCount: 0,
            durationMs: 20,
            warmupDurationMs: 0,
            httpPerSec: 5_000,
            requestP50Ms: 1,
            requestP90Ms: 2,
            requestP95Ms: 2,
            requestP99Ms: 3,
            serverRequests: 100,
            serverMaxInFlight: 10,
            clientMaxInFlight: 10,
            clientWireMaxInFlight: 10,
            observedFinishedSpans: 100,
            gcAvailable: false,
            memory: {
              before: snapshot(1),
              after: snapshot(1),
              delta: { heapUsedMb: 0, heapTotalMb: 0, rssMb: 0, externalMb: 0, arrayBuffersMb: 0 },
            },
          },
        ],
      },
    });

    expect(recommendations.some((item) => item.area === "observability" && item.severity === "warn")).toBe(true);
  });
});

function snapshot(timestamp: number) {
  return {
    timestamp,
    heapUsedMb: 1,
    heapTotalMb: 2,
    rssMb: 3,
    externalMb: 4,
    arrayBuffersMb: 5,
    gcAvailable: false,
  };
}
