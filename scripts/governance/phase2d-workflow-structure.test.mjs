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
