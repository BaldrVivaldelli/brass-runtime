#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateProductPublishReport } from "./product-publish-report.mjs";

const root = path.resolve(import.meta.dirname, "..");
const requested = process.argv[2];
const supported = new Set(["agent", "perf", "engine-wasm"]);
if (requested && !supported.has(requested)) {
  throw new Error(`Unknown product '${requested}'. Expected agent, perf, or engine-wasm.`);
}
const products = requested ? [requested] : [...supported];
const evidence = JSON.parse(readFileSync(
  path.join(root, "docs", "evidence", "product-registry-readiness-2026-09-20.json"),
  "utf8",
));
const evidenceById = new Map(evidence.products.map((product) => [product.id, product]));
const productSizeBudgets = JSON.parse(readFileSync(
  path.join(root, "scripts", "package-size-budget.json"),
  "utf8",
)).productTargets;
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "brass-product-publish-dry-run-"));

try {
  for (const product of products) validateProduct(product);
  console.log(`Product publication dry-runs validated: ${products.join(", ")}.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function validateProduct(product) {
  const manifest = JSON.parse(readFileSync(path.join(root, "packages", product, "package.json"), "utf8"));
  const recorded = evidenceById.get(product);
  if (!recorded) throw new Error(`${product} is missing registry-readiness evidence`);

  const result = spawnSync(npmCommand(), [
    "publish",
    `./packages/${product}`,
    "--ignore-scripts",
    "--dry-run",
    "--access",
    "public",
    "--tag",
    "alpha",
    "--json",
    "--cache",
    path.join(temporaryRoot, "npm-cache"),
  ], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm publish dry-run failed for ${product}:\n${result.stdout}${result.stderr}`);
  }
  if (result.stderr.includes("auto-corrected")) {
    throw new Error(`${manifest.name} requires npm manifest normalization:\n${result.stderr}`);
  }

  const report = JSON.parse(result.stdout);
  const actual = validateProductPublishReport({
    manifest,
    recorded,
    report,
    budget: productSizeBudgets[product],
  });
  console.log(
    `${manifest.name} dry-run: ${actual.files} files, ${actual.compressedBytes} compressed bytes, ` +
    `${actual.unpackedBytes} unpacked bytes.`,
  );
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
