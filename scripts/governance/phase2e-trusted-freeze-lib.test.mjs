import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PHASE2E_CANDIDATE_HEAD_SHA,
  PHASE2E_FROZEN_BASE_SHA,
  PHASE2E_INVALIDATED_CORRECTIVE1_HEAD_SHA,
  PHASE2E_INVALIDATED_CORRECTIVE1_TREE_SHA,
  PHASE2E_SCHEMA_VERSION,
  PHASE2E_STALE_CORRECTIVE2_HEAD_SHA,
  PHASE2E_TRUSTED_BASELINE_PATH,
  evaluatePhase2eIntegrity,
  formatPhase2eMachineSummary,
  parsePhase2eBaseline,
} from "./phase2e-trusted-freeze-lib.mjs";
import { summaryContainsForbiddenDecisionWording } from "./phase2d-trusted-freeze-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const parsed = parsePhase2eBaseline(
  readFileSync(path.join(root, PHASE2E_TRUSTED_BASELINE_PATH), "utf8"),
);
const baseline = parsed.baseline;
const REPO = "danny0971haha/multi-venue-grid-engine";

function blob(file) {
  return { path: file.path, mode: file.mode, type: "blob", sha: file.blobSha };
}

function snapshotEntry(filePath, snapshot) {
  return { path: filePath, mode: snapshot.mode, type: "blob", sha: snapshot.blobSha };
}

function trees() {
  const baseTree = [
    ...baseline.protectedFrozenFiles.map(blob),
    ...baseline.candidateChangedFiles
      .filter((item) => item.base)
      .map((item) => snapshotEntry(item.path, item.base)),
  ];
  const headTree = [
    ...baseline.protectedFrozenFiles.map(blob),
    ...baseline.candidateChangedFiles
      .filter((item) => item.head)
      .map((item) => snapshotEntry(item.path, item.head)),
  ];
  const observedBlobSha256ByKey = {};
  for (const file of baseline.protectedFrozenFiles) {
    observedBlobSha256ByKey[`head:${file.path}`] = file.sha256;
  }
  for (const item of baseline.candidateChangedFiles) {
    if (item.base) observedBlobSha256ByKey[`base:${item.path}`] = item.base.sha256;
    if (item.head) observedBlobSha256ByKey[`head:${item.path}`] = item.head.sha256;
  }
  observedBlobSha256ByKey["head:package-lock.json"] = baseline.packageLock.sha256;
  return { baseTree, headTree, observedBlobSha256ByKey };
}

function headPackageJson(overrides = {}) {
  return JSON.stringify({
    name: "multi-venue-grid-engine",
    dependencies: overrides.dependencies ?? baseline.dependencyIdentity.dependencies,
    devDependencies: overrides.devDependencies ?? baseline.dependencyIdentity.devDependencies,
    scripts: {
      ...baseline.packageJsonScriptsPolicy.expectedHeadScripts,
    },
  });
}

function evalInput(overrides = {}) {
  const { baseTree, headTree, observedBlobSha256ByKey } = trees();
  return {
    baseline,
    repositoryFullName: REPO,
    prHeadRepositoryFullName: REPO,
    prHeadRef: baseline.candidateHeadRef,
    prBaseRef: baseline.candidateBaseRef,
    prBaseSha: baseline.frozenBaseSha,
    sourceHeadSha: PHASE2E_CANDIDATE_HEAD_SHA,
    eventSourceHeadSha: PHASE2E_CANDIDATE_HEAD_SHA,
    ancestorCheckComplete: true,
    frozenBaseIsAncestor: true,
    baseTreeComplete: true,
    headTreeComplete: true,
    observedBaseTreeSha: baseline.frozenBaseTreeSha,
    observedHeadTreeSha: baseline.candidateHeadTreeSha,
    baseTree,
    headTree,
    headTextByPath: { "package.json": headPackageJson() },
    observedBlobSha256ByKey,
    ...overrides,
  };
}

