#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidencePath = path.resolve(
  root,
  process.argv[2] ?? "docs/evidence/next-level-readiness-2026-09-21.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const failures = [];
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const readText = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

if (evidence.schemaVersion !== 1 || evidence.kind !== "next-level-readiness") {
  failures.push("invalid next-level readiness schema or kind");
}
if (evidence.baselineMainSha !== "48089a2632ec538851c780b97d873436fdcb7462"
  || !Number.isFinite(Date.parse(evidence.recordedAt))) {
  failures.push("next-level readiness baseline identity or timestamp is invalid");
}
if (evidence.outcome !== "three-objectives-verified-with-publication-deferred") {
  failures.push("next-level readiness outcome must verify all three objectives without requiring publication");
}

validateAdoption();
validateProductAndV2();
validateOperations();

if (!Array.isArray(evidence.limitations)
  || evidence.limitations.length < 4
  || !evidence.limitations.some((entry) => entry.includes("does not claim an external production adopter"))
  || !evidence.limitations.some((entry) => entry.includes("has not completed"))
  || !evidence.limitations.some((entry) => entry.includes("history is still accumulating"))
  || !evidence.limitations.some((entry) => entry.includes("publication is intentionally deferred"))) {
  failures.push("readiness limitations must retain adoption, ownership, trend, and publication boundaries");
}
if (!Array.isArray(evidence.reproduce)
  || !evidence.reproduce.includes("npm run validate:next-level-readiness")
  || !evidence.reproduce.includes("npm run release:check")
  || evidence.reproduce.some((command) => /\bnpm publish\b/.test(command))) {
  failures.push("readiness reproduction must include the master and release gates without publication commands");
}

if (failures.length > 0) {
  console.error("Next-level readiness validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Next-level readiness validated (3 objectives, ${evidence.adoptionAndEvidence.useCases.length} `
    + `consented internal use cases, ${evidence.productAndApiV2.independentProducts.length} `
    + "independent product candidates, registry publication deferred).",
  );
}

function validateAdoption() {
  const adoption = evidence.adoptionAndEvidence;
  if (adoption?.status !== "verified-with-consented-internal-use-cases") {
    failures.push("adoption objective must be verified with consented internal use cases");
    return;
  }
  if (adoption.discoveryEvidence !== "docs/evidence/adoption-discovery-2026-09-20.json") {
    failures.push("adoption discovery evidence path is invalid");
    return;
  }
  const discovery = readJson(adoption.discoveryEvidence);
  const verifiedConsumerIds = discovery.verifiedConsumers?.map((consumer) => consumer.id).sort() ?? [];
  if (JSON.stringify(adoption.verifiedConsumerIds) !== JSON.stringify(["create-brass"])
    || !adoption.verifiedConsumerIds.every((id) => verifiedConsumerIds.includes(id))
    || discovery.githubDependencyGraph?.externalRepositories !== 0
    || discovery.inferredActiveUsers !== null
    || discovery.inferredProductionWorkloads !== null) {
    failures.push("adoption discovery must retain the verified first-party consumer and zero external inference");
  }

  const useCases = adoption.useCases;
  if (adoption.useCaseTarget?.minimum !== 2
    || adoption.useCaseTarget?.observed !== useCases?.length
    || JSON.stringify(adoption.useCaseTarget?.allowedKinds) !== JSON.stringify(["internal", "external"])
    || !Array.isArray(useCases)
    || useCases.length < adoption.useCaseTarget.minimum) {
    failures.push("adoption objective requires at least two internal or external use cases");
    return;
  }
  const expectedUseCases = new Map([
    ["workspace-template-lighthouse-1", "docs/evidence/v2-migration-lighthouse-1-2026-09-20.json"],
    ["internal-express-observability-lighthouse-2", "docs/evidence/v2-migration-lighthouse-2-2026-09-20.json"],
    ["internal-core-effect-stream-lighthouse-3", "docs/evidence/v2-migration-lighthouse-3-2026-09-20.json"],
  ]);
  if (useCases.length !== expectedUseCases.size
    || new Set(useCases.map((useCase) => useCase.id)).size !== useCases.length) {
    failures.push("adoption readiness must retain the three unique lighthouse use cases");
  }
  for (const useCase of useCases) {
    if (useCase.kind !== "internal" || expectedUseCases.get(useCase.id) !== useCase.evidence) {
      failures.push(`use case ${useCase.id ?? "unknown"} identity or evidence path is invalid`);
      continue;
    }
    const record = readJson(useCase.evidence);
    if (record.consumerId !== useCase.id
      || record.stage !== "completed"
      || record.consent !== "granted"
      || record.publishableCaseStudy !== false
      || !Array.isArray(record.thresholds)
      || record.thresholds.length < 1
      || record.thresholds.some((threshold) => threshold.passed !== true)
      || !Array.isArray(record.negativeFindings)
      || record.negativeFindings.length < 1
      || typeof record.rollbackPath !== "string"
      || record.rollbackPath.length < 10
      || !record.reproduce?.includes("analyze-v2-migration")) {
      failures.push(`use case ${useCase.id} lacks consented, reproducible migration and rollback evidence`);
    }
  }

  const metrics = adoption.metricsAndInventory;
  if (metrics?.productionEvidence !== "docs/production-evidence.md"
    || metrics?.privateInventoryContract !== "docs/adopter-inventory.md"
    || metrics?.aggregateCommand !== "npm run adoption:report") {
    failures.push("adoption metrics and inventory contract are incomplete");
  } else {
    const productionEvidence = readText(metrics.productionEvidence);
    const inventoryContract = readText(metrics.privateInventoryContract);
    for (const fragment of ["Documented internal use cases", "zero external-production adopters", "zero publishable adopter case studies"]) {
      if (!productionEvidence.includes(fragment)) failures.push(`production evidence is missing: ${fragment}`);
    }
    for (const fragment of ["active30Days", "active90Days", "upgradeLagDays", "deploymentStage", "consent"]) {
      if (!inventoryContract.includes(fragment)) failures.push(`adopter inventory is missing metric: ${fragment}`);
    }
  }
  if (adoption.claims?.externalProductionAdopters !== 0
    || adoption.claims?.publishableExternalCaseStudies !== 0
    || adoption.claims?.downloadsTreatedAsUsers !== false) {
    failures.push("adoption readiness must not invent external users or case studies");
  }
}

