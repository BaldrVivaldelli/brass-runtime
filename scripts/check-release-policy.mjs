import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const fail = (message) => {
  throw new Error(`Release policy validation failed: ${message}`);
};

const packageJson = await readJson(new URL("../package.json", import.meta.url));
const packageLock = await readJson(new URL("../package-lock.json", import.meta.url));
const releaseConfig = await readJson(new URL("../.releaserc.json", import.meta.url));
const stabilityBudgets = await readJson(new URL("./stability-budgets.json", import.meta.url));
const nodeSupport = await readJson(new URL("./node-support-policy.json", import.meta.url));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const qualityWorkflow = await readFile(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8");
const stabilityWorkflow = await readFile(new URL("../.github/workflows/stability.yml", import.meta.url), "utf8");
const v2BetaWorkflow = await readFile(new URL("../.github/workflows/v2-beta.yml", import.meta.url), "utf8");
const dependencySecurityWorkflow = await readFile(new URL("../.github/workflows/dependency-security.yml", import.meta.url), "utf8");
const examplesWorkflow = await readFile(new URL("../.github/workflows/examples.yml", import.meta.url), "utf8");
const publishV2BetaWorkflow = await readFile(new URL("../.github/workflows/publish-v2-beta.yml", import.meta.url), "utf8");
const publishProductWorkflow = await readFile(new URL("../.github/workflows/publish-product-alpha.yml", import.meta.url), "utf8");
const perfWorkflow = await readFile(new URL("../.github/workflows/perf.yml", import.meta.url), "utf8");

if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages?.[""]?.version) {
  fail("package.json and package-lock.json versions must match");
}
if (packageJson.engines?.node !== ">=20") fail("the shipped Node engine contract must be >=20");
if (nodeSupport.schemaVersion !== 1
  || nodeSupport.source !== "https://github.com/nodejs/Release/blob/main/schedule.json"
  || JSON.stringify(nodeSupport.releaseLines?.lts) !== JSON.stringify([22, 24])
  || JSON.stringify(nodeSupport.releaseLines?.current) !== JSON.stringify([26])
  || JSON.stringify(nodeSupport.releaseLines?.eolCompatibility) !== JSON.stringify([18, 20])
  || nodeSupport.stable?.engine !== packageJson.engines.node
  || nodeSupport.stableV1?.engine !== ">=18"
  || JSON.stringify(nodeSupport.stableV1?.fullValidation) !== JSON.stringify([20, 22, 24])
  || JSON.stringify(nodeSupport.stableV1?.compatibilitySmoke) !== JSON.stringify([18])
  || JSON.stringify(nodeSupport.stableV1?.securitySupported) !== JSON.stringify([22, 24])
  || JSON.stringify(nodeSupport.stableV1?.compatibilityOnly) !== JSON.stringify([18, 20])
  || nodeSupport.v2Beta?.engine !== ">=20"
  || JSON.stringify(nodeSupport.v2Beta?.fullValidation) !== JSON.stringify([20, 22, 24])
  || JSON.stringify(nodeSupport.v2Beta?.securitySupported) !== JSON.stringify([22, 24])
  || JSON.stringify(nodeSupport.v2Beta?.compatibilityOnly) !== JSON.stringify([20])
  || nodeSupport.canonicalBuildNode !== 22) {
  fail("the versioned Node support policy must distinguish current LTS support from EOL compatibility");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(nodeSupport.observedAt ?? "")
  || !/^\d{4}-\d{2}-\d{2}$/.test(nodeSupport.reviewAfter ?? "")
  || Date.parse(`${nodeSupport.reviewAfter}T00:00:00Z`) <= Date.now()) {
  fail("the Node support policy must be refreshed no later than the next scheduled LTS transition");
}
if (!packageJson.scripts?.["release:check"]?.includes("npm run validate:product-publish-dry-run")) {
  fail("the release gate must execute companion-product publication dry-runs");
}
for (const script of ["check", "release:check"]) {
  if (!packageJson.scripts?.[script]?.includes("npm run validate:dependency-security")) {
    fail(`${script} must execute the offline dependency security policy`);
  }
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
if (!releaseWorkflow.includes("github.ref == 'refs/heads/main' &&")
  || !releaseWorkflow.includes("inputs.channel == 'stable'")) {
  fail("the stable publisher must be locked to the main branch");
}
const stableReleaseJob = releaseWorkflow.slice(
  releaseWorkflow.indexOf("\n  release:\n"),
  releaseWorkflow.indexOf("\n  v2-beta:\n"),
);
if (!stableReleaseJob
  || !stableReleaseJob.includes("github.event_name == 'schedule'")
  || !stableReleaseJob.includes("github.event_name == 'workflow_dispatch'")
  || !stableReleaseJob.includes("inputs.channel == 'stable' &&")
  || !stableReleaseJob.includes("inputs.publish")) {
  fail("manual stable publication must require publish=true while publish=false remains validation-only");
}
if (!releaseWorkflow.includes("semantic-release@25.0.9") || !releaseWorkflow.includes("@semantic-release/git@10.0.1")) {
  fail("release tooling must be pinned in the isolated release job");
}
if (!releaseWorkflow.includes("node-version: [20, 22, 24]")
  || !releaseWorkflow.includes("node20-compat-smoke")) {
  fail("the stable release workflow must validate Node 20/22/24 and retain the compatibility-only smoke");
}

const requiredV2BetaFragments = [
  "branches: [main, next]",
  "group: v2-beta-${{ github.ref }}",
  "node-version: [20, 22, 24]",
  "npm run validate:v2-beta",
  "npm run validate:example:v2-core",
  "brass-runtime-v2-beta-package",
  "artifacts/v2-beta/*.tgz",
];
for (const fragment of requiredV2BetaFragments) {
  if (!v2BetaWorkflow.includes(fragment)) fail(`v2 beta workflow is missing: ${fragment}`);
}
for (const [name, workflow] of [
  ["quality", qualityWorkflow],
  ["release", releaseWorkflow],
  ["v2 beta", v2BetaWorkflow],
]) {
  if (!workflow.includes("npm run validate:dependency-security")) {
    fail(`${name} workflow must execute the offline dependency security policy`);
  }
}
for (const fragment of [
  'cron: "30 8 * * 1"',
  "npm run validate:dependency-security",
  "npm audit --package-lock-only --audit-level=high",
  "--prefix examples/angular",
  "--prefix examples/nestjs",
  "--prefix examples/nextjs",
  "--prefix examples/react",
]) {
  if (!dependencySecurityWorkflow.includes(fragment)) fail(`dependency security workflow is missing: ${fragment}`);
}
for (const fragment of [
  "cargo install wasm-pack --version 0.14.0 --locked",
  "npm run build",
  "working-directory: examples/angular",
  "working-directory: examples/nestjs",
  "working-directory: examples/nextjs",
  "working-directory: examples/react",
  "npm run typecheck",
  "npm run build",
]) {
  if (!examplesWorkflow.includes(fragment)) fail(`example consumer workflow is missing: ${fragment}`);
}
if (/^\s*group:.*matrix\./m.test(v2BetaWorkflow)) {
  fail("v2 beta workflow-level concurrency cannot reference the job matrix");
}
for (const [name, workflow] of [
  ["release", releaseWorkflow],
  ["stability", stabilityWorkflow],
  ["v2 beta", v2BetaWorkflow],
  ["v2 publisher", publishV2BetaWorkflow],
  ["product publisher", publishProductWorkflow],
  ["perf", perfWorkflow],
]) {
  if (workflow.includes("actions/upload-artifact@v4")) {
    fail(`${name} workflow must not use the deprecated Node 20 artifact action`);
  }
}

const requiredV2PublishFragments = [
  "workflow_call:",
  "github.ref == 'refs/heads/next' && inputs.publish",
  "environment: npm-next",
  "npm install --global npm@11.5.1",
  "test \"$(npm --version)\" = \"11.5.1\"",
  "npm run release:check",
  "npm run validate:v2-beta -- --version",
  "npm run validate:example:v2-core -- --beta-tarball",
  "brass-runtime-${BRASS_BETA_VERSION}.tgz",
  "--dry-run --access public --tag next --json",
  'npm view "brass-runtime@$BRASS_BETA_VERSION" version',
  "npm publish ./artifacts/v2-beta/package",
  "--tag next",
  "--provenance",
  "for attempt in {1..20}",
  "sleep 15",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
];
for (const fragment of requiredV2PublishFragments) {
  if (!publishV2BetaWorkflow.includes(fragment)) fail(`v2 beta publisher is missing: ${fragment}`);
}
if (publishV2BetaWorkflow.includes("NODE_AUTH_TOKEN:")) {
  fail("v2 beta publisher must use the trusted release caller instead of a long-lived write token");
}
for (const fragment of [
  "channel:",
  "v2-beta",
  "uses: ./.github/workflows/publish-v2-beta.yml",
  "id-token: write",
]) {
  if (!releaseWorkflow.includes(fragment)) fail(`trusted v2 beta entrypoint is missing: ${fragment}`);
}

const requiredProductPublishFragments = [
  "workflow_dispatch:",
  "github.ref == 'refs/heads/main' && inputs.publish",
  "environment: npm-products",
  "bootstrap:",
  "npm install --global npm@11.5.1",
  "Enforce the bootstrap or Trusted Publishing boundary",
  'if: inputs.bootstrap',
  'if: ${{ !inputs.bootstrap }}',
  "already exists; disable bootstrap",
  "does not exist; its first version requires an explicitly approved bootstrap run",
  "Unable to determine registry state",
  "npm whoami",
  "npm org ls brass",
  "npm run release:check",
  'npm run "validate:product:$PRODUCT"',
  "--dry-run --access public --tag alpha --json",
  "--tag alpha --provenance",
  "for attempt in {1..20}",
  "sleep 15",
  'test "$current_latest" = "$STABLE_LATEST_BEFORE"',
];
for (const fragment of requiredProductPublishFragments) {
  if (!publishProductWorkflow.includes(fragment)) fail(`product alpha publisher is missing: ${fragment}`);
}
const productTokenBindings = publishProductWorkflow.match(/NODE_AUTH_TOKEN:/g)?.length ?? 0;
if (productTokenBindings !== 2) {
  fail("the product alpha publisher must expose its token only to bootstrap identity and first-publication steps");
}
const productBootstrapSecretBindings = publishProductWorkflow.match(
  /secrets\.NPM_PRODUCT_BOOTSTRAP_TOKEN/g,
)?.length ?? 0;
if (productBootstrapSecretBindings !== 2 || publishProductWorkflow.includes("secrets.NPM_TOKEN")) {
  fail("the product alpha publisher must use only the isolated NPM_PRODUCT_BOOTSTRAP_TOKEN");
}
if (!releaseWorkflow.includes("secrets.NPM_TOKEN")) {
  fail("the stable publisher must retain its independent NPM_TOKEN binding");
}
const trustedProductPublishStep = publishProductWorkflow.slice(
  publishProductWorkflow.indexOf("- name: Publish alpha with npm Trusted Publishing"),
  publishProductWorkflow.indexOf("- name: Verify alpha changed and latest did not"),
);
if (!trustedProductPublishStep || trustedProductPublishStep.includes("NODE_AUTH_TOKEN")) {
  fail("the recurring product alpha publisher must authenticate only through npm Trusted Publishing");
}

const requiredStabilityFragments = [
  'cron: "0 3 * * 6"',
  "actions: read",
  "timeout-minutes: 45",
  "npm run build:wasm",
  "npm run test:stability",
  "npm run perf:stability:soak",
  "npm run benchmark:http:stability",
  "npm run benchmark:adaptive:stability",
  "npm run stability:manifest -- artifacts/stability",
  "gh run list",
  "gh run download",
  "npm run stability:trend -- --allow-incomplete artifacts/stability-history",
  "BRASS_STABILITY_TREND_REPORT_PATH: artifacts/stability/stability-trend.json",
  "retention-days: 90",
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
