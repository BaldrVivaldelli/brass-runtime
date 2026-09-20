#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const requestedPaths = process.argv.slice(2);
const evidencePaths = requestedPaths.length > 0
  ? requestedPaths.map((file) => path.resolve(process.cwd(), file))
  : readdirSync(path.resolve(process.cwd(), "docs/evidence"))
    .filter((file) => /^v2-migration-.*\.json$/.test(file))
    .sort()
    .map((file) => path.resolve(process.cwd(), "docs/evidence", file));

let invalid = false;

for (const evidencePath of evidencePaths) {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const failures = validate(evidence);
  if (failures.length > 0) {
    invalid = true;
    console.error(`Adoption evidence validation failed (${path.relative(process.cwd(), evidencePath)}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    continue;
  }
  console.log(
    `Adoption evidence validated (${evidence.consumerId}: ${evidence.source.filesScanned} files, ` +
    `${evidence.result.manualDecisions} manual decisions, consent: ${evidence.consent}).`,
  );
}

if (invalid) process.exitCode = 1;

function validate(evidence) {
  const failures = [];

  if (evidence.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (typeof evidence.consumerId !== "string" || evidence.consumerId.length < 3) failures.push("consumerId is required");
  if (!new Set(["assessment", "completed"]).has(evidence.stage)) failures.push("stage must be assessment or completed");
  if (!new Set(["not-requested", "denied", "granted"]).has(evidence.consent)) failures.push("invalid consent state");
  if (evidence.publishableCaseStudy === true && evidence.consent !== "granted") {
    failures.push("a publishable case study requires granted consent");
  }
  if (!Number.isInteger(evidence.source?.filesScanned) || evidence.source.filesScanned < 1) {
    failures.push("filesScanned must be a positive integer");
  }

  for (const key of ["filesWithV1Imports", "documentedMappings", "directMoves", "manualDecisions", "parseErrors"]) {
    if (!Number.isInteger(evidence.result?.[key]) || evidence.result[key] < 0) failures.push(`${key} must be a non-negative integer`);
  }
  if (evidence.result?.filesWithV1Imports > evidence.source?.filesScanned) {
    failures.push("filesWithV1Imports cannot exceed filesScanned");
  }
  if (!Array.isArray(evidence.manualImports)) {
    failures.push("manualImports must be an array");
  } else {
    const names = evidence.manualImports.map((entry) => entry?.name);
    if (new Set(names).size !== names.length) failures.push("manualImports must have unique names");
    const occurrences = evidence.manualImports.reduce((total, entry) => {
      if (typeof entry?.name !== "string" || !Number.isInteger(entry?.occurrences) || entry.occurrences < 1) {
        failures.push("manualImports entries require a name and positive occurrence count");
        return total;
      }
      return total + entry.occurrences;
    }, 0);
    if (occurrences !== evidence.result?.manualDecisions) failures.push("manual import occurrences must equal manualDecisions");
  }
  if (!Array.isArray(evidence.limitations) || evidence.limitations.length < 3) {
    failures.push("at least three limitations are required");
  }
  if (typeof evidence.reproduce !== "string" || !evidence.reproduce.includes("analyze-v2-migration")) {
    failures.push("the migration analyzer reproduction command is required");
  }
  if (evidence.registryFollowUp !== undefined) {
    const followUp = evidence.registryFollowUp;
    if (followUp?.source !== "npm registry tarball"
      || followUp?.version !== "2.0.0-beta.0"
      || followUp?.distTag !== "next"
      || !/^[a-f0-9]{64}$/.test(followUp?.registryTarballSha256 ?? "")
      || followUp?.publicationEvidence !== "docs/evidence/v2-beta-readiness-2026-09-20.json"
      || !Array.isArray(followUp?.checks)
      || followUp.checks.length < 5) {
      failures.push("registry follow-up must identify the public beta tarball and replayed rollback checks");
    }
  }

  if (evidence.stage === "completed") validateCompletedMigration(evidence, failures);
  return failures;
}

function validateCompletedMigration(evidence, failures) {
  const startedAt = Date.parse(evidence.migration?.startedAt);
  const finishedAt = Date.parse(evidence.migration?.finishedAt);
  const measuredSeconds = (finishedAt - startedAt) / 1000;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    failures.push("completed migrations require a valid measurement window");
  }
  if (!Number.isInteger(evidence.migration?.durationSeconds) || evidence.migration.durationSeconds < 1) {
    failures.push("completed migrations require a positive integer durationSeconds");
  } else if (Number.isFinite(measuredSeconds) && measuredSeconds !== evidence.migration.durationSeconds) {
    failures.push("durationSeconds must match the measurement window");
  }
  if (!Array.isArray(evidence.thresholds) || evidence.thresholds.length < 1 || evidence.thresholds.some((threshold) => threshold?.passed !== true)) {
    failures.push("completed migrations require passing predeclared thresholds");
  }
  if (!Array.isArray(evidence.negativeFindings) || evidence.negativeFindings.length < 1) {
    failures.push("completed migrations must retain negative findings");
  }
  if (typeof evidence.rollbackPath !== "string" || evidence.rollbackPath.length < 10) {
    failures.push("completed migrations require a rollback path");
  }
  if (evidence.validation?.templateBuildsPassed !== evidence.validation?.templateBuildsTotal) {
    failures.push("all declared template builds must pass");
  }
  if (evidence.validation?.publishedPackageTemplateBuildsPassed !== evidence.validation?.publishedPackageTemplateBuildsTotal) {
    failures.push("all declared published-package template builds must pass");
  }
  if (evidence.validation?.rollbackTemplateBuildsPassed !== evidence.validation?.rollbackTemplateBuildsTotal) {
    failures.push("all declared rollback template builds must pass");
  }
}
