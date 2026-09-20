import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-remote-stability-evidence.mjs");
const committed = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "stability-ci-2026-09-20.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe("remote stability evidence integrity", () => {
  it("accepts both retained green GitHub Actions runs", () => {
    expect(validate(committed)).toMatchObject({ status: 0 });
  });

  it("rejects a failed workflow conclusion", () => {
    const changed = structuredClone(committed);
    changed.workflow.conclusion = "failure";
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("rejects a mutated artifact digest", () => {
    const changed = structuredClone(committed);
    changed.artifact.files["http-soak.json"].sha256 = "not-a-digest";
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("rejects an HTTP error even when the workflow is marked successful", () => {
    const changed = structuredClone(committed);
    changed.http.errors = 1;
    changed.http.successes -= 1;
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("rejects a failed repeat conformance result", () => {
    const changed = structuredClone(committed);
    changed.repeatValidation.conformance.result = "failed";
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("rejects a mutated repeat artifact digest", () => {
    const changed = structuredClone(committed);
    changed.repeatValidation.artifact.files["runtime-soak.json"].sha256 = "not-a-digest";
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("does not promote same-day repeats to a weekly trend", () => {
    const changed = structuredClone(committed);
    changed.comparison.weeklyTrendEstablished = true;
    expect(validate(changed)).toMatchObject({ status: 1 });
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-remote-stability-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], { cwd: root, encoding: "utf8" });
}
