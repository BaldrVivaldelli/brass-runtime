import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Property-based tests for documentation completeness.
 * These are deterministic tests that verify universal properties about the documentation.
 *
 * Feature: lifecycle-client-docs-benchmarks, Property 1: API reference completeness
 * Feature: lifecycle-client-docs-benchmarks, Property 2: Event type documentation completeness
 *
 * **Validates: Requirements 1.6, 1.10, 1.12**
 */

const LIFECYCLE_DIR = path.resolve(__dirname, "../lifecycle");
const INDEX_PATH = path.join(LIFECYCLE_DIR, "index.ts");
const README_PATH = path.join(LIFECYCLE_DIR, "README.md");

/**
 * Extracts all exported symbol names from the barrel index.ts file.
 * Handles both `export { Name }` and `export type { Name }` patterns.
 */
function extractExportedSymbols(indexContent: string): string[] {
  const symbols: string[] = [];

  // Match export { ... } from and export type { ... } from patterns
  const exportBlockRegex = /export\s+(?:type\s+)?\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = exportBlockRegex.exec(indexContent)) !== null) {
    const block = match[1];
    // Split by comma and extract symbol names (handle renaming with 'as')
    const names = block.split(",").map((s) => {
      const trimmed = s.trim();
      // Handle "Name as Alias" — use the alias (exported name)
      const asMatch = trimmed.match(/\w+\s+as\s+(\w+)/);
      return asMatch ? asMatch[1] : trimmed;
    });
    symbols.push(...names.filter((n) => n.length > 0));
  }

  return symbols;
}

/**
 * Extracts the API Reference section content from the README.
 */
function extractApiReferenceSection(readmeContent: string): string {
  const lines = readmeContent.split("\n");
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (/^## API Reference/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.join("\n");
}

/**
 * Extracts the Observability section content from the README.
 */
function extractObservabilitySection(readmeContent: string): string {
  const lines = readmeContent.split("\n");
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (/^## Observability/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.join("\n");
}

/**
 * Extracts table rows from a markdown section.
 * Returns an array of objects with symbol name and description.
 */
function extractTableEntries(
  sectionContent: string,
): Array<{ symbol: string; description: string }> {
  const entries: Array<{ symbol: string; description: string }> = [];
  const lines = sectionContent.split("\n");

  for (const line of lines) {
    // Match markdown table rows: | [`SymbolName`](...) | Description |
    // or | `SymbolName` | Description |
    const tableRowMatch = line.match(
      /\|\s*\[?`([^`]+)`\]?(?:\([^)]*\))?\s*\|\s*(.+?)\s*\|/,
    );
    if (tableRowMatch) {
      const symbol = tableRowMatch[1];
      const description = tableRowMatch[2].trim();
      // Skip header separator rows
      if (!symbol.includes("---") && symbol !== "Export") {
        entries.push({ symbol, description });
      }
    }
  }

  return entries;
}

describe("Property 1: API reference completeness", () => {
  const indexContent = fs.readFileSync(INDEX_PATH, "utf-8");
  const readmeContent = fs.readFileSync(README_PATH, "utf-8");
  const exportedSymbols = extractExportedSymbols(indexContent);
  const apiReferenceSection = extractApiReferenceSection(readmeContent);
  const tableEntries = extractTableEntries(apiReferenceSection);
  const documentedSymbols = tableEntries.map((e) => e.symbol);

  it("should have exported symbols to test", () => {
    expect(exportedSymbols.length).toBeGreaterThan(0);
  });

  it("every exported symbol appears in the API Reference section", () => {
    const missingSymbols: string[] = [];

    for (const symbol of exportedSymbols) {
      if (!documentedSymbols.includes(symbol)) {
        missingSymbols.push(symbol);
      }
    }

    expect(
      missingSymbols,
      `The following exported symbols are missing from the API Reference section:\n${missingSymbols.join("\n")}`,
    ).toEqual([]);
  });

  it("every API Reference entry has a description of ≤120 characters", () => {
    const tooLong: Array<{ symbol: string; length: number }> = [];

    for (const entry of tableEntries) {
      if (entry.description.length > 120) {
        tooLong.push({ symbol: entry.symbol, length: entry.description.length });
      }
    }

    expect(
      tooLong,
      `The following API Reference entries have descriptions exceeding 120 characters:\n${tooLong.map((e) => `  ${e.symbol}: ${e.length} chars`).join("\n")}`,
    ).toEqual([]);
  });
});

describe("Property 2: Event type documentation completeness", () => {
  const readmeContent = fs.readFileSync(README_PATH, "utf-8");
  const observabilitySection = extractObservabilitySection(readmeContent);

  const expectedEventTypes = [
    "request-start",
    "request-end",
    "cache-hit",
    "cache-miss",
    "dedup-hit",
    "dedup-miss",
    "queue-enqueue",
    "queue-dispatch",
  ];

  it("should have an Observability section", () => {
    expect(observabilitySection.length).toBeGreaterThan(0);
  });

  it("every LifecycleEventType value appears in the Observability section", () => {
    const missingEventTypes: string[] = [];

    for (const eventType of expectedEventTypes) {
      if (!observabilitySection.includes(eventType)) {
        missingEventTypes.push(eventType);
      }
    }

    expect(
      missingEventTypes,
      `The following LifecycleEventType values are missing from the Observability section:\n${missingEventTypes.join("\n")}`,
    ).toEqual([]);
  });
});
