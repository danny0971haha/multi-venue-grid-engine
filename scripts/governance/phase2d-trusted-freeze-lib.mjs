/**
 * Pure trusted Phase 2D freeze checker.
 * No GitHub I/O. No candidate-code import. No gate/release wording in outputs.
 */

import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "multi-venue-phase2d-trusted-baseline/2";

export const TRUSTED_BASELINE_PATH =
  ".github/trusted/phase2d-corrective4-baseline.json";
export const TRUSTED_WORKFLOW_PATH =
  ".github/workflows/trusted-phase2d-freeze.yml";

export const GIT_SHA1_RE = /^[0-9a-f]{40}$/;
export const GIT_SHA256_RE = /^[0-9a-f]{64}$/;

const ALLOWED_BLOB_MODES = new Set(["100644", "100755"]);
const OBJECT_TYPES = new Set(["blob", "tree", "commit"]);
const CHANGE_TYPES = new Set(["added", "modified", "deleted"]);

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "repository",
  "minimumTrustedAncestorSha",
  "candidateHeadRef",
  "acceptedImplementationBaseSha",
  "acceptedImplementationBaseTreeSha",
  "currentAcceptedCandidateSourceHead",
  "protectedPathRules",
  "allowedEvidenceOnlyChangedPathRules",
  "protectedContentAnchors",
  "protectedFiles",
  "candidateChangedFiles",
  "trustedGovernancePathRules",
  "trustedGovernanceFiles",
]);
const FILE_FIELDS = new Set(["path", "mode", "objectType", "blobSha", "sha256"]);
const ANCHOR_FIELDS = new Set([
  "path",
  "description",
  "startMarker",
  "endExclusiveMarker",
  "sha256",
  "requiredSubstrings",
]);
const CHANGE_FIELDS = new Set(["path", "change", "base", "head"]);

const FROZEN_LIMIT_LINES = [
  "capital ceiling=100 USDT",
  "leverage=5x",
  "margin budget=30 USDT",
  "planned gross-notional cap=150 USDT",
  "daily net-loss halt=-5 USDT",
  "starting-equity drawdown halt=10 USDT",
  "boundary buffer=1% beyond ±3% grid boundary",
];

