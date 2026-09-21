#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidencePath = path.resolve(
  root,
  process.argv[2] ?? "docs/evidence/stable-release-validation-2026-09-21.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const nodePolicy = JSON.parse(readFileSync(path.join(root, "scripts", "node-support-policy.json"), "utf8"));
const betaEvidence = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "v2-beta-readiness-2026-09-20.json"),
  "utf8",
));
const failures = [];

if (evidence.schemaVersion !== 1 || evidence.kind !== "stable-release-validation") {
  failures.push("invalid stable release validation schema or kind");
}
if (evidence.packageVersion !== packageJson.version) {
  failures.push("stable release evidence package version mismatch");
}
if (evidence.sourceSha !== "ed023ffb993261bb9f6ecdbf9b15adf16105d75f") {
  failures.push("stable release source SHA does not match the retained run");
}

const workflow = evidence.workflow;
const startedAt = Date.parse(workflow?.startedAt);
const completedAt = Date.parse(workflow?.completedAt);
if (workflow?.name !== "Release"
  || workflow?.runId !== 35547826504
  || workflow?.runUrl !== `https://github.com/BaldrVivaldelli/brass-runtime/actions/runs/${workflow?.runId}`
  || workflow?.event !== "workflow_dispatch"
  || workflow?.branch !== "main"
  || workflow?.conclusion !== "success"
  || workflow?.dispatch?.channel !== "stable"
  || workflow?.dispatch?.publish !== false
  || !Number.isFinite(startedAt)
  || !Number.isFinite(completedAt)
  || completedAt < startedAt
  || Date.parse(evidence.recordedAt) < completedAt) {
  failures.push("stable release workflow identity, dispatch controls, or successful duration is invalid");
}

validateNodeJobs(
  "compatibility smoke",
  evidence.nodeValidation?.compatibilitySmoke,
  nodePolicy.stableV1.compatibilitySmoke,
  { "18": 106176854046 },
);
validateNodeJobs(
  "full validation",
  evidence.nodeValidation?.fullValidation,
  nodePolicy.stableV1.fullValidation,
  { "20": 106176854169, "22": 106176854232, "24": 106176854241 },
);
if (evidence.nodeValidation?.canonicalNode !== nodePolicy.canonicalBuildNode) {
  failures.push("canonical validation Node must match the support policy");
}
const requiredCanonicalChecks = [
  "npm run validate:boundaries",
  "npm run validate:dependency-security",
  "npm run validate:evidence",
  "npm run validate:adoption-evidence",
  "npm run validate:release-policy",
  "npm run test:types",
  "npm run rust:check",
  "npm run rust:fuzz:check",
  "npm run build",
  "npm run validate:example:express",
  "npm run validate:api",
  "npm run validate:v2-map",
  "npm run validate:wasm",
  "npm run test:coverage",
  "npm run validate:cjs",
  "npm run validate:browser",
  "npm run validate:package",
  "npm run validate:products",
  "npm run perf:runtime:budget",
  "npm run benchmark:runtime:budget",
  "npm run benchmark:runtime:primitives:budget",
  "npm run benchmark:http:budget",
  "npm run benchmark:observability:budget",
];
if (!Array.isArray(evidence.nodeValidation?.canonicalChecks)
  || requiredCanonicalChecks.some((command) => !evidence.nodeValidation.canonicalChecks.includes(command))) {
  failures.push("canonical Node validation does not record every release gate");
}