describe("Phase 2E trusted baseline parse", () => {
  it("parses the committed Runtime Corrective 3 baseline", () => {
    assert.equal(parsed.ok, true);
    assert.equal(baseline.schemaVersion, PHASE2E_SCHEMA_VERSION);
    assert.equal(baseline.candidateHeadSha, PHASE2E_CANDIDATE_HEAD_SHA);
    assert.equal(baseline.frozenBaseSha, PHASE2E_FROZEN_BASE_SHA);
    assert.equal(baseline.allowedChangedPaths.includes("src/**"), false);
    assert.equal(baseline.allowedChangedPaths.length, 16);
    assert.equal(baseline.protectedFrozenFiles.length, 61);
    assert.equal(baseline.candidateHeadSha.startsWith("7b98c888"), false);
    assert.equal(baseline.candidateHeadSha, "704afa2dd858c52dad06aa22941d463aa5ce4d69");
    assert.notEqual(baseline.candidateHeadSha, PHASE2E_INVALIDATED_CORRECTIVE1_HEAD_SHA);
    assert.ok(baseline.allowedChangedPaths.includes("test/halt/p2e-corrective-2.test.ts"));
    assert.ok(baseline.allowedChangedPaths.includes("test/halt/p2e-corrective-3.test.ts"));
    assert.equal(
      baseline.npmTestHistoricalMismatch.boundCandidateHeadSha,
      PHASE2E_CANDIDATE_HEAD_SHA,
    );
    assert.equal(baseline.npmTestHistoricalMismatch.expectedTapFail, 0);
    assert.equal(baseline.npmTestHistoricalMismatch.expectedExitCode, 0);
    assert.equal(baseline.npmTestHistoricalMismatch.expectedTapTests, 474);
    assert.equal(baseline.npmTestHistoricalMismatch.expectedFailureNames.length, 0);
    const committed = readFileSync(path.join(root, PHASE2E_TRUSTED_BASELINE_PATH), "utf8");
    assert.match(committed, /"allowedScriptKeysChanged": \["test:phase2e"\]/);
  });

  it("rejects the invalidated Runtime Corrective 1 baseline as the live pin", () => {
    const old = parsePhase2eBaseline(
      readFileSync(path.join(root, ".github/trusted/phase2e-corrective1-baseline.json"), "utf8"),
    );
    assert.equal(old.ok, false);
    assert.ok(old.reasons.includes("phase2e_baseline_candidate_head_sha"));
  });

  it("rejects malformed JSON", () => {
    const result = parsePhase2eBaseline("{");
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("phase2e_baseline_malformed_json"));
  });
});

