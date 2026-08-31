/**
 * Pure trusted Phase 2E freeze checker.
 * No GitHub I/O. No candidate-code import. Candidate bytes never control
 * classification, allowed paths, expected SHAs, protected hashes, required
 * commands, or final disposition.
 */

import {
  GIT_SHA1_RE,
  GIT_SHA256_RE,
  isSafeGitPath,
  pathMatchesAnyRule,
  sha256Bytes,
  sha256Text,
} from "./phase2d-trusted-freeze-lib.mjs";

export const PHASE2E_SCHEMA_VERSION = "multi-venue-phase2e-trusted-baseline/1";
export const PHASE2E_TRUSTED_BASELINE_PATH = ".github/trusted/phase2e-corrective3-baseline.json";
export const PHASE2E_REPOSITORY = "danny0971haha/multi-venue-grid-engine";
export const PHASE2E_CANDIDATE_HEAD_REF = "experiment/v0.1-phase2e-halt-ack";
export const PHASE2E_CANDIDATE_BASE_REF = "experiment/v0.1-phase2";
export const PHASE2E_FROZEN_BASE_SHA = "7f196d367e39640eee9517f742b0d61424f9d4cc";
export const PHASE2E_CANDIDATE_HEAD_SHA = "704afa2dd858c52dad06aa22941d463aa5ce4d69";
export const PHASE2E_INVALIDATED_CORRECTIVE1_HEAD_SHA = "f24421d9c80d96d7279d9626fc6bb95941031cf5";
export const PHASE2E_INVALIDATED_CORRECTIVE1_TREE_SHA = "be500d1ec4268269672cf1e1bb8f6cca29e5d397";
export const PHASE2E_STALE_CORRECTIVE2_HEAD_SHA = "80a86c8f3374711ad939a93e94292f177dc8f9e4";

export const PHASE2E_PROTECTED_PATH_RULES = Object.freeze([
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
]);

export const PHASE2E_TRUSTED_GOVERNANCE_PATH_RULES = Object.freeze([
  ".github/workflows/trusted-phase2d-freeze.yml",
  ".github/workflows/trusted-governance-self-test.yml",
  ".github/trusted/**",
  "scripts/governance/**",
  ".github/CODEOWNERS",
]);

export const PHASE2E_REQUIRED_RUNTIME_COMMANDS = Object.freeze([
  "npm ci",
  "npm run typecheck",
  "npm run lint",
  "npm run format:check",
  "npm test",
  "npm run test:phase2e",
  "npm run build",
  "npm run scan:secrets",
  "npm run dry-run",
]);

export const PHASE2E_FORBIDDEN_RUNTIME_COMMANDS = Object.freeze([
  "npm run evidence:phase2d-corrective4:verify",
  "npm run evidence:phase2d-corrective4",
]);

export const PHASE2E_NPM_TEST_HISTORICAL_MISMATCH = Object.freeze({
  boundCandidateHeadSha: PHASE2E_CANDIDATE_HEAD_SHA,
  testFilePath: "test/evidence/phase2d-corrective4-evidence.test.ts",
  expectedExitCode: 0,
  expectedTapTests: 474,
  expectedTapPass: 474,
  expectedTapFail: 0,
  expectedTapCancelled: 0,
  expectedTapSkipped: 0,
  expectedTapTodo: 0,
  expectedFailureType: "testCodeFailure",
  expectedFailureCode: "ERR_ASSERTION",
  expectedErrorSubstring: "PACKAGE_SCRIPT",
  expectedFailureNames: Object.freeze([]),
  expectedSuiteFailureName: "Phase 2D Corrective 4 evidence verifier",
  expectedSuiteFailureType: "subtestsFailed",
  expectedSuiteFailureCode: "ERR_TEST_FAILURE",
});