export function frozenLimitRequiredSubstrings() {
  return [...FROZEN_LIMIT_LINES];
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const FROZEN_START_MARKER = "## 2. Frozen v0.1 limits";
export const FROZEN_END_MARKER = "## 11. Corrective 4 evidence-closure addendum";

export function countExactOccurrences(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string" || needle.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) {
      return count;
    }
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

export function extractFrozenRiskNumericContractDetailed(markdown) {
  if (typeof markdown !== "string") {
    return { ok: false, body: null, reason: "anchor_content_unavailable" };
  }
  const startCount = countExactOccurrences(markdown, FROZEN_START_MARKER);
  const endCount = countExactOccurrences(markdown, FROZEN_END_MARKER);
  if (startCount === 0) {
    return { ok: false, body: null, reason: "anchor_start_marker_missing" };
  }
  if (startCount !== 1) {
    return { ok: false, body: null, reason: "anchor_start_marker_not_unique" };
  }
  if (endCount === 0) {
    return { ok: false, body: null, reason: "anchor_end_marker_missing" };
  }
  if (endCount !== 1) {
    return { ok: false, body: null, reason: "anchor_end_marker_not_unique" };
  }
  const start = markdown.indexOf(FROZEN_START_MARKER);
  const end = markdown.indexOf(FROZEN_END_MARKER);
  if (end <= start) {
    return { ok: false, body: null, reason: "anchor_markers_out_of_order" };
  }
  return { ok: true, body: markdown.slice(start, end), reason: null };
}

export function extractFrozenRiskNumericContract(markdown) {
  const extracted = extractFrozenRiskNumericContractDetailed(markdown);
  return extracted.ok ? extracted.body : null;
}

export function pathMatchesRule(filePath, rule) {
  if (!isSafeGitPath(filePath) || typeof rule !== "string") {
    return false;
  }
  if (!rule.includes("*")) {
    return filePath === rule;
  }
  if (rule.endsWith("/**") && !rule.slice(0, -3).includes("*")) {
    const prefix = rule.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return false;
}

export function isSafeGitPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return false;
  }
  if (
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    filePath.includes("//")
  ) {
    return false;
  }
  const parts = filePath.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function pathMatchesAnyRule(filePath, rules) {
  if (!Array.isArray(rules)) {
    return false;
  }
  return rules.some((rule) => pathMatchesRule(filePath, rule));
}

export function parseBaseline(jsonText) {
  const reasons = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return failParse("baseline_malformed_json", reasons);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failParse("baseline_not_object", reasons);
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    reasons.push("baseline_schema_version");
  }
  if (parsed.repository !== "danny0971haha/multi-venue-grid-engine") {
    reasons.push("baseline_repository");
  }
  rejectUnknownFields(parsed, ROOT_FIELDS, "baseline_unknown_field", reasons);
  if (!GIT_SHA1_RE.test(parsed.minimumTrustedAncestorSha ?? "")) {
    reasons.push("baseline_minimum_trusted_ancestor_sha");
  }
  if (parsed.candidateHeadRef !== "experiment/v0.1-phase2") {
    reasons.push("baseline_candidate_head_ref");
  }
  if (!GIT_SHA1_RE.test(parsed.acceptedImplementationBaseSha ?? "")) {
    reasons.push("baseline_implementation_base_sha");
  }
  if (!GIT_SHA1_RE.test(parsed.acceptedImplementationBaseTreeSha ?? "")) {
    reasons.push("baseline_implementation_base_tree_sha");
  }
  if (!GIT_SHA1_RE.test(parsed.currentAcceptedCandidateSourceHead ?? "")) {
    reasons.push("baseline_candidate_source_head");
  }

  const protectedPathRules = parsed.protectedPathRules;
  const allowedRules = parsed.allowedEvidenceOnlyChangedPathRules;
  if (!isStringRuleList(protectedPathRules)) {
    reasons.push("baseline_protected_path_rules");
  } else {
    for (const rule of protectedPathRules) {
      if (!isSupportedRule(rule)) {
        reasons.push("baseline_protected_path_rule_unsupported");
        break;
      }
    }
  }
  if (!isStringRuleList(allowedRules)) {
    reasons.push("baseline_allowed_path_rules");
  } else {
    for (const rule of allowedRules) {
      if (!isSupportedRule(rule)) {
        reasons.push("baseline_allowed_path_rule_unsupported");
        break;
      }
    }
  }

  const protectedFiles = parsed.protectedFiles;
  if (!Array.isArray(protectedFiles) || protectedFiles.length === 0) {
    reasons.push("baseline_protected_files");
  }

  const seen = new Set();
  const files = [];
  if (Array.isArray(protectedFiles)) {
    for (const file of protectedFiles) {
      if (file === null || typeof file !== "object" || Array.isArray(file)) {
        reasons.push("baseline_protected_file_entry");
        continue;
      }
      rejectUnknownFields(file, FILE_FIELDS, "baseline_protected_file_unknown_field", reasons);
      const path = file.path;
      if (!isSafeGitPath(path)) {
        reasons.push("baseline_protected_file_path");
        continue;
      }
      if (seen.has(path)) {
        reasons.push("baseline_duplicate_path");
        continue;
      }
      seen.add(path);
      if (!ALLOWED_BLOB_MODES.has(file.mode)) {
        reasons.push("baseline_protected_file_mode");
      }
      if (file.objectType !== "blob") {
        reasons.push("baseline_protected_file_type");
      }
      if (!GIT_SHA1_RE.test(file.blobSha ?? "")) {
        reasons.push("baseline_protected_file_blob_sha");
      }
      if (!GIT_SHA256_RE.test(file.sha256 ?? "")) {
        reasons.push("baseline_protected_file_sha256");
      }
      files.push(file);
    }
  }

  const anchors = parsed.protectedContentAnchors;
  if (!Array.isArray(anchors) || anchors.length === 0) {
    reasons.push("baseline_protected_content_anchors");
  } else {
    for (const anchor of anchors) {
      if (anchor === null || typeof anchor !== "object" || Array.isArray(anchor)) {
        reasons.push("baseline_anchor_entry");
        continue;
      }
      rejectUnknownFields(anchor, ANCHOR_FIELDS, "baseline_anchor_unknown_field", reasons);
      if (!isSafeGitPath(anchor.path)) {
        reasons.push("baseline_anchor_path");
      }
      if (typeof anchor.startMarker !== "string" || anchor.startMarker.length === 0) {
        reasons.push("baseline_anchor_start_marker");
      }
      if (
        typeof anchor.endExclusiveMarker !== "string" ||
        anchor.endExclusiveMarker.length === 0
      ) {
        reasons.push("baseline_anchor_end_marker");
      }
      if (!GIT_SHA256_RE.test(anchor.sha256 ?? "")) {
        reasons.push("baseline_anchor_sha256");
      }
      if (
        !Array.isArray(anchor.requiredSubstrings) ||
        anchor.requiredSubstrings.length === 0 ||
        anchor.requiredSubstrings.some((item) => typeof item !== "string")
      ) {
        reasons.push("baseline_anchor_required_substrings");
      }
    }
  }

  validateChangedFiles(parsed.candidateChangedFiles, reasons);

  const trustedRules = parsed.trustedGovernancePathRules;
  if (!isStringRuleList(trustedRules)) {
    reasons.push("baseline_trusted_governance_path_rules");
  } else if (trustedRules.some((rule) => !isSupportedRule(rule))) {
    reasons.push("baseline_trusted_governance_path_rule_unsupported");
  }
  validateFileManifest(
    parsed.trustedGovernanceFiles,
    "baseline_trusted_governance",
    reasons,
  );

  if (reasons.length > 0) {
    return {
      ok: false,
      baseline: null,
      reasons: unique(reasons),
    };
  }

  return {
    ok: true,
    baseline: parsed,
    reasons: [],
  };
}

