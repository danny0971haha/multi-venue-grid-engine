import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyGate } from "./phase2d-trusted-gate.mjs";

const REPO = "danny0971haha/multi-venue-grid-engine";
const baseline = {
  repository: REPO,
  candidateHeadRef: "experiment/v0.1-phase2",
  protectedPathRules: ["src/**", "test/risk/**", "package-lock.json"],
  allowedEvidenceOnlyChangedPathRules: ["scripts/evidence/**", "docs/PHASE_2D_CONTRACT.md"],
  trustedGovernancePathRules: [
    ".github/workflows/trusted-phase2d-freeze.yml",
    ".github/workflows/trusted-governance-self-test.yml",
    ".github/trusted/**",
    "scripts/governance/**",
    ".github/CODEOWNERS",
  ],
};

function input(overrides = {}) {
  return {
    baseline,
    changedPaths: ["README.md"],
    headRef: "docs/readme",
    headRepository: REPO,
    baseRepository: REPO,
    ...overrides,
  };
}

describe("stable required gate classification", () => {
  it("actually returns NOT_APPLICABLE for unrelated work", () => {
    assert.equal(classifyGate(input()).mode, "NOT_APPLICABLE");
  });

  it("enforces the exact Phase 2 branch even without a path hint", () => {
    assert.equal(
      classifyGate(input({ headRef: "experiment/v0.1-phase2" })).mode,
      "PHASE2D_ENFORCE",
    );
  });

  it("renamed candidate branches cannot bypass protected Phase 2 paths", () => {
    assert.equal(
      classifyGate(input({ headRef: "renamed", changedPaths: ["src/risk/risk-engine.ts"] })).mode,
      "PHASE2D_ENFORCE",
    );
  });

  it("fork candidates touching Phase 2 paths are still enforced", () => {
    assert.equal(
      classifyGate(input({ headRepository: "fork/engine", changedPaths: ["test/risk/x.ts"] })).mode,
      "PHASE2D_ENFORCE",
    );
  });

  it("candidate attempts to modify trusted workflow are enforced", () => {
    assert.equal(
      classifyGate(
        input({
          headRef: "experiment/v0.1-phase2",
          changedPaths: [".github/workflows/trusted-phase2d-freeze.yml"],
        }),
      ).mode,
      "PHASE2D_ENFORCE",
    );
  });

  it("same-repository governance changes require protected review", () => {
    assert.equal(
      classifyGate(input({ changedPaths: ["scripts/governance/check.mjs"] })).mode,
      "GOVERNANCE_REVIEW_REQUIRED",
    );
  });

  it("fork governance changes fail closed", () => {
    assert.equal(
      classifyGate(
        input({
          headRepository: "fork/engine",
          changedPaths: [".github/CODEOWNERS"],
        }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("does not whitelist Phase 0 or Phase 1 predecessors that touch src/**", () => {
    assert.equal(
      classifyGate(
        input({
          headRef: "experiment/v0.1-phase0",
          changedPaths: ["src/index.ts"],
        }),
      ).mode,
      "PHASE2D_ENFORCE",
    );
    assert.equal(
      classifyGate(
        input({
          headRef: "experiment/v0.1-phase1",
          changedPaths: ["src/domain/types.ts"],
        }),
      ).mode,
      "PHASE2D_ENFORCE",
    );
  });
});