const ALLOWED_BLOB_MODES = new Set(["100644", "100755"]);
const OBJECT_TYPES = new Set(["blob", "tree", "commit"]);
const CHANGE_TYPES = new Set(["added", "modified", "deleted"]);

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "repository",
  "candidateHeadRef",
  "candidateBaseRef",
  "frozenBaseSha",
  "frozenBaseTreeSha",
  "candidateHeadSha",
  "candidateHeadTreeSha",
  "allowedChangedPaths",
  "candidateChangedFiles",
  "protectedPathRules",
  "protectedFrozenFiles",
  "trustedGovernancePathRules",
  "packageLock",
  "dependencyIdentity",
  "packageJsonScriptsPolicy",
  "requiredNodeVersion",
  "requiredNpmVersion",
  "requiredRuntimeCommands",
  "forbiddenRuntimeCommands",
  "npmTestHistoricalMismatch",
]);
const MISMATCH_FIELDS = new Set([
  "boundCandidateHeadSha",
  "testFilePath",
  "expectedExitCode",
  "expectedTapTests",
  "expectedTapPass",
  "expectedTapFail",
  "expectedTapCancelled",
  "expectedTapSkipped",
  "expectedTapTodo",
  "expectedFailureType",
  "expectedFailureCode",
  "expectedErrorSubstring",
  "expectedFailureNames",
  "expectedSuiteFailureName",
  "expectedSuiteFailureType",
  "expectedSuiteFailureCode",
]);
const FILE_FIELDS = new Set(["path", "mode", "objectType", "blobSha", "sha256"]);
const CHANGE_FIELDS = new Set(["path", "change", "base", "head"]);
const SNAPSHOT_FIELDS = new Set(["mode", "objectType", "blobSha", "sha256"]);
const LOCK_FIELDS = new Set(["path", "mode", "objectType", "blobSha", "sha256"]);
const DEP_FIELDS = new Set(["dependencies", "devDependencies"]);
const SCRIPT_POLICY_FIELDS = new Set([
  "allowedScriptKeysChanged",
  "expectedBaseTestScript",
  "expectedHeadScripts",
]);

const PHASE2E_SIGNAL_EXACT_PATHS = new Set([
  "docs/PHASE_2E_EVIDENCE.md",
  "test/fixtures/phase2e-crash-worker.ts",
]);

export function isPhase2eSignalPath(filePath) {
  if (!isSafeGitPath(filePath)) return false;
  if (PHASE2E_SIGNAL_EXACT_PATHS.has(filePath)) return true;
  return filePath.startsWith("src/halt/") || filePath.startsWith("test/halt/");
}

export function hasPhase2eSignal({ headRef, changedPaths, phase2eBaseline }) {
  const expectedHead = phase2eBaseline?.candidateHeadRef ?? PHASE2E_CANDIDATE_HEAD_REF;
  if (headRef === expectedHead) return true;
  if (!Array.isArray(changedPaths)) return false;
  return changedPaths.some((filePath) => isPhase2eSignalPath(filePath));
}

