import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-stable-release-validation.mjs");
const committed = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "stable-release-validation-2026-09-21.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("stable release validation evidence integrity", () => {
  it("accepts the committed non-publishing release run", () => {
    expect(validate(committed)).toMatchObject({ status: 0 });
  });

  it("rejects evidence without a successful Node 24 job", () => {
    const changed = structuredClone(committed);
    changed.nodeValidation.fullValidation["24"].conclusion = "failure";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("full validation Node 24 job is incomplete or unsuccessful");
  });

  it("rejects a publisher that executed during validation", () => {
    const changed = structuredClone(committed);
    changed.publisherJobs.release.conclusion = "success";
    changed.publisherJobs.release.stepCount = 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release publisher must be skipped without executing steps");
  });

  it("rejects a registry mutation", () => {
    const changed = structuredClone(committed);
    changed.registryMutation = true;
    changed.registrySnapshotAfter.latest = "1.23.0";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publication and registry mutation were not attempted");
    expect(result.stderr).toContain("registry tags must remain unchanged");
  });

  it("rejects an incomplete native platform set", () => {
    const changed = structuredClone(committed);
    changed.nativeArtifacts.pop();
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly three native artifacts");
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-stable-release-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], { cwd: root, encoding: "utf8" });
}