function rejectUnknownFields(value, allowed, reason, reasons) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      reasons.push(reason);
    }
  }
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

function validateChangedFiles(files, reasons) {
  if (!Array.isArray(files) || files.length === 0) {
    reasons.push("baseline_candidate_changed_files");
    return;
  }
  const seen = new Set();
  for (const item of files) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      reasons.push("baseline_candidate_changed_file_entry");
      continue;
    }
    rejectUnknownFields(item, CHANGE_FIELDS, "baseline_candidate_changed_file_unknown_field", reasons);
    if (!isSafeGitPath(item.path)) reasons.push("baseline_candidate_changed_file_path");
    if (seen.has(item.path)) reasons.push("baseline_candidate_changed_file_duplicate_path");
    seen.add(item.path);
    if (!CHANGE_TYPES.has(item.change)) reasons.push("baseline_candidate_change_type");
    if (item.change === "added" && item.base !== null) reasons.push("baseline_candidate_change_base");
    if (item.change === "deleted" && item.head !== null) reasons.push("baseline_candidate_change_head");
    if (item.change !== "added") validateSnapshot(item.base, "base", reasons);
    if (item.change !== "deleted") validateSnapshot(item.head, "head", reasons);
  }
}

function validateSnapshot(snapshot, side, reasons) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    reasons.push(`baseline_candidate_${side}_snapshot`);
    return;
  }
  rejectUnknownFields(snapshot, new Set(["mode", "objectType", "blobSha", "sha256"]), `baseline_candidate_${side}_unknown_field`, reasons);
  if (!ALLOWED_BLOB_MODES.has(snapshot.mode)) reasons.push(`baseline_candidate_${side}_mode`);
  if (snapshot.objectType !== "blob") reasons.push(`baseline_candidate_${side}_type`);
  if (!GIT_SHA1_RE.test(snapshot.blobSha ?? "")) reasons.push(`baseline_candidate_${side}_blob_sha`);
  if (!GIT_SHA256_RE.test(snapshot.sha256 ?? "")) reasons.push(`baseline_candidate_${side}_sha256`);
}

