#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  const actual = {
    id: report.id,
    name: report.name,
    version: report.version,
    files: report.entryCount ?? report.files?.length,
    compressedBytes: report.size,
    unpackedBytes: report.unpackedSize,
  };
  const expected = {
    id: `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    files: recorded.publishDryRun.files,
    compressedBytes: recorded.publishDryRun.compressedBytes,
    unpackedBytes: recorded.publishDryRun.unpackedBytes,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${manifest.name} dry-run ${key} changed: ${actual[key]} !== ${value}`);
    }
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
