#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const contractPath = path.join(root, "docs", "ai", "api-contract.v1.json");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const write = process.argv.includes("--write");
const typedEntrypoints = Object.entries(packageJson.exports)
  .filter(([, target]) => typeof target === "object" && typeof target.types === "string")
  .map(([subpath, target]) => [subpath, target.types.replace(/^\.\//, "")]);
const program = ts.createProgram(typedEntrypoints.map(([, file]) => path.join(root, file)), {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

const entrypoints = Object.fromEntries(
  typedEntrypoints
    .map(([subpath, file]) => {
      const absolute = path.join(root, file);
      if (!existsSync(absolute)) {
        throw new Error(`Missing declaration artifact for ${subpath}: ${file}. Run npm run build first.`);
      }
      const declaration = normalizeDeclaration(readFileSync(absolute, "utf8"));
      const source = program.getSourceFile(absolute);
      const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
      if (!moduleSymbol) throw new Error(`Unable to inspect declaration exports for ${subpath}: ${file}`);
      return [subpath, {
        file,
        sha256: createHash("sha256").update(declaration).digest("hex"),
        exportCount: checker.getExportsOfModule(moduleSymbol).length,
      }];
    })
    .sort(([left], [right]) => left.localeCompare(right)),
);

const actual = {
  schemaVersion: 2,
  description: "Generated declaration fingerprints and export counts for the frozen v1 API and additive v2 preview.",
  normalization: "line-endings-and-tsup-content-hashes-v1",
  entrypoints,
};

if (write) {
  writeFileSync(contractPath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  console.log(`Updated ${path.relative(root, contractPath)} (${Object.keys(entrypoints).length} entrypoints).`);
  process.exit(0);
}

if (!existsSync(contractPath)) {
  throw new Error(`Missing ${path.relative(root, contractPath)}. Run npm run api:contract:update after a reviewed API change.`);
}

const expected = JSON.parse(readFileSync(contractPath, "utf8"));
const differences = [];
if (expected.schemaVersion !== actual.schemaVersion) {
  differences.push(`contract schema changed from ${String(expected.schemaVersion)} to ${actual.schemaVersion}`);
}
if (expected.normalization !== actual.normalization) {
  differences.push(`contract normalization changed from ${String(expected.normalization)} to ${actual.normalization}`);
}
const names = new Set([
  ...Object.keys(expected.entrypoints ?? {}),
  ...Object.keys(actual.entrypoints),
]);

for (const name of [...names].sort()) {
  const before = expected.entrypoints?.[name];
  const after = actual.entrypoints[name];
  if (!before) {
    differences.push(`${name}: new declaration entrypoint ${after.file}`);
  } else if (!after) {
    differences.push(`${name}: declaration entrypoint removed`);
  } else if (before.file !== after.file) {
    differences.push(`${name}: declaration moved from ${before.file} to ${after.file}`);
  } else if (before.exportCount !== after.exportCount) {
    differences.push(`${name}: export count changed from ${String(before.exportCount)} to ${after.exportCount}`);
  } else if (before.sha256 !== after.sha256) {
    differences.push(`${name}: declaration signature changed`);
  }
}

if (differences.length > 0) {
  console.error("Public API declaration contract changed:");
  for (const difference of differences) console.error(`- ${difference}`);
  console.error("Review the generated .d.ts diff, then run npm run api:contract:update if the change is intentional.");
  process.exit(1);
}

console.log(`Public API declaration contract validated (${names.size} entrypoints).`);

function normalizeDeclaration(value) {
  return value
    .replaceAll("\r\n", "\n")
    .replace(/(\.\/[A-Za-z0-9_./-]+)-[A-Za-z0-9_-]{8}\.js/g, "$1-[content].js");
}