function failParse(reason, reasons) {
  reasons.push(reason);
  return { ok: false, baseline: null, reasons: unique(reasons) };
}

function isStringRuleList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

function isSupportedRule(rule) {
  if (!isSafeGitPath(rule.replace(/\/\*\*$/, "/x"))) {
    if (rule.endsWith("/**")) {
      const prefix = rule.slice(0, -3);
      return isSafeGitPath(prefix);
    }
    return false;
  }
  if (!rule.includes("*")) {
    return true;
  }
  return rule.endsWith("/**") && !rule.slice(0, -3).includes("*");
}

function unique(items) {
  return [...new Set(items)];
}

export function evaluateTrustedFreeze(input) {
  const reasons = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return result(false, false, ["evaluation_input_invalid"]);
  }

  const baseline = input.baseline;
  if (!baseline || typeof baseline !== "object") {
    return result(false, false, ["baseline_missing"]);
  }

  const sourceHeadSha = input.sourceHeadSha;
  const eventSourceHeadSha = input.eventSourceHeadSha ?? sourceHeadSha;
  const sourceHeadMatchesReviewedCandidate =
    GIT_SHA1_RE.test(sourceHeadSha ?? "") &&
    sourceHeadSha === baseline.currentAcceptedCandidateSourceHead;

  if (!GIT_SHA1_RE.test(sourceHeadSha ?? "")) {
    reasons.push("source_head_sha_invalid");
  }
  if (!GIT_SHA1_RE.test(eventSourceHeadSha ?? "")) {
    reasons.push("event_source_head_sha_invalid");
  }
  if (
    GIT_SHA1_RE.test(sourceHeadSha ?? "") &&
    GIT_SHA1_RE.test(eventSourceHeadSha ?? "") &&
    sourceHeadSha !== eventSourceHeadSha
  ) {
    reasons.push("source_head_event_mismatch");
  }
  if (!sourceHeadMatchesReviewedCandidate) {
    reasons.push("source_head_not_reviewed_candidate");
  }
  if (input.prHeadRef !== baseline.candidateHeadRef) {
    reasons.push("pr_head_ref_mismatch");
  }

  if (input.repositoryFullName !== baseline.repository) {
    reasons.push("repository_identity_mismatch");
  }
  if (input.prHeadRepositoryFullName !== baseline.repository) {
    reasons.push("pr_head_repository_identity_mismatch");
  }

  if (input.ancestorCheckComplete !== true) {
    reasons.push("ancestor_check_incomplete");
  } else if (input.implementationBaseIsAncestor !== true) {
    reasons.push("implementation_base_not_ancestor");
  }

  if (input.baseTreeComplete !== true) {
    reasons.push("base_tree_incomplete");
  }
  if (input.headTreeComplete !== true) {
    reasons.push("head_tree_incomplete");
  }
  if (input.compareFilesIncomplete === true) {
    reasons.push("compare_files_incomplete");
  }

  const treesUsable =
    input.baseTreeComplete === true &&
    input.headTreeComplete === true &&
    Array.isArray(input.baseTree) &&
    Array.isArray(input.headTree);

  const baseIndex = treesUsable ? indexTree(input.baseTree, reasons, "base") : null;
  const headIndex = treesUsable ? indexTree(input.headTree, reasons, "head") : null;

  if (baseIndex && input.observedBaseTreeSha) {
    if (!GIT_SHA1_RE.test(input.observedBaseTreeSha)) {
      reasons.push("observed_base_tree_sha_invalid");
    } else if (input.observedBaseTreeSha !== baseline.acceptedImplementationBaseTreeSha) {
      reasons.push("implementation_base_tree_sha_mismatch");
    }
  }

  if (baseIndex && headIndex) {
    checkProtectedFiles(baseline, headIndex, reasons);
    checkProtectedRuleAdditions(baseline, headIndex, reasons);
    checkCaseCollisions(baseline, headIndex, reasons);
    checkTypeAndModeAttacks(baseline, headIndex, reasons);
    const changedPaths = collectChangedPaths(baseIndex.map, headIndex.map);
    checkExactCandidateManifest(
      baseline,
      changedPaths,
      input.observedBlobSha256ByKey,
      reasons,
    );
    checkProtectedFileSha256(baseline, input.observedBlobSha256ByKey, reasons);
    checkAllowedChangedPaths(baseline, changedPaths, reasons);
    checkRenamesAndCopies(input.compareFiles, baseline, reasons);
    checkVerifierCommitmentCombo(changedPaths, reasons);
    checkContentAnchors(baseline, headIndex, input.headTextByPath, reasons);
  }

  const trustedBaselineIntegrityOk =
    reasons.filter((code) => code !== "source_head_not_reviewed_candidate").length === 0;

  return result(
    trustedBaselineIntegrityOk,
    sourceHeadMatchesReviewedCandidate,
    unique(reasons),
  );
}

