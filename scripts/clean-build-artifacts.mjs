#!/usr/bin/env node

import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const targets = [path.join(root, "dist"), path.join(root, "wasm", "pkg")];

for (const target of targets) rmSync(target, { recursive: true, force: true });

console.log("Removed generated dist and wasm/pkg artifacts.");
