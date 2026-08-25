import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  TRUSTED_BASELINE_PATH,
  TRUSTED_WORKFLOW_PATH,
  evaluateTrustedFreeze,
  extractFrozenRiskNumericContract,
  formatMachineSummary,
  frozenLimitRequiredSubstrings,
  parseBaseline,
  sha256Text,
  summaryContainsForbiddenDecisionWording,
} from "./phase2d-trusted-freeze-lib.mjs";

const SHA = {
  impl: "c".repeat(40),
  tree: "d".repeat(40),
  head: "a".repeat(40),
  otherHead: "e".repeat(40),
  risk: "b".repeat(40),
  riskNew: "f".repeat(40),
  pkgBase: "1".repeat(40),
  pkgHead: "2".repeat(40),
  contractBase: "3".repeat(40),
  contractHead: "4".repeat(40),
  lock: "5".repeat(40),
  extra: "6".repeat(40),
  governance: "7".repeat(40),
  baseline: "8".repeat(40),
  symlink: "9".repeat(40),
};

const FROZEN_MARKDOWN = `intro

## 2. Frozen v0.1 limits

These values are not upward-configurable.

\`\`\`text
capital ceiling=100 USDT
leverage=5x
margin budget=30 USDT
planned gross-notional cap=150 USDT
daily net-loss halt=-5 USDT
starting-equity drawdown halt=10 USDT
boundary buffer=1% beyond ±3% grid boundary
\`\`\`

Authoritative arithmetic uses decimal.js.

## 3. Decision model

body

## 11. Corrective 4 evidence-closure addendum
`;

const FROZEN_BODY = extractFrozenRiskNumericContract(FROZEN_MARKDOWN);
const FROZEN_SHA256 = sha256Text(FROZEN_BODY);

function baseline(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    repository: "danny0971haha/multi-venue-grid-engine",
    minimumTrustedAncestorSha: "9".repeat(40),
    candidateHeadRef: "experiment/v0.1-phase2",
    acceptedImplementationBaseSha: SHA.impl,
    acceptedImplementationBaseTreeSha: SHA.tree,
    currentAcceptedCandidateSourceHead: SHA.head,
    protectedPathRules: ["src/**", "package-lock.json"],
    allowedEvidenceOnlyChangedPathRules: [
      "package.json",
      "scripts/evidence/**",
      "docs/PHASE_2D_CONTRACT.md",
    ],
    protectedContentAnchors: [
      {
        path: "docs/PHASE_2D_CONTRACT.md",
        startMarker: "## 2. Frozen v0.1 limits",
        endExclusiveMarker: "## 11. Corrective 4 evidence-closure addendum",
        sha256: FROZEN_SHA256,
        requiredSubstrings: frozenLimitRequiredSubstrings(),
      },
    ],
    protectedFiles: [
      {
        path: "src/risk/risk-engine.ts",
        mode: "100644",
        objectType: "blob",
        blobSha: SHA.risk,
        sha256: "a".repeat(64),
      },
      {
        path: "package-lock.json",
        mode: "100644",
        objectType: "blob",
        blobSha: SHA.lock,
        sha256: "b".repeat(64),
      },
    ],
    candidateChangedFiles: [
      {
        path: "docs/PHASE_2D_CONTRACT.md",
        change: "modified",
        base: { mode: "100644", objectType: "blob", blobSha: SHA.contractBase, sha256: "c".repeat(64) },
        head: { mode: "100644", objectType: "blob", blobSha: SHA.contractHead, sha256: "d".repeat(64) },
      },
      {
        path: "package.json",
        change: "modified",
        base: { mode: "100644", objectType: "blob", blobSha: SHA.pkgBase, sha256: "e".repeat(64) },
        head: { mode: "100644", objectType: "blob", blobSha: SHA.pkgHead, sha256: "f".repeat(64) },
      },
      {
        path: "scripts/evidence/phase2d-corrective4-verify.mjs",
        change: "added",
        base: null,
        head: { mode: "100644", objectType: "blob", blobSha: SHA.extra, sha256: "1".repeat(64) },
      },
    ],
    trustedGovernancePathRules: [
      ".github/workflows/trusted-phase2d-freeze.yml",
      ".github/workflows/trusted-governance-self-test.yml",
      ".github/trusted/**",
      "scripts/governance/**",
      ".github/CODEOWNERS",
    ],
    trustedGovernanceFiles: [
      {
        path: ".github/CODEOWNERS",
        mode: "100644",
        objectType: "blob",
        blobSha: "2".repeat(40),
        sha256: "2".repeat(64),
      },
    ],
    ...overrides,
  };
}

