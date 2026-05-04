#!/usr/bin/env node
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(root, "dist", "agent", "cli", "main.cjs");

const fail = (message, details) => {
  console.error(`agent local smoke failed: ${message}`);
  if (details) console.error(details);
  process.exit(1);
};

if (!existsSync(cli)) {
  fail(`built CLI was not found at ${cli}`, "Run `npm run build` first, or use `npm run agent:test:local`.");
}

const runAgent = (cwd, args, env = {}) => {
  const result = spawnSync(process.execPath, [cli, "--no-config", "--no-env-file", "--cwd", cwd, ...args], {
    cwd,
    env: {
      ...process.env,
      BRASS_LLM_PROVIDER: "fake",
      ...env,
    },
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  return result;
};

const parseJson = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    fail("could not parse JSON output", stdout);
  }
};

const tmp = await mkdtemp(path.join(tmpdir(), "brass-agent-smoke-"));

try {
  await writeFile(path.join(tmp, "package.json"), JSON.stringify({
    name: "brass-agent-smoke",
    private: true,
    scripts: {
      test: "node test.js"
    }
  }, null, 2));
  await writeFile(path.join(tmp, "message.txt"), "old\n");
  await writeFile(path.join(tmp, "test.js"), [
    "const { readFileSync } = require('node:fs');",
    "const value = readFileSync('message.txt', 'utf8').trim();",
    "if (value !== 'new') { console.error(`expected new, got ${value}`); process.exit(1); }",
    "console.log('ok');",
    ""
  ].join("\n"));

  const inspect = runAgent(tmp, ["--mode", "read-only", "--json", "inspect this smoke project"]);
  if (inspect.status !== 0) fail("read-only inspect exited non-zero", inspect.stderr || inspect.stdout);
  const inspectState = parseJson(inspect.stdout);
  if (inspectState.phase !== "done") fail("read-only inspect did not finish with phase done", inspect.stdout);

  const patch = [
    "```diff",
    "--- a/message.txt",
    "+++ b/message.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "```",
  ].join("\n");

  const apply = runAgent(tmp, ["--apply", "--yes", "--json", "fix the failing smoke test"], {
    BRASS_FAKE_LLM_RESPONSE: patch,
  });
  if (apply.status !== 0) fail("apply run exited non-zero", apply.stderr || apply.stdout);
  const applyState = parseJson(apply.stdout);
  if (applyState.phase !== "done") fail("apply run did not finish with phase done", apply.stdout);

  const message = await readFile(path.join(tmp, "message.txt"), "utf8");
  if (message.trim() !== "new") fail("patch did not update message.txt", message);

  console.log("agent local smoke ok");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
