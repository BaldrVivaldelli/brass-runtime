import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-adoption-signals.mjs");
const baseline = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "adoption-discovery-2026-09-20.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("adoption discovery integrity", () => {
  it("accepts the evidence without inferring users", () => {
    expect(validate(baseline)).toMatchObject({ status: 0 });
  });

  it("rejects a dependency-graph count without the corresponding inventory", () => {
    const changed = structuredClone(baseline);
    changed.githubDependencyGraph.reportedRepositories += 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("count must match its repository inventory");
  });

  it("rejects download-based active-user claims", () => {
    const changed = structuredClone(baseline);
    changed.inferredActiveUsers = 10;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not infer active users");
  });

  it("requires a verified consumer rather than treating reach as adoption", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers = [];
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least one verified consumer");
  });

  it("requires the public create-brass evidence commit to match its permalink", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers[0].publicVerification.evidenceCommitSha = "a".repeat(40);
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create-brass public verification");
  });

  it("rejects turning first-party validation into an external-adoption claim", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers[0].publicVerification.claimBoundary = "external production adopter";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("first-party claim boundary");
  });

  it("requires all eight public template builds to pass", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers[0].publicVerification.buildsPassed = 7;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create-brass public verification");
  });

  it("requires the hardened consumer validation to use OIDC", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers[0].publicVerification.authentication = "repository-token";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create-brass public verification");
  });

  it("does not turn a validation-only run into a publication claim", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers[0].publicVerification.publicationRequested = true;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create-brass public verification");
  });

  it("retains the production dependency audit as a required consumer check", () => {
    const changed = structuredClone(baseline);
    changed.verifiedConsumers[0].publicVerification.requiredChecks = ["templates", "CodeQL"];
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create-brass public verification");
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-adoption-signals-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], {
    cwd: root,
    encoding: "utf8",
  });
}
