#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function argumentValue(name) {
  const inline = process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const requestedTarball = argumentValue("--runtime-tarball");
const stagingRoot = mkdtempSync(join(tmpdir(), "brass-express-lighthouse-"));
const stagedExamples = join(stagingRoot, "examples");
const stagedExpress = join(stagedExamples, "express");
let child;

try {
  const runtimeTarball = requestedTarball
    ? resolve(requestedTarball)
    : packRuntime(stagingRoot);
  if (!existsSync(runtimeTarball)) throw new Error(`Runtime tarball does not exist: ${runtimeTarball}`);

  cpSync(resolve("examples/express"), stagedExpress, { recursive: true });
  cpSync(resolve("examples/shared"), join(stagedExamples, "shared"), { recursive: true });

  const sourceManifestPath = join(stagedExpress, "package.json");
  const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  manifest.name = "brass-express-lighthouse";
  manifest.dependencies["brass-runtime"] = `file:${runtimeTarball}`;
  const manifestPath = join(stagedExamples, "package.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], stagedExamples);
  const tscCli = join(stagedExamples, "node_modules", "typescript", "bin", "tsc");
  runNode([tscCli, "-p", join(stagedExpress, "tsconfig.json"), "--noEmit"], stagedExamples);

  const port = await availablePort();
  const tsxCli = join(stagedExamples, "node_modules", "tsx", "dist", "cli.mjs");
  child = spawn(process.execPath, [tsxCli, "src/server.ts"], {
    cwd: stagedExpress,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  await waitForReady(child, output, `Express example listening on http://localhost:${port}`);

  const incomingTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const userResponse = await fetch(`http://127.0.0.1:${port}/users/42`, {
    headers: { traceparent: `00-${incomingTraceId}-bbbbbbbbbbbbbbbb-01` },
  });
  assert.equal(userResponse.status, 200);
  const user = await userResponse.json();
  assert.equal(user.user?.id, "42");
  assert.equal(user.user?.role, "user");
  assert.equal(user.traceId, incomingTraceId);

  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ready, true);

  const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.match(await metricsResponse.text(), /http/);

  child.kill("SIGTERM");
  const exit = await waitForExit(child, 10_000);
  assert.equal(exit.code, 0, `Express lighthouse did not shut down cleanly:\n${output.text}`);
  child = undefined;

  console.log(`Express lighthouse passed against ${basename(runtimeTarball)} (typecheck, HTTP, observability, graceful shutdown).`);
} finally {
  if (child?.exitCode === null) child.kill("SIGKILL");
  rmSync(stagingRoot, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const result = spawnSync(npmCommand, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${npmCommand} ${args.join(" ")} failed with status ${result.status}`);
}

function packRuntime(destination) {
  const result = spawnSync(
    npmCommand,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed with status ${result.status}: ${result.stderr}`);
  const packed = JSON.parse(result.stdout);
  const filename = packed?.[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball filename");
  return join(destination, filename);
}

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node ${args.join(" ")} failed with status ${result.status}`);
}

function collectOutput(processHandle) {
  const output = { text: "" };
  const append = (chunk) => {
    const value = chunk.toString("utf8");
    output.text += value;
    process.stdout.write(value);
  };
  processHandle.stdout.on("data", append);
  processHandle.stderr.on("data", append);
  return output;
}

function waitForReady(processHandle, output, marker) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for Express:\n${output.text}`)), 10_000);
    const poll = setInterval(() => {
      if (output.text.includes(marker)) finish();
    }, 25);
    const onExit = (code, signal) => finish(new Error(`Express exited before readiness (${code ?? signal}):\n${output.text}`));
    processHandle.once("exit", onExit);

    function finish(error) {
      clearTimeout(timer);
      clearInterval(poll);
      processHandle.off("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady();
    }
  });
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Timed out waiting for graceful shutdown")), timeoutMs);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}
