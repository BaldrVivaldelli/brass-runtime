#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidencePath = path.resolve(
  root,
  process.argv[2] ?? "docs/evidence/v2-beta-readiness-2026-09-20.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const budget = JSON.parse(readFileSync(path.join(root, "scripts", "package-size-budget.json"), "utf8")).v2Target;
const publisher = readFileSync(path.join(root, ".github", "workflows", "publish-v2-beta.yml"), "utf8");
const failures = [];

if (evidence.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (evidence.status !== "candidate-validated-not-published") {
  failures.push("readiness evidence must not claim publication before the next tag exists");
}
if (evidence.registry?.package !== packageJson.name || evidence.registry?.latest !== packageJson.version) {
  failures.push("registry latest snapshot must match the stable source package");
}
if (evidence.registry?.next !== null) failures.push("pre-publication next snapshot must be null");
if (!/^2\.\d+\.\d+-beta\.\d+$/.test(evidence.candidate?.version ?? "")) {
  failures.push("candidate version must be an exact v2 beta");
}
if (!/^[a-f0-9]{64}$/.test(evidence.candidate?.sha256 ?? "")) failures.push("candidate sha256 is invalid");

for (const [key, maximum] of [
  ["files", budget.fileCount],
  ["compressedBytes", budget.compressedBytes],
  ["unpackedBytes", budget.unpackedBytes],
]) {
  const value = evidence.candidate?.[key];
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    failures.push(`candidate ${key} must be positive and <= ${maximum}`);
  }
}

if (evidence.candidate?.node !== ">=20") failures.push("v2 beta Node contract must be >=20");
if (evidence.publishDryRun?.id !== `${packageJson.name}@${evidence.candidate?.version}`
  || evidence.publishDryRun?.distTag !== "next"
  || evidence.publishDryRun?.access !== "public"
  || evidence.publishDryRun?.files !== evidence.candidate?.files
  || evidence.publishDryRun?.compressedBytes !== evidence.candidate?.compressedBytes
  || evidence.publishDryRun?.unpackedBytes !== evidence.candidate?.unpackedBytes) {
  failures.push("npm publication dry-run must match the exact candidate and next/public controls");
}
if (!Array.isArray(evidence.validatedConditions) || evidence.validatedConditions.length < 10) {
  failures.push("readiness evidence must enumerate all package and migration conditions");
}
if (evidence.publicationControl?.branch !== "next"
  || evidence.publicationControl?.environment !== "npm-next"
  || evidence.publicationControl?.branchExistsAtRecordedAt !== false
  || evidence.publicationControl?.environmentExistsAtRecordedAt !== false
  || evidence.publicationControl?.npmTokenSecretExistsAtRecordedAt !== true
  || evidence.publicationControl?.distTag !== "next"
  || evidence.publicationControl?.provenance !== true
  || evidence.publicationControl?.automaticPublish !== false) {
  failures.push("publication control must remain manual, protected, provenance-enabled, and next-only");
}
if (!Array.isArray(evidence.remaining) || evidence.remaining.length < 4) {
  failures.push("pre-publication actions must remain explicit");
}
if (!Array.isArray(evidence.reproduce) || !evidence.reproduce.includes("npm run release:check")) {
  failures.push("release gate reproduction is required");
}

for (const fragment of [
  "github.ref == 'refs/heads/next' && inputs.publish",
  "environment: npm-next",
  "npm run release:check",
  "--dry-run --access public --tag next --json",
  "--tag next",
  "--provenance",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
]) {
  if (!publisher.includes(fragment)) failures.push(`publisher is missing ${fragment}`);
}

const artifactPath = path.resolve(root, evidence.candidate?.path ?? "");
if (existsSync(artifactPath)) {
  const bytes = readFileSync(artifactPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== evidence.candidate.sha256) failures.push("candidate artifact sha256 does not match evidence");
  if (statSync(artifactPath).size !== evidence.candidate.compressedBytes) {
    failures.push("candidate artifact size does not match evidence");
  }
}

if (failures.length > 0) {
  console.error("V2 beta readiness validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `V2 beta readiness validated (${evidence.candidate.version}, ${evidence.candidate.files} files, ` +
    `published: no, artifact checked: ${existsSync(artifactPath) ? "yes" : "no"}).`,
  );
}
