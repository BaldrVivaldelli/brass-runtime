import { describe, expect, it } from "vitest";
import { validateProductPublishReport } from "../product-publish-report.mjs";

const manifest = { name: "@brass/engine-wasm", version: "0.1.0-alpha.0" };
const recorded = {
  publishDryRun: {
    files: 8,
    compressedBytes: 109169,
    unpackedBytes: 317046,
  },
};
const budget = { fileCount: 10, compressedBytes: 125000, unpackedBytes: 350000 };
const report = {
  id: "@brass/engine-wasm@0.1.0-alpha.0",
  name: "@brass/engine-wasm",
  version: "0.1.0-alpha.0",
  entryCount: 8,
  size: 109089,
  unpackedSize: 316758,
};

describe("portable product publish report validation", () => {
  it("accepts platform-dependent byte drift inside the reviewed budgets", () => {
    expect(validateProductPublishReport({ manifest, recorded, report, budget })).toMatchObject({
      files: 8,
      compressedBytes: 109089,
      unpackedBytes: 316758,
    });
  });

  it("rejects package identity or file-set drift", () => {
    expect(() => validateProductPublishReport({
      manifest,
      recorded,
      report: { ...report, entryCount: 9 },
      budget,
    })).toThrow("dry-run files changed");
  });

  it("rejects artifacts that exceed a portable size budget", () => {
    expect(() => validateProductPublishReport({
      manifest,
      recorded,
      report: { ...report, size: budget.compressedBytes + 1 },
      budget,
    })).toThrow("outside the portable budget");
  });
});
