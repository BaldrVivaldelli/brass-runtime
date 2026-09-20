import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-adoption-evidence.mjs");
const assessment = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "v2-migration-assessment-2026-09-20.json"),
  "utf8",
));
const completed = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "v2-migration-lighthouse-1-2026-09-20.json"),
  "utf8",
));
const registryFollowUp = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "v2-migration-lighthouse-3-2026-09-20.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe("adoption evidence integrity", () => {
  it("accepts the committed non-claiming migration assessment", () => {
    expect(validate(assessment)).toMatchObject({ status: 0 });
  });

  it("accepts completed migration evidence with measured time, passing thresholds, and rollback", () => {
    expect(validate(completed)).toMatchObject({ status: 0 });
  });

  it("rejects publication without adopter consent", () => {
    const changed = structuredClone(assessment);
    changed.publishableCaseStudy = true;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires granted consent");
  });

  it("rejects manual-decision counts that do not match the inventory", () => {
    const changed = structuredClone(assessment);
    changed.result.manualDecisions += 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must equal manualDecisions");
  });

  it("rejects a completed migration whose duration does not match its measurement window", () => {
    const changed = structuredClone(completed);
    changed.migration.durationSeconds += 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must match the measurement window");
  });

  it("rejects incomplete published-package validation", () => {
    const changed = structuredClone(completed);
    changed.validation.publishedPackageTemplateBuildsPassed -= 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("published-package template builds must pass");
  });

  it("rejects incomplete rollback validation", () => {
    const changed = structuredClone(completed);
    changed.validation.rollbackTemplateBuildsPassed -= 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback template builds must pass");
  });

  it("accepts a public-registry replay that retains the initial migration boundary", () => {
    expect(validate(registryFollowUp)).toMatchObject({ status: 0 });
  });

  it("rejects an incomplete public-registry replay", () => {
    const changed = structuredClone(registryFollowUp);
    changed.registryFollowUp.registryTarballSha256 = "not-a-digest";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registry follow-up");
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-adoption-evidence-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], { cwd: root, encoding: "utf8" });
}
