import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const fail = (message) => {
  throw new Error(`Release policy validation failed: ${message}`);
};

const packageJson = await readJson(new URL("../package.json", import.meta.url));
const packageLock = await readJson(new URL("../package-lock.json", import.meta.url));
const releaseConfig = await readJson(new URL("../.releaserc.json", import.meta.url));
const stabilityBudgets = await readJson(new URL("./stability-budgets.json", import.meta.url));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const stabilityWorkflow = await readFile(new URL("../.github/workflows/stability.yml", import.meta.url), "utf8");
const v2BetaWorkflow = await readFile(new URL("../.github/workflows/v2-beta.yml", import.meta.url), "utf8");
const publishV2BetaWorkflow = await readFile(new URL("../.github/workflows/publish-v2-beta.yml", import.meta.url), "utf8");
const publishProductWorkflow = await readFile(new URL("../.github/workflows/publish-product-alpha.yml", import.meta.url), "utf8");

if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages?.[""]?.version) {
  fail("package.json and package-lock.json versions must match");
}
if (packageJson.engines?.node !== ">=18") fail("the stable v1 Node engine contract must be >=18");
if (!packageJson.scripts?.["release:check"]?.includes("npm run validate:product-publish-dry-run")) {
  fail("the release gate must execute companion-product publication dry-runs");
}

const main = releaseConfig.branches?.some((branch) => branch === "main");
if (!main || releaseConfig.branches.length !== 1) {
  fail("semantic-release must be restricted to the stable main branch");
}

const analyzer = releaseConfig.plugins?.find((plugin) =>
  Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer");
const rules = new Map(analyzer?.[1]?.releaseRules?.map((rule) => [rule.type, rule.release]) ?? []);
for (const type of ["chore", "docs", "test", "ci", "build", "style"]) {
  if (rules.get(type) !== false) fail(`${type} commits must not publish`);
}
if (rules.get("feat") !== "minor" || rules.get("fix") !== "patch" || rules.get("perf") !== "patch") {
  fail("feat/fix/perf semantic version rules changed unexpectedly");
}

const npmIndex = releaseConfig.plugins?.findIndex((plugin) => plugin === "@semantic-release/npm") ?? -1;
const gitIndex = releaseConfig.plugins?.findIndex((plugin) =>
  Array.isArray(plugin) && plugin[0] === "@semantic-release/git") ?? -1;
const githubIndex = releaseConfig.plugins?.findIndex((plugin) => plugin === "@semantic-release/github") ?? -1;
if (!(npmIndex >= 0 && gitIndex > npmIndex && githubIndex > gitIndex)) {
  fail("npm, synchronized Git commit, and GitHub publication must run in that order");
}
const gitPlugin = releaseConfig.plugins[gitIndex];
for (const asset of ["package.json", "package-lock.json"]) {
  if (!gitPlugin[1]?.assets?.includes(asset)) fail(`release commit must include ${asset}`);
}
if (!gitPlugin[1]?.message?.includes("[skip ci]")) fail("release commits must prevent recursive CI releases");

if (!releaseWorkflow.includes('cron: "0 9 * * 1"')) fail("stable weekly release schedule is missing");
if (releaseWorkflow.includes("branches: [next]")) fail("the stable publisher must not run on next pushes");
if (!releaseWorkflow.includes("if: github.ref == 'refs/heads/main'")) {
  fail("the stable publisher must be locked to the main branch");
}
if (!releaseWorkflow.includes("semantic-release@25.0.9") || !releaseWorkflow.includes("@semantic-release/git@10.0.1")) {
  fail("release tooling must be pinned in the isolated release job");
}

const requiredV2BetaFragments = [
  "branches: [main, next]",
  "node-version: [20, 22]",
  "npm run validate:v2-beta",
  "npm run validate:example:v2-core",
  "brass-runtime-v2-beta-package",
  "artifacts/v2-beta/*.tgz",
];
for (const fragment of requiredV2BetaFragments) {
  if (!v2BetaWorkflow.includes(fragment)) fail(`v2 beta workflow is missing: ${fragment}`);
}

const requiredV2PublishFragments = [
  "workflow_dispatch:",
  "github.ref == 'refs/heads/next' && inputs.publish",
  "environment: npm-next",
  "npm run release:check",
  "npm run validate:v2-beta -- --version",
  "npm run validate:example:v2-core -- --beta-tarball",
  "brass-runtime-${BRASS_BETA_VERSION}.tgz",
  "--dry-run --access public --tag next --json",
  'npm view "brass-runtime@$BRASS_BETA_VERSION" version',
  "npm publish ./artifacts/v2-beta/package",
  "--tag next",
  "--provenance",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
];
for (const fragment of requiredV2PublishFragments) {
  if (!publishV2BetaWorkflow.includes(fragment)) fail(`v2 beta publisher is missing: ${fragment}`);
}

const requiredProductPublishFragments = [
  "workflow_dispatch:",
  "github.ref == 'refs/heads/main' && inputs.publish",
  "environment: npm-products",
  "npm run release:check",
  'npm run "validate:product:$PRODUCT"',
  "--dry-run --access public --tag alpha --json",
  "--tag alpha --provenance",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
];
for (const fragment of requiredProductPublishFragments) {
  if (!publishProductWorkflow.includes(fragment)) fail(`product alpha publisher is missing: ${fragment}`);
}

const requiredStabilityFragments = [
  'cron: "0 3 * * 6"',
  "timeout-minutes: 45",
  "npm run build:wasm",
  "npm run test:stability",
  "npm run perf:stability:soak",
  "npm run benchmark:http:stability",
  "npm run benchmark:adaptive:stability",
  "if: always()",
];
for (const fragment of requiredStabilityFragments) {
  if (!stabilityWorkflow.includes(fragment)) fail(`stability workflow is missing: ${fragment}`);
}
if (stabilityBudgets.version !== 1
  || stabilityBudgets.runtime?.rounds < 2
  || stabilityBudgets.http?.calls < 100_000
  || stabilityBudgets.adaptive?.samples < 100_000) {
  fail("versioned stability budgets must retain bounded soak coverage");
}

console.log(`Release policy validated for brass-runtime ${packageJson.version}.`);
