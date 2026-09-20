#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const evidencePath = path.resolve(
  process.cwd(),
  process.argv[2] ?? "docs/evidence/adoption-discovery-2026-09-20.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const failures = [];

if (evidence.schemaVersion !== 2) failures.push("schemaVersion must be 2");
if (evidence.kind !== "adoption-discovery") failures.push("kind must be adoption-discovery");
if (evidence.inferredActiveUsers !== null) failures.push("download signals must not infer active users");
if (evidence.inferredProductionWorkloads !== null) failures.push("discovery signals must not infer production workloads");

const measurements = evidence.npmDownloads?.measurements;
if (!Array.isArray(measurements) || measurements.length !== 3) {
  failures.push("exactly three npm download windows are required");
} else {
  const periods = new Set(measurements.map((measurement) => measurement?.period));
  for (const period of ["last-week", "last-month", "last-year"]) {
    if (!periods.has(period)) failures.push(`missing npm period ${period}`);
  }
  for (const measurement of measurements) {
    if (!Number.isInteger(measurement?.downloads) || measurement.downloads < 0) {
      failures.push(`invalid download count for ${measurement?.period ?? "unknown period"}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(measurement?.start) || !/^\d{4}-\d{2}-\d{2}$/.test(measurement?.end)) {
      failures.push(`invalid measurement window for ${measurement?.period ?? "unknown period"}`);
    }
  }
}

if (!Number.isInteger(evidence.publicCodeSearch?.externalRepositories) || evidence.publicCodeSearch.externalRepositories < 0) {
  failures.push("externalRepositories must be a non-negative integer");
}
const dependencyRepositories = evidence.githubDependencyGraph?.repositories;
if (!Array.isArray(dependencyRepositories) || dependencyRepositories.length < 1) {
  failures.push("GitHub dependency graph repositories are required");
} else {
  const names = dependencyRepositories.map((entry) => entry?.name);
  if (new Set(names).size !== names.length) failures.push("GitHub dependency graph repositories must be unique");
  if (dependencyRepositories.some((entry) => typeof entry?.name !== "string" || typeof entry?.relationship !== "string")) {
    failures.push("GitHub dependency graph repositories require name and relationship");
  }
  if (evidence.githubDependencyGraph.reportedRepositories !== dependencyRepositories.length) {
    failures.push("GitHub dependency graph count must match its repository inventory");
  }
}
if (!Number.isInteger(evidence.githubDependencyGraph?.externalRepositories)
  || evidence.githubDependencyGraph.externalRepositories < 0) {
  failures.push("GitHub dependency graph externalRepositories must be a non-negative integer");
}
for (const key of ["stars", "forks", "subscribers"]) {
  if (!Number.isInteger(evidence.githubRepositorySignals?.[key]) || evidence.githubRepositorySignals[key] < 0) {
    failures.push(`invalid GitHub repository signal ${key}`);
  }
}
if (typeof evidence.npmRegistry?.latest !== "string"
  || !Number.isInteger(evidence.npmRegistry?.publishedVersions)
  || evidence.npmRegistry.publishedVersions < 1
  || !Number.isInteger(evidence.npmRegistry?.maintainers)
  || evidence.npmRegistry.maintainers < 1) {
  failures.push("npm registry version and maintainer signals are required");
}
if (!Number.isInteger(evidence.workspaceScan?.declaredDependencyConsumers) || evidence.workspaceScan.declaredDependencyConsumers < 0) {
  failures.push("declaredDependencyConsumers must be a non-negative integer");
}
if (!Array.isArray(evidence.verifiedConsumers) || evidence.verifiedConsumers.length < 1) {
  failures.push("at least one verified consumer is required");
} else if (evidence.verifiedConsumers.some((consumer) =>
  typeof consumer?.id !== "string"
  || typeof consumer?.relationship !== "string"
  || typeof consumer?.visibility !== "string"
  || typeof consumer?.evidence !== "string")) {
  failures.push("verified consumers require id, relationship, visibility, and evidence");
}
const createBrass = evidence.verifiedConsumers?.find((consumer) => consumer.id === "create-brass");
const publicVerification = createBrass?.publicVerification;
if (createBrass?.relationship !== "first-party-template-generator"
  || createBrass?.visibility !== "public"
  || publicVerification?.repository !== "BaldrVivaldelli/create-brass"
  || !/^https:\/\/github\.com\/BaldrVivaldelli\/create-brass\/blob\/[a-f0-9]{40}\/docs\/evidence\/beta-readiness-2026-09-20\.json$/.test(publicVerification?.evidenceUrl ?? "")
  || !/^[a-f0-9]{40}$/.test(publicVerification?.evidenceCommitSha ?? "")
  || !publicVerification?.evidenceUrl?.includes(publicVerification.evidenceCommitSha)
  || publicVerification?.migrationPullRequest !== 13
  || publicVerification?.runtimeBeta !== "brass-runtime@2.0.0-beta.0"
  || publicVerification?.candidate !== "create-brass@1.3.0-beta.0"
  || publicVerification?.candidateStatus !== "validated-not-published"
  || !Number.isInteger(publicVerification?.validationRunId)
  || publicVerification?.validationResult !== "success"
  || publicVerification?.templateModes !== 4
  || publicVerification?.buildsPassed !== 8
  || publicVerification?.buildsTotal !== 8
  || !/^[a-f0-9]{64}$/.test(publicVerification?.tarballSha256 ?? "")
  || publicVerification?.authentication !== "npm-trusted-publishing-oidc"
  || publicVerification?.publicationRequested !== false
  || publicVerification?.trustedPublisherConfiguration !== "owner-confirmation-required"
  || publicVerification?.registryLatest !== "1.2.1"
  || publicVerification?.registryNext !== null
  || !publicVerification?.claimBoundary?.includes("not independent external production adoption")) {
  failures.push("create-brass public verification or first-party claim boundary is incomplete");
}
if (!Array.isArray(evidence.limitations) || evidence.limitations.length < 3) {
  failures.push("at least three discovery limitations are required");
}
if (!Array.isArray(evidence.reproduce) || evidence.reproduce.length < 4) {
  failures.push("reproduction commands for every discovery source are required");
}

if (failures.length > 0) {
  console.error("Adoption discovery validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Adoption discovery validated (${measurements.find((entry) => entry.period === "last-year").downloads} yearly downloads, ` +
    `${evidence.githubDependencyGraph.reportedRepositories} dependency-graph repositories, ` +
    `${evidence.githubDependencyGraph.externalRepositories} external, no inferred users).`,
  );
}
