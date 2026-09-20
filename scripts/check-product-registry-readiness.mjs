#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidencePath = path.resolve(
  root,
  process.argv[2] ?? "docs/evidence/product-registry-readiness-2026-09-20.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const productSizeBudgets = JSON.parse(
  readFileSync(path.join(root, "scripts", "package-size-budget.json"), "utf8"),
).productTargets;
const workflow = readFileSync(
  path.join(root, ".github", "workflows", "publish-product-alpha.yml"),
  "utf8",
);
const failures = [];
const expectedProducts = new Map([
  ["agent", "@brass/agent"],
  ["perf", "@brass/perf"],
  ["engine-wasm", "@brass/engine-wasm"],
]);
const expectedAttemptRuns = new Map([
  ["agent", 35520793237],
  ["perf", 35520792929],
  ["engine-wasm", 35520792944],
]);

if (evidence.schemaVersion !== 3) failures.push("schemaVersion must be 3");
if (evidence.status !== "publication-blocked-on-npm-organization-read-access") {
  failures.push("product readiness must record the verified npm organization-access blocker");
}
if (!Array.isArray(evidence.products) || evidence.products.length !== expectedProducts.size) {
  failures.push("all three independent products are required");
} else {
  for (const product of evidence.products) {
    const expectedName = expectedProducts.get(product.id);
    if (!expectedName || product.package !== expectedName) failures.push(`invalid product identity: ${product.id}`);
    const manifest = JSON.parse(readFileSync(path.join(root, "packages", product.id, "package.json"), "utf8"));
    if (manifest.name !== product.package || manifest.version !== product.candidateVersion) {
      failures.push(`${product.id} evidence must match its package manifest`);
    }
    if (!/^0\.\d+\.\d+-alpha\.\d+$/.test(product.candidateVersion ?? "")) {
      failures.push(`${product.id} must use an exact alpha candidate version`);
    }
    if (product.registryPackageExists !== false) {
      failures.push(`${product.id} must remain a non-publication snapshot until npm is verified`);
    }
    const attempt = product.latestPublicationAttempt;
    if (attempt?.runId !== expectedAttemptRuns.get(product.id)
      || !/^https:\/\/github\.com\//.test(attempt?.runUrl ?? "")
      || !/^[a-f0-9]{40}$/.test(attempt?.sourceSha ?? "")
      || !/^\d{4}-\d{2}-\d{2}T/.test(attempt?.attemptedAt ?? "")
      || attempt?.httpStatus !== 404
      || attempt?.result !== "scope-not-found-or-token-not-authorized"
      || attempt?.registryMutation !== false
      || !/^https:\/\/search\.sigstore\.dev\//.test(attempt?.provenanceLog ?? "")) {
      failures.push(`${product.id} latest first-version publication failure evidence is incomplete`);
    }
    const dryRun = product.publishDryRun;
    const budget = productSizeBudgets?.[product.id];
    if (dryRun?.distTag !== "alpha"
      || dryRun?.access !== "public"
      || dryRun?.registryMutation !== false
      || !Number.isInteger(dryRun?.files)
      || !Number.isInteger(dryRun?.compressedBytes)
      || !Number.isInteger(dryRun?.unpackedBytes)
      || dryRun.files > budget?.fileCount
      || dryRun.compressedBytes > budget?.compressedBytes
      || dryRun.unpackedBytes > budget?.unpackedBytes) {
      failures.push(`${product.id} publication dry-run must be measured, non-mutating, alpha-only, and within budget`);
    }
  }
}

if (evidence.publicationControl?.branch !== "main"
  || evidence.publicationControl?.branchExistsAtRecordedAt !== true
  || evidence.publicationControl?.branchProtectedAtRecordedAt !== true
  || evidence.publicationControl?.environment !== "npm-products"
  || evidence.publicationControl?.environmentExistsAtRecordedAt !== true
  || evidence.publicationControl?.environmentProtectedAtRecordedAt !== true
  || evidence.publicationControl?.requiredReviewer !== "BaldrVivaldelli"
  || evidence.publicationControl?.npmTokenSecretExistsAtRecordedAt !== true
  || evidence.publicationControl?.authentication !== "granular-access-token-for-first-publication"
  || evidence.publicationControl?.distTag !== "alpha"
  || evidence.publicationControl?.provenance !== true
  || evidence.publicationControl?.automaticPublish !== false) {
  failures.push("product publication must remain manual, protected, provenance-enabled, and alpha-only");
}
if (!Array.isArray(evidence.validatedConditions) || evidence.validatedConditions.length < 7) {
  failures.push("product validation conditions are incomplete");
}
const bootstrap = evidence.bootstrapVerificationAttempt;
if (bootstrap?.runId !== 35538420035
  || bootstrap?.jobId !== 106151532383
  || bootstrap?.runUrl !== "https://github.com/BaldrVivaldelli/brass-runtime/actions/runs/35538420035"
  || !/^[a-f0-9]{40}$/.test(bootstrap?.sourceSha ?? "")
  || bootstrap?.environment !== "npm-products"
  || bootstrap?.environmentApproved !== true
  || bootstrap?.tokenIdentity !== "avivaldelli"
  || bootstrap?.whoami !== "passed"
  || bootstrap?.organizationMembershipRead?.httpStatus !== 403
  || bootstrap?.organizationMembershipRead?.result !== "forbidden"
  || bootstrap?.publicationReached !== false
  || bootstrap?.registryMutation !== false) {
  failures.push("latest npm bootstrap verification evidence is incomplete");
}
if (evidence.blocker?.code !== "E403"
  || !evidence.blocker?.causeBoundary?.includes("NPM_TOKEN")
  || !Array.isArray(evidence.blocker?.notCausedBy)
  || evidence.blocker.notCausedBy.length < 4) {
  failures.push("npm scope-access blocker must remain explicit and bounded by evidence");
}
if (!Array.isArray(evidence.remaining) || evidence.remaining.length < 5) {
  failures.push("first-publication requirements must remain explicit");
}

for (const fragment of [
  "github.ref == 'refs/heads/main' && inputs.publish",
  "environment: npm-products",
  "npm install --global npm@11.5.1",
  "npm whoami",
  "npm org ls brass",
  "npm run release:check",
  "--dry-run --access public --tag alpha --json",
  "--tag alpha --provenance",
  "for attempt in {1..20}",
  "sleep 15",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
]) {
  if (!workflow.includes(fragment)) failures.push(`product publisher is missing ${fragment}`);
}

if (failures.length > 0) {
  console.error("Product registry readiness validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Product registry readiness validated (${evidence.products.map((product) => product.package).join(", ")}; ` +
    "published: no, blocker: npm organization read access).",
  );
}