function trees({ risk = {}, contractHeadText = FROZEN_MARKDOWN } = {}) {
  const riskEntry = {
    path: "src/risk/risk-engine.ts",
    mode: "100644",
    type: "blob",
    sha: SHA.risk,
    ...risk,
  };
  const baseTree = [
    riskEntry,
    { path: "package-lock.json", mode: "100644", type: "blob", sha: SHA.lock },
    { path: "package.json", mode: "100644", type: "blob", sha: SHA.pkgBase },
    { path: "docs/PHASE_2D_CONTRACT.md", mode: "100644", type: "blob", sha: SHA.contractBase },
    { path: "README.md", mode: "100644", type: "blob", sha: SHA.extra },
  ];
  const headTree = [
    riskEntry,
    { path: "package-lock.json", mode: "100644", type: "blob", sha: SHA.lock },
    { path: "package.json", mode: "100644", type: "blob", sha: SHA.pkgHead },
    { path: "docs/PHASE_2D_CONTRACT.md", mode: "100644", type: "blob", sha: SHA.contractHead },
    { path: "README.md", mode: "100644", type: "blob", sha: SHA.extra },
    {
      path: "scripts/evidence/phase2d-corrective4-verify.mjs",
      mode: "100644",
      type: "blob",
      sha: SHA.extra,
    },
  ];
  return {
    baseTree,
    headTree,
    headTextByPath: {
      "docs/PHASE_2D_CONTRACT.md": contractHeadText,
    },
  };
}

function evalInput(overrides = {}) {
  const { baseTree, headTree, headTextByPath } = trees();
  return {
    baseline: baseline(),
    repositoryFullName: "danny0971haha/multi-venue-grid-engine",
    prHeadRepositoryFullName: "danny0971haha/multi-venue-grid-engine",
    prHeadRef: "experiment/v0.1-phase2",
    sourceHeadSha: SHA.head,
    eventSourceHeadSha: SHA.head,
    implementationBaseIsAncestor: true,
    ancestorCheckComplete: true,
    baseTreeComplete: true,
    headTreeComplete: true,
    observedBaseTreeSha: SHA.tree,
    baseTree,
    headTree,
    headTextByPath,
    observedBlobSha256ByKey: {
      "head:src/risk/risk-engine.ts": "a".repeat(64),
      "head:package-lock.json": "b".repeat(64),
      "base:docs/PHASE_2D_CONTRACT.md": "c".repeat(64),
      "head:docs/PHASE_2D_CONTRACT.md": "d".repeat(64),
      "base:package.json": "e".repeat(64),
      "head:package.json": "f".repeat(64),
      "head:scripts/evidence/phase2d-corrective4-verify.mjs": "1".repeat(64),
    },
    ...overrides,
  };
}

describe("parseBaseline", () => {
  it("rejects malformed JSON", () => {
    const parsed = parseBaseline("{");
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_malformed_json"));
  });

  it("rejects duplicate protected paths", () => {
    const dup = baseline({
      protectedFiles: [
        {
          path: "src/risk/risk-engine.ts",
          mode: "100644",
          objectType: "blob",
          blobSha: SHA.risk,
          sha256: "a".repeat(64),
        },
        {
          path: "src/risk/risk-engine.ts",
          mode: "100644",
          objectType: "blob",
          blobSha: SHA.riskNew,
          sha256: "a".repeat(64),
        },
      ],
    });
    const parsed = parseBaseline(JSON.stringify(dup));
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_duplicate_path"));
  });

  it("rejects a protected file that omits sha256", () => {
    const missingHash = baseline({
      protectedFiles: [
        {
          path: "src/risk/risk-engine.ts",
          mode: "100644",
          objectType: "blob",
          blobSha: SHA.risk,
        },
        {
          path: "package-lock.json",
          mode: "100644",
          objectType: "blob",
          blobSha: SHA.lock,
          sha256: "b".repeat(64),
        },
      ],
    });
    const parsed = parseBaseline(JSON.stringify(missingHash));
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_protected_file_sha256"));
  });

  it("rejects missing schema and short SHAs", () => {
    const parsed = parseBaseline(JSON.stringify({ schemaVersion: "nope" }));
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_schema_version"));
  });

  it("rejects unknown root and nested critical fields", () => {
    const value = baseline({ unexpectedPolicy: true });
    value.protectedFiles[0].unexpectedHash = "ignored";
    const parsed = parseBaseline(JSON.stringify(value));
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_unknown_field"));
    assert.ok(parsed.reasons.includes("baseline_protected_file_unknown_field"));
  });
});

