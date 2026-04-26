#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const options = {
  packageName: "brass-runtime",
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

  if (arg === "--package" || arg.startsWith("--package=")) options.packageName = readValue("--package");
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: node scripts/unlink-agent-cli.mjs [options]\n\nRemoves the global brass-agent npm link/install if present.\n\nOptions:\n  --package NAME  Global package name to remove. Default: brass-runtime.\n  --dry-run       Print commands without executing them.`);
    process.exit(0);
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

const runAllowFailure = (command, commandArgs) => {
  const rendered = `$ ${command} ${commandArgs.map((value) => JSON.stringify(value)).join(" ")}`;
  console.log(rendered);
  if (options.dryRun) return { status: 0 };

  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.warn(`${rendered} could not run: ${result.error.message}`);
    return result;
  }

  if ((result.status ?? 0) !== 0) {
    console.warn(`${rendered} exited with ${result.status}. Continuing because the package may not be linked/installed.`);
  }

  return result;
};

runAllowFailure("npm", ["unlink", "-g", options.packageName]);
runAllowFailure("npm", ["uninstall", "-g", options.packageName]);

console.log("\nGlobal Brass Agent CLI removal completed.");
console.log("Verify with:");
console.log("  which brass-agent");
console.log("or:");
console.log("  brass-agent --version");
