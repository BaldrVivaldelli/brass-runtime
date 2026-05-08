#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

const modules = [
  {
    name: "core-runtime",
    aliases: ["core", "runtime", "types"],
    purpose: "Effect types, runtime execution, fibers, scopes, scheduler, resources, layers, tracing, metrics.",
    paths: ["src/core/types", "src/core/runtime"],
    docs: ["docs/ai/INVARIANTS.md", "docs/ARCHITECTURE.md", "docs/cancellation.md", "docs/observability.md"],
    tests: ["src/core/types/__tests__", "src/core/runtime/__tests__"],
    validation: ["npm run test:types", "npm test -- src/core/types src/core/runtime/__tests__"],
  },
  {
    name: "streams",
    aliases: ["stream", "zstream", "pipeline", "queue", "hub"],
    purpose: "Pull-based streams, buffering, queues, hubs, pipelines, fusion, chunks, and operators.",
    paths: ["src/core/stream"],
    docs: ["docs/guides/streams.md", "agent.md"],
    tests: ["src/core/stream/__tests__"],
    validation: ["npm run test:types", "npm test -- src/core/stream/__tests__"],
  },
  {
    name: "http",
    aliases: ["client", "retry", "lifecycle", "compression", "pool"],
    purpose: "Lazy cancelable HTTP client, middleware, lifecycle cache/dedup/priority, retry, compression, batching, pre-warming, validation.",
    paths: ["src/http"],
    docs: ["docs/http.md", "src/http/README.md", "src/http/lifecycle/README.md"],
    tests: ["src/http/__tests__"],
    validation: ["npm run test:types", "npm test -- src/http/__tests__"],
  },
  {
    name: "agent",
    aliases: ["brass-agent", "cli", "llm", "vscode"],
    purpose: "Workspace intelligence, policy-aware tools, LLM patch loop, CLI, and VS Code integration.",
    paths: ["src/agent", "extensions/vscode-brass-agent"],
    docs: ["docs/agent-boundaries.md", "docs/agent-project-intelligence.md", "docs/agent-context-discovery.md", "docs/agent-cli.md"],
    tests: [],
    validation: ["npm run test:types", "npm run agent:test:smoke"],
  },
  {
    name: "wasm",
    aliases: ["rust", "engine"],
    purpose: "Strict WASM engine/state-machine sources and TypeScript bridge code.",
    paths: ["crates/brass-runtime-wasm-engine", "src/core/runtime/engine", "src/core/runtime/wasmModule.ts", "src/http/wasmPermitPool.ts", "src/http/retry/wasmRetryPlanner.ts"],
    docs: ["docs/wasm-fiber-engine.md", "docs/wasm-scheduler-state-machine.md", "docs/wasm-bounded-queues.md"],
    tests: ["src/core/runtime/__tests__/engine-defaults.test.ts", "src/core/runtime/__tests__/engine-parity.test.ts"],
    validation: ["npm run build:wasm", "npm test -- src/core/runtime/__tests__/engine src/core/runtime/__tests__/scheduler"],
  },
  {
    name: "packaging",
    aliases: ["package", "exports", "build", "tsup"],
    purpose: "Package exports, build entries, CJS/ESM/type output, CLI bin, generated assets.",
    paths: ["package.json", "tsup.config.ts", "tsconfig.json", "tsconfig.base.json", "src/index.ts", "src/http/index.ts", "src/agent/index.ts"],
    docs: ["docs/ai/PUBLIC_API.md", "README.md"],
    tests: [],
    validation: ["npm run build", "npm run validate:cjs", "npm run test:types"],
  },
  {
    name: "benchmarks",
    aliases: ["bench", "performance", "perf"],
    purpose: "Runtime and HTTP lifecycle benchmark harnesses and thresholds.",
    paths: ["src/benchmarks", "src/core/runtime/bench"],
    docs: ["docs/wasm-engine-observability-benchmarks.md"],
    tests: ["src/benchmarks/__tests__"],
    validation: ["npm run benchmark", "npm run benchmark:json"],
  },
  {
    name: "docs",
    aliases: ["documentation", "guides", "ai"],
    purpose: "Human and agent documentation.",
    paths: ["docs", "README.md", "AGENTS.md", "agent.md", "BRASS_AGENT.md", "scripts/context-pack.mjs"],
    docs: ["docs/README.md", "docs/ai/PROJECT_MAP.md", "docs/ai/VALIDATION_MATRIX.md"],
    tests: [],
    validation: ["npm run context"],
  },
];

const invariantBullets = [
  "Effects are values; constructing one must not run side effects.",
  "Promise is an interop boundary, not the runtime primitive.",
  "Async work should be cancelable and owned by a fiber/scope.",
  "Finalizers run exactly once and in reverse registration order.",
  "HTTP is layered above runtime; core must not depend on HTTP or agent code.",
  "WASM mode is strict and should fail clearly when unavailable.",
];

function usage() {
  return [
    "Usage:",
    "  npm run context",
    "  npm run context -- --changed",
    "  npm run context -- --module http",
    "  npm run context -- --json",
    "",
    "Options:",
    "  --changed       Focus on git changed/untracked files.",
    "  --module NAME   Focus on one known module or alias.",
    "  --json          Emit JSON instead of Markdown.",
    "  --help          Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { changed: false, module: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--changed") out.changed = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--module" || arg === "-m") out.module = argv[++i];
    else if (arg.startsWith("--module=")) out.module = arg.slice("--module=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch {
    return "";
  }
}

