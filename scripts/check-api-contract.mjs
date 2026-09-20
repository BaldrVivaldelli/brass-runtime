#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const contractPath = path.join(root, "docs", "ai", "api-contract.v1.json");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const write = process.argv.includes("--write");

const entrypoints = Object.fromEntries(
  Object.entries(packageJson.exports)
    .filter(([, target]) => typeof target === "object" && typeof target.types === "string")
    .map(([subpath, target]) => {
      const file = target.types.replace(/^\.\//, "");
      const absolute = path.join(root, file);
      if (!existsSync(absolute)) {
        throw new Error(`Missing declaration artifact for ${subpath}: ${file}. Run npm run build first.`);
      }
      const declaration = readFileSync(absolute, "utf8").replaceAll("\r\n", "\n");
      return [subpath, {
        file,
        sha256: createHash("sha256").update(declaration).digest("hex"),
      }];
    })
    .sort(([left], [right]) => left.localeCompare(right)),
);

const actual = {
  schemaVersion: 1,
  description: "Generated declaration fingerprints for the frozen v1 API and additive v2 preview.",
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
