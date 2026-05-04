#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(repoRoot, "extensions", "vscode-brass-agent");
const extensionId = "baldr-vivaldelli.vscode-brass-agent";

const options = {
  codeCommand: process.env.BRASS_CODE_CMD || "code",
  workspace: repoRoot,
  uninstall: true,
  removeInstalledDirs: true,
  removeGlobalStorage: true,
  removeWorkspaceSettings: true,
  removeVsix: true,
  removeExtensionBuild: false,
  yes: false,
  dryRun: false,
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
  else if (arg === "--no-uninstall") options.uninstall = false;
  else if (arg === "--no-installed-dirs") options.removeInstalledDirs = false;
  else if (arg === "--no-global-storage") options.removeGlobalStorage = false;
  else if (arg === "--no-settings") options.removeWorkspaceSettings = false;
  else if (arg === "--no-vsix") options.removeVsix = false;
  else if (arg === "--extension-build") options.removeExtensionBuild = true;
  else if (arg === "--yes" || arg === "-y") options.yes = true;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: node scripts/clean-vscode-extension.mjs [options]\n\nRemoves the local Brass Agent VS Code extension install and generated artifacts.\n\nOptions:\n  --workspace PATH        Workspace whose .vscode/settings.json should be cleaned.\n  --code CMD              VS Code CLI command. Default: code or BRASS_CODE_CMD.\n  --no-uninstall          Do not run code --uninstall-extension.\n  --no-installed-dirs     Do not remove installed extension folders under ~/.vscode*/extensions.\n  --no-global-storage     Do not remove VS Code globalStorage folders for the extension.\n  --no-settings           Do not remove brassAgent.* keys from workspace .vscode/settings.json.\n  --no-vsix               Do not delete generated .vsix packages in the extension folder.\n  --extension-build       Also delete extensions/vscode-brass-agent/out.\n  --yes, -y               Execute destructive file deletes. Required unless --dry-run.\n  --dry-run               Print what would be removed without deleting anything.`);
    process.exit(0);
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

const destructiveAllowed = options.yes || options.dryRun;
if (!destructiveAllowed) {
  console.error("Refusing to delete files without --yes. Use --dry-run to preview.");
  process.exit(2);
}

const run = (command, commandArgs, cwd, allowFailure = false) => {
  const rendered = `$ ${command} ${commandArgs.map((value) => JSON.stringify(value)).join(" ")}`;
  console.log(rendered);
  if (options.dryRun) return { status: 0 };

  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    if (allowFailure) return result;
    throw result.error;
  }
  if ((result.status ?? 0) !== 0 && !allowFailure) {
    throw new Error(`${rendered} failed with exit code ${result.status}`);
  }
  return result;
};

const removePath = (path) => {
  console.log(`remove ${path}`);
  if (!options.dryRun && existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
};

const existingDirs = (root, predicate) => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && predicate(entry.name))
    .map((entry) => join(root, entry.name));
};

const home = homedir();
const extensionInstallRoots = [
  join(home, ".vscode", "extensions"),
  join(home, ".vscode-insiders", "extensions"),
  join(home, ".cursor", "extensions"),
  join(home, ".windsurf", "extensions"),
];

const codeGlobalStorageRoots = (() => {
  if (platform() === "darwin") {
    return [
      join(home, "Library", "Application Support", "Code", "User", "globalStorage"),
      join(home, "Library", "Application Support", "Code - Insiders", "User", "globalStorage"),
      join(home, "Library", "Application Support", "Cursor", "User", "globalStorage"),
      join(home, "Library", "Application Support", "Windsurf", "User", "globalStorage"),
    ];
  }

  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return [
      join(appData, "Code", "User", "globalStorage"),
      join(appData, "Code - Insiders", "User", "globalStorage"),
      join(appData, "Cursor", "User", "globalStorage"),
      join(appData, "Windsurf", "User", "globalStorage"),
    ];
  }

  return [
    join(home, ".config", "Code", "User", "globalStorage"),
    join(home, ".config", "Code - Insiders", "User", "globalStorage"),
    join(home, ".config", "Cursor", "User", "globalStorage"),
    join(home, ".config", "Windsurf", "User", "globalStorage"),
  ];
})();

if (options.uninstall) {
  run(options.codeCommand, ["--uninstall-extension", extensionId], repoRoot, true);
}

if (options.removeInstalledDirs) {
  for (const root of extensionInstallRoots) {
    for (const dir of existingDirs(root, (name) => name === extensionId || name.startsWith(`${extensionId}-`))) {
      removePath(dir);
    }
  }
}

if (options.removeGlobalStorage) {
  for (const root of codeGlobalStorageRoots) {
    removePath(join(root, extensionId));
  }
}

if (options.removeVsix && existsSync(extensionDir)) {
  for (const file of readdirSync(extensionDir)) {
    if (file.endsWith(".vsix")) removePath(join(extensionDir, file));
  }
}

if (options.removeExtensionBuild) {
  removePath(join(extensionDir, "out"));
}

if (options.removeWorkspaceSettings) {
  const settingsPath = join(options.workspace, ".vscode", "settings.json");
  console.log(`clean ${settingsPath}`);
  if (!options.dryRun && existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const key of Object.keys(settings)) {
      if (key.startsWith("brassAgent.")) delete settings[key];
    }
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}

console.log("\nVS Code Brass Agent clean completed.");
console.log("Next install:");
console.log("  npm run agent:vscode:install");
console.log("Then reload VS Code:");
console.log("  Developer: Reload Window");