describe("Phase 2E integrity evaluation", () => {
  it("accepts the exact stacked candidate trees", () => {
    const evaluation = evaluatePhase2eIntegrity(evalInput());
    assert.equal(evaluation.trustedBaselineIntegrityOk, true);
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, true);
  });

  it("fail closed when a protected Phase 2D blob changes", () => {
    const { headTree } = trees();
    const mutated = headTree.map((entry) =>
      entry.path === "src/risk/risk-engine.ts" ? { ...entry, sha: "a".repeat(40) } : entry,
    );
    const evaluation = evaluatePhase2eIntegrity(evalInput({ headTree: mutated }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_blob_mismatch"));
  });

  it("fail closed when a protected file is deleted", () => {
    const { headTree } = trees();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({ headTree: headTree.filter((entry) => entry.path !== "src/risk/risk-engine.ts") }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_deleted"));
  });

  it("fail closed when a changed blob is replaced by a symlink", () => {
    const { headTree } = trees();
    const mutated = headTree.map((entry) =>
      entry.path === "src/halt/engine.ts" ? { ...entry, mode: "120000" } : entry,
    );
    const evaluation = evaluatePhase2eIntegrity(evalInput({ headTree: mutated }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("changed_path_symlink"));
  });

  it("fail closed when a changed path is a gitlink/submodule", () => {
    const { headTree } = trees();
    const mutated = headTree.map((entry) =>
      entry.path === "src/halt/store.ts"
        ? { ...entry, mode: "160000", type: "commit", sha: "b".repeat(40) }
        : entry,
    );
    const evaluation = evaluatePhase2eIntegrity(evalInput({ headTree: mutated }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("changed_path_gitlink"));
  });

  it("fail closed on an extra unexpected path", () => {
    const { headTree } = trees();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTree: [
          ...headTree,
          { path: "src/index.ts.bak", mode: "100644", type: "blob", sha: "c".repeat(40) },
        ],
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_manifest_unexpected_path"));
  });

  it("fail closed on an unsafe tree path", () => {
    const { headTree } = trees();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTree: [
          ...headTree,
          { path: "../etc/passwd", mode: "100644", type: "blob", sha: "d".repeat(40) },
        ],
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("head_tree_path_unsafe"));
  });

  it("fail closed when package-lock identity changes", () => {
    const { headTree } = trees();
    const mutated = headTree.map((entry) =>
      entry.path === "package-lock.json" ? { ...entry, sha: "e".repeat(40) } : entry,
    );
    const evaluation = evaluatePhase2eIntegrity(evalInput({ headTree: mutated }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("package_lock_identity_mismatch"));
  });

  it("fail closed when a dependency field changes", () => {
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTextByPath: {
          "package.json": headPackageJson({ dependencies: { "decimal.js": "10.6.1" } }),
        },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("package_json_dependency_identity_mismatch"));
  });

  it("fail closed when a devDependency field changes", () => {
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTextByPath: {
          "package.json": headPackageJson({
            devDependencies: { ...baseline.dependencyIdentity.devDependencies, tsx: "4.23.13" },
          }),
        },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("package_json_dependency_identity_mismatch"));
  });

  it("fail closed when GitHub tree metadata is incomplete", () => {
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({ headTreeComplete: false, headTree: [] }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("head_tree_incomplete"));
  });

  it("fail closed when the frozen base is not an ancestor", () => {
    const evaluation = evaluatePhase2eIntegrity(evalInput({ frozenBaseIsAncestor: false }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("frozen_base_not_ancestor"));
  });

  it("fail closed on the wrong head SHA", () => {
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({ sourceHeadSha: "7b98c888543b980dee48b27f4497db1bf93a7970" }),
    );
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, false);
    assert.ok(evaluation.reasons.includes("source_head_not_reviewed_candidate"));
  });

  it("fail closed on the invalidated Runtime Corrective 1 HEAD", () => {
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({ sourceHeadSha: PHASE2E_INVALIDATED_CORRECTIVE1_HEAD_SHA }),
    );
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, false);
    assert.ok(evaluation.reasons.includes("source_head_not_reviewed_candidate"));
  });

  it("fail closed on the stale Runtime Corrective 2 HEAD", () => {
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({ sourceHeadSha: PHASE2E_STALE_CORRECTIVE2_HEAD_SHA }),
    );
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, false);
    assert.ok(evaluation.reasons.includes("source_head_not_reviewed_candidate"));
  });

  it("fail closed on the invalidated Runtime Corrective 1 tree", () => {
    const wrongTree = JSON.parse(
      readFileSync(path.join(root, "scripts/governance/fixtures/wrong-tree.json"), "utf8"),
    );
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({ observedHeadTreeSha: wrongTree.observedHeadTreeSha }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_head_tree_sha_mismatch"));
    assert.equal(wrongTree.observedHeadTreeSha, PHASE2E_INVALIDATED_CORRECTIVE1_TREE_SHA);
  });

  it("fail closed when the Runtime Corrective 3 test file is omitted", () => {
    const { headTree } = trees();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTree: headTree.filter((entry) => entry.path !== "test/halt/p2e-corrective-3.test.ts"),
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_manifest_missing_path"));
  });

  it("fail closed when an additional protected-path file appears", () => {
    const { headTree } = trees();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTree: [
          ...headTree,
          { path: "src/risk/extra.ts", mode: "100644", type: "blob", sha: "c".repeat(40) },
        ],
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_manifest_unexpected_path"));
  });

  it("fail closed when a protected file object type changes", () => {
    const { headTree } = trees();
    const mutated = headTree.map((entry) =>
      entry.path === "src/risk/risk-engine.ts"
        ? { ...entry, type: "commit", mode: "160000" }
        : entry,
    );
    const evaluation = evaluatePhase2eIntegrity(evalInput({ headTree: mutated }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_type_change"));
  });

  it("fail closed when a protected SHA-256 does not match", () => {
    const input = evalInput();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        observedBlobSha256ByKey: {
          ...input.observedBlobSha256ByKey,
          "head:src/risk/risk-engine.ts": "0".repeat(64),
        },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_sha256_mismatch"));
  });

  it("fail closed when trusted governance bytes mix into the runtime candidate", () => {
    const { headTree } = trees();
    const evaluation = evaluatePhase2eIntegrity(
      evalInput({
        headTree: [
          ...headTree,
          {
            path: "scripts/governance/phase2d-trusted-gate.mjs",
            mode: "100644",
            type: "blob",
            sha: "d".repeat(40),
          },
        ],
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("trusted_governance_path_changed"));
  });

  it("does not emit ACCEPT or PASS in the machine summary", () => {
    const summary = formatPhase2eMachineSummary({
      trustedBaselineIntegrityOk: false,
      sourceHeadMatchesReviewedCandidate: false,
      reasons: ["protected_file_blob_mismatch"],
    });
    assert.equal(summaryContainsForbiddenDecisionWording(summary), false);
  });
});