function checkExactCandidateManifest(baseline, changed, observedHashes, reasons) {
  const expected = baseline.candidateChangedFiles;
  if (!Array.isArray(expected)) {
    reasons.push("candidate_manifest_missing");
    return;
  }
  const actualByPath = new Map(changed.map((item) => [item.path, item]));
  const expectedByPath = new Map(expected.map((item) => [item.path, item]));
  if (actualByPath.size !== expectedByPath.size) reasons.push("candidate_manifest_path_count_mismatch");
  for (const [path, actual] of actualByPath) {
    const item = expectedByPath.get(path);
    if (!item) {
      reasons.push("candidate_manifest_unexpected_path");
      continue;
    }
    if (item.change !== actual.change) reasons.push("candidate_manifest_change_mismatch");
    checkSnapshotMatch(item.base, actual.base, "base", path, observedHashes, reasons);
    checkSnapshotMatch(item.head, actual.head, "head", path, observedHashes, reasons);
  }
  for (const path of expectedByPath.keys()) {
    if (!actualByPath.has(path)) reasons.push("candidate_manifest_missing_path");
  }
}

function checkSnapshotMatch(expected, actual, side, path, observedHashes, reasons) {
  if (expected === null || actual === undefined) {
    if (!(expected === null && actual === undefined)) reasons.push(`candidate_manifest_${side}_presence_mismatch`);
    return;
  }
  if (!actual || expected.mode !== actual.mode || expected.objectType !== actual.type || expected.blobSha !== actual.sha) {
    reasons.push(`candidate_manifest_${side}_identity_mismatch`);
    return;
  }
  const observed = observedHashes?.[`${side}:${path}`];
  if (observed !== expected.sha256) reasons.push(`candidate_manifest_${side}_sha256_mismatch`);
}

function checkProtectedFileSha256(baseline, observedHashes, reasons) {
  for (const file of baseline.protectedFiles) {
    if (observedHashes?.[`head:${file.path}`] !== file.sha256) {
      reasons.push("protected_file_sha256_mismatch");
    }
  }
}

function result(trustedBaselineIntegrityOk, sourceHeadMatchesReviewedCandidate, reasons) {
  return {
    trustedBaselineIntegrityOk,
    sourceHeadMatchesReviewedCandidate,
    reasons,
  };
}

