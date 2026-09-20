#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  V2_DIRECT_TYPES,
  V2_DIRECT_VALUES,
  V2_NAMESPACE_MAPPINGS,
} from "./v2-export-disposition-config.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".git", "target", "wasm"]);
const V1_MODULES = new Set(["brass-runtime", "brass-runtime/core"]);

const scriptKind = (file) => {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const locationOf = (source, node) => {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: location.line + 1, column: location.character + 1 };
};

const mappedImport = (imported, typeOnly) => {
  if (typeOnly) {
    const replacement = V2_DIRECT_TYPES.get(imported);
    return replacement ? { classification: "mapped", replacement } : undefined;
  }
  const namespaced = V2_NAMESPACE_MAPPINGS.get(imported);
  if (namespaced) return { classification: "mapped", replacement: namespaced };
  if (V2_DIRECT_VALUES.has(imported)) return { classification: "direct", replacement: imported };
  return undefined;
};

export function analyzeSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const findings = [];

  for (const statement of source.statements) {
    if (
      (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (!V1_MODULES.has(moduleName)) continue;

    const base = { file, module: moduleName, ...locationOf(source, statement) };
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        findings.push({ ...base, classification: "manual", imported: "*", local: null, typeOnly: statement.isTypeOnly, replacement: null, reason: "star re-exports must be reviewed by usage" });
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        findings.push({ ...base, classification: "manual", imported: "*", local: statement.exportClause.name.text, typeOnly: statement.isTypeOnly, replacement: null, reason: "namespace re-exports must be reviewed by usage" });
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const imported = (element.propertyName ?? element.name).text;
        const local = element.name.text;
        const typeOnly = statement.isTypeOnly || element.isTypeOnly;
        const mapping = mappedImport(imported, typeOnly);
        findings.push({
          ...base,
          ...(mapping ?? { classification: "manual", replacement: null }),
          imported,
          local,
          typeOnly,
          ...(mapping ? {} : { reason: "not present in the documented v2 preview contract" }),
        });
      }
      continue;
    }

    const clause = statement.importClause;
    if (!clause) {
      findings.push({ ...base, classification: "manual", imported: "<side-effect import>", local: null, typeOnly: false, replacement: null, reason: "side-effect imports have no v2 mapping" });
      continue;
    }

    if (clause.name) {
      findings.push({ ...base, classification: "manual", imported: "default", local: clause.name.text, typeOnly: clause.isTypeOnly, replacement: null, reason: "the v2 preview has no default export" });
    }

    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      findings.push({ ...base, classification: "manual", imported: "*", local: clause.namedBindings.name.text, typeOnly: clause.isTypeOnly, replacement: null, reason: "namespace imports must be reviewed by usage" });
      continue;
    }

    for (const element of clause.namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const local = element.name.text;
      const typeOnly = clause.isTypeOnly || element.isTypeOnly;
      const mapping = mappedImport(imported, typeOnly);
      findings.push({
        ...base,
        ...(mapping ?? { classification: "manual", replacement: null }),
        imported,
        local,
        typeOnly,
        ...(mapping ? {} : { reason: "not present in the documented v2 preview contract" }),
      });
    }
  }

  return {
    file,
    parseDiagnostics: source.parseDiagnostics.map((diagnostic) => ({
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ...(typeof diagnostic.start === "number" ? locationOf(source, { getStart: () => diagnostic.start }) : {}),
    })),
    findings,
  };
}

async function collectFiles(input) {
  const absolute = resolve(input);
  const metadata = await stat(absolute);
  if (metadata.isFile()) return SOURCE_EXTENSIONS.has(extname(absolute)) ? [absolute] : [];
  if (!metadata.isDirectory()) return [];

  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(child);
  }
  return files;
}

export async function analyzePaths(inputs) {
  const files = [...new Set((await Promise.all(inputs.map(collectFiles))).flat())].sort();
  const reports = [];
  for (const file of files) reports.push(analyzeSource(file, await readFile(file, "utf8")));
  const findings = reports.flatMap((report) => report.findings);
  return {
    filesScanned: files.length,
    filesWithV1Imports: reports.filter((report) => report.findings.length > 0).length,
    mapped: findings.filter((finding) => finding.classification === "mapped").length,
    direct: findings.filter((finding) => finding.classification === "direct").length,
    manual: findings.filter((finding) => finding.classification === "manual").length,
    parseErrors: reports.reduce((total, report) => total + report.parseDiagnostics.length, 0),
    reports: reports.filter((report) => report.findings.length > 0 || report.parseDiagnostics.length > 0),
  };
}

const formatHuman = (result) => {
  const lines = [
    `Scanned ${result.filesScanned} source files; ${result.filesWithV1Imports} contain v1 root/core imports or re-exports.`,
    `Mappings: ${result.mapped}; direct moves: ${result.direct}; manual decisions: ${result.manual}; parse errors: ${result.parseErrors}.`,
  ];
  for (const report of result.reports) {
    for (const finding of report.findings) {
      const target = finding.replacement ? ` -> ${finding.replacement}` : ` -> manual (${finding.reason})`;
      const alias = finding.local && finding.local !== finding.imported ? ` as ${finding.local}` : "";
      lines.push(`${finding.file}:${finding.line}:${finding.column} ${finding.imported}${alias}${target}`);
    }
    for (const diagnostic of report.parseDiagnostics) {
      lines.push(`${report.file}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1} parse error: ${diagnostic.message}`);
    }
  }
  return lines.join("\n");
};

async function main(argv) {
  const json = argv.includes("--json");
  const check = argv.includes("--check");
  const inputs = argv.filter((argument) => !argument.startsWith("--"));
  if (inputs.length === 0) {
    console.error("Usage: analyze-v2-migration [--json] [--check] <file-or-directory> [...]");
    process.exitCode = 2;
    return;
  }
  const result = await analyzePaths(inputs);
  console.log(json ? JSON.stringify(result, null, 2) : formatHuman(result));
  if (check && (result.filesWithV1Imports > 0 || result.parseErrors > 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
