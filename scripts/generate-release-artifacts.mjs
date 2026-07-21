#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageUrl } from "./release-package-url.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(root, process.env.BRASS_RELEASE_OUTPUT_DIR ?? "artifacts/release");
mkdirSync(outputDirectory, { recursive: true });

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const cargo = cargoMetadata();
const npmPackages = Object.entries(packageLock.packages ?? {}).map(([path, value]) => ({
  ecosystem: "npm",
  name: path === "" ? packageJson.name : npmName(path),
  version: value.version ?? "NOASSERTION",
  license: normalizeLicense(value.license),
  downloadLocation: value.resolved ?? "NOASSERTION",
  development: value.dev === true,
}));
const rustPackages = cargo.packages.map((value) => ({
  ecosystem: "cargo",
  name: value.name,
  version: value.version,
  license: normalizeLicense(value.license),
  downloadLocation: value.source ?? "NOASSERTION",
  development: false,
}));
const inventory = uniquePackages([...npmPackages, ...rustPackages]);
const lockDigest = sha256(Buffer.concat([
  readFileSync(resolve(root, "package-lock.json")),
  readFileSync(resolve(root, "Cargo.lock")),
]));
const created = new Date().toISOString();
const spdxPackages = inventory.map((item) => ({
  name: item.name,
  SPDXID: spdxId(item),
  versionInfo: item.version,
  downloadLocation: item.downloadLocation,
  filesAnalyzed: false,
  licenseConcluded: item.license,
  licenseDeclared: item.license,
  supplier: "NOASSERTION",
  externalRefs: [{
    referenceCategory: "PACKAGE-MANAGER",
    referenceType: item.ecosystem === "npm" ? "purl" : "purl",
    referenceLocator: packageUrl(item),
  }],
  comment: item.development ? "Development dependency; not shipped in the npm runtime package." : undefined,
}));
const rootSpdxId = spdxId({ ecosystem: "npm", name: packageJson.name, version: packageJson.version });
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://github.com/BaldrVivaldelli/brass-runtime/sbom/${packageJson.version}/${lockDigest}`,
  creationInfo: {
    created,
    creators: ["Tool: brass-runtime/scripts/generate-release-artifacts.mjs"],
  },
  packages: spdxPackages,
  relationships: [{
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: rootSpdxId,
  }],
};

const licenses = {
  schemaVersion: 1,
  package: `${packageJson.name}@${packageJson.version}`,
  generatedAt: created,
  counts: {
    total: inventory.length,
    noAssertion: inventory.filter((item) => item.license === "NOASSERTION").length,
  },
  packages: inventory
    .filter((item) => !(item.ecosystem === "npm" && item.name === packageJson.name))
    .sort(comparePackage),
};

const artifacts = discoverArtifacts();
const checksums = artifacts
  .map((path) => `${sha256(readFileSync(path))}  ${portable(relative(root, path))}`)
  .sort();

writeJson(resolve(outputDirectory, "sbom.spdx.json"), sbom);
writeJson(resolve(outputDirectory, "third-party-licenses.json"), licenses);
writeFileSync(resolve(outputDirectory, "checksums-sha256.txt"), `${checksums.join("\n")}\n`, "utf8");
writeJson(resolve(outputDirectory, "release-manifest.json"), {
  schemaVersion: 1,
  package: `${packageJson.name}@${packageJson.version}`,
  generatedAt: created,
  lockDigestSha256: lockDigest,
  artifacts: checksums.length,
  sbomPackages: inventory.length,
  licenseNoAssertion: licenses.counts.noAssertion,
});

process.stdout.write(`Generated release metadata for ${inventory.length} packages and ${artifacts.length} artifacts in ${portable(relative(root, outputDirectory))}\n`);

function cargoMetadata() {
  const run = spawnSync("cargo", ["metadata", "--format-version=1", "--locked"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`cargo metadata failed: ${run.error?.message ?? run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

function discoverArtifacts() {
  const candidates = [
    resolve(root, "wasm/pkg/brass_runtime_wasm_engine.js"),
    resolve(root, "wasm/pkg/brass_runtime_wasm_engine_bg.wasm"),
  ];
  collectFiles(resolve(root, "native"), candidates);
  if (!existsSync(resolve(root, "native"))) {
    candidates.push(resolve(
      root,
      "target/release",
      process.platform === "win32" ? "brass-native-service.exe" : "brass-native-service",
    ));
  }
  for (const name of readdirSync(root)) {
    if (name.endsWith(".tgz")) candidates.push(resolve(root, name));
  }
  for (const entry of (process.env.BRASS_RELEASE_ARTIFACTS ?? "").split(delimiter)) {
    if (entry.trim()) candidates.push(resolve(root, entry.trim()));
  }
  return [...new Set(candidates.filter((path) => existsSync(path) && statSync(path).isFile()))];
}

function collectFiles(directory, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, output);
    else if (entry.isFile()) output.push(path);
  }
}

function npmName(path) {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index < 0 ? path : path.slice(index + marker.length);
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) return value.join(" OR ");
  return "NOASSERTION";
}

function uniquePackages(values) {
  const unique = new Map();
  for (const value of values) unique.set(`${value.ecosystem}:${value.name}@${value.version}`, value);
  return [...unique.values()].sort(comparePackage);
}

function comparePackage(left, right) {
  return `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(
    `${right.ecosystem}:${right.name}@${right.version}`,
  );
}

function spdxId(item) {
  return `SPDXRef-${item.ecosystem}-${item.name}-${item.version}`.replace(/[^A-Za-z0-9.-]/gu, "-");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, (_key, item) => item === undefined ? undefined : item, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portable(path) {
  return path.split(sep).join("/");
}
