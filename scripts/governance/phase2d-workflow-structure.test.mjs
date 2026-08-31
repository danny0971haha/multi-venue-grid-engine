import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatePath = path.join(root, ".github", "workflows", "trusted-phase2d-freeze.yml");
const selfTestPath = path.join(root, ".github", "workflows", "trusted-governance-self-test.yml");

describe("trusted workflow structure", () => {
  it("parses both workflow YAML files", () => {
    execFileSync("ruby", [
      "-e",
      'require "yaml"; ARGV.each { |f| YAML.parse_file(f) }',
      gatePath,
      selfTestPath,
    ]);
  });

  it("defines a stable always-created gate job instead of a job-level if", () => {
    const text = readFileSync(gatePath, "utf8");
    assert.match(text, /^  pull_request_target:/m);
    assert.match(
      text,
      /^  trusted-phase2d-freeze-gate:\n    name: trusted-phase2d-freeze-gate\n    runs-on:/m,
    );
    assert.doesNotMatch(text, /^  trusted-phase2d-freeze-gate:[\s\S]*?^    if:/m);
    assert.match(text, /trustedPhase2dFreezeGateExecuted=true/);
    assert.match(text, /PR_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  });

  it("executes governance from github.workflow_sha rather than the PR base", () => {
    const text = readFileSync(gatePath, "utf8");
    assert.equal(text.includes("ref: ${{ github.workflow_sha }}"), true);
    assert.equal(text.includes("ref: ${{ github.event.pull_request.base.sha }}"), false);
    assert.equal([...text.matchAll(/persist-credentials: false/g)].length >= 2, true);
    assert.doesNotMatch(text, /continue-on-error/);
    assert.doesNotMatch(text, /allow-unsafe-pr-checkout/);
    assert.doesNotMatch(text, /contents:\s*write/);
    assert.doesNotMatch(text, /secrets:/);
    assert.doesNotMatch(text, /evidence:phase2d-corrective4:verify/);
  });

  it("routes Phase 2D and Phase 2E through the same required context", () => {
    const text = readFileSync(gatePath, "utf8");
    assert.match(text, /steps\.classify\.outputs\.mode == 'PHASE2D_ENFORCE'/);
    assert.match(text, /steps\.classify\.outputs\.mode == 'PHASE2E_ENFORCE'/);
    assert.match(
      text,
      /PHASE2D_ENFORCE\|PHASE2E_ENFORCE\|NOT_APPLICABLE\|GOVERNANCE_REVIEW_REQUIRED/,
    );
    assert.match(text, /node-version: "22\.23\.2"/);
    assert.match(text, /phase2e-trusted-freeze-check\.mjs/);
    assert.match(text, /phase2e-corrective3-baseline\.json/);
    assert.doesNotMatch(text, /phase2e-corrective1-baseline\.json/);
    assert.match(text, /TRUSTED_PHASE2E_RUNNER/);
    assert.match(text, /Check out the exact Phase 2E candidate HEAD after trusted classification/);
    const classifyIndex = text.indexOf("Classify the pull request from trusted workflow code");
    const integrityIndex = text.indexOf("Enforce exact Phase 2E candidate integrity");
    const checkoutIndex = text.indexOf(
      "Check out the exact Phase 2E candidate HEAD after trusted classification",
    );
    const runtimeIndex = text.indexOf("Run trusted Phase 2E runtime commands");
    assert.equal(classifyIndex > 0, true);
    assert.equal(integrityIndex > classifyIndex, true);
    assert.equal(checkoutIndex > integrityIndex, true);
    assert.equal(runtimeIndex > checkoutIndex, true);
    assert.match(
      text,
      /Check out the exact Phase 2E candidate HEAD after trusted classification\n {8}if: steps\.classify\.outputs\.mode == 'PHASE2E_ENFORCE' && steps\.phase2e_integrity\.outcome == 'success'/,
    );
    assert.match(text, /governanceCandidateAccepted=false/);
    assert.match(text, /phase2eRuntimeAccepted=false/);
  });

  it("defines an unskipped governance self-test with an execution marker", () => {
    const text = readFileSync(selfTestPath, "utf8");
    assert.match(
      text,
      /^  trusted-governance-self-test:\n    name: trusted-governance-self-test\n    runs-on:/m,
    );
    assert.doesNotMatch(text, /^  trusted-governance-self-test:[\s\S]*?^    if:/m);
    assert.match(text, /trustedGovernanceSelfTestExecuted=true/);
    assert.match(text, /paths:/);
    assert.match(text, /Validate machine-readable governance policy/);
  });
});