function validateProductAndV2() {
  const product = evidence.productAndApiV2;
  if (product?.status !== "verified") {
    failures.push("product and v2 objective must be verified");
    return;
  }
  const useCasePaths = evidence.adoptionAndEvidence?.useCases?.map((useCase) => useCase.evidence) ?? [];
  if (JSON.stringify(product.migrationEvidence) !== JSON.stringify(useCasePaths)) {
    failures.push("v2 migration evidence must match the consented lighthouse set");
  }

  const tooling = product.migrationTooling;
  if (tooling?.mode !== "read-only"
    || tooling?.script !== "scripts/analyze-v2-migration.mjs"
    || tooling?.tests !== "scripts/__tests__/analyze-v2-migration.test.mjs"
    || tooling?.guide !== "docs/migration-v1-to-v2.md"
    || ![tooling?.script, tooling?.tests, tooling?.guide].every((file) => existsSync(path.join(root, file)))) {
    failures.push("read-only v2 migration tooling, tests, or guide is incomplete");
  } else {
    const migrationGuide = readText(tooling.guide);
    if (!migrationGuide.includes("It never edits") || !migrationGuide.includes("application files.")) {
      failures.push("v2 migration guide must preserve the read-only tooling boundary");
    }
  }

  if (product.apiDisposition?.path !== "docs/v1-to-v2-export-map.json") {
    failures.push("v1-to-v2 API disposition path is invalid");
  } else {
    const apiMap = readJson(product.apiDisposition.path);
    if (apiMap.summary?.totalV1RootExports !== product.apiDisposition.totalV1RootExports
      || apiMap.summary?.uncovered !== product.apiDisposition.uncovered
      || product.apiDisposition.totalV1RootExports !== 546
      || product.apiDisposition.uncovered !== 0
      || Object.keys(apiMap.exports ?? {}).length !== apiMap.summary.totalV1RootExports) {
      failures.push("v1-to-v2 API disposition must cover all 546 root exports");
    }
  }

  const beta = product.beta;
  if (beta?.evidence !== "docs/evidence/v2-beta-readiness-2026-09-20.json") {
    failures.push("v2 beta evidence path is invalid");
  } else {
    const betaEvidence = readJson(beta.evidence);
    if (beta.version !== "2.0.0-beta.0"
      || beta.distTag !== "next"
      || beta.rollbackBridge !== "brass-runtime/v1"
      || betaEvidence.status !== "published-on-next"
      || betaEvidence.candidate?.version !== beta.version
      || betaEvidence.registry?.next !== beta.version
      || betaEvidence.registry?.latest !== readJson("package.json").version
      || betaEvidence.rollback?.stable !== readJson("package.json").version
      || !betaEvidence.validatedConditions?.some((condition) => condition.includes("@brass/engine-wasm"))) {
      failures.push("v2 beta package, optional engine, registry, or rollback evidence is incomplete");
    }
  }

  const expectedProducts = new Map([
    ["@brass/agent", { version: "0.1.0-alpha.0", manifest: "packages/agent/package.json", bin: "brass-agent" }],
    ["@brass/perf", { version: "0.1.0-alpha.0", manifest: "packages/perf/package.json", bin: "brass-perf" }],
    ["@brass/engine-wasm", { version: "0.1.0-alpha.0", manifest: "packages/engine-wasm/package.json", bin: null }],
  ]);
  if (!Array.isArray(product.independentProducts)
    || product.independentProducts.length !== expectedProducts.size
    || new Set(product.independentProducts.map((candidate) => candidate.name)).size !== expectedProducts.size) {
    failures.push("product readiness requires three unique independent candidates");
  } else {
    for (const candidate of product.independentProducts) {
      const expected = expectedProducts.get(candidate.name);
      if (!expected
        || candidate.version !== expected.version
        || candidate.manifest !== expected.manifest) {
        failures.push(`independent product ${candidate.name ?? "unknown"} identity is invalid`);
        continue;
      }
      const manifest = readJson(expected.manifest);
      if (manifest.name !== candidate.name
        || manifest.version !== candidate.version
        || manifest.private === true
        || typeof manifest.main !== "string"
        || typeof manifest.types !== "string"
        || typeof manifest.exports?.["."] !== "object"
        || (expected.bin && manifest.bin?.[expected.bin] === undefined)) {
        failures.push(`independent product ${candidate.name} manifest is incomplete`);
      }
    }
  }

  const packageJson = readJson("package.json");
  const validation = product.packageValidation;
  const stableEvidence = validation?.releaseEvidence && readJson(validation.releaseEvidence);
  if (validation?.command !== "npm run validate:products"
    || validation?.releaseEvidence !== "docs/evidence/stable-release-validation-2026-09-21.json"
    || !stableEvidence?.nodeValidation?.canonicalChecks?.includes(validation.command)
    || !packageJson.scripts?.["release:check"]?.includes(validation.command)
    || JSON.stringify(validation?.v1CompatibilityEntrypoints) !== JSON.stringify(["./agent", "./perf"])
    || !validation.v1CompatibilityEntrypoints.every((entrypoint) => packageJson.exports?.[entrypoint])) {
    failures.push("independent package execution evidence or v1 compatibility entrypoints are incomplete");
  }
  if (product.companionRegistryPublication !== "deferred-not-required-for-readiness") {
    failures.push("companion registry publication must remain deferred and outside readiness");
  }
}

