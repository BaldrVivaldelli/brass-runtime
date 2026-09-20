import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildReleaseGuardrailPlan } from "../release-guardrail-plan.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts", "configure-release-guardrails.mjs");
const policy = JSON.parse(readFileSync(path.join(root, ".github", "release-guardrails.json"), "utf8"));

describe("release guardrail configuration safety", () => {
  it("renders four deterministic operations without touching GitHub", () => {
    const plan = buildReleaseGuardrailPlan(policy);
    expect(plan.repository).toBe("BaldrVivaldelli/brass-runtime");
    expect(plan.githubApiVersion).toBe("2026-03-10");
    expect(plan.operations).toHaveLength(4);
    expect(plan.operations.map((operation) => operation.endpoint)).toEqual([
      "repos/BaldrVivaldelli/brass-runtime/branches/main/protection",
      "repos/BaldrVivaldelli/brass-runtime/branches/next/protection",
      "repos/BaldrVivaldelli/brass-runtime/environments/npm-next",
      "repos/BaldrVivaldelli/brass-runtime/environments/npm-products",
    ]);
    for (const operation of plan.operations.slice(0, 2)) {
      expect(operation.payload.required_pull_request_reviews).not.toHaveProperty("dismissal_restrictions");
      expect(operation.payload.required_pull_request_reviews).not.toHaveProperty("bypass_pull_request_allowances");
    }
  });

  it("refuses apply mode without the exact repository confirmation", () => {
    expect(run(["--apply"]).status).toBe(1);
    expect(run(["--apply", "--confirm", "wrong/repository"]).status).toBe(1);
  });

  it("keeps confirmation-only invocation in non-mutating plan mode", () => {
    const result = run(["--confirm", "BaldrVivaldelli/brass-runtime"]);
    expect(result.status).toBe(0);
  });
});

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}