export function parsePhase2eBaseline(jsonText) {
  const reasons = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, baseline: null, reasons: ["phase2e_baseline_malformed_json"] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, baseline: null, reasons: ["phase2e_baseline_not_object"] };
  }
  rejectUnknownFields(parsed, ROOT_FIELDS, "phase2e_baseline_unknown_field", reasons);
  if (parsed.schemaVersion !== PHASE2E_SCHEMA_VERSION)
    reasons.push("phase2e_baseline_schema_version");
  if (parsed.repository !== PHASE2E_REPOSITORY) reasons.push("phase2e_baseline_repository");
  if (parsed.candidateHeadRef !== PHASE2E_CANDIDATE_HEAD_REF) {
    reasons.push("phase2e_baseline_candidate_head_ref");
  }
  if (parsed.candidateBaseRef !== PHASE2E_CANDIDATE_BASE_REF) {
    reasons.push("phase2e_baseline_candidate_base_ref");
  }
  if (parsed.frozenBaseSha !== PHASE2E_FROZEN_BASE_SHA)
    reasons.push("phase2e_baseline_frozen_base_sha");
  if (parsed.candidateHeadSha !== PHASE2E_CANDIDATE_HEAD_SHA) {
    reasons.push("phase2e_baseline_candidate_head_sha");
  }
  if (!GIT_SHA1_RE.test(parsed.frozenBaseTreeSha ?? ""))
    reasons.push("phase2e_baseline_frozen_base_tree_sha");
  if (!GIT_SHA1_RE.test(parsed.candidateHeadTreeSha ?? "")) {
    reasons.push("phase2e_baseline_candidate_head_tree_sha");
  }
  if (!isStringPathList(parsed.allowedChangedPaths)) {
    reasons.push("phase2e_baseline_allowed_changed_paths");
  } else if (parsed.allowedChangedPaths.some((filePath) => !isSafeGitPath(filePath))) {
    reasons.push("phase2e_baseline_allowed_path_unsafe");
  } else if (
    parsed.allowedChangedPaths.some(
      (filePath) => filePath.endsWith("/**") || filePath.includes("*"),
    )
  ) {
    reasons.push("phase2e_baseline_allowed_path_glob");
  }
  if (!isStringRuleList(parsed.protectedPathRules)) {
    reasons.push("phase2e_baseline_protected_path_rules");
  }
  if (!isStringRuleList(parsed.trustedGovernancePathRules)) {
    reasons.push("phase2e_baseline_trusted_governance_path_rules");
  }
  validateChangedFiles(parsed.candidateChangedFiles, reasons);
  validateFileManifest(parsed.protectedFrozenFiles, "phase2e_protected_frozen", reasons);
  validateLock(parsed.packageLock, reasons);
  validateDependencyIdentity(parsed.dependencyIdentity, reasons);
  validateScriptsPolicy(parsed.packageJsonScriptsPolicy, reasons);
  if (parsed.requiredNodeVersion !== "v22.23.2") reasons.push("phase2e_baseline_node_version");
  if (parsed.requiredNpmVersion !== "10.9.8") reasons.push("phase2e_baseline_npm_version");
  if (!sameStringList(parsed.requiredRuntimeCommands, PHASE2E_REQUIRED_RUNTIME_COMMANDS)) {
    reasons.push("phase2e_baseline_required_runtime_commands");
  }
  if (!sameStringList(parsed.forbiddenRuntimeCommands, PHASE2E_FORBIDDEN_RUNTIME_COMMANDS)) {
    reasons.push("phase2e_baseline_forbidden_runtime_commands");
  }
  validateNpmTestHistoricalMismatch(parsed.npmTestHistoricalMismatch, reasons);
  if (
    Array.isArray(parsed.allowedChangedPaths) &&
    Array.isArray(parsed.candidateChangedFiles) &&
    parsed.allowedChangedPaths.join("\0") !==
      parsed.candidateChangedFiles.map((item) => item.path).join("\0")
  ) {
    reasons.push("phase2e_baseline_allowed_paths_manifest_mismatch");
  }
  if (reasons.length > 0) {
    return { ok: false, baseline: null, reasons: unique(reasons) };
  }
  return { ok: true, baseline: parsed, reasons: [] };
}