function currentBranch() {
  return git(["branch", "--show-current"]).trim() || "unknown";
}

function parseStatusLine(line) {
  if (!line) return undefined;
  const status = line.slice(0, 2);
  let file = line.slice(3);
  const renameArrow = " -> ";
  if (file.includes(renameArrow)) file = file.slice(file.lastIndexOf(renameArrow) + renameArrow.length);
  return { status: status.trim() || "modified", file: stripQuotes(file) };
}

function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function changedFiles() {
  const status = git(["status", "--porcelain=v1", "-uall"]);
  if (!status) return [];
  return status.split("\n").map(parseStatusLine).filter(Boolean);
}

function isInside(file, target) {
  if (file === target) return true;
  return file.startsWith(`${target.replace(/\/$/, "")}/`);
}

function moduleMatchesFile(mod, file) {
  return mod.paths.some((p) => isInside(file, p));
}

function findModule(name) {
  if (!name) return undefined;
  const key = name.toLowerCase();
  return modules.find((mod) => mod.name === key || mod.aliases.includes(key));
}

function inferModules(files) {
  const matched = modules.filter((mod) => files.some(({ file }) => moduleMatchesFile(mod, file)));
  return matched.length > 0 ? matched : modules;
}

function existing(paths) {
  return paths.filter((p) => existsSync(path.join(root, p)));
}

function collectContext(options) {
  const pkg = readJson("package.json");
  const files = changedFiles();
  const selectedModule = findModule(options.module);
  if (options.module && !selectedModule) {
    throw new Error(`Unknown module '${options.module}'. Known modules: ${modules.map((m) => m.name).join(", ")}`);
  }

  const activeModules = selectedModule
    ? [selectedModule]
    : options.changed
      ? inferModules(files)
      : modules;

  const activeFiles = selectedModule
    ? files.filter(({ file }) => moduleMatchesFile(selectedModule, file))
    : options.changed
      ? files
      : [];

  return {
    generatedAt: new Date().toISOString(),
    repo: path.basename(root),
    branch: currentBranch(),
    package: {
      name: pkg.name,
      version: pkg.version,
      exports: Object.keys(pkg.exports ?? {}),
      scripts: Object.keys(pkg.scripts ?? {}),
    },
    mode: selectedModule ? `module:${selectedModule.name}` : options.changed ? "changed" : "all",
    changedFiles: files,
    activeFiles,
    modules: activeModules.map((mod) => ({
      name: mod.name,
      purpose: mod.purpose,
      paths: existing(mod.paths),
      docs: existing(mod.docs),
      tests: existing(mod.tests),
      validation: mod.validation,
      changedFiles: files.filter(({ file }) => moduleMatchesFile(mod, file)),
    })),
    invariants: invariantBullets,
    publicDocs: existing(["AGENTS.md", "docs/ai/PROJECT_MAP.md", "docs/ai/INVARIANTS.md", "docs/ai/VALIDATION_MATRIX.md", "docs/ai/PUBLIC_API.md", "docs/adr/0001-ai-context-pack.md"]),
  };
}

function bulletList(items, prefix = "-") {
  if (!items.length) return `${prefix} none`;
  return items.map((item) => `${prefix} ${item}`).join("\n");
}

function changedList(items) {
  if (!items.length) return "- none";
  return items.map(({ status, file }) => `- ${status.padEnd(2)} ${file}`).join("\n");
}

function renderMarkdown(ctx) {
  const lines = [];
  lines.push("# Brass Runtime Context Pack");
  lines.push("");
  lines.push(`Generated: ${ctx.generatedAt}`);
  lines.push(`Repo: ${ctx.repo}`);
  lines.push(`Branch: ${ctx.branch}`);
  lines.push(`Mode: ${ctx.mode}`);
  lines.push("");
  lines.push("## Package");
  lines.push("");
  lines.push(`- name: ${ctx.package.name}`);
  lines.push(`- version: ${ctx.package.version}`);
  lines.push(`- exports: ${ctx.package.exports.join(", ") || "none"}`);
  lines.push("");
  lines.push("## Changed Files");
  lines.push("");
  lines.push(changedList(ctx.mode === "all" ? ctx.changedFiles : ctx.activeFiles));
  lines.push("");
  lines.push("## Active Modules");
  for (const mod of ctx.modules) {
    lines.push("");
    lines.push(`### ${mod.name}`);
    lines.push("");
    lines.push(mod.purpose);
    lines.push("");
    lines.push("Paths:");
    lines.push(bulletList(mod.paths));
    lines.push("");
    lines.push("Docs:");
    lines.push(bulletList(mod.docs));
    lines.push("");
    lines.push("Tests:");
    lines.push(bulletList(mod.tests));
    lines.push("");
    lines.push("Validation:");
    lines.push(bulletList(mod.validation));
    if (mod.changedFiles.length) {
      lines.push("");
      lines.push("Module changes:");
      lines.push(changedList(mod.changedFiles));
    }
  }
  lines.push("");
  lines.push("## Invariants To Keep In Mind");
  lines.push("");
  lines.push(bulletList(ctx.invariants));
  lines.push("");
  lines.push("## Context Docs");
  lines.push("");
  lines.push(bulletList(ctx.publicDocs));
  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const ctx = collectContext(options);
  if (options.json) console.log(JSON.stringify(ctx, null, 2));
  else console.log(renderMarkdown(ctx));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
