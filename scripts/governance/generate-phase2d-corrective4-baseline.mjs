#!/usr/bin/env node
/**
 * Generate the trusted baseline manifest from Git objects at the
 * accepted Phase 2D Corrective 4 implementation base. Run only on a
 * trusted machine that already has those objects. Never run against
 * untrusted PR checkouts as a source of frozen bytes.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  TRUSTED_BASELINE_PATH,
  extractFrozenRiskNumericContract,
  frozenLimitRequiredSubstrings,
  pathMatchesAnyRule,
  sha256Bytes,
  sha256Text,
} from "./phase2d-trusted-freeze-lib.mjs";

const IMPLEMENTATION_BASE = "c64fa291af0d53139c6c526cd25ede434c08c17b";
const CANDIDATE_HEAD = "7f196d367e39640eee9517f742b0d61424f9d4cc";
const REPOSITORY = "danny0971haha/multi-venue-grid-engine";

const PROTECTED_PATH_RULES = [
  "src/**",
  "test/risk/**",
  "test/persistence/**",
  "test/simulator/**",
  "package-lock.json",
  "docs/RISK_PERSISTENCE_CONTRACT.md",
  "docs/EXPERIMENT_SPEC.md",
  "docs/PHASE_1_CONTRACT.md",
  "docs/DOMAIN_CONTRACTS.md",
  "docs/ACCEPTANCE_GATES.md",
];

const ALLOWED_EVIDENCE_ONLY_CHANGED_PATH_RULES = [
  ".github/workflows/README.md",
  ".github/workflows/ci.yml",
  ".gitignore",
  "docs/IMPLEMENTATION_CONTRACT.md",
  "docs/PHASE_2D_CONTRACT.md",
  "docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md",
  "docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md",
  "package.json",
  "scripts/evidence/**",
  "test/evidence/**",
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitBytes(args) {
  return execFileSync("git", args);
}

function main() {
  const baseSha = git(["rev-parse", IMPLEMENTATION_BASE]);
  const treeSha = git(["rev-parse", `${IMPLEMENTATION_BASE}^{tree}`]);
  const candidateSha = git(["rev-parse", CANDIDATE_HEAD]);
  if (baseSha !== IMPLEMENTATION_BASE || candidateSha !== CANDIDATE_HEAD) {
    throw new Error("git_rev_parse_mismatch");
  }
  const ancestor = spawnExit(["merge-base", "--is-ancestor", IMPLEMENTATION_BASE, CANDIDATE_HEAD]);
  if (ancestor !== 0) {
    throw new Error("implementation_base_not_ancestor");
  }

  const lsTree = git(["ls-tree", "-r", treeSha]);
  const protectedFiles = [];
  for (const line of lsTree.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      throw new Error("ls_tree_malformed");
    }
    const [mode, objectType, blobSha] = line.slice(0, tab).split(" ");
    const filePath = line.slice(tab + 1);
    if (!pathMatchesAnyRule(filePath, PROTECTED_PATH_RULES)) {
      continue;
    }
    if (objectType !== "blob") {
      throw new Error(`protected_non_blob:${filePath}`);
    }
    const bytes = gitBytes(["cat-file", "blob", blobSha]);
    protectedFiles.push({
      path: filePath,
      mode,
      objectType,
      blobSha,
      sha256: sha256Bytes(bytes),
    });
  }
  protectedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const contract = git(["show", `${IMPLEMENTATION_BASE}:docs/PHASE_2D_CONTRACT.md`]);
  const frozenBody = extractFrozenRiskNumericContract(contract);
  if (!frozenBody) {
    throw new Error("frozen_numeric_contract_missing");
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    repository: REPOSITORY,
    acceptedImplementationBaseSha: IMPLEMENTATION_BASE,
    acceptedImplementationBaseTreeSha: treeSha,
    currentAcceptedCandidateSourceHead: CANDIDATE_HEAD,
    protectedPathRules: PROTECTED_PATH_RULES,
    allowedEvidenceOnlyChangedPathRules: ALLOWED_EVIDENCE_ONLY_CHANGED_PATH_RULES,
    protectedContentAnchors: [
      {
        path: "docs/PHASE_2D_CONTRACT.md",
        description: "Phase 2D frozen v0.1 risk numeric contract body",
        startMarker: "## 2. Frozen v0.1 limits",
        endExclusiveMarker: "## 11. Corrective 4 evidence-closure addendum",
        sha256: sha256Text(frozenBody),
        requiredSubstrings: frozenLimitRequiredSubstrings(),
      },
    ],
    protectedFiles,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const outPath = path.join(repoRoot, TRUSTED_BASELINE_PATH);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `wrote ${TRUSTED_BASELINE_PATH} files=${protectedFiles.length} tree=${treeSha}\n`,
  );
}

function spawnExit(args) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

main();