export function evaluatePhase2eIntegrity(input) {
  const reasons = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return result(false, false, ["evaluation_input_invalid"]);
  }
  const baseline = input.baseline;
  if (!baseline || typeof baseline !== "object") {
    return result(false, false, ["phase2e_baseline_missing"]);
  }

  const sourceHeadSha = input.sourceHeadSha;
  const eventSourceHeadSha = input.eventSourceHeadSha ?? sourceHeadSha;
  const sourceHeadMatchesReviewedCandidate =
    GIT_SHA1_RE.test(sourceHeadSha ?? "") && sourceHeadSha === baseline.candidateHeadSha;

  if (!GIT_SHA1_RE.test(sourceHeadSha ?? "")) reasons.push("source_head_sha_invalid");
  if (!GIT_SHA1_RE.test(eventSourceHeadSha ?? "")) reasons.push("event_source_head_sha_invalid");
  if (
    GIT_SHA1_RE.test(sourceHeadSha ?? "") &&
    GIT_SHA1_RE.test(eventSourceHeadSha ?? "") &&
    sourceHeadSha !== eventSourceHeadSha
  ) {
    reasons.push("source_head_event_mismatch");
  }
  if (!sourceHeadMatchesReviewedCandidate) reasons.push("source_head_not_reviewed_candidate");
  if (input.prHeadRef !== baseline.candidateHeadRef) reasons.push("pr_head_ref_mismatch");
  if (input.prBaseRef !== baseline.candidateBaseRef) reasons.push("pr_base_ref_mismatch");
  if (input.prBaseSha !== baseline.frozenBaseSha) reasons.push("pr_base_sha_mismatch");
  if (input.repositoryFullName !== baseline.repository)
    reasons.push("repository_identity_mismatch");
  if (input.prHeadRepositoryFullName !== baseline.repository) {
    reasons.push("pr_head_repository_identity_mismatch");
  }
  if (input.ancestorCheckComplete !== true) reasons.push("ancestor_check_incomplete");
  else if (input.frozenBaseIsAncestor !== true) reasons.push("frozen_base_not_ancestor");
  if (input.baseTreeComplete !== true) reasons.push("base_tree_incomplete");
  if (input.headTreeComplete !== true) reasons.push("head_tree_incomplete");
  if (input.compareFilesIncomplete === true) reasons.push("compare_files_incomplete");

  const treesUsable =
    input.baseTreeComplete === true &&
    input.headTreeComplete === true &&
    Array.isArray(input.baseTree) &&
    Array.isArray(input.headTree);

  const baseIndex = treesUsable ? indexTree(input.baseTree, reasons, "base") : null;
  const headIndex = treesUsable ? indexTree(input.headTree, reasons, "head") : null;

  if (baseIndex && input.observedBaseTreeSha) {
    if (!GIT_SHA1_RE.test(input.observedBaseTreeSha))
      reasons.push("observed_base_tree_sha_invalid");
    else if (input.observedBaseTreeSha !== baseline.frozenBaseTreeSha) {
      reasons.push("frozen_base_tree_sha_mismatch");
    }
  }
  if (headIndex && input.observedHeadTreeSha) {
    if (!GIT_SHA1_RE.test(input.observedHeadTreeSha))
      reasons.push("observed_head_tree_sha_invalid");
    else if (input.observedHeadTreeSha !== baseline.candidateHeadTreeSha) {
      reasons.push("candidate_head_tree_sha_mismatch");
    }
  }

  if (baseIndex && headIndex) {
    const changedPaths = collectChangedPaths(baseIndex.map, headIndex.map);
    checkExactCandidateManifest(baseline, changedPaths, input.observedBlobSha256ByKey, reasons);
    checkAllowedChangedPaths(baseline, changedPaths, reasons);
    checkProtectedFrozenFiles(baseline, headIndex, reasons);
    checkProtectedFrozenSha256(baseline, input.observedBlobSha256ByKey, reasons);
    checkTypeAndModeAttacks(changedPaths, reasons);
    checkPackageLock(baseline, headIndex, reasons);
    checkPackageJsonPolicy(baseline, headIndex, input.headTextByPath, reasons);
    checkRenamesAndCopies(input.compareFiles, reasons);
  }

  const trustedBaselineIntegrityOk =
    reasons.filter((code) => code !== "source_head_not_reviewed_candidate").length === 0;

  return result(trustedBaselineIntegrityOk, sourceHeadMatchesReviewedCandidate, unique(reasons));
}

export function formatPhase2eMachineSummary(evaluation) {
  const integrity = evaluation.trustedBaselineIntegrityOk ? "true" : "false";
  const match = evaluation.sourceHeadMatchesReviewedCandidate ? "true" : "false";
  return [
    `phase2eTrustedBaselineIntegrityOk=${integrity}`,
    `sourceHeadMatchesReviewedCandidate=${match}`,
    `reasonCodes=${evaluation.reasons.join(",")}`,
  ].join("\n");
}

export function parsePackageJsonObject(text) {
  if (typeof text !== "string")
    return { ok: false, value: null, reason: "package_json_unavailable" };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, value: null, reason: "package_json_not_object" };
    }
    return { ok: true, value, reason: null };
  } catch {
    return { ok: false, value: null, reason: "package_json_malformed" };
  }
}

