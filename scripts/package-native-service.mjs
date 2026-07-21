#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const executable = process.platform === "win32" ? "brass-native-service.exe" : "brass-native-service";
const source = resolve(root, process.env.BRASS_NATIVE_SOURCE ?? `target/release/${executable}`);
if (!existsSync(source)) throw new Error(`Native service binary does not exist: ${source}`);
const directory = resolve(root, "native", `${process.platform}-${process.arch}`);
const destination = resolve(directory, executable);
mkdirSync(directory, { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
const bytes = readFileSync(destination);
writeFileSync(resolve(directory, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  protocolVersion: 1,
  platform: process.platform,
  architecture: process.arch,
  executable,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  readOnlyPilot: true,
}, null, 2)}\n`, "utf8");
process.stdout.write(`Packaged ${destination}\n`);
