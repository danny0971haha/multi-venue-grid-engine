import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { uncommittedGovernancePaths } from "./generate-phase2d-corrective4-baseline.mjs";

describe("baseline generator input hygiene", () => {
  it("ignores a dirty baseline output and non-governance untracked files", () => {
    const dirty = uncommittedGovernancePaths(
      [
        " M .github/trusted/phase2d-corrective4-baseline.json",
        "?? artifacts/local.json",
        "?? .omo/session.json",
      ].join("\n"),
    );
    assert.deepEqual(dirty, []);
  });

  it("refuses uncommitted governance policy, scripts, and workflows", () => {
    const dirty = uncommittedGovernancePaths(
      [
        "?? .github/trusted/repository-governance-policy.json",
        " M scripts/governance/repository-governance-policy.mjs",
        "?? scripts/governance/fixtures/policy/negative/empty-required-checks.json",
        " M .github/workflows/trusted-governance-self-test.yml",
      ].join("\n"),
    );
    assert.deepEqual(dirty, [
      ".github/trusted/repository-governance-policy.json",
      "scripts/governance/repository-governance-policy.mjs",
      "scripts/governance/fixtures/policy/negative/empty-required-checks.json",
      ".github/workflows/trusted-governance-self-test.yml",
    ]);
  });
});
