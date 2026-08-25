import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { inspectTrustedCheckout } from "./phase2d-trusted-control.mjs";

describe("trusted protected-main checkout", () => {
  it("accepts the trusted control commit and a simulated post-merge descendant", () => {
    const fixture = repositoryFixture();
    assert.equal(inspectTrustedCheckout({ repoRoot: fixture.root, baseline: fixture.baseline }).ok, true);
    writeFileSync(path.join(fixture.root, "post-merge.txt"), "merge result\n");
    git(fixture.root, ["add", "post-merge.txt"]);
    git(fixture.root, ["commit", "-m", "simulated post-merge main"]);
    const result = inspectTrustedCheckout({ repoRoot: fixture.root, baseline: fixture.baseline });
    assert.equal(result.ok, true);
  });

  it("fails when HEAD does not contain the trusted control ancestor", () => {
    const fixture = repositoryFixture();
    git(fixture.root, ["checkout", "--orphan", "untrusted-main"]);
    git(fixture.root, ["rm", "-rf", "."]);
    createGovernanceFiles(fixture.root);
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "unrelated root"]);
    const baseline = { ...fixture.baseline, trustedGovernanceFiles: governanceManifest(fixture.root) };
    const result = inspectTrustedCheckout({ repoRoot: fixture.root, baseline });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("minimum_trusted_ancestor_not_ancestor"));
  });

  it("fails closed on a dirty trusted checkout", () => {
    const fixture = repositoryFixture();
    writeFileSync(path.join(fixture.root, ".github", "CODEOWNERS"), "tampered\n");
    const result = inspectTrustedCheckout({ repoRoot: fixture.root, baseline: fixture.baseline });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("trusted_checkout_dirty"));
    assert.ok(result.reasons.includes("trusted_governance_file_sha256_mismatch"));
  });
});

function repositoryFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "phase2d-trusted-control-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Governance Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "trusted ancestor"]);
  const minimumTrustedAncestorSha = git(root, ["rev-parse", "HEAD"]);
  createGovernanceFiles(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "governance control"]);
  return {
    root,
    baseline: {
      minimumTrustedAncestorSha,
      trustedGovernancePathRules: [
        ".github/workflows/trusted-phase2d-freeze.yml",
        ".github/workflows/trusted-governance-self-test.yml",
        ".github/trusted/**",
        "scripts/governance/**",
        ".github/CODEOWNERS",
      ],
      trustedGovernanceFiles: governanceManifest(root),
    },
  };
}

function createGovernanceFiles(root) {
  mkdirSync(path.join(root, ".github", "trusted"), { recursive: true });
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(root, "scripts", "governance"), { recursive: true });
  writeFileSync(path.join(root, ".github", "trusted", "phase2d-corrective4-baseline.json"), "{}\n");
  writeFileSync(path.join(root, ".github", "CODEOWNERS"), "* @owner\n");
  writeFileSync(path.join(root, ".github", "workflows", "trusted-phase2d-freeze.yml"), "name: fixture\n");
  writeFileSync(path.join(root, "scripts", "governance", "check.mjs"), "export {};\n");
}

function governanceManifest(root) {
  return [
    ".github/CODEOWNERS",
    ".github/workflows/trusted-phase2d-freeze.yml",
    "scripts/governance/check.mjs",
  ].map((filePath) => {
    const bytes = readFileSync(path.join(root, filePath));
    return {
      path: filePath,
      mode: "100644",
      objectType: "blob",
      blobSha: git(root, ["hash-object", "--stdin"], bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
