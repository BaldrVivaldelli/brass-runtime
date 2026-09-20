import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-production-evidence.mjs");
const baseline = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "production-like-baseline-2026-09-19.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("production evidence integrity", () => {
  it("accepts the committed baseline", () => {
    expect(validate(baseline)).toMatchObject({ status: 0 });
  });

  it("rejects missing thresholds instead of comparing measurements with undefined", () => {
    const evidence = structuredClone(baseline);
    delete evidence.http.thresholds.maxHeapDeltaMb;

    const result = validate(evidence);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP maxHeapDeltaMb must be positive");
  });

  it("rejects duplicated measurements that only preserve the expected array length", () => {
    const evidence = structuredClone(baseline);
    evidence.http.results[1] = structuredClone(evidence.http.results[0]);

    const result = validate(evidence);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP variants: duplicate node-http-text");
    expect(result.stderr).toContain("HTTP variants: missing wire-raw");
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-evidence-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], {
    cwd: root,
    encoding: "utf8",
  });
}
