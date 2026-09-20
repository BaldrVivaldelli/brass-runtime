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

if (evidence.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (evidence.status !== "candidates-validated-not-published") {
  failures.push("product readiness must not claim publication before registry packages exist");
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
  || evidence.publicationControl?.branchProtectedAtRecordedAt !== false
  || evidence.publicationControl?.environment !== "npm-products"
  || evidence.publicationControl?.environmentExistsAtRecordedAt !== false
  || evidence.publicationControl?.npmTokenSecretExistsAtRecordedAt !== true
  || evidence.publicationControl?.distTag !== "alpha"
  || evidence.publicationControl?.provenance !== true
  || evidence.publicationControl?.automaticPublish !== false) {
  failures.push("product publication must remain manual, protected, provenance-enabled, and alpha-only");
}
if (!Array.isArray(evidence.validatedConditions) || evidence.validatedConditions.length < 7) {
  failures.push("product validation conditions are incomplete");
}
if (!Array.isArray(evidence.remaining) || evidence.remaining.length < 5) {
  failures.push("first-publication requirements must remain explicit");
}

for (const fragment of [
  "github.ref == 'refs/heads/main' && inputs.publish",
  "environment: npm-products",
  "npm run release:check",
  "--dry-run --access public --tag alpha --json",
  "--tag alpha --provenance",
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
    `Product registry readiness validated (${evidence.products.map((product) => product.package).join(", ")}; published: no).`,
  );
}
