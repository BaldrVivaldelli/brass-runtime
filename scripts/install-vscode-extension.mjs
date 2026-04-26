#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const options = {
  codeCommand: process.env.BRASS_CODE_CMD || "code",
  workspace: repoRoot,
  command: undefined,
  useGlobalCommand: false,
  rootInstall: true,
  rootBuild: true,
  extensionInstall: true,
  extensionCompile: true,
  extensionPackage: true,
  bundleCli: true,
  codeInstall: true,
  writeSettings: true,
  dryRun: false,
  force: true,
};

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const readValue = (flag) => {
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    const next = args[i + 1];
    if (!next) throw new Error(`${flag} requires a value`);
    i += 1;
    return next;
  };

  if (arg === "--code" || arg.startsWith("--code=")) options.codeCommand = readValue("--code");
  else if (arg === "--workspace" || arg.startsWith("--workspace=")) options.workspace = resolve(readValue("--workspace"));
  else if (arg === "--command" || arg.startsWith("--command=")) options.command = readValue("--command");
  else if (arg === "--use-global-command") options.useGlobalCommand = true;
  else if (arg === "--no-root-install") options.rootInstall = false;
  else if (arg === "--no-root-build") options.rootBuild = false;
  else if (arg === "--no-extension-install") options.extensionInstall = false;
  else if (arg === "--no-compile") options.extensionCompile = false;
  else if (arg === "--no-package") options.extensionPackage = false;
  else if (arg === "--no-bundle-cli") options.bundleCli = false;
  else if (arg === "--no-code-install") options.codeInstall = false;
  else if (arg === "--no-settings") options.writeSettings = false;
  else if (arg === "--no-force") options.force = false;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: node scripts/install-vscode-extension.mjs [options]\n\nOptions:\n  --workspace PATH        Workspace where .vscode/settings.json should be written.\n  --code CMD              VS Code CLI command. Default: code or BRASS_CODE_CMD.\n  --no-root-install       Skip npm install in the repo root.\n  --no-root-build         Skip npm run build in the repo root.\n  --no-extension-install  Skip npm install in the VS Code extension folder.\n  --no-compile            Skip extension compile.\n  --no-package            Skip .vsix packaging.\n  --no-bundle-cli         Skip copying the built CLI into the VS Code extension bundle.\n  --no-code-install       Do not run code --install-extension.\n  --no-settings           Do not write workspace .vscode/settings.json.\n  --no-force              Do not pass --force to code --install-extension.\n  --dry-run               Print commands and file writes without executing them.`);
    process.exit(0);
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

const run = (command, commandArgs, cwd) => {
  const rendered = `$ ${command} ${commandArgs.map((value) => JSON.stringify(value)).join(" ")}`;
  console.log(rendered);
  if (options.dryRun) return;

  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) throw new Error(`${rendered} failed with exit code ${result.status}`);
};

const extensionDir = join(repoRoot, "extensions", "vscode-brass-agent");
const cliPath = join(repoRoot, "dist", "agent", "cli", "main.cjs");

if (options.rootInstall && !existsSync(join(repoRoot, "node_modules"))) {
  run("npm", ["install"], repoRoot);
}

if (options.rootBuild) {
  run("npm", ["run", "build"], repoRoot);
}

if (!existsSync(cliPath) && !options.dryRun) {
  throw new Error(`Built CLI not found: ${cliPath}`);
}

if (options.bundleCli) {
  run("node", ["scripts/prepare-vscode-bundle.mjs"], repoRoot);
}

if (options.extensionInstall && !existsSync(join(extensionDir, "node_modules"))) {
  run("npm", ["install"], extensionDir);
}

if (options.extensionCompile) {
  run("npm", ["run", "compile"], extensionDir);
}

if (options.extensionPackage) {
  run("npm", ["run", "package:vsix"], extensionDir);
}

const findVsix = () => readdirSync(extensionDir)
  .filter((name) => name.endsWith(".vsix"))
  .sort()
  .at(-1);

const vsix = options.dryRun ? "vscode-brass-agent-0.0.1.vsix" : findVsix();
if (!vsix && options.codeInstall) {
  throw new Error(`No .vsix found in ${extensionDir}. Run with packaging enabled first.`);
}

if (options.codeInstall && vsix) {
  const installArgs = ["--install-extension", join(extensionDir, vsix)];
  if (options.force) installArgs.push("--force");
  run(options.codeCommand, installArgs, repoRoot);
}

if (options.writeSettings) {
  const vscodeDir = join(options.workspace, ".vscode");
  const settingsPath = join(vscodeDir, "settings.json");
  let settings = {};

  if (!options.dryRun && existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  settings["brassAgent.command"] = options.command || (options.useGlobalCommand ? "brass-agent" : "auto");
  settings["brassAgent.preferBundledCli"] = options.useGlobalCommand ? false : true;

  console.log(`write ${settingsPath}`);
  if (!options.dryRun) {
    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

console.log("\nlocal VS Code install flow completed.");
console.log(`CLI setting: ${options.command || (options.useGlobalCommand ? "brass-agent" : "auto (bundled/workspace/global discovery)")}`);
if (vsix) console.log(`VSIX: ${join(extensionDir, vsix)}`);
console.log("\nNext steps in VS Code:");
console.log("  1. Run: Developer: Reload Window");
console.log("  2. Click the Brass Agent icon in the Activity Bar");
console.log("  3. Open the Chat view, or run: Brass Agent: Open Chat");
console.log("  4. Optional: run Brass Agent: Configure CLI to inspect auto-discovery.");
console.log("\nIf the UI still looks stale:");
console.log("  npm run agent:vscode:reinstall");
console.log("Run `npm run agent:doctor` to verify the local setup.");
