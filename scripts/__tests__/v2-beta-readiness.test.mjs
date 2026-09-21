import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-v2-beta-readiness.mjs");
const committed = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "v2-beta-readiness-2026-09-20.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("v2 beta readiness integrity", () => {
  it("accepts the committed published candidate and its registry evidence", () => {
    expect(validate(committed)).toMatchObject({ status: 0 });
  });

  it("rejects a next tag that does not resolve to the candidate", () => {
    const changed = structuredClone(committed);
    changed.registry.next = "2.0.0-beta.99";
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects published evidence without a provenance attestation", () => {
    const changed = structuredClone(committed);
    changed.registry.attestation = null;
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects post-publication validation for a different registry tarball", () => {
    const changed = structuredClone(committed);
    changed.publication.postPublishValidation.registryTarballSha256 = "0".repeat(64);
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects a dry-run that does not match the candidate", () => {
    const changed = structuredClone(committed);
    changed.publishDryRun.files -= 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects a publication control that could move latest", () => {
    const changed = structuredClone(committed);
    changed.publicationControl.distTag = "latest";
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects a failed manual workflow verification", () => {
    const changed = structuredClone(committed);
    changed.workflowValidation.manual.conclusion = "failure";
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects a manual verification that was not dispatched manually", () => {
    const changed = structuredClone(committed);
    changed.workflowValidation.manual.event = "push";
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects current compatibility evidence without a successful Node 24 job", () => {
    const changed = structuredClone(committed);
    changed.currentCompatibilityValidation.jobs["24"] = null;
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("rejects compatibility evidence that attempted publication", () => {
    const changed = structuredClone(committed);
    changed.currentCompatibilityValidation.publicationAttempted = true;
    const result = validate(changed);
    expect(result.status).toBe(1);
  });

  it("checks a local candidate only when its path is explicitly requested", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "brass-v2-artifact-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "candidate.tgz");
    writeFileSync(artifactPath, "not-the-published-candidate", "utf8");
    expect(validate(committed, ["--artifact", artifactPath])).toMatchObject({ status: 1 });
  });
});

function validate(evidence, extraArguments = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-v2-readiness-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(
    process.execPath,
    [validator, evidencePath, ...extraArguments],
    { cwd: root, encoding: "utf8" },
  );
}
