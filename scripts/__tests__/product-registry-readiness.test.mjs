import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const validator = path.join(root, "scripts", "check-product-registry-readiness.mjs");
const committed = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "product-registry-readiness-2026-09-20.json"),
  "utf8",
));
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("companion product registry readiness", () => {
  it("accepts the three committed non-publication snapshots", () => {
    expect(validate(committed)).toMatchObject({ status: 0 });
  });

  it("rejects a registry claim that has not replaced the readiness status", () => {
    const changed = structuredClone(committed);
    changed.products[0].registryPackageExists = true;
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("rejects evidence that drifts from an independent package manifest", () => {
    const changed = structuredClone(committed);
    changed.products[1].candidateVersion = "0.1.0-alpha.1";
    expect(validate(changed)).toMatchObject({ status: 1 });
  });

  it("rejects a first-publication workflow targeting latest", () => {
    const changed = structuredClone(committed);
    changed.publicationControl.distTag = "latest";
    expect(validate(changed)).toMatchObject({ status: 1 });
  });
});

function validate(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-product-readiness-test-"));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  return spawnSync(process.execPath, [validator, evidencePath], { cwd: root, encoding: "utf8" });
}
