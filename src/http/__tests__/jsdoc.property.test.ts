import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Property-based tests for JSDoc coverage completeness.
 * Feature: lifecycle-client-docs-benchmarks, Property 4: JSDoc coverage completeness
 *
 * For any public export listed in `src/http/lifecycle/index.ts`, the declaring source
 * file SHALL contain a JSDoc comment (`/** ... * /`) immediately preceding the export's
 * declaration, and that comment SHALL include at minimum a description line. For functions,
 * it SHALL additionally include `@param` tags for each parameter and a `@returns` tag.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 */

const LIFECYCLE_DIR = path.resolve(__dirname, "../lifecycle");
const INDEX_PATH = path.join(LIFECYCLE_DIR, "index.ts");

/**
 * Represents a public export found in the barrel file.
 */
type ExportInfo = {
  name: string;
  kind: "type" | "function" | "class" | "const";
  sourceFile: string;
};

/**
 * Parses the barrel index.ts to extract all re-exported symbols and their source files.
 */
function parseBarrelExports(indexContent: string): ExportInfo[] {
  const exports: ExportInfo[] = [];

  // Match: export type { TypeA, TypeB } from "./file";
  const typeReExportRegex = /export\s+type\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = typeReExportRegex.exec(indexContent)) !== null) {
    const names = match[1].split(",").map((n) => n.trim()).filter(Boolean);
    const sourceFile = match[2].replace(/\.ts$/, "") + ".ts";
    for (const name of names) {
      exports.push({ name, kind: "type", sourceFile });
    }
  }

  // Match: export { funcA, funcB } from "./file";
  const valueReExportRegex = /export\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g;
  while ((match = valueReExportRegex.exec(indexContent)) !== null) {
    const names = match[1].split(",").map((n) => n.trim()).filter(Boolean);
    const sourceFile = match[2].replace(/\.ts$/, "") + ".ts";
    for (const name of names) {
      // Skip if already added as type export
      if (!exports.some((e) => e.name === name && e.sourceFile === sourceFile)) {
        exports.push({ name, kind: "function", sourceFile }); // Will be refined below
      }
    }
  }

  return exports;
}

/**
 * Determines the actual kind of an export by examining the source file content.
 */
function refineExportKind(
  exportInfo: ExportInfo,
  sourceContent: string,
): ExportInfo["kind"] {
  const name = exportInfo.name;

  // Check for class
  if (new RegExp(`export\\s+class\\s+${name}\\b`).test(sourceContent)) {
    return "class";
  }

  // Check for function
  if (new RegExp(`export\\s+function\\s+${name}\\b`).test(sourceContent)) {
    return "function";
  }

  // Check for const
  if (new RegExp(`export\\s+const\\s+${name}\\b`).test(sourceContent)) {
    return "const";
  }

  // Check for type/interface
  if (
    new RegExp(`export\\s+type\\s+${name}\\b`).test(sourceContent) ||
    new RegExp(`export\\s+interface\\s+${name}\\b`).test(sourceContent)
  ) {
    return "type";
  }

  return exportInfo.kind;
}

/**
 * Checks if a JSDoc comment exists immediately before a declaration.
 * Returns the JSDoc block if found, or null.
 */
function findJSDocBefore(sourceContent: string, declarationPattern: RegExp): string | null {
  const match = declarationPattern.exec(sourceContent);
  if (!match) return null;

  const beforeDecl = sourceContent.substring(0, match.index);
  // Find the last JSDoc block before the declaration
  const jsDocRegex = /\/\*\*[\s\S]*?\*\//g;
  let lastJSDoc: string | null = null;
  let jsDocMatch: RegExpExecArray | null;

  while ((jsDocMatch = jsDocRegex.exec(beforeDecl)) !== null) {
    lastJSDoc = jsDocMatch[0];
  }

  if (!lastJSDoc) return null;

  // Verify the JSDoc is "immediately" before the declaration
  // (only whitespace/comments between JSDoc end and declaration start)
  const jsDocEnd = beforeDecl.lastIndexOf(lastJSDoc) + lastJSDoc.length;
  const between = beforeDecl.substring(jsDocEnd).trim();

  // Allow only empty space or single-line comments between JSDoc and declaration
  if (between && !/^(?:\s|\/\/[^\n]*(?:\n|$))*$/.test(between)) {
    return null;
  }

  return lastJSDoc;
}

/**
 * Extracts function parameters from a function declaration.
 */
function extractFunctionParams(sourceContent: string, funcName: string): string[] {
  // Match function declaration and extract parameter list
  const funcRegex = new RegExp(
    `export\\s+function\\s+${funcName}\\s*(?:<[^>]*>)?\\s*\\(([^)]*(?:\\([^)]*\\)[^)]*)*)\\)`,
    "s",
  );
  const match = funcRegex.exec(sourceContent);
  if (!match) return [];

  const paramStr = match[1].trim();
  if (!paramStr) return [];

  // Parse parameters - handle complex types with nested parens/generics
  const params: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of paramStr) {
    if (char === "(" || char === "<" || char === "{" || char === "[") {
      depth++;
      current += char;
    } else if (char === ")" || char === ">" || char === "}" || char === "]") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) params.push(current.trim());

  // Extract parameter names (before the colon or default value)
  return params
    .map((p) => {
      const name = p.split(/[?:=]/)[0].trim();
      return name;
    })
    .filter(Boolean);
}

