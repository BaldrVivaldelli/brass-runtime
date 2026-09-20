#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { V2_NAMESPACE_MAPPINGS } from "./v2-export-disposition-config.mjs";

const root = process.cwd();
const outputPath = path.join(root, "docs", "v1-to-v2-export-map.json");
const declarations = {
  v1Root: path.join(root, "dist", "index.d.ts"),
  v1Core: path.join(root, "dist", "core", "index.d.ts"),
  v2Preview: path.join(root, "dist", "next.d.ts"),
};
const write = process.argv.includes("--write");

for (const [name, file] of Object.entries(declarations)) {
  if (!existsSync(file)) throw new Error(`Missing ${name} declaration ${path.relative(root, file)}. Run npm run build:ts first.`);
}

const program = ts.createProgram(Object.values(declarations), {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const v1Root = moduleExports(declarations.v1Root);
const v1Core = moduleExports(declarations.v1Core);
const v2Preview = moduleExports(declarations.v2Preview);
const failures = [];

for (const name of v1Root.keys()) {
  if (!v1Core.has(name)) failures.push(`${name} has no stable brass-runtime/core compatibility owner`);
}

for (const [source, target] of V2_NAMESPACE_MAPPINGS) {
  if (!v1Root.has(source)) continue;
  if (!hasTarget(target)) failures.push(`${source} maps to missing v2 target ${target}`);
}

if (failures.length > 0) {
  throw new Error(`Cannot generate a complete v2 disposition:\n- ${failures.join("\n- ")}`);
}

const entries = {};
for (const [name, symbol] of [...v1Root.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const namespaceTarget = V2_NAMESPACE_MAPPINGS.get(name);
  if (namespaceTarget) {
    entries[name] = {
      kind: symbolKind(symbol),
      disposition: "v2-namespace",
      target: `brass-runtime/next#${namespaceTarget}`,
    };
  } else if (v2Preview.has(name)) {
    entries[name] = {
      kind: symbolKind(symbol),
      disposition: "v2-direct",
      target: `brass-runtime/next#${name}`,
    };
  } else {
    entries[name] = {
      kind: symbolKind(symbol),
      disposition: "v1-compatibility-subpath",
      target: `brass-runtime/core#${name}`,
    };
  }
}

const dispositions = Object.values(entries).reduce((counts, entry) => {
  counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
  return counts;
}, {});
const actual = {
  schemaVersion: 1,
  description: "Exhaustive generated disposition for every brass-runtime v1 root export before v2 promotion.",
  generatedFrom: Object.fromEntries(Object.entries(declarations).map(([name, file]) => [name, {
    file: path.relative(root, file),
    sha256: sha256(file),
  }])),
  summary: {
    totalV1RootExports: v1Root.size,
    totalV2PreviewExports: v2Preview.size,
    dispositions,
    uncovered: 0,
  },
  exports: entries,
};
const serialized = `${JSON.stringify(actual, null, 2)}\n`;

if (write) {
  writeFileSync(outputPath, serialized, "utf8");
  console.log(`Updated ${path.relative(root, outputPath)} (${v1Root.size} v1 exports, 0 uncovered).`);
} else {
  if (!existsSync(outputPath)) throw new Error(`Missing ${path.relative(root, outputPath)}. Run npm run api:v2-map:update.`);
  const expected = readFileSync(outputPath, "utf8").replaceAll("\r\n", "\n");
  if (expected !== serialized) {
    throw new Error(`V1-to-v2 export disposition is stale. Review declarations, then run npm run api:v2-map:update.`);
  }
  console.log(
    `V1-to-v2 export disposition validated (${v1Root.size} v1 exports: ` +
    `${dispositions["v2-direct"] ?? 0} direct, ${dispositions["v2-namespace"] ?? 0} namespaced, ` +
    `${dispositions["v1-compatibility-subpath"] ?? 0} on /core).`,
  );
}

function moduleExports(file) {
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`TypeScript did not load ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`TypeScript did not resolve module exports for ${file}`);
  return new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
}

function hasTarget(target) {
  const [namespace, member] = target.split(".", 2);
  const namespaceSymbol = v2Preview.get(namespace);
  if (!namespaceSymbol) return false;
  if (!member) return true;
  const source = program.getSourceFile(declarations.v2Preview);
  return Boolean(checker.getTypeOfSymbolAtLocation(namespaceSymbol, source).getProperty(member));
}

function symbolKind(symbol) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const hasValue = Boolean(resolved.flags & ts.SymbolFlags.Value);
  const hasType = Boolean(resolved.flags & ts.SymbolFlags.Type);
  if (hasValue && hasType) return "value-and-type";
  if (hasValue) return "value";
  if (hasType) return "type";
  return "namespace";
}

function sha256(file) {
  const normalized = readFileSync(file, "utf8")
    .replaceAll("\r\n", "\n")
    .replace(/(\.\/[A-Za-z0-9_./-]+)-[A-Za-z0-9_-]{8}\.js/g, "$1-[content].js");
  return createHash("sha256").update(normalized).digest("hex");
}
