import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-next-level-readiness.mjs");
const committed = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "next-level-readiness-2026-09-21.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("next-level readiness integrity", () => {
  it("accepts the three evidence-backed objectives without npm publication", () => {
    const result = validate(committed);
    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("3 objectives");
    expect(result.stdout).toContain("registry publication deferred");
  });

  it("rejects an adoption objective with fewer than two use cases", () => {
    const changed = structuredClone(committed);
    changed.adoptionAndEvidence.useCases = changed.adoptionAndEvidence.useCases.slice(0, 1);
    changed.adoptionAndEvidence.useCaseTarget.observed = 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least two internal or external use cases");
  });

  it("rejects an invented external-production claim", () => {
    const changed = structuredClone(committed);
    changed.adoptionAndEvidence.claims.externalProductionAdopters = 1;
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not invent external users or case studies");
  });

  it("rejects registry publication as a product readiness requirement", () => {
    const changed = structuredClone(committed);
    changed.productAndApiV2.companionRegistryPublication = "required";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must remain deferred and outside readiness");
  });

  it("rejects readiness without a verified operational objective", () => {
    const changed = structuredClone(committed);
    changed.operationalMaturity.status = "pending";
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("operational maturity objective must be verified");
  });

  it("rejects a reproduction plan that would publish", () => {
    const changed = structuredClone(committed);
    changed.reproduce.push("npm publish");
    const result = validate(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without publication commands");
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-next-level-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], { cwd: root, encoding: "utf8" });
}