export function dependencyIdentityMatches(baseline, pkg) {
  return (
    stableJson(pkg?.dependencies) === stableJson(baseline.dependencyIdentity.dependencies) &&
    stableJson(pkg?.devDependencies) === stableJson(baseline.dependencyIdentity.devDependencies)
  );
}

function checkPackageJsonPolicy(baseline, headIndex, headTextByPath, reasons) {
  const entry = headIndex.map.get("package.json");
  if (!entry) {
    reasons.push("package_json_missing");
    return;
  }
  if (entry.type !== "blob" || entry.mode === "120000" || entry.mode === "160000") {
    reasons.push("package_json_type_change");
    return;
  }
  const text = headTextByPath?.["package.json"];
  const parsed = parsePackageJsonObject(text);
  if (!parsed.ok) {
    reasons.push(parsed.reason);
    return;
  }
  if (!dependencyIdentityMatches(baseline, parsed.value)) {
    reasons.push("package_json_dependency_identity_mismatch");
  }
  const policy = baseline.packageJsonScriptsPolicy;
  const scripts = parsed.value.scripts;
  if (!scripts || typeof scripts !== "object") {
    reasons.push("package_json_scripts_missing");
    return;
  }
  for (const key of policy.allowedScriptKeysChanged) {
    if ((scripts[key] ?? null) !== (policy.expectedHeadScripts[key] ?? null)) {
      reasons.push("package_json_script_mismatch");
    }
  }
}

function checkPackageLock(baseline, headIndex, reasons) {
  const head = headIndex.map.get("package-lock.json");
  const expected = baseline.packageLock;
  if (!head) {
    reasons.push("package_lock_deleted");
    return;
  }
  if (head.type !== "blob" || head.mode === "120000" || head.mode === "160000") {
    reasons.push("package_lock_type_change");
    return;
  }
  if (head.sha !== expected.blobSha || head.mode !== expected.mode) {
    reasons.push("package_lock_identity_mismatch");
  }
}

function checkProtectedFrozenFiles(baseline, headIndex, reasons) {
  for (const file of baseline.protectedFrozenFiles) {
    const head = headIndex.map.get(file.path);
    if (!head) {
      reasons.push("protected_file_deleted");
      continue;
    }
    if (head.type !== file.objectType) reasons.push("protected_file_type_change");
    if (head.mode !== file.mode) reasons.push("protected_file_mode_change");
    if (head.sha !== file.blobSha) reasons.push("protected_file_blob_mismatch");
    if (head.mode === "120000") reasons.push("protected_file_symlink");
    if (head.type === "commit" || head.mode === "160000") reasons.push("protected_file_gitlink");
  }
}

function checkProtectedFrozenSha256(baseline, observedHashes, reasons) {
  for (const file of baseline.protectedFrozenFiles) {
    if (observedHashes?.[`head:${file.path}`] !== file.sha256) {
      reasons.push("protected_file_sha256_mismatch");
    }
  }
}

function checkExactCandidateManifest(baseline, changed, observedHashes, reasons) {
  const expected = baseline.candidateChangedFiles;
  const actualByPath = new Map(changed.map((item) => [item.path, item]));
  const expectedByPath = new Map(expected.map((item) => [item.path, item]));
  if (actualByPath.size !== expectedByPath.size)
    reasons.push("candidate_manifest_path_count_mismatch");
  for (const [filePath, actual] of actualByPath) {
    const item = expectedByPath.get(filePath);
    if (!item) {
      reasons.push("candidate_manifest_unexpected_path");
      continue;
    }
    if (item.change !== actual.change) reasons.push("candidate_manifest_change_mismatch");
    checkSnapshotMatch(item.base, actual.base, "base", filePath, observedHashes, reasons);
    checkSnapshotMatch(item.head, actual.head, "head", filePath, observedHashes, reasons);
  }
  for (const filePath of expectedByPath.keys()) {
    if (!actualByPath.has(filePath)) reasons.push("candidate_manifest_missing_path");
  }
}