function validateOperations() {
  const operations = evidence.operationalMaturity;
  if (operations?.status !== "verified") {
    failures.push("operational maturity objective must be verified");
    return;
  }
  const expectedPaths = {
    stableReleaseEvidence: "docs/evidence/stable-release-validation-2026-09-21.json",
    nodePolicy: "scripts/node-support-policy.json",
    packageSizeBudget: "scripts/package-size-budget.json",
    stabilityEvidence: "docs/evidence/stability-ci-2026-09-20.json",
    stabilityWorkflow: ".github/workflows/stability.yml",
    coveragePolicy: "vitest.config.ts",
    supportAndMaintenance: "docs/support-and-maintenance.md",
    migrationAndRollback: "docs/migration-v1-to-v2.md",
  };
  for (const [key, expected] of Object.entries(expectedPaths)) {
    if (operations[key] !== expected || !existsSync(path.join(root, expected))) {
      failures.push(`operational readiness path ${key} is invalid`);
    }
  }

  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const stable = readJson(expectedPaths.stableReleaseEvidence);
  const nodePolicy = readJson(expectedPaths.nodePolicy);
  if (packageJson.version !== packageLock.version
    || packageJson.version !== packageLock.packages?.[""].version
    || stable.packageVersion !== packageJson.version
    || stable.workflow?.conclusion !== "success"
    || stable.workflow?.dispatch?.publish !== false
    || stable.publicationAttempted !== false
    || stable.registryMutation !== false
    || stable.publisherJobs?.release?.conclusion !== "skipped"
    || stable.publisherJobs?.v2Beta?.conclusion !== "skipped"
    || JSON.stringify(Object.keys(stable.nodeValidation?.compatibilitySmoke ?? {}).map(Number))
      !== JSON.stringify(nodePolicy.stableV1?.compatibilitySmoke)
    || JSON.stringify(Object.keys(stable.nodeValidation?.fullValidation ?? {}).map(Number))
      !== JSON.stringify(nodePolicy.stableV1?.fullValidation)) {
    failures.push("stable version synchronization, Node matrix, or validation-only release evidence is incomplete");
  }

  const sizeBudget = readJson(expectedPaths.packageSizeBudget);
  if (sizeBudget.schemaVersion !== 1
    || sizeBudget.maximum?.fileCount > 220
    || sizeBudget.maximum?.compressedBytes > 1_150_000
    || sizeBudget.maximum?.unpackedBytes > 4_875_000
    || Object.keys(sizeBudget.productTargets ?? {}).sort().join(",") !== "agent,engine-wasm,perf"
    || !stable.nodeValidation?.canonicalChecks?.includes("npm run validate:package")) {
    failures.push("stable and independent package-size budgets are incomplete or unproven");
  }

  const stability = readJson(expectedPaths.stabilityEvidence);
  if (stability.decision !== "two-retained-ci-stability-gates-and-post-merge-manifest-proof-passed"
    || stability.comparison?.runCount < 2
    || stability.comparison?.allBudgetsPassed !== true
    || stability.comparison?.weeklyTrendEstablished !== false
    || operations.scheduledTrend !== "capability-verified-history-accumulating") {
    failures.push("retained stability evidence or scheduled-trend boundary is invalid");
  }
  const stabilityWorkflow = readText(expectedPaths.stabilityWorkflow);
  for (const fragment of [
    'cron: "0 3 * * 6"',
    "npm run test:stability",
    "npm run perf:stability:soak",
    "npm run benchmark:http:stability",
    "npm run benchmark:adaptive:stability",
    "npm run stability:trend -- --allow-incomplete",
    "retention-days: 90",
  ]) {
    if (!stabilityWorkflow.includes(fragment)) failures.push(`scheduled stability workflow is missing: ${fragment}`);
  }

  const coveragePolicy = readText(expectedPaths.coveragePolicy);
  for (const surface of ["src/core/**/*.ts", "src/http/**/*.ts", "src/schema/**/*.ts", "src/observability/**/*.ts"]) {
    if (!coveragePolicy.includes(`"${surface}"`)) failures.push(`coverage policy is missing stable surface: ${surface}`);
  }
  const support = readText(expectedPaths.supportAndMaintenance);
  for (const fragment of ["v1 LTS window", "v2 beta migration and rollback", "Adding a second release-capable maintainer"]) {
    if (!support.includes(fragment)) failures.push(`support policy is missing: ${fragment}`);
  }
  const migration = readText(expectedPaths.migrationAndRollback);
  if (!migration.includes("retain the known-good v1 lockfile") || !migration.includes("Roll back by restoring that lockfile")) {
    failures.push("migration documentation must retain a tested v1 rollback path");
  }
  if (operations.releaseGate !== "npm run release:check"
    || !packageJson.scripts?.["release:check"]?.includes("npm run test:coverage")
    || !packageJson.scripts?.["release:check"]?.includes("npm run validate:products")
    || operations.releaseOwnership !== "single-maintainer-with-qualified-expansion-path") {
    failures.push("release gate, coverage, products, or maintenance ownership path is incomplete");
  }
}