function indexTree(entries, reasons, label) {
  if (!Array.isArray(entries)) {
    reasons.push(`${label}_tree_missing`);
    return null;
  }
  const map = new Map();
  const caseIndex = new Map();
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
    if (!OBJECT_TYPES.has(entry.type)) {
      reasons.push(`${label}_tree_type_invalid`);
    }
    if (typeof entry.mode !== "string" || typeof entry.sha !== "string") {
      reasons.push(`${label}_tree_entry_fields`);
    }
    // GitHub's recursive tree API includes directory entries. Their tree SHA
    // changes whenever any descendant changes, so they are not candidate file
    // identities and must not participate in the exact file manifest. Blobs
    // (including symlinks) and commit entries (gitlinks) remain indexed and
    // therefore retain the fail-closed type/mode checks below.
    if (entry.type === "tree") {
      continue;
    }
    map.set(entry.path, entry);
    const lower = entry.path.toLowerCase();
    if (!caseIndex.has(lower)) {
      caseIndex.set(lower, []);
    }
    caseIndex.get(lower).push(entry.path);
  }
  return { map, caseIndex };
}

function checkProtectedFiles(baseline, headIndex, reasons) {
  for (const file of baseline.protectedFiles) {
    const head = headIndex.map.get(file.path);
    if (!head) {
      reasons.push("protected_file_deleted");
      const variant = caseVariant(headIndex, file.path);
      if (variant) {
        reasons.push("protected_file_case_rename");
      }
      continue;
    }
    if (head.type !== file.objectType) {
      reasons.push("protected_file_type_change");
    }
    if (head.mode !== file.mode) {
      reasons.push("protected_file_mode_change");
    }
    if (head.sha !== file.blobSha) {
      reasons.push("protected_file_blob_mismatch");
    }
    if (head.type === "blob" && head.mode === "120000") {
      reasons.push("protected_file_symlink");
    }
    if (head.type === "commit" || head.mode === "160000") {
      reasons.push("protected_file_gitlink");
    }
  }
}

function checkProtectedRuleAdditions(baseline, headIndex, reasons) {
  const known = new Set(baseline.protectedFiles.map((file) => file.path));
  for (const path of headIndex.map.keys()) {
    if (!pathMatchesAnyRule(path, baseline.protectedPathRules)) {
      continue;
    }
    if (!known.has(path)) {
      reasons.push("protected_path_added");
    }
  }
}

function checkCaseCollisions(baseline, headIndex, reasons) {
  for (const [lower, paths] of headIndex.caseIndex.entries()) {
    if (paths.length > 1) {
      const touchesProtected = paths.some(
        (path) =>
          pathMatchesAnyRule(path, baseline.protectedPathRules) ||
          baseline.protectedFiles.some((file) => file.path.toLowerCase() === lower),
      );
      if (touchesProtected) {
        reasons.push("protected_path_case_collision");
      }
    }
  }
}

function caseVariant(headIndex, path) {
  const paths = headIndex.caseIndex.get(path.toLowerCase()) ?? [];
  return paths.find((item) => item !== path) ?? null;
}

function checkTypeAndModeAttacks(baseline, headIndex, reasons) {
  for (const file of baseline.protectedFiles) {
    const head = headIndex.map.get(file.path);
    if (!head) {
      continue;
    }
    if (head.mode === "120000" && file.mode !== "120000") {
      reasons.push("protected_file_symlink");
    }
    if (head.mode === "160000" || head.type === "commit") {
      reasons.push("protected_file_gitlink");
    }
  }
}

function collectChangedPaths(baseMap, headMap) {
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const changed = [];
  for (const path of paths) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    if (!base && head) {
      changed.push({ path, change: "added", base, head });
      continue;
    }
    if (base && !head) {
      changed.push({ path, change: "deleted", base, head });
      continue;
    }
    if (
      base.sha !== head.sha ||
      base.mode !== head.mode ||
      base.type !== head.type
    ) {
      changed.push({ path, change: "modified", base, head });
    }
  }
  return changed;
}

