#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const inventoryPath = path.resolve(root, process.argv[2] ?? ".brass-private/adopters.json");
const reportPath = process.env.BRASS_ADOPTION_REPORT_PATH
  ? path.resolve(root, process.env.BRASS_ADOPTION_REPORT_PATH)
  : null;

let inventory;
try {
  inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
} catch (error) {
  console.error(`Private adopter inventory could not be read: ${error.message}`);
  process.exit(1);
}

const failures = [];
const deploymentStages = new Set(["evaluation", "staging", "canary", "production"]);
const consentStates = new Set(["not-requested", "denied", "internal-only", "publishable"]);
const updatedAt = Date.parse(inventory.updatedAt);

if (inventory.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (!Number.isFinite(updatedAt)) failures.push("updatedAt must be a valid ISO timestamp");
if (!Array.isArray(inventory.adopters) || inventory.adopters.length < 1) {
  failures.push("at least one observed adopter workload is required");
}

const adopters = Array.isArray(inventory.adopters) ? inventory.adopters : [];
const ids = new Set();
for (const [index, adopter] of adopters.entries()) validateAdopter(adopter, index);

if (failures.length > 0) {
  console.error("Private adopter inventory validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const upgradeLagDays = adopters.map((adopter) => adopter.upgradeLagDays).sort((a, b) => a - b);
const active30Days = adopters.filter((adopter) => adopter.active30Days).length;
const active90Days = adopters.filter((adopter) => adopter.active90Days).length;
const report = {
  schemaVersion: 1,
  kind: "private-adopter-aggregate",
  generatedAt: inventory.updatedAt,
  records: adopters.length,
  metrics: {
    active30Days,
    active90Days,
    retention30Percent: percentage(active30Days, adopters.length),
    retention90Percent: percentage(active90Days, adopters.length),
    upgradeLagDays: {
      minimum: upgradeLagDays[0],
      median: median(upgradeLagDays),
      maximum: upgradeLagDays.at(-1),
    },
    publishableConsent: adopters.filter((adopter) => adopter.consent === "publishable").length,
    reviewsDue: adopters.filter((adopter) => Date.parse(adopter.nextReviewAt) <= updatedAt).length,
  },
  distributions: {
    brassVersion: distribution(adopters.flatMap((adopter) => [adopter.brassVersion])),
    deploymentStage: distribution(adopters.flatMap((adopter) => [adopter.deploymentStage])),
    workload: distribution(adopters.flatMap((adopter) => [adopter.workload])),
    entrypoint: distribution(adopters.flatMap((adopter) => adopter.entrypoints)),
    consent: distribution(adopters.flatMap((adopter) => [adopter.consent])),
  },
  privacy: {
    identitiesIncluded: false,
    ownersIncluded: false,
    evidenceReferencesIncluded: false,
  },
  claimBoundary:
    "These aggregates describe explicitly recorded private observations; they do not convert downloads into users or imply external-production adoption.",
};

if (reportPath) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(
  `Private adopter metrics validated (${report.records} workloads, ${active30Days} active/30d, ` +
  `${active90Days} active/90d, median upgrade lag ${report.metrics.upgradeLagDays.median} days; ` +
  "identities omitted).",
);

function validateAdopter(adopter, index) {
  const label = `adopters[${index}]`;
  if (!adopter || typeof adopter !== "object" || Array.isArray(adopter)) {
    failures.push(`${label} must be an object`);
    return;
  }
  if (typeof adopter.id !== "string" || adopter.id.length < 3) failures.push(`${label}.id is required`);
  else if (ids.has(adopter.id)) failures.push(`${label}.id must be unique`);
  else ids.add(adopter.id);

  for (const field of ["identityReference", "owner", "workload", "evidenceReference"]) {
    if (typeof adopter[field] !== "string" || adopter[field].trim().length < 1) {
      failures.push(`${label}.${field} is required`);
    }
  }
  if (typeof adopter.brassVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(adopter.brassVersion)) {
    failures.push(`${label}.brassVersion must be an exact semantic version`);
  }
  if (!Array.isArray(adopter.entrypoints)
    || adopter.entrypoints.length < 1
    || adopter.entrypoints.some((entrypoint) => typeof entrypoint !== "string" || entrypoint.length < 1)
    || new Set(adopter.entrypoints).size !== adopter.entrypoints.length) {
    failures.push(`${label}.entrypoints must contain unique non-empty package entrypoints`);
  }
  if (!deploymentStages.has(adopter.deploymentStage)) failures.push(`${label}.deploymentStage is invalid`);
  if (!consentStates.has(adopter.consent)) failures.push(`${label}.consent is invalid`);
  if (!Number.isInteger(adopter.upgradeLagDays) || adopter.upgradeLagDays < 0) {
    failures.push(`${label}.upgradeLagDays must be a non-negative integer`);
  }
  if (typeof adopter.active30Days !== "boolean" || typeof adopter.active90Days !== "boolean") {
    failures.push(`${label} requires active30Days and active90Days booleans`);
  }

  const firstVerifiedAt = Date.parse(adopter.firstVerifiedAt);
  const lastVerifiedAt = Date.parse(adopter.lastVerifiedAt);
  const nextReviewAt = Date.parse(adopter.nextReviewAt);
  if (!Number.isFinite(firstVerifiedAt)
    || !Number.isFinite(lastVerifiedAt)
    || !Number.isFinite(nextReviewAt)
    || !Number.isFinite(updatedAt)
    || firstVerifiedAt > lastVerifiedAt
    || lastVerifiedAt > updatedAt
    || nextReviewAt < lastVerifiedAt) {
    failures.push(`${label} has an invalid observation or review timeline`);
    return;
  }

  const ageDays = (updatedAt - lastVerifiedAt) / 86_400_000;
  const derivedActive30Days = ageDays <= 30;
  const derivedActive90Days = ageDays <= 90;
  if (adopter.active30Days !== derivedActive30Days || adopter.active90Days !== derivedActive90Days) {
    failures.push(`${label} active-window flags do not match lastVerifiedAt and inventory.updatedAt`);
  }
}

function distribution(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function percentage(count, total) {
  return Math.round((count / total) * 100_000) / 1000;
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle];
  return Math.round(((values[middle - 1] + values[middle]) / 2) * 1000) / 1000;
}
