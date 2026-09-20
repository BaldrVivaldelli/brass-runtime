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
const releaseEntrypoint = readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const publisher = readFileSync(path.join(root, ".github", "workflows", "publish-v2-beta.yml"), "utf8");
const failures = [];

if (evidence.schemaVersion !== 2) failures.push("schemaVersion must be 2");
if (evidence.status !== "published-on-next") failures.push("v2 beta evidence must record next publication");
if (evidence.registry?.package !== packageJson.name || evidence.registry?.latest !== packageJson.version) {
  failures.push("registry latest snapshot must match the stable source package");
}
if (!/^2\.\d+\.\d+-beta\.\d+$/.test(evidence.candidate?.version ?? "")) {
  failures.push("candidate version must be an exact v2 beta");
}
if (evidence.registry?.next !== evidence.candidate?.version) {
  failures.push("registry next must resolve to the published beta candidate");
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
  || evidence.publicationControl?.branchProtected !== true
  || evidence.publicationControl?.environmentProtected !== true
  || evidence.publicationControl?.authentication !== "npm-trusted-publishing-oidc"
  || evidence.publicationControl?.npmCli !== "11.5.1"
  || evidence.publicationControl?.distTag !== "next"
  || evidence.publicationControl?.provenance !== true
  || evidence.publicationControl?.automaticPublish !== false) {
  failures.push("publication control must remain manual, protected, provenance-enabled, and next-only");
}
if (evidence.publication?.runId !== 35523173036
  || evidence.publication?.sourceSha !== "d5f272c6a5ec79bb5281c8165e190fba401df42f"
  || evidence.publication?.artifactId !== 10608933909
  || !/^https:\/\/github\.com\//.test(evidence.publication?.runUrl ?? "")) {
  failures.push("protected GitHub publication evidence is incomplete");
}
if (!/^\d{4}-\d{2}-\d{2}T/.test(evidence.registry?.publishedAt ?? "")
  || !/^[a-f0-9]{64}$/.test(evidence.registry?.sha256 ?? "")
  || !/^[a-f0-9]{40}$/.test(evidence.registry?.shasum ?? "")
  || !/^sha512-/.test(evidence.registry?.integrity ?? "")
  || !/^https:\/\/registry\.npmjs\.org\//.test(evidence.registry?.tarball ?? "")
  || !/^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\//.test(evidence.registry?.attestation ?? "")
  || evidence.registry?.files !== evidence.candidate?.files) {
  failures.push("published registry identity, integrity, file count, or provenance is incomplete");
}
if (evidence.publication?.postPublishValidation?.source !== "npm registry tarball"
  || evidence.publication?.postPublishValidation?.registryTarballSha256 !== evidence.registry?.sha256
  || !evidence.publication?.postPublishValidation?.core?.includes("stable 1.22.0 rollback passed")
  || !evidence.publication?.postPublishValidation?.createBrass?.includes("React and vanilla")) {
  failures.push("post-publication registry consumer and rollback validation is incomplete");
}
for (const [key, maximum] of [
  ["compressedBytes", budget.compressedBytes],
  ["unpackedBytes", budget.unpackedBytes],
]) {
  const value = evidence.registry?.[key];
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    failures.push(`published registry ${key} must be positive and <= ${maximum}`);
  }
}
if (evidence.rollback?.stable !== packageJson.version
  || evidence.rollback?.removeNext !== "npm dist-tag rm brass-runtime next"
  || !evidence.rollback?.deprecate?.includes(evidence.candidate.version)) {
  failures.push("published beta rollback must preserve stable latest and cover next removal/deprecation");
}
if (!Array.isArray(evidence.reproduce) || !evidence.reproduce.includes("npm run release:check")) {
  failures.push("release gate reproduction is required");
}

for (const fragment of [
  "github.ref == 'refs/heads/next' && inputs.publish",
  "environment: npm-next",
  "npm install --global npm@11.5.1",
  "test \"$(npm --version)\" = \"11.5.1\"",
  "npm run release:check",
  "--dry-run --access public --tag next --json",
  "--tag next",
  "--provenance",
  "for attempt in {1..20}",
  "sleep 15",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
]) {
  if (!publisher.includes(fragment)) failures.push(`publisher is missing ${fragment}`);
}

for (const fragment of [
  "channel:",
  "v2-beta",
  "uses: ./.github/workflows/publish-v2-beta.yml",
  "id-token: write",
]) {
  if (!releaseEntrypoint.includes(fragment)) failures.push(`trusted release entrypoint is missing ${fragment}`);
}

if (!publisher.includes("workflow_call:") || publisher.includes("NODE_AUTH_TOKEN:")) {
  failures.push("v2 beta publication must be called by the trusted OIDC release workflow without a write token");
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
    `published: yes, artifact checked: ${existsSync(artifactPath) ? "yes" : "no"}).`,
  );
}