function checkSnapshotMatch(expected, actual, side, filePath, observedHashes, reasons) {
  if (expected === null) {
    if (actual !== undefined) reasons.push(`candidate_manifest_${side}_presence_mismatch`);
    return;
  }
  if (
    !actual ||
    expected.mode !== actual.mode ||
    expected.objectType !== actual.type ||
    expected.blobSha !== actual.sha
  ) {
    reasons.push(`candidate_manifest_${side}_identity_mismatch`);
    return;
  }
  const observed = observedHashes?.[`${side}:${filePath}`];
  if (observed !== expected.sha256) reasons.push(`candidate_manifest_${side}_sha256_mismatch`);
}

function checkAllowedChangedPaths(baseline, changed, reasons) {
  const allowed = new Set(baseline.allowedChangedPaths);
  for (const item of changed) {
    if (!isSafeGitPath(item.path)) {
      reasons.push("changed_path_unsafe");
      continue;
    }
    if (pathMatchesAnyRule(item.path, baseline.trustedGovernancePathRules)) {
      reasons.push("trusted_governance_path_changed");
    }
    if (item.path === "package-lock.json") reasons.push("package_lock_changed");
    if (!allowed.has(item.path)) reasons.push("unallowed_path_changed");
  }
}

function checkTypeAndModeAttacks(changed, reasons) {
  for (const item of changed) {
    const node = item.head ?? item.base;
    if (!node) continue;
    if (node.mode === "120000") reasons.push("changed_path_symlink");
    if (node.mode === "160000" || node.type === "commit") reasons.push("changed_path_gitlink");
    if (node.type === "tree") reasons.push("changed_path_tree_object");
  }
}

function checkRenamesAndCopies(compareFiles, reasons) {
  if (!Array.isArray(compareFiles)) return;
  for (const file of compareFiles) {
    if (!file || typeof file !== "object") {
      reasons.push("compare_file_entry_invalid");
      continue;
    }
    if (file.status === "renamed") reasons.push("protected_file_renamed");
    if (file.status === "copied") reasons.push("protected_file_copied");
  }
}

function collectChangedPaths(baseMap, headMap) {
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const changed = [];
  for (const filePath of paths) {
    const base = baseMap.get(filePath);
    const head = headMap.get(filePath);
    if (!base && head) {
      changed.push({ path: filePath, change: "added", base, head });
      continue;
    }
    if (base && !head) {
      changed.push({ path: filePath, change: "deleted", base, head });
      continue;
    }
    if (base.sha !== head.sha || base.mode !== head.mode || base.type !== head.type) {
      changed.push({ path: filePath, change: "modified", base, head });
    }
  }
  return changed;
}

function indexTree(entries, reasons, label) {
  if (!Array.isArray(entries)) {
    reasons.push(`${label}_tree_missing`);
    return null;
  }
  const map = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      reasons.push(`${label}_tree_entry_invalid`);
      continue;
    }
    if (!isSafeGitPath(entry.path)) {
      reasons.push(`${label}_tree_path_unsafe`);
      continue;
    }
    if (map.has(entry.path)) {
      reasons.push(`${label}_tree_duplicate_path`);
      continue;
    }
    if (!OBJECT_TYPES.has(entry.type)) reasons.push(`${label}_tree_type_invalid`);
    if (typeof entry.mode !== "string" || typeof entry.sha !== "string") {
      reasons.push(`${label}_tree_entry_fields`);
    }
    if (entry.type === "tree") continue;
    map.set(entry.path, entry);
  }
  return { map };
}

function validateChangedFiles(files, reasons) {
  if (!Array.isArray(files) || files.length === 0) {
    reasons.push("phase2e_baseline_candidate_changed_files");
    return;
  }
  const seen = new Set();
  for (const item of files) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      reasons.push("phase2e_baseline_candidate_changed_file_entry");
      continue;
    }
    rejectUnknownFields(
      item,
      CHANGE_FIELDS,
      "phase2e_baseline_candidate_changed_file_unknown_field",
      reasons,
    );
    if (!isSafeGitPath(item.path)) reasons.push("phase2e_baseline_candidate_changed_file_path");
    if (seen.has(item.path)) reasons.push("phase2e_baseline_candidate_changed_file_duplicate_path");
    seen.add(item.path);
    if (!CHANGE_TYPES.has(item.change)) reasons.push("phase2e_baseline_change_type");
    if (item.change === "added" && item.base !== null) reasons.push("phase2e_baseline_change_base");
    if (item.change === "deleted" && item.head !== null)
      reasons.push("phase2e_baseline_change_head");
    if (item.change !== "added") validateSnapshot(item.base, "base", reasons);
    if (item.change !== "deleted") validateSnapshot(item.head, "head", reasons);
  }
}