function checkAllowedChangedPaths(baseline, changed, reasons) {
  for (const item of changed) {
    if (item.path === TRUSTED_BASELINE_PATH || item.path.startsWith(".github/trusted/")) {
      reasons.push("trusted_baseline_modified");
    }
    const protectedHit =
      pathMatchesAnyRule(item.path, baseline.protectedPathRules) ||
      baseline.protectedFiles.some((file) => file.path === item.path);
    if (protectedHit) {
      if (item.change === "deleted") {
        reasons.push("protected_file_deleted");
      } else if (item.change === "added") {
        reasons.push("protected_path_added");
      } else {
        reasons.push("protected_file_modified");
      }
      continue;
    }
    if (!pathMatchesAnyRule(item.path, baseline.allowedEvidenceOnlyChangedPathRules)) {
      reasons.push("unallowed_path_changed");
    }
  }
}

function checkRenamesAndCopies(compareFiles, baseline, reasons) {
  if (!Array.isArray(compareFiles)) {
    return;
  }
  for (const file of compareFiles) {
    if (!file || typeof file !== "object") {
      reasons.push("compare_file_entry_invalid");
      continue;
    }
    const status = file.status;
    const filename = file.filename;
    const previous = file.previous_filename;
    const touchesProtected =
      (typeof filename === "string" &&
        (pathMatchesAnyRule(filename, baseline.protectedPathRules) ||
          baseline.protectedFiles.some((item) => item.path === filename))) ||
      (typeof previous === "string" &&
        (pathMatchesAnyRule(previous, baseline.protectedPathRules) ||
          baseline.protectedFiles.some((item) => item.path === previous)));
    if (!touchesProtected) {
      continue;
    }
    if (status === "renamed") {
      reasons.push("protected_file_renamed");
    }
    if (status === "copied") {
      reasons.push("protected_file_copied");
    }
  }
}

function checkVerifierCommitmentCombo(changed, reasons) {
  const paths = changed.map((item) => item.path);
  const verifierChanged = paths.some(
    (path) =>
      path === TRUSTED_WORKFLOW_PATH || path.startsWith("scripts/governance/"),
  );
  const commitmentChanged = paths.some(
    (path) => path === TRUSTED_BASELINE_PATH || path.startsWith(".github/trusted/"),
  );
  if (verifierChanged && commitmentChanged) {
    reasons.push("verifier_and_commitment_changed");
  }
}

function checkContentAnchors(baseline, headIndex, headTextByPath, reasons) {
  for (const anchor of baseline.protectedContentAnchors) {
    const head = headIndex.map.get(anchor.path);
    if (!head) {
      reasons.push("anchor_file_missing");
      continue;
    }
    if (head.type !== "blob" || head.mode === "120000" || head.mode === "160000") {
      reasons.push("anchor_file_type_change");
      continue;
    }
    if (!headTextByPath || typeof headTextByPath[anchor.path] !== "string") {
      reasons.push("anchor_content_unavailable");
      continue;
    }
    const markdown = headTextByPath[anchor.path];
    const extracted = extractFrozenRiskNumericContractDetailed(markdown);
    if (!extracted.ok) {
      reasons.push(extracted.reason);
      continue;
    }
    const body = extracted.body;
    if (sha256Text(body) !== anchor.sha256) {
      reasons.push("anchor_sha256_mismatch");
    }
    for (const required of anchor.requiredSubstrings) {
      if (!body.includes(required)) {
        reasons.push("anchor_required_substring_missing");
      }
    }
  }
}

export function formatMachineSummary(evaluation) {
  const integrity = evaluation.trustedBaselineIntegrityOk ? "true" : "false";
  const match = evaluation.sourceHeadMatchesReviewedCandidate ? "true" : "false";
  const reasonLine = evaluation.reasons.join(",");
  return [
    `trustedBaselineIntegrityOk=${integrity}`,
    `sourceHeadMatchesReviewedCandidate=${match}`,
    `reasonCodes=${reasonLine}`,
  ].join("\n");
}

export function summaryContainsForbiddenDecisionWording(text) {
  if (typeof text !== "string") {
    return false;
  }
  return (
    /\b(ACCEPT|PASS)\b/.test(text) ||
    /release approval|merge approval|Gate 2 approval/i.test(text)
  );
}
