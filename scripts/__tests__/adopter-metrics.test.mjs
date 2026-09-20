import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const reporter = path.join(root, "scripts", "report-adopter-metrics.mjs");
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe("private adopter metrics", () => {
  it("derives retention, version distribution, and median upgrade lag without identities", () => {
    const inventory = validInventory();
    const { result, report } = runReporter(inventory);
    const serialized = JSON.stringify(report);

    expect(result).toMatchObject({ status: 0 });
    expect(report).toMatchObject({
      kind: "private-adopter-aggregate",
      records: 3,
      metrics: {
        active30Days: 1,
        active90Days: 2,
        retention30Percent: 33.333,
        retention90Percent: 66.667,
        upgradeLagDays: { minimum: 10, median: 20, maximum: 30 },
        publishableConsent: 1,
        reviewsDue: 1,
      },
      distributions: {
        brassVersion: { "1.22.0": 2, "2.0.0-beta.0": 1 },
        deploymentStage: { evaluation: 1, production: 1, staging: 1 },
      },
      privacy: {
        identitiesIncluded: false,
        ownersIncluded: false,
        evidenceReferencesIncluded: false,
      },
    });
    for (const secret of ["contact-one", "owner-one", "private-evidence-one"]) {
      expect(serialized).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
    }
  });

  it("rejects duplicate private record identifiers", () => {
    const inventory = validInventory();
    inventory.adopters[1].id = inventory.adopters[0].id;

    const { result } = runReporter(inventory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("id must be unique");
  });

  it("rejects stale active-window flags instead of reporting false retention", () => {
    const inventory = validInventory();
    inventory.adopters[1].active30Days = true;

    const { result } = runReporter(inventory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active-window flags do not match");
  });

  it("rejects observations recorded after the inventory timestamp", () => {
    const inventory = validInventory();
    inventory.adopters[0].lastVerifiedAt = "2026-09-21T00:00:00Z";

    const { result } = runReporter(inventory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid observation or review timeline");
  });

  it("requires at least one real observation", () => {
    const inventory = validInventory();
    inventory.adopters = [];

    const { result } = runReporter(inventory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least one observed adopter workload is required");
  });
});

function runReporter(inventory) {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-adopter-metrics-test-"));
  temporaryDirectories.push(directory);
  const inventoryPath = path.join(directory, "adopters.json");
  const reportPath = path.join(directory, "aggregate.json");
  writeFileSync(inventoryPath, `${JSON.stringify(inventory)}\n`, "utf8");
  const result = spawnSync(process.execPath, [reporter, inventoryPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BRASS_ADOPTION_REPORT_PATH: reportPath },
  });
  return {
    result,
    report: result.status === 0 ? JSON.parse(readFileSync(reportPath, "utf8")) : null,
  };
}

function validInventory() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-09-20T00:00:00Z",
    adopters: [
      adopter({
        id: "adopter-001",
        identityReference: "contact-one",
        owner: "owner-one",
        workload: "runtime",
        brassVersion: "1.22.0",
        entrypoints: ["brass-runtime/core"],
        deploymentStage: "production",
        firstVerifiedAt: "2026-07-01T00:00:00Z",
        lastVerifiedAt: "2026-09-15T00:00:00Z",
        upgradeLagDays: 10,
        active30Days: true,
        active90Days: true,
        consent: "internal-only",
        evidenceReference: "private-evidence-one",
        nextReviewAt: "2026-10-15T00:00:00Z",
      }),
      adopter({
        id: "adopter-002",
        identityReference: "contact-two",
        owner: "owner-two",
        workload: "http-observability",
        brassVersion: "1.22.0",
        entrypoints: ["brass-runtime/http", "brass-runtime/observability"],
        deploymentStage: "staging",
        firstVerifiedAt: "2026-07-10T00:00:00Z",
        lastVerifiedAt: "2026-08-20T00:00:00Z",
        upgradeLagDays: 20,
        active30Days: false,
        active90Days: true,
        consent: "publishable",
        evidenceReference: "private-evidence-two",
        nextReviewAt: "2026-09-25T00:00:00Z",
      }),
      adopter({
        id: "adopter-003",
        identityReference: "contact-three",
        owner: "owner-three",
        workload: "agent-evaluation",
        brassVersion: "2.0.0-beta.0",
        entrypoints: ["brass-runtime"],
        deploymentStage: "evaluation",
        firstVerifiedAt: "2026-05-01T00:00:00Z",
        lastVerifiedAt: "2026-06-01T00:00:00Z",
        upgradeLagDays: 30,
        active30Days: false,
        active90Days: false,
        consent: "denied",
        evidenceReference: "private-evidence-three",
        nextReviewAt: "2026-09-10T00:00:00Z",
      }),
    ],
  };
}

function adopter(value) {
  return value;
}
