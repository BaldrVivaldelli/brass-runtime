#!/usr/bin/env node
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(0, "utf8"));
const packageReport = report[0] ?? {};
const packageFiles = packageReport.files ?? [];
const paths = new Set(packageFiles.map((file) => file.path));
const sizeBudget = JSON.parse(readFileSync(new URL("./package-size-budget.json", import.meta.url), "utf8"));
const required = [
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "dist/index.cjs",
  "dist/index.mjs",
  "dist/index.d.ts",
  "dist/next.cjs",
  "dist/next.mjs",
  "dist/next.d.ts",
  "dist/browser/index.mjs",
  "dist/browser/next.mjs",
  "dist/browser/core/index.mjs",
  "dist/browser/http/index.mjs",
  "dist/browser/observability/index.mjs",
  "docs/migration-v1-to-v2.md",
  "docs/production-evidence.md",
  "docs/support-and-maintenance.md",
  "wasm/pkg/brass_runtime_wasm_engine.js",
  "wasm/pkg/brass_runtime_wasm_engine_bg.wasm",
  "wasm/pkg/brass-runtime-build.json",
];
const missing = required.filter((entry) => !paths.has(entry));

if (missing.length > 0) {
  console.error(`Package is missing required artifacts: ${missing.join(", ")}`);
  process.exit(1);
}

const unpublishedDuplicateEsm = packageFiles
  .map((file) => file.path)
  .filter((path) => path.startsWith("dist/") && path.endsWith(".js"));
if (unpublishedDuplicateEsm.length > 0) {
  console.error(`Package contains unpublished duplicate ESM artifacts: ${unpublishedDuplicateEsm.join(", ")}`);
  process.exit(1);
}

const sourceOnlyEvidence = packageFiles
  .map((file) => file.path)
  .filter((path) => path.startsWith("docs/evidence/"));
if (sourceOnlyEvidence.length > 0) {
  console.error(`Package contains source-only operational evidence: ${sourceOnlyEvidence.join(", ")}`);
  process.exit(1);
}

const repositoryOnlyDocs = [
  "docs/adr/",
  "docs/ai/",
  "docs/case-studies/",
  "docs/agent-release-readiness.md",
  "docs/native-roadmap-traceability.md",
  "docs/native-search-pilot-decision.md",
  "docs/next-level-roadmap.md",
];
const publishedRepositoryOnlyDocs = packageFiles
  .map((file) => file.path)
  .filter((path) => repositoryOnlyDocs.some((entry) => path === entry || path.startsWith(entry)));
if (publishedRepositoryOnlyDocs.length > 0) {
  console.error(`Package contains repository-only documentation: ${publishedRepositoryOnlyDocs.join(", ")}`);
  process.exit(1);
}

const groupBytes = (group) => packageFiles
  .filter((file) => file.path === group || file.path.startsWith(`${group}/`))
  .reduce((total, file) => total + file.size, 0);
const actual = {
  compressedBytes: Number(packageReport.size ?? 0),
  unpackedBytes: Number(packageReport.unpackedSize ?? 0),
  fileCount: packageFiles.length,
  groups: Object.fromEntries(Object.keys(sizeBudget.maximum.groups).map((group) => [group, groupBytes(group)])),
};
const exceeded = [];
for (const key of ["compressedBytes", "unpackedBytes", "fileCount"]) {
  if (actual[key] > sizeBudget.maximum[key]) exceeded.push(`${key} ${actual[key]} > ${sizeBudget.maximum[key]}`);
}
for (const [group, maximum] of Object.entries(sizeBudget.maximum.groups)) {
  if (actual.groups[group] > maximum) exceeded.push(`${group} bytes ${actual.groups[group]} > ${maximum}`);
}
if (exceeded.length > 0) {
  console.error(`Package size budget exceeded: ${exceeded.join("; ")}`);
  process.exit(1);
}

console.log(
  `Package contents validated (${paths.size} files, ${actual.compressedBytes} compressed bytes, ` +
  `${actual.unpackedBytes} unpacked bytes; ` +
  Object.entries(actual.groups).map(([group, bytes]) => `${group}=${bytes}`).join(", ") +
  ").",
);