describe("evaluateTrustedFreeze", () => {
  it("records integrity ok for evidence-only changes at the reviewed HEAD", () => {
    const evaluation = evaluateTrustedFreeze(evalInput());
    assert.equal(evaluation.trustedBaselineIntegrityOk, true);
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, true);
    assert.deepEqual(evaluation.reasons, []);
    const summary = formatMachineSummary(evaluation);
    assert.equal(summaryContainsForbiddenDecisionWording(summary), false);
    assert.match(summary, /^trustedBaselineIntegrityOk=true$/m);
    assert.match(summary, /^sourceHeadMatchesReviewedCandidate=true$/m);
  });

  it("1. fail closed when src/risk/risk-engine.ts bytes change", () => {
    const { baseTree, headTree, headTextByPath } = trees({
      risk: { sha: SHA.riskNew },
    });
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_blob_mismatch"));
  });

  it("2. fail closed when a protected file is deleted", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree.filter((item) => item.path !== "src/risk/risk-engine.ts");
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree: nextHead, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_deleted"));
  });

  it("3. fail closed when a protected file is renamed", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree
      .filter((item) => item.path !== "src/risk/risk-engine.ts")
      .concat([
        {
          path: "src/risk/risk-engine-moved.ts",
          mode: "100644",
          type: "blob",
          sha: SHA.risk,
        },
      ]);
    const evaluation = evaluateTrustedFreeze(
      evalInput({
        baseTree,
        headTree: nextHead,
        headTextByPath,
        compareFiles: [
          {
            filename: "src/risk/risk-engine-moved.ts",
            status: "renamed",
            previous_filename: "src/risk/risk-engine.ts",
          },
        ],
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_deleted"));
    assert.ok(evaluation.reasons.includes("protected_file_renamed"));
    assert.ok(evaluation.reasons.includes("protected_path_added"));
  });

  it("4. fail closed when a protected regular blob becomes a symlink", () => {
    const { baseTree, headTree, headTextByPath } = trees({
      risk: { mode: "120000", sha: SHA.symlink },
    });
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_mode_change"));
    assert.ok(evaluation.reasons.includes("protected_file_symlink"));
  });

  it("5. fail closed when a protected path becomes a gitlink", () => {
    const { baseTree, headTree, headTextByPath } = trees({
      risk: { mode: "160000", type: "commit", sha: SHA.symlink },
    });
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_gitlink"));
    assert.ok(evaluation.reasons.includes("protected_file_type_change"));
  });

  it("6. fail closed when a protected file mode changes", () => {
    const { baseTree, headTree, headTextByPath } = trees({
      risk: { mode: "100755" },
    });
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_mode_change"));
  });

  it("7. fail closed on a case-only rename of a protected path", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree
      .filter((item) => item.path !== "src/risk/risk-engine.ts")
      .concat([
        {
          path: "src/risk/Risk-engine.ts",
          mode: "100644",
          type: "blob",
          sha: SHA.risk,
        },
      ]);
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree: nextHead, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_deleted"));
    assert.ok(evaluation.reasons.includes("protected_file_case_rename"));
  });

  it("8. fail closed when the candidate changes the trusted verifier and commitment together", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree.concat([
      {
        path: "scripts/governance/phase2d-trusted-freeze-lib.mjs",
        mode: "100644",
        type: "blob",
        sha: SHA.governance,
      },
      {
        path: TRUSTED_BASELINE_PATH,
        mode: "100644",
        type: "blob",
        sha: SHA.baseline,
      },
    ]);
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree: nextHead, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("verifier_and_commitment_changed"));
    assert.ok(evaluation.reasons.includes("trusted_baseline_modified"));
  });

  it("9. fail closed when an unallowed path is added", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree.concat([
      { path: "tools/hack.sh", mode: "100644", type: "blob", sha: SHA.extra },
    ]);
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree: nextHead, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("unallowed_path_changed"));
  });

  it("10. fail closed when source HEAD is not the reviewed candidate", () => {
    const evaluation = evaluateTrustedFreeze(
      evalInput({ sourceHeadSha: SHA.otherHead, eventSourceHeadSha: SHA.otherHead }),
    );
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, false);
    assert.ok(evaluation.reasons.includes("source_head_not_reviewed_candidate"));
    assert.equal(evaluation.trustedBaselineIntegrityOk, true);
  });

  it("fails when the exact candidate SHA changes by one character", () => {
    const oneCharacterChanged = `${SHA.head.slice(0, -1)}b`;
    const evaluation = evaluateTrustedFreeze(
      evalInput({ sourceHeadSha: oneCharacterChanged, eventSourceHeadSha: oneCharacterChanged }),
    );
    assert.equal(evaluation.sourceHeadMatchesReviewedCandidate, false);
    assert.ok(evaluation.reasons.includes("source_head_not_reviewed_candidate"));
  });

  it("fails the exact manifest when the candidate has one extra file", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const evaluation = evaluateTrustedFreeze(evalInput({
      baseTree,
      headTree: headTree.concat({ path: "scripts/evidence/extra.mjs", mode: "100644", type: "blob", sha: SHA.otherHead }),
      headTextByPath,
    }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_manifest_unexpected_path"));
  });

  it("fails the exact manifest when the candidate is missing one file", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const evaluation = evaluateTrustedFreeze(evalInput({
      baseTree,
      headTree: headTree.filter((item) => item.path !== "scripts/evidence/phase2d-corrective4-verify.mjs"),
      headTextByPath,
    }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_manifest_missing_path"));
  });

  it("fails per-file identity and SHA-256 when one candidate byte changes", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree.map((item) => item.path === "package.json" ? { ...item, sha: SHA.otherHead } : item);
    const evaluation = evaluateTrustedFreeze(evalInput({ baseTree, headTree: nextHead, headTextByPath }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("candidate_manifest_head_identity_mismatch"));
  });

  it("fails when the candidate branch is renamed", () => {
    const evaluation = evaluateTrustedFreeze(evalInput({ prHeadRef: "experiment/v0.1-phase2-renamed" }));
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("pr_head_ref_mismatch"));
  });

  it("11. fail closed when the implementation base is not an ancestor", () => {
    const evaluation = evaluateTrustedFreeze(
      evalInput({ implementationBaseIsAncestor: false }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("implementation_base_not_ancestor"));
  });

  it("12. fail closed when GitHub tree metadata is incomplete", () => {
    const evaluation = evaluateTrustedFreeze(
      evalInput({ headTreeComplete: false, headTree: [] }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("head_tree_incomplete"));
  });

  it("13. fail closed when the baseline manifest is malformed before evaluation", () => {
    const parsed = parseBaseline("null");
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_not_object"));
  });

  it("14. fail closed when the baseline lists a duplicate protected path", () => {
    const parsed = parseBaseline(
      JSON.stringify(
        baseline({
          protectedFiles: [
            {
              path: "package-lock.json",
              mode: "100644",
              objectType: "blob",
              blobSha: SHA.lock,
              sha256: "b".repeat(64),
            },
            {
              path: "package-lock.json",
              mode: "100644",
              objectType: "blob",
              blobSha: SHA.lock,
              sha256: "b".repeat(64),
            },
          ],
        }),
      ),
    );
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("baseline_duplicate_path"));
  });

  it("15. fail closed when the candidate modifies the trusted baseline manifest", () => {
    const { baseTree, headTree, headTextByPath } = trees();
    const nextHead = headTree.concat([
      {
        path: TRUSTED_BASELINE_PATH,
        mode: "100644",
        type: "blob",
        sha: SHA.baseline,
      },
    ]);
    const evaluation = evaluateTrustedFreeze(
      evalInput({ baseTree, headTree: nextHead, headTextByPath }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("trusted_baseline_modified"));
  });

  it("fail closed when frozen numeric contract text changes inside an allowlisted file", () => {
    const mutated = FROZEN_MARKDOWN.replace("capital ceiling=100 USDT", "capital ceiling=200 USDT");
    const { baseTree, headTree } = trees();
    const evaluation = evaluateTrustedFreeze(
      evalInput({
        baseTree,
        headTree,
        headTextByPath: { "docs/PHASE_2D_CONTRACT.md": mutated },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("anchor_sha256_mismatch"));
  });

  it("fail closed on a copied protected file reported by compare metadata", () => {
    const evaluation = evaluateTrustedFreeze(
      evalInput({
        compareFiles: [
          {
            filename: "src/risk/risk-engine-copy.ts",
            status: "copied",
            previous_filename: "src/risk/risk-engine.ts",
          },
        ],
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("protected_file_copied"));
  });

  it("fail closed when a decoy frozen-section heading hides mutated later limits", () => {
    const originalBody = extractFrozenRiskNumericContract(FROZEN_MARKDOWN);
    const decoy = `${originalBody}## 11. Corrective 4 evidence-closure addendum

## 2. Frozen v0.1 limits

These values are not upward-configurable.

\`\`\`text
capital ceiling=200 USDT
leverage=5x
margin budget=30 USDT
planned gross-notional cap=150 USDT
daily net-loss halt=-5 USDT
starting-equity drawdown halt=10 USDT
boundary buffer=1% beyond ±3% grid boundary
\`\`\`

## 11. Corrective 4 evidence-closure addendum
`;
    const { baseTree, headTree } = trees();
    const evaluation = evaluateTrustedFreeze(
      evalInput({
        baseTree,
        headTree,
        headTextByPath: { "docs/PHASE_2D_CONTRACT.md": decoy },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("anchor_start_marker_not_unique"));
  });

  it("fail closed when the frozen end marker is duplicated to truncate the hashed slice", () => {
    const truncated = FROZEN_MARKDOWN.replace(
      "## 2. Frozen v0.1 limits",
      "## 2. Frozen v0.1 limits\n\n## 11. Corrective 4 evidence-closure addendum\n",
    );
    const { baseTree, headTree } = trees();
    const evaluation = evaluateTrustedFreeze(
      evalInput({
        baseTree,
        headTree,
        headTextByPath: { "docs/PHASE_2D_CONTRACT.md": truncated },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("anchor_end_marker_not_unique"));
  });

  it("fail closed when required numeric limits are only outside the unique frozen slice", () => {
    const mutated = FROZEN_MARKDOWN.replace(
      "capital ceiling=100 USDT",
      "capital ceiling=200 USDT",
    ).replace(
      "## 11. Corrective 4 evidence-closure addendum",
      "## 11. Corrective 4 evidence-closure addendum\n\ncapital ceiling=100 USDT\n",
    );
    const { baseTree, headTree } = trees();
    const evaluation = evaluateTrustedFreeze(
      evalInput({
        baseTree,
        headTree,
        headTextByPath: { "docs/PHASE_2D_CONTRACT.md": mutated },
      }),
    );
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
    assert.ok(evaluation.reasons.includes("anchor_sha256_mismatch"));
    assert.ok(evaluation.reasons.includes("anchor_required_substring_missing"));
  });

  it("does not emit ACCEPT or PASS in the machine summary", () => {
    const summary = formatMachineSummary({
      trustedBaselineIntegrityOk: false,
      sourceHeadMatchesReviewedCandidate: false,
      reasons: ["protected_file_blob_mismatch"],
    });
    assert.equal(summaryContainsForbiddenDecisionWording(summary), false);
    assert.doesNotMatch(summary, /\bACCEPT\b/);
    assert.doesNotMatch(summary, /\bPASS\b/);
  });
});

describe("committed baseline", () => {
  it("parses the generated trusted baseline manifest", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const jsonText = readFileSync(path.join(repoRoot, TRUSTED_BASELINE_PATH), "utf8");
    const parsed = parseBaseline(jsonText);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.baseline.acceptedImplementationBaseSha, "c64fa291af0d53139c6c526cd25ede434c08c17b");
    assert.equal(parsed.baseline.minimumTrustedAncestorSha, "ed320fbf6558fcf249a6685031f5280a0e402def");
    assert.equal(parsed.baseline.candidateHeadRef, "experiment/v0.1-phase2");
    assert.equal(
      parsed.baseline.currentAcceptedCandidateSourceHead,
      "7f196d367e39640eee9517f742b0d61424f9d4cc",
    );
    assert.ok(parsed.baseline.protectedFiles.length >= 61);
    assert.equal(
      new Set(parsed.baseline.protectedFiles.map((file) => file.path)).size,
      parsed.baseline.protectedFiles.length,
    );
    assert.ok(
      parsed.baseline.protectedFiles.some((file) => file.path === "src/risk/risk-engine.ts"),
    );
    assert.ok(!parsed.baseline.protectedFiles.some((file) => file.path === "docs/PHASE_2D_CONTRACT.md"));
    assert.equal(
      parsed.baseline.protectedContentAnchors[0].sha256,
      "2eb75b74d668578fa996fb21a7ef2d7998bbc3a6274d61c1ba7b847506f5a68f",
    );
    for (const required of frozenLimitRequiredSubstrings()) {
      assert.ok(parsed.baseline.protectedContentAnchors[0].requiredSubstrings.includes(required));
    }
    assert.equal(TRUSTED_WORKFLOW_PATH.length > 0, true);
  });
});
