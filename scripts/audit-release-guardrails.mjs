#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const policy = JSON.parse(readFileSync(
  new URL("../.github/release-guardrails.json", import.meta.url),
  "utf8",
));
const failures = [];
const observed = {
  repository: policy.repository,
  secretNames: [],
  branches: {},
  environments: {},
};

const secrets = api(`repos/${policy.repository}/actions/secrets`);
observed.secretNames = secrets.secrets?.map((secret) => secret.name).sort() ?? [];
for (const secretName of policy.requiredRepositorySecretNames) {
  if (!observed.secretNames.includes(secretName)) failures.push(`missing repository secret ${secretName}`);
}

for (const [branchName, desired] of Object.entries(policy.branches)) {
  const branch = apiOptional(`repos/${policy.repository}/branches/${branchName}`);
  const protection = apiOptional(`repos/${policy.repository}/branches/${branchName}/protection`);
  observed.branches[branchName] = {
    exists: branch !== null,
    protected: protection !== null,
  };
  if (!branch) {
    failures.push(`branch ${branchName} does not exist`);
    continue;
  }
  if (!protection) {
    failures.push(`branch ${branchName} is not protected`);
    continue;
  }

  const actualChecks = new Map(
    protection.required_status_checks?.checks?.map((check) => [check.context, check.app_id]) ?? [],
  );
  for (const check of desired.requiredStatusChecks.checks) {
    if (actualChecks.get(check.context) !== check.appId) {
      failures.push(`${branchName} is missing ${check.context} from app ${check.appId}`);
    }
  }
  compare(`${branchName} strict status checks`, protection.required_status_checks?.strict, desired.requiredStatusChecks.strict);
  compare(`${branchName} admin enforcement`, protection.enforce_admins?.enabled, desired.enforceAdmins);
  compare(
    `${branchName} pull-request requirement`,
    protection.required_pull_request_reviews !== null && protection.required_pull_request_reviews !== undefined,
    desired.requirePullRequest,
  );
  compare(
    `${branchName} approval count`,
    protection.required_pull_request_reviews?.required_approving_review_count,
    desired.requiredApprovingReviewCount,
  );
  compare(
    `${branchName} stale-review dismissal`,
    protection.required_pull_request_reviews?.dismiss_stale_reviews,
    desired.dismissStaleReviews,
  );
  compare(
    `${branchName} conversation resolution`,
    protection.required_conversation_resolution?.enabled,
    desired.requireConversationResolution,
  );
  compare(`${branchName} force pushes`, protection.allow_force_pushes?.enabled, desired.allowForcePushes);
  compare(`${branchName} deletions`, protection.allow_deletions?.enabled, desired.allowDeletions);
}

for (const [environmentName, desired] of Object.entries(policy.environments)) {
  const environment = apiOptional(`repos/${policy.repository}/environments/${environmentName}`);
  observed.environments[environmentName] = { exists: environment !== null };
  if (!environment) {
    failures.push(`environment ${environmentName} does not exist`);
    continue;
  }
  const reviewersRule = environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
  const reviewers = reviewersRule?.reviewers ?? [];
  for (const desiredReviewer of desired.reviewers) {
    const found = reviewers.some((entry) =>
      entry.type === desiredReviewer.type && entry.reviewer?.id === desiredReviewer.id);
    if (!found) failures.push(`${environmentName} is missing reviewer ${desiredReviewer.login}`);
  }
  const waitRule = environment.protection_rules?.find((rule) => rule.type === "wait_timer");
  compare(`${environmentName} wait timer`, waitRule?.wait_timer ?? 0, desired.waitTimerMinutes);
  compare(
    `${environmentName} self-review prevention`,
    reviewersRule?.prevent_self_review ?? false,
    desired.preventSelfReview,
  );
  compare(
    `${environmentName} protected-branch deployments`,
    environment.deployment_branch_policy?.protected_branches,
    desired.protectedBranchesOnly,
  );
  compare(
    `${environmentName} custom-branch deployments`,
    environment.deployment_branch_policy?.custom_branch_policies,
    !desired.protectedBranchesOnly,
  );
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ schemaVersion: 1, observed, compliant: failures.length === 0, failures }, null, 2));
} else if (failures.length === 0) {
  console.log(`Remote release guardrails are enforced for ${policy.repository}.`);
} else {
  console.error(`Remote release guardrail audit failed for ${policy.repository}:`);
  for (const failure of failures) console.error(`- ${failure}`);
}
if (failures.length > 0) process.exitCode = 1;

function compare(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: observed ${String(actual)}, expected ${String(expected)}`);
}

function api(endpoint) {
  const result = runGh(endpoint);
  if (result.status !== 0) throw new Error(`gh api ${endpoint} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function apiOptional(endpoint) {
  const result = runGh(endpoint);
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/HTTP 404|status.?404|Not Found/i.test(result.stderr)) return null;
  throw new Error(`gh api ${endpoint} failed:\n${result.stderr}`);
}

function runGh(endpoint) {
  return spawnSync("gh", [
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${policy.githubApiVersion}`,
    endpoint,
  ], { encoding: "utf8" });
}