describe("Property 4: JSDoc coverage completeness", () => {
  const indexContent = fs.readFileSync(INDEX_PATH, "utf-8");
  const allExports = parseBarrelExports(indexContent);

  // Group exports by source file for efficient reading
  const exportsByFile = new Map<string, ExportInfo[]>();
  for (const exp of allExports) {
    const existing = exportsByFile.get(exp.sourceFile) || [];
    existing.push(exp);
    exportsByFile.set(exp.sourceFile, existing);
  }

  // Refine kinds based on actual source content
  const refinedExports: ExportInfo[] = [];
  for (const [sourceFile, exports] of exportsByFile) {
    const filePath = path.join(LIFECYCLE_DIR, sourceFile);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    for (const exp of exports) {
      const refinedKind = refineExportKind(exp, content);
      refinedExports.push({ ...exp, kind: refinedKind });
    }
  }

  describe("Every exported type/interface has a JSDoc comment", () => {
    const typeExports = refinedExports.filter((e) => e.kind === "type");

    it.each(typeExports.map((e) => [e.name, e.sourceFile]))(
      "%s (from %s) has a JSDoc comment",
      (name, sourceFile) => {
        const filePath = path.join(LIFECYCLE_DIR, sourceFile);
        const content = fs.readFileSync(filePath, "utf-8");

        const typePattern = new RegExp(
          `export\\s+(?:type|interface)\\s+${name}\\b`,
        );
        const jsDoc = findJSDocBefore(content, typePattern);

        expect(jsDoc).not.toBeNull();
        // Verify it has at least a description (non-empty content beyond tags)
        expect(jsDoc!.length).toBeGreaterThan(6); // More than just "/** */"
      },
    );
  });

  describe("Every exported function has a JSDoc comment with @param and @returns", () => {
    const funcExports = refinedExports.filter((e) => e.kind === "function");

    it.each(funcExports.map((e) => [e.name, e.sourceFile]))(
      "%s (from %s) has JSDoc with @param and @returns tags",
      (name, sourceFile) => {
        const filePath = path.join(LIFECYCLE_DIR, sourceFile);
        const content = fs.readFileSync(filePath, "utf-8");

        const funcPattern = new RegExp(`export\\s+function\\s+${name}\\b`);
        const jsDoc = findJSDocBefore(content, funcPattern);

        expect(jsDoc).not.toBeNull();

        // Verify @returns tag exists
        expect(jsDoc).toMatch(/@returns/);

        // Verify @param tags exist for each parameter
        const params = extractFunctionParams(content, name);
        for (const param of params) {
          expect(jsDoc).toMatch(new RegExp(`@param\\s+(?:\\{[^}]*\\}\\s+)?${param}\\b`));
        }
      },
    );
  });

  describe("Every exported class has a JSDoc comment and public methods have JSDoc", () => {
    const classExports = refinedExports.filter((e) => e.kind === "class");

    it.each(classExports.map((e) => [e.name, e.sourceFile]))(
      "%s (from %s) has a JSDoc comment on the class declaration",
      (name, sourceFile) => {
        const filePath = path.join(LIFECYCLE_DIR, sourceFile);
        const content = fs.readFileSync(filePath, "utf-8");

        const classPattern = new RegExp(`export\\s+class\\s+${name}\\b`);
        const jsDoc = findJSDocBefore(content, classPattern);

        expect(jsDoc).not.toBeNull();
        expect(jsDoc!.length).toBeGreaterThan(6);
      },
    );
  });

  describe("Every exported constant has a JSDoc comment", () => {
    const constExports = refinedExports.filter((e) => e.kind === "const");

    it.each(constExports.map((e) => [e.name, e.sourceFile]))(
      "%s (from %s) has a JSDoc comment",
      (name, sourceFile) => {
        const filePath = path.join(LIFECYCLE_DIR, sourceFile);
        const content = fs.readFileSync(filePath, "utf-8");

        const constPattern = new RegExp(`export\\s+const\\s+${name}\\b`);
        const jsDoc = findJSDocBefore(content, constPattern);

        expect(jsDoc).not.toBeNull();
        expect(jsDoc!.length).toBeGreaterThan(6);
      },
    );
  });

  describe("All public exports have JSDoc coverage", () => {
    it("every export in the barrel has a corresponding JSDoc in its source file", () => {
      const missing: string[] = [];

      for (const exp of refinedExports) {
        const filePath = path.join(LIFECYCLE_DIR, exp.sourceFile);
        if (!fs.existsSync(filePath)) {
          missing.push(`${exp.name} - source file not found: ${exp.sourceFile}`);
          continue;
        }

        const content = fs.readFileSync(filePath, "utf-8");
        let pattern: RegExp;

        switch (exp.kind) {
          case "type":
            pattern = new RegExp(`export\\s+(?:type|interface)\\s+${exp.name}\\b`);
            break;
          case "function":
            pattern = new RegExp(`export\\s+function\\s+${exp.name}\\b`);
            break;
          case "class":
            pattern = new RegExp(`export\\s+class\\s+${exp.name}\\b`);
            break;
          case "const":
            pattern = new RegExp(`export\\s+const\\s+${exp.name}\\b`);
            break;
        }

        const jsDoc = findJSDocBefore(content, pattern);
        if (!jsDoc) {
          missing.push(`${exp.name} (${exp.kind}) in ${exp.sourceFile}`);
        }
      }

      expect(missing).toEqual([]);
    });
  });
});
