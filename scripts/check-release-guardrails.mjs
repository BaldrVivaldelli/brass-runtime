#!/usr/bin/env node

import { readFileSync } from "node:fs";

const policy = JSON.parse(readFileSync(
  new URL("../.github/release-guardrails.json", import.meta.url),
  "utf8",
));
const failures = [];

if (policy.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (policy.repository !== "BaldrVivaldelli/brass-runtime") failures.push("repository identity changed");
if (policy.githubApiVersion !== "2026-03-10") failures.push("GitHub REST API version must remain pinned");
if (!policy.requiredRepositorySecretNames?.includes("NPM_TOKEN")) {
  failures.push("NPM_TOKEN must remain an explicit repository prerequisite");
}

for (const branchName of ["main", "next"]) {
  const branch = policy.branches?.[branchName];
  if (!branch) {
    failures.push(`${branchName} branch policy is missing`);
    continue;
  }
  const checks = new Map(branch.requiredStatusChecks?.checks?.map((check) => [check.context, check.appId]));
  if (branch.requiredStatusChecks?.strict !== true
    || checks.get("validate") !== 15368
    || checks.get("audit") !== 15368
    || checks.get("examples") !== 15368
    || checks.get("CodeQL") !== 57789) {
    failures.push(`${branchName} must require strict validate, audit, examples, and CodeQL checks from their verified apps`);
  }
  if (branch.enforceAdmins !== true
    || branch.requirePullRequest !== true
    || branch.dismissStaleReviews !== true
    || branch.requireConversationResolution !== true
    || branch.allowForcePushes !== false
    || branch.allowDeletions !== false) {
    failures.push(`${branchName} must enforce PRs, admins, conversations, and destructive-push protections`);
  }
  if (branch.requiredApprovingReviewCount !== 0) {
    failures.push(`${branchName} temporary single-maintainer approval count must remain explicit`);
  }
}

for (const environmentName of ["npm-next", "npm-products"]) {
  const environment = policy.environments?.[environmentName];
  const reviewer = environment?.reviewers?.[0];
  if (!environment
    || environment.reviewers.length !== 1
    || reviewer?.type !== "User"
    || reviewer?.id !== 18494121
    || reviewer?.login !== "BaldrVivaldelli"
    || environment.preventSelfReview !== false
    || environment.waitTimerMinutes !== 0
    || environment.protectedBranchesOnly !== true) {
    failures.push(`${environmentName} must retain the explicit single-maintainer protected-branch approval policy`);
  }
}

if (!Array.isArray(policy.limitations) || policy.limitations.length < 3) {
  failures.push("guardrail limitations and second-maintainer debt must remain explicit");
}

if (failures.length > 0) {
  console.error("Release guardrail validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Release guardrail desired state validated for main, next, npm-next, and npm-products.");
}
