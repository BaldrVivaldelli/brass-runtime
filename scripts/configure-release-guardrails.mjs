#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildReleaseGuardrailPlan } from "./release-guardrail-plan.mjs";

const policy = JSON.parse(readFileSync(
  new URL("../.github/release-guardrails.json", import.meta.url),
  "utf8",
));
const apply = process.argv.includes("--apply");
const confirmation = argumentValue("--confirm");
const plan = buildReleaseGuardrailPlan(policy);

if (!apply) {
  if (process.argv.includes("--json")) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`Release guardrail plan for ${policy.repository} (${plan.operations.length} operations):`);
    for (const operation of plan.operations) console.log(`- PUT ${operation.endpoint}`);
    console.log(`No remote changes made. Apply only with --apply --confirm ${policy.repository}.`);
  }
} else {
  if (confirmation !== policy.repository) {
    throw new Error(`Refusing remote mutation without --confirm ${policy.repository}`);
  }

  preflight(policy);
  for (const operation of plan.operations) {
    const result = spawnSync("gh", [
      "api",
      "--method",
      "PUT",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${policy.githubApiVersion}`,
      operation.endpoint,
      "--input",
      "-",
    ], {
      encoding: "utf8",
      input: `${JSON.stringify(operation.payload)}\n`,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Failed to apply ${operation.endpoint}:\n${result.stderr}`);
    }
    console.log(`Applied ${operation.endpoint}`);
  }
  console.log(`Applied ${plan.operations.length} release guardrail operations. Run npm run audit:release-guardrails.`);
}

function preflight(configuration) {
  const secrets = api(`repos/${configuration.repository}/actions/secrets`);
  const names = new Set(secrets.secrets?.map((secret) => secret.name) ?? []);
  for (const name of configuration.requiredRepositorySecretNames) {
    if (!names.has(name)) throw new Error(`Preflight failed: missing repository secret ${name}`);
  }
  for (const branchName of Object.keys(configuration.branches)) {
    api(`repos/${configuration.repository}/branches/${branchName}`);
  }
}

function api(endpoint) {
  const result = spawnSync("gh", [
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${policy.githubApiVersion}`,
    endpoint,
  ], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Preflight gh api ${endpoint} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function argumentValue(name) {
  const inline = process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