const expectedArtifacts = new Map([
  ["windows-x64", {
    jobId: 106176854138,
    artifactId: 10617600889,
    name: "brass-native-service-Windows-X64",
    sizeBytes: 216837,
    digest: "sha256:44d73c14c64076c47a0c75a2767b7f3c9f883f5f55fce5b1541b47cdedc6cb4f",
  }],
  ["linux-x64", {
    jobId: 106176854171,
    artifactId: 10617281262,
    name: "brass-native-service-Linux-X64",
    sizeBytes: 362526,
    digest: "sha256:90fdad81ce018c3ed0a1861a756ca662cb847630eca24757552a26425be4b314",
  }],
  ["macos-arm64", {
    jobId: 106176854199,
    artifactId: 10617216370,
    name: "brass-native-service-macOS-ARM64",
    sizeBytes: 330779,
    digest: "sha256:183e6a4686899a7c78928186b484876afd74805d36d67e20b69eeccabcb08d9f",
  }],
]);
if (!Array.isArray(evidence.nativeArtifacts) || evidence.nativeArtifacts.length !== expectedArtifacts.size) {
  failures.push("stable release evidence must contain exactly three native artifacts");
} else {
  for (const artifact of evidence.nativeArtifacts) {
    const expected = expectedArtifacts.get(artifact.platform);
    if (artifact.name !== expected?.name
      || artifact.jobId !== expected?.jobId
      || artifact.jobConclusion !== "success"
      || artifact.artifactId !== expected?.artifactId
      || artifact.sizeBytes !== expected?.sizeBytes
      || artifact.digest !== expected?.digest
      || Date.parse(artifact.expiresAt) <= completedAt) {
      failures.push(`native artifact ${artifact.platform ?? "unknown"} is incomplete or unsuccessful`);
    }
  }
  if (new Set(evidence.nativeArtifacts.map((artifact) => artifact.platform)).size !== expectedArtifacts.size) {
    failures.push("stable release native artifact platforms must be unique");
  }
}

for (const [name, { job, expectedJobId }] of Object.entries({
  release: { job: evidence.publisherJobs?.release, expectedJobId: 106177651598 },
  "v2-beta": { job: evidence.publisherJobs?.v2Beta, expectedJobId: 106177651657 },
})) {
  if (job?.jobId !== expectedJobId || job?.conclusion !== "skipped" || job?.stepCount !== 0) {
    failures.push(`${name} publisher must be skipped without executing steps`);
  }
}
if (evidence.publicationAttempted !== false || evidence.registryMutation !== false) {
  failures.push("validation-only evidence must prove that publication and registry mutation were not attempted");
}
const expectedTags = {
  latest: packageJson.version,
  next: betaEvidence.candidate.version,
};
if (JSON.stringify(evidence.registrySnapshotBefore) !== JSON.stringify(expectedTags)
  || JSON.stringify(evidence.registrySnapshotAfter) !== JSON.stringify(expectedTags)) {
  failures.push("registry tags must remain unchanged across validation-only execution");
}
if (evidence.decision !== "stable-matrix-and-native-artifacts-passed-with-publishers-skipped"
  || !evidence.claimBoundary?.includes("without publishing a package")) {
  failures.push("stable release decision or non-publication claim boundary is invalid");
}
if (!Array.isArray(evidence.reproduce)
  || !evidence.reproduce.includes("node scripts/check-stable-release-validation.mjs")) {
  failures.push("stable release evidence requires a local reproduction command");
}

if (failures.length > 0) {
  console.error("Stable release validation evidence failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Stable release validation evidence passed (run ${workflow.runId}, `
    + `Node ${[...nodePolicy.stableV1.compatibilitySmoke, ...nodePolicy.stableV1.fullValidation].join("/")}, `
    + `${evidence.nativeArtifacts.length} native artifacts, publishers skipped).`,
  );
}

function validateNodeJobs(label, jobs, expectedNodes, expectedJobIds) {
  if (!jobs || JSON.stringify(Object.keys(jobs).map(Number)) !== JSON.stringify(expectedNodes)) {
    failures.push(`${label} Node jobs do not match the support policy`);
    return;
  }
  for (const node of expectedNodes) {
    const job = jobs[String(node)];
    if (job?.jobId !== expectedJobIds[String(node)] || job?.conclusion !== "success") {
      failures.push(`${label} Node ${node} job is incomplete or unsuccessful`);
    }
  }
}
