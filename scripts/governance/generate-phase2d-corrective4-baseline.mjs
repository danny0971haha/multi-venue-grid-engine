#!/usr/bin/env node
/**
 * Generate the trusted baseline manifest from Git objects.
 * Protected file bytes come from the accepted Corrective 4 implementation
 * base. The frozen numeric-contract hash comes from the unique
 * `## 2` ... `## 11` slice at the pinned candidate source HEAD.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  TRUSTED_BASELINE_PATH,
  extractFrozenRiskNumericContractDetailed,
  frozenLimitRequiredSubstrings,
  pathMatchesAnyRule,
  sha256Bytes,
  sha256Text,
} from "./phase2d-trusted-freeze-lib.mjs";
import { POLICY_PATH } from "./repository-governance-policy.mjs";

const IMPLEMENTATION_BASE = "c64fa291af0d53139c6c526cd25ede434c08c17b";
const CANDIDATE_HEAD = "7f196d367e39640eee9517f742b0d61424f9d4cc";
const MINIMUM_TRUSTED_ANCESTOR = "ed320fbf6558fcf249a6685031f5280a0e402def";
const CANDIDATE_HEAD_REF = "experiment/v0.1-phase2";
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

const TRUSTED_GOVERNANCE_PATH_RULES = [
  ".github/workflows/trusted-phase2d-freeze.yml",
  ".github/workflows/trusted-governance-self-test.yml",
  ".github/trusted/**",
  "scripts/governance/**",
  ".github/CODEOWNERS",
];

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: options.cwd ?? repoRoot(),
    input: options.input,
  }).trim();
}

function gitBytes(args) {
  return execFileSync("git", args, { cwd: repoRoot() });
}

function uncommittedGovernancePaths(porcelain) {
  const paths = [];
  for (const line of porcelain.split("\n").filter(Boolean)) {
    const pathPart = line.slice(3);
    const filePath = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop() : pathPart;
    if (filePath === TRUSTED_BASELINE_PATH) continue;
    if (pathMatchesAnyRule(filePath, TRUSTED_GOVERNANCE_PATH_RULES)) {
      paths.push(filePath);
    }
  }
  return paths;
}

function assertGeneratorInputsCommitted() {
  const dirty = uncommittedGovernancePaths(
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
  );
  if (dirty.length > 0) {
    throw new Error(`generator_uncommitted_governance:${dirty.join(",")}`);
  }
}

function main() {
  assertGeneratorInputsCommitted();
  const baseSha = git(["rev-parse", IMPLEMENTATION_BASE]);
  const treeSha = git(["rev-parse", `${IMPLEMENTATION_BASE}^{tree}`]);
  const candidateSha = git(["rev-parse", CANDIDATE_HEAD]);
  const trustedAncestorSha = git(["rev-parse", MINIMUM_TRUSTED_ANCESTOR]);
  if (
    baseSha !== IMPLEMENTATION_BASE ||
    candidateSha !== CANDIDATE_HEAD ||
    trustedAncestorSha !== MINIMUM_TRUSTED_ANCESTOR
  ) {
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

  const baseIndex = treeIndex(IMPLEMENTATION_BASE);
  const headIndex = treeIndex(CANDIDATE_HEAD);
  const candidateChangedFiles = [];
  for (const filePath of [...new Set([...baseIndex.keys(), ...headIndex.keys()])].sort()) {
    const base = baseIndex.get(filePath) ?? null;
    const head = headIndex.get(filePath) ?? null;
    if (
      base &&
      head &&
      base.mode === head.mode &&
      base.objectType === head.objectType &&
      base.blobSha === head.blobSha
    ) {
      continue;
    }
    candidateChangedFiles.push({
      path: filePath,
      change: base === null ? "added" : head === null ? "deleted" : "modified",
      base: base ? snapshotWithHash(base) : null,
      head: head ? snapshotWithHash(head) : null,
    });
  }

  const contract = execFileSync("git", ["show", `${CANDIDATE_HEAD}:docs/PHASE_2D_CONTRACT.md`], {
    encoding: "utf8",
  });
  const extracted = extractFrozenRiskNumericContractDetailed(contract);
  if (!extracted.ok) {
    throw new Error(extracted.reason ?? "frozen_numeric_contract_missing");
  }
  const frozenBody = extracted.body;

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    repository: REPOSITORY,
    minimumTrustedAncestorSha: MINIMUM_TRUSTED_ANCESTOR,
    candidateHeadRef: CANDIDATE_HEAD_REF,
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
    candidateChangedFiles,
    trustedGovernancePathRules: TRUSTED_GOVERNANCE_PATH_RULES,
    trustedGovernanceFiles: trustedGovernanceManifest(repoRoot()),
  };

  const outPath = path.join(repoRoot(), TRUSTED_BASELINE_PATH);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `wrote ${TRUSTED_BASELINE_PATH} files=${protectedFiles.length} tree=${treeSha}\n`,
  );
}

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function treeIndex(ref) {
  const result = new Map();
  const output = execFileSync("git", ["ls-tree", "-r", "-z", ref], { cwd: repoRoot() });
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("ls_tree_malformed");
    const [mode, objectType, blobSha] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    if (objectType !== "blob") throw new Error(`candidate_non_blob:${filePath}`);
    result.set(filePath, { mode, objectType, blobSha });
  }
  return result;
}

function snapshotWithHash(snapshot) {
  return {
    ...snapshot,
    sha256: sha256Bytes(gitBytes(["cat-file", "blob", snapshot.blobSha])),
  };
}

function trustedGovernanceManifest(root) {
  const listed = git(["ls-files", "--cached"])
    .split("\n")
    .filter(Boolean)
    .filter(
      (filePath) =>
        filePath !== TRUSTED_BASELINE_PATH &&
        pathMatchesAnyRule(filePath, TRUSTED_GOVERNANCE_PATH_RULES),
    )
    .sort();
  if (!listed.includes(POLICY_PATH)) {
    throw new Error("governance_policy_missing");
  }
  return listed.map((filePath) => {
    const absolute = path.join(root, filePath);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`trusted_non_blob:${filePath}`);
    const bytes = readFileSync(absolute);
    return {
      path: filePath,
      mode: stat.mode & 0o111 ? "100755" : "100644",
      objectType: "blob",
      blobSha: git(["hash-object", "--stdin"], { input: bytes }),
      sha256: sha256Bytes(bytes),
    };
  });
}

function spawnExit(args) {
  try {
    execFileSync("git", args, { cwd: repoRoot(), stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

export { uncommittedGovernancePaths, TRUSTED_GOVERNANCE_PATH_RULES };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
