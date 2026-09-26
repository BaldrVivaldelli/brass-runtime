#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const rules = [
  {
    owner: "core",
    from: "src/core",
    forbidden: ["src/http", "src/observability", "src/perf"],
  },
  {
    owner: "schema",
    from: "src/schema",
    forbidden: ["src/core", "src/http", "src/observability", "src/perf"],
  },
  {
    owner: "http",
    from: "src/http",
    forbidden: ["src/perf"],
  },
  {
    owner: "observability",
    from: "src/observability",
    forbidden: ["src/perf"],
  },
  {
    owner: "perf",
    from: "src/perf",
    forbidden: [],
  },
];

const importPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
const violations = [];

for (const rule of rules) {
  const directory = path.join(root, rule.from);
  for (const file of walkTypeScript(directory)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;

      const target = relativeToRoot(path.resolve(path.dirname(file), specifier));
      const forbidden = rule.forbidden.find((prefix) => target === prefix || target.startsWith(`${prefix}/`));
      if (!forbidden) continue;

      violations.push(
        `${relativeToRoot(file)} imports ${specifier} (${rule.owner} must not depend on ${forbidden})`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Product boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Product boundaries validated (${rules.length} dependency rules).`);

function walkTypeScript(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...walkTypeScript(absolute));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(absolute);
    }
  }
  return files;
}

function relativeToRoot(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