function validateSnapshot(snapshot, side, reasons) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    reasons.push(`phase2e_baseline_${side}_snapshot`);
    return;
  }
  rejectUnknownFields(snapshot, SNAPSHOT_FIELDS, `phase2e_baseline_${side}_unknown_field`, reasons);
  if (!ALLOWED_BLOB_MODES.has(snapshot.mode)) reasons.push(`phase2e_baseline_${side}_mode`);
  if (snapshot.objectType !== "blob") reasons.push(`phase2e_baseline_${side}_type`);
  if (!GIT_SHA1_RE.test(snapshot.blobSha ?? "")) reasons.push(`phase2e_baseline_${side}_blob_sha`);
  if (!GIT_SHA256_RE.test(snapshot.sha256 ?? "")) reasons.push(`phase2e_baseline_${side}_sha256`);
}

function validateFileManifest(files, prefix, reasons) {
  if (!Array.isArray(files) || files.length === 0) {
    reasons.push(`${prefix}_files`);
    return;
  }
  const seen = new Set();
  for (const file of files) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      reasons.push(`${prefix}_file_entry`);
      continue;
    }
    rejectUnknownFields(file, FILE_FIELDS, `${prefix}_file_unknown_field`, reasons);
    if (!isSafeGitPath(file.path)) reasons.push(`${prefix}_file_path`);
    if (seen.has(file.path)) reasons.push(`${prefix}_duplicate_path`);
    seen.add(file.path);
    if (!ALLOWED_BLOB_MODES.has(file.mode)) reasons.push(`${prefix}_file_mode`);
    if (file.objectType !== "blob") reasons.push(`${prefix}_file_type`);
    if (!GIT_SHA1_RE.test(file.blobSha ?? "")) reasons.push(`${prefix}_file_blob_sha`);
    if (!GIT_SHA256_RE.test(file.sha256 ?? "")) reasons.push(`${prefix}_file_sha256`);
  }
}

function validateLock(lock, reasons) {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    reasons.push("phase2e_baseline_package_lock");
    return;
  }
  rejectUnknownFields(lock, LOCK_FIELDS, "phase2e_baseline_package_lock_unknown_field", reasons);
  if (lock.path !== "package-lock.json") reasons.push("phase2e_baseline_package_lock_path");
  if (!ALLOWED_BLOB_MODES.has(lock.mode)) reasons.push("phase2e_baseline_package_lock_mode");
  if (lock.objectType !== "blob") reasons.push("phase2e_baseline_package_lock_type");
  if (!GIT_SHA1_RE.test(lock.blobSha ?? "")) reasons.push("phase2e_baseline_package_lock_blob_sha");
  if (!GIT_SHA256_RE.test(lock.sha256 ?? "")) reasons.push("phase2e_baseline_package_lock_sha256");
}

function validateDependencyIdentity(identity, reasons) {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    reasons.push("phase2e_baseline_dependency_identity");
    return;
  }
  rejectUnknownFields(identity, DEP_FIELDS, "phase2e_baseline_dependency_unknown_field", reasons);
  if (!isStringMap(identity.dependencies) || !isStringMap(identity.devDependencies)) {
    reasons.push("phase2e_baseline_dependency_map");
  }
}

