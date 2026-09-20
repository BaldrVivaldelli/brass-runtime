#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const surfaces = [
  {
    directory: ".",
    declarations: {},
    lockedMinimums: {},
  },
  {
    directory: "examples/angular",
    engine: "^20.19.0 || >=22.12.0",
    declarations: {
      "dependencies.@angular/common": "^20.3.31",
      "dependencies.@angular/core": "^20.3.31",
      "dependencies.@angular/platform-browser": "^20.3.31",
      "dependencies.rxjs": "^7.8.2",
      "dependencies.zone.js": "~0.15.1",
      "devDependencies.@angular-devkit/build-angular": "^20.3.37",
      "devDependencies.@angular/cli": "^20.3.37",
      "devDependencies.@angular/compiler-cli": "^20.3.31",
    },
    lockedMinimums: {
      "@angular/common": "20.3.31",
      "@angular/core": "20.3.31",
      "@angular/platform-browser": "20.3.31",
      "@angular-devkit/build-angular": "20.3.37",
      "@angular/cli": "20.3.37",
      "@angular/compiler-cli": "20.3.31",
    },
    localRuntime: true,
  },
  {
    directory: "examples/nextjs",
    engine: ">=20.9.0",
    declarations: {
      "dependencies.next": "^16.3.5",
      "dependencies.react": "^19.1.1",
      "dependencies.react-dom": "^19.1.1",
    },
    lockedMinimums: { next: "16.3.5", react: "19.1.1", "react-dom": "19.1.1" },
    localRuntime: true,
  },
  {
    directory: "examples/nestjs",
    engine: ">=20",
    declarations: {
      "dependencies.@nestjs/common": "^12.0.3",
      "dependencies.@nestjs/core": "^12.0.3",
      "dependencies.@nestjs/platform-express": "^12.0.3",
    },
    lockedMinimums: {
      "@nestjs/common": "12.0.3",
      "@nestjs/core": "12.0.3",
      "@nestjs/platform-express": "12.0.3",
    },
    localRuntime: true,
  },
  {
    directory: "examples/react",
    engine: "^18.0.0 || ^20.0.0 || >=22.0.0",
    declarations: {
      "dependencies.react": "^19.1.1",
      "dependencies.react-dom": "^19.1.1",
      "devDependencies.@vitejs/plugin-react": "^4.7.0",
      "devDependencies.vite": "^6.4.3",
    },
    lockedMinimums: {
      react: "19.1.1",
      "react-dom": "19.1.1",
      "@vitejs/plugin-react": "4.7.0",
      vite: "6.4.3",
    },
    localRuntime: true,
  },
  {
    directory: "extensions/vscode-brass-agent",
    declarations: { "devDependencies.@vscode/vsce": "^3.9.2" },
    lockedMinimums: {
      "@vscode/vsce": "3.9.2",
      "fast-uri": "3.1.6",
      "js-yaml": "4.3.2",
      undici: "7.29.0",
    },
  },
];

for (const surface of surfaces) {
  const manifest = readJson(surface.directory, "package.json");
  const lock = readJson(surface.directory, "package-lock.json");
  const label = surface.directory === "." ? "root" : surface.directory;

  if (lock.lockfileVersion !== 3) failures.push(`${label} must use lockfileVersion 3`);
  if (surface.directory !== "." && manifest.private !== true) failures.push(`${label} must remain private`);
  if (surface.engine && manifest.engines?.node !== surface.engine) {
    failures.push(`${label} Node engine must be ${surface.engine}`);
  }
  for (const [key, expected] of Object.entries(surface.declarations)) {
    const separator = key.indexOf(".");
    const section = key.slice(0, separator);
    const dependency = key.slice(separator + 1);
    if (manifest[section]?.[dependency] !== expected) {
      failures.push(`${label} must declare ${dependency} as ${expected}`);
    }
  }
  for (const [dependency, minimum] of Object.entries(surface.lockedMinimums)) {
    const actual = lock.packages?.[`node_modules/${dependency}`]?.version;
    if (!atLeast(actual, minimum)) failures.push(`${label} locks ${dependency} at ${actual ?? "missing"}; require >=${minimum}`);
  }
  if (surface.directory !== ".") validateLockRoot(label, manifest, lock);
  if (surface.localRuntime) {
    const runtime = lock.packages?.["node_modules/brass-runtime"];
    if (runtime?.link !== true || runtime?.resolved !== "../..") {
      failures.push(`${label} must lock brass-runtime to the repository root`);
    }
  }
}

const rootLock = readJson(".", "package-lock.json");
const rootManifest = readJson(".", "package.json");
if (rootManifest.devDependencies?.rimraf !== undefined
  || rootLock.packages?.["node_modules/rimraf"] !== undefined) {
  failures.push("root must use the bounded Node cleaner instead of rimraf/glob tooling");
}
const braceVersion = rootLock.packages?.["node_modules/brace-expansion"]?.version;
if (braceVersion !== undefined && !safeBraceExpansion(braceVersion)) {
  failures.push(`root brace-expansion ${braceVersion ?? "missing"} is below the audited safe line`);
}

if (failures.length > 0) {
  console.error("Dependency security policy failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Dependency security policy validated (${surfaces.length} locked surfaces; high/critical audits run in CI).`);

function readJson(directory, file) {
  return JSON.parse(readFileSync(path.join(root, directory, file), "utf8"));
}

function atLeast(actual, minimum) {
  const left = numericVersion(actual);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|-)/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

function safeBraceExpansion(version) {
  const parsed = numericVersion(version);
  if (!parsed) return false;
  return parsed[0] < 4 || atLeast(version, "5.0.9");
}

function validateLockRoot(label, manifest, lock) {
  const lockRoot = lock.packages?.[""];
  if (!lockRoot || lockRoot.name !== manifest.name) {
    failures.push(`${label} lock root must match its manifest name`);
    return;
  }
  for (const section of ["dependencies", "devDependencies", "engines"]) {
    if (JSON.stringify(lockRoot[section] ?? {}) !== JSON.stringify(manifest[section] ?? {})) {
      failures.push(`${label} lock root ${section} does not match package.json`);
    }
  }
}