function validateNpmTestHistoricalMismatch(value, reasons) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reasons.push("phase2e_baseline_npm_test_mismatch");
    return;
  }
  rejectUnknownFields(
    value,
    MISMATCH_FIELDS,
    "phase2e_baseline_npm_test_mismatch_unknown_field",
    reasons,
  );
  const pinned = PHASE2E_NPM_TEST_HISTORICAL_MISMATCH;
  if (value.boundCandidateHeadSha !== pinned.boundCandidateHeadSha) {
    reasons.push("phase2e_baseline_npm_test_mismatch_head");
  }
  if (value.testFilePath !== pinned.testFilePath) {
    reasons.push("phase2e_baseline_npm_test_mismatch_file");
  }
  if (value.expectedExitCode !== pinned.expectedExitCode) {
    reasons.push("phase2e_baseline_npm_test_mismatch_exit");
  }
  if (value.expectedTapTests !== pinned.expectedTapTests) {
    reasons.push("phase2e_baseline_npm_test_mismatch_tests");
  }
  if (value.expectedTapPass !== pinned.expectedTapPass) {
    reasons.push("phase2e_baseline_npm_test_mismatch_pass");
  }
  if (value.expectedTapFail !== pinned.expectedTapFail) {
    reasons.push("phase2e_baseline_npm_test_mismatch_fail");
  }
  if (value.expectedTapCancelled !== pinned.expectedTapCancelled) {
    reasons.push("phase2e_baseline_npm_test_mismatch_cancelled");
  }
  if (value.expectedTapSkipped !== pinned.expectedTapSkipped) {
    reasons.push("phase2e_baseline_npm_test_mismatch_skipped");
  }
  if (value.expectedTapTodo !== pinned.expectedTapTodo) {
    reasons.push("phase2e_baseline_npm_test_mismatch_todo");
  }
  if (value.expectedFailureType !== pinned.expectedFailureType) {
    reasons.push("phase2e_baseline_npm_test_mismatch_failure_type");
  }
  if (value.expectedFailureCode !== pinned.expectedFailureCode) {
    reasons.push("phase2e_baseline_npm_test_mismatch_failure_code");
  }
  if (value.expectedErrorSubstring !== pinned.expectedErrorSubstring) {
    reasons.push("phase2e_baseline_npm_test_mismatch_error");
  }
  if (value.expectedSuiteFailureName !== pinned.expectedSuiteFailureName) {
    reasons.push("phase2e_baseline_npm_test_mismatch_suite_name");
  }
  if (value.expectedSuiteFailureType !== pinned.expectedSuiteFailureType) {
    reasons.push("phase2e_baseline_npm_test_mismatch_suite_type");
  }
  if (value.expectedSuiteFailureCode !== pinned.expectedSuiteFailureCode) {
    reasons.push("phase2e_baseline_npm_test_mismatch_suite_code");
  }
  if (!sameStringList(value.expectedFailureNames, pinned.expectedFailureNames)) {
    reasons.push("phase2e_baseline_npm_test_mismatch_names");
  }
}

function validateScriptsPolicy(policy, reasons) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    reasons.push("phase2e_baseline_scripts_policy");
    return;
  }
  rejectUnknownFields(
    policy,
    SCRIPT_POLICY_FIELDS,
    "phase2e_baseline_scripts_policy_unknown_field",
    reasons,
  );
  if (
    !Array.isArray(policy.allowedScriptKeysChanged) ||
    policy.allowedScriptKeysChanged.length === 0
  ) {
    reasons.push("phase2e_baseline_scripts_policy_keys");
  }
  if (
    typeof policy.expectedBaseTestScript !== "string" ||
    policy.expectedBaseTestScript.length === 0
  ) {
    reasons.push("phase2e_baseline_scripts_policy_base_test");
  }
  if (policy.expectedHeadScripts === null || typeof policy.expectedHeadScripts !== "object") {
    reasons.push("phase2e_baseline_scripts_policy_head_scripts");
  }
}

function rejectUnknownFields(value, allowed, reason, reasons) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reasons.push(reason);
  }
}

function isStringRuleList(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
  );
}

function isStringPathList(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
  );
}

function isStringMap(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function sameStringList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((item, i) => item === expected[i])
  );
}

function stableJson(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function unique(items) {
  return [...new Set(items)];
}

function result(trustedBaselineIntegrityOk, sourceHeadMatchesReviewedCandidate, reasons) {
  return { trustedBaselineIntegrityOk, sourceHeadMatchesReviewedCandidate, reasons };
}

export { sha256Bytes, sha256Text, isSafeGitPath, pathMatchesAnyRule, GIT_SHA1_RE };
