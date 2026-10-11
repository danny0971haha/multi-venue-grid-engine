#!/usr/bin/env node
/**
 * Strict parser/evaluator for the repository governance policy.
 * Unknown fields, unknown profiles, and unsatisfiable bootstrap values fail closed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { GIT_SHA1_RE } from "./phase2d-trusted-freeze-lib.mjs";

export const POLICY_SCHEMA_VERSION = "multi-venue-repository-governance-policy/1";
export const POLICY_PATH = ".github/trusted/repository-governance-policy.json";
export const POLICY_DOCS_PATH = "docs/TRUSTED_PHASE2D_REVIEW_BOUNDARY.md";
export const REPOSITORY = "danny0971haha/multi-venue-grid-engine";
export const FROZEN_PHASE2_CANDIDATE_HEAD = "7f196d367e39640eee9517f742b0d61424f9d4cc";
export const ACCEPTED_PHASE1_HEAD = "057732cee021889d17573425ee4f24e2065df1e9";
export const ACCEPTED_PHASE0_HEAD = "ee0c25664f14ea8ef7e68d070d46e544c3c93ee4";
export const INTEGRATION_ORDER = Object.freeze(["PR1", "PR2", "PR4", "RETARGET_PR3"]);
export const REQUIRED_STATUS_CHECKS = Object.freeze([
  "trusted-phase2d-freeze-gate",
  "Clean install, static checks, tests, secret scan, and dry-run",
]);
export const GOVERNANCE_SELF_TEST_CONTEXT = "trusted-governance-self-test";
export const ACTIVE_PROFILE = "SOLO_OWNER_BOOTSTRAP";
export const FUTURE_PROFILE = "STRICT_MULTI_REVIEWER";
export const KNOWN_PROFILES = Object.freeze([ACTIVE_PROFILE, FUTURE_PROFILE]);

export const SOLO_OWNER_BOOTSTRAP_EFFECTIVE = Object.freeze({
  requiredApprovingReviewCount: 0,
  requireCodeOwnerReview: false,
  requireLastPushApproval: false,
  strictRequiredStatusChecks: false,
  requireConversationResolution: true,
  blockForcePushes: true,
  blockDeletions: true,
  allowDirectMainPush: false,
  rulesetWorkflowRequired: false,
  globallyRequiredGovernanceSelfTest: false,
  liveExchangeWriteAuthorized: false,
  deploymentAuthorized: false,
  mergeMethod: "merge",
});

export const STRICT_MULTI_REVIEWER_DEFINED = Object.freeze({
  requiredApprovingReviewCount: 2,
  requireCodeOwnerReview: true,
  requireLastPushApproval: true,
  dismissStaleReviews: true,
  strictRequiredStatusChecks: true,
  requireConversationResolution: true,
  blockForcePushes: true,
  blockDeletions: true,
  allowDirectMainPush: false,
  rulesetWorkflowRequired: false,
  globallyRequiredGovernanceSelfTest: false,
  liveExchangeWriteAuthorized: false,
  deploymentAuthorized: false,
  mergeMethod: "merge",
});

export const STRICT_ACTIVATION_PREREQUISITES = Object.freeze({
  independentEligibleCollaboratorsAtLeast: 2,
  sameOwnerMultipleAccountsCountAsIndependent: false,
  placeholderReviewerAccountsAllowed: false,
  frozenPhase2BootstrapCompleted: true,
});

export const SOLO_OWNER_BOOTSTRAP_OBSERVED = Object.freeze({
  phase2CandidateMerged: false,
  independentEligibleCollaboratorCount: 1,
  sameOwnerMultipleAccountsCountedAsIndependent: false,
});

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "repository",
  "activeProfile",
  "postBootstrapTargetProfile",
  "frozenPhase2CandidateHead",
  "acceptedPhase1Head",
  "acceptedPhase0Head",
  "mergeMethod",
  "integrationOrder",
  "requiredStatusChecks",
  "globallyRequiredGovernanceSelfTest",
  "rulesetWorkflowRequired",
  "requiredApprovingReviewCount",
  "requireCodeOwnerReview",
  "requireLastPushApproval",
  "strictRequiredStatusChecks",
  "requireConversationResolution",
  "blockForcePushes",
  "blockDeletions",
  "allowDirectMainPush",
  "liveExchangeWriteAuthorized",
  "deploymentAuthorized",
  "profiles",
]);

const SOLO_PROFILE_FIELDS = new Set([
  "requiredApprovingReviewCount",
  "requireCodeOwnerReview",
  "requireLastPushApproval",
  "strictRequiredStatusChecks",
  "requireConversationResolution",
  "blockForcePushes",
  "blockDeletions",
  "allowDirectMainPush",
  "rulesetWorkflowRequired",
  "globallyRequiredGovernanceSelfTest",
  "mergeMethod",
  "requiredStatusChecks",
  "liveExchangeWriteAuthorized",
  "deploymentAuthorized",
]);

const STRICT_PROFILE_FIELDS = new Set([
  ...SOLO_PROFILE_FIELDS,
  "dismissStaleReviews",
  "activationPrerequisites",
]);

const PREREQUISITE_FIELDS = new Set([
  "independentEligibleCollaboratorsAtLeast",
  "sameOwnerMultipleAccountsCountAsIndependent",
  "placeholderReviewerAccountsAllowed",
  "frozenPhase2BootstrapCompleted",
]);

const DOC_BINDING_KEYS = Object.freeze([
  "activeProfile",
  "postBootstrapTargetProfile",
  "requiredApprovingReviewCount",
  "requireCodeOwnerReview",
  "requireLastPushApproval",
  "strictRequiredStatusChecks",
  "rulesetWorkflowRequired",
  "globallyRequiredGovernanceSelfTest",
  "requireConversationResolution",
  "blockForcePushes",
  "blockDeletions",
  "allowDirectMainPush",
  "liveExchangeWriteAuthorized",
  "deploymentAuthorized",
  "mergeMethod",
  "integrationOrder",
  "frozenPhase2CandidateHead",
  "acceptedPhase1Head",
  "acceptedPhase0Head",
  "requiredStatusCheck1",
  "requiredStatusCheck2",
]);

export function parseRepositoryGovernancePolicy(jsonText) {
  const reasons = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return failParse("policy_malformed_json", reasons);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failParse("policy_not_object", reasons);
  }

  rejectUnknownFields(parsed, ROOT_FIELDS, "policy_unknown_field", reasons);
  if (parsed.schemaVersion !== POLICY_SCHEMA_VERSION) reasons.push("policy_schema_version");
  if (parsed.repository !== REPOSITORY) reasons.push("policy_repository");
  if (!KNOWN_PROFILES.includes(parsed.activeProfile)) reasons.push("policy_unknown_profile");
  if (parsed.postBootstrapTargetProfile !== FUTURE_PROFILE) {
    reasons.push("policy_post_bootstrap_target_profile");
  }
  if (parsed.frozenPhase2CandidateHead !== FROZEN_PHASE2_CANDIDATE_HEAD) {
    reasons.push("policy_frozen_phase2_candidate_head");
  }
  if (parsed.acceptedPhase1Head !== ACCEPTED_PHASE1_HEAD)
    reasons.push("policy_accepted_phase1_head");
  if (parsed.acceptedPhase0Head !== ACCEPTED_PHASE0_HEAD)
    reasons.push("policy_accepted_phase0_head");
  if (!GIT_SHA1_RE.test(parsed.frozenPhase2CandidateHead ?? "")) {
    reasons.push("policy_frozen_phase2_candidate_head_sha");
  }
  if (!GIT_SHA1_RE.test(parsed.acceptedPhase1Head ?? ""))
    reasons.push("policy_accepted_phase1_head_sha");
  if (!GIT_SHA1_RE.test(parsed.acceptedPhase0Head ?? ""))
    reasons.push("policy_accepted_phase0_head_sha");

  validateRequiredStatusChecks(parsed.requiredStatusChecks, "policy", reasons);
  if (!Array.isArray(parsed.integrationOrder)) {
    reasons.push("policy_integration_order");
  } else if (!sameStringList(parsed.integrationOrder, INTEGRATION_ORDER)) {
    reasons.push("policy_integration_order");
  }

  validateBoolean(parsed, "globallyRequiredGovernanceSelfTest", reasons, "policy_");
  validateBoolean(parsed, "rulesetWorkflowRequired", reasons, "policy_");
  validateBoolean(parsed, "requireCodeOwnerReview", reasons, "policy_");
  validateBoolean(parsed, "requireLastPushApproval", reasons, "policy_");
  validateBoolean(parsed, "strictRequiredStatusChecks", reasons, "policy_");
  validateBoolean(parsed, "requireConversationResolution", reasons, "policy_");
  validateBoolean(parsed, "blockForcePushes", reasons, "policy_");
  validateBoolean(parsed, "blockDeletions", reasons, "policy_");
  validateBoolean(parsed, "allowDirectMainPush", reasons, "policy_");
  validateBoolean(parsed, "liveExchangeWriteAuthorized", reasons, "policy_");
  validateBoolean(parsed, "deploymentAuthorized", reasons, "policy_");
  if (!Number.isInteger(parsed.requiredApprovingReviewCount)) {
    reasons.push("policy_required_approving_review_count");
  }
  if (
    parsed.mergeMethod !== "merge" &&
    parsed.mergeMethod !== "squash" &&
    parsed.mergeMethod !== "rebase"
  ) {
    reasons.push("policy_merge_method");
  }

  const profiles = parsed.profiles;
  if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles)) {
    reasons.push("policy_profiles");
  } else {
    for (const name of Object.keys(profiles)) {
      if (!KNOWN_PROFILES.includes(name)) reasons.push("policy_unknown_profile");
    }
    if (!Object.hasOwn(profiles, ACTIVE_PROFILE)) reasons.push("policy_solo_profile_missing");
    if (!Object.hasOwn(profiles, FUTURE_PROFILE)) reasons.push("policy_strict_profile_missing");
    if (Object.hasOwn(profiles, ACTIVE_PROFILE)) {
      validateSoloProfile(profiles[ACTIVE_PROFILE], reasons);
    }
    if (Object.hasOwn(profiles, FUTURE_PROFILE)) {
      validateStrictProfile(profiles[FUTURE_PROFILE], reasons);
    }
  }

  if (parsed.activeProfile === ACTIVE_PROFILE) {
    validateSoloEffective(parsed, "policy_solo_", reasons);
    if (
      profiles &&
      typeof profiles === "object" &&
      !Array.isArray(profiles) &&
      profiles[ACTIVE_PROFILE]
    ) {
      assertRootMatchesProfile(parsed, profiles[ACTIVE_PROFILE], reasons);
    }
  }

  if (parsed.activeProfile === FUTURE_PROFILE) {
    validateStrictActiveRoot(parsed, reasons);
    if (
      profiles &&
      typeof profiles === "object" &&
      !Array.isArray(profiles) &&
      profiles[FUTURE_PROFILE]
    ) {
      assertRootMatchesStrictProfile(parsed, profiles[FUTURE_PROFILE], reasons);
    }
  }

  if (reasons.length > 0) {
    return { ok: false, policy: null, reasons: unique(reasons) };
  }
  return { ok: true, policy: parsed, reasons: [] };
}

export function evaluateRepositoryGovernancePolicy(
  policy,
  observed = SOLO_OWNER_BOOTSTRAP_OBSERVED,
) {
  const reasons = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return { ok: false, reasons: ["policy_evaluation_input_invalid"] };
  }
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    return { ok: false, reasons: ["policy_observed_input_invalid"] };
  }

  if (policy.strictRequiredStatusChecks === true && observed.phase2CandidateMerged !== true) {
    reasons.push("strict_up_to_date_while_phase2_unmerged");
  }
  if (policy.activeProfile === FUTURE_PROFILE) {
    const collaborators = observed.independentEligibleCollaboratorCount;
    if (!Number.isInteger(collaborators) || collaborators < 2) {
      reasons.push("strict_profile_prerequisites_unsatisfied");
    }
    if (observed.sameOwnerMultipleAccountsCountedAsIndependent === true) {
      reasons.push("strict_profile_same_owner_accounts_not_independent");
    }
    if (observed.phase2CandidateMerged !== true) {
      reasons.push("strict_profile_prerequisites_unsatisfied");
    }
  }
  if (policy.liveExchangeWriteAuthorized === true)
    reasons.push("policy_live_exchange_write_authorized");
  if (policy.deploymentAuthorized === true) reasons.push("policy_deployment_authorized");

  return { ok: reasons.length === 0, reasons: unique(reasons) };
}

export function extractDocGovernanceBindings(markdown) {
  if (typeof markdown !== "string") {
    return { ok: false, bindings: null, reasons: ["docs_unavailable"] };
  }
  const start = markdown.indexOf("```text\nMACHINE_POLICY_BINDINGS");
  const end = markdown.indexOf("```", start + 1);
  if (start < 0 || end < 0) {
    return { ok: false, bindings: null, reasons: ["docs_machine_bindings_missing"] };
  }
  const block = markdown.slice(start, end);
  const bindings = {};
  const reasons = [];
  for (const line of block.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (DOC_BINDING_KEYS.includes(key)) bindings[key] = value;
  }
  for (const key of DOC_BINDING_KEYS) {
    if (typeof bindings[key] !== "string") reasons.push(`docs_binding_missing_${key}`);
  }
  return { ok: reasons.length === 0, bindings, reasons };
}

export function comparePolicyToDocs(policy, markdown) {
  const reasons = [];
  const extracted = extractDocGovernanceBindings(markdown);
  if (!extracted.ok) return { ok: false, reasons: extracted.reasons };
  const bindings = extracted.bindings;
  const expected = {
    activeProfile: policy.activeProfile,
    postBootstrapTargetProfile: policy.postBootstrapTargetProfile,
    requiredApprovingReviewCount: String(policy.requiredApprovingReviewCount),
    requireCodeOwnerReview: String(policy.requireCodeOwnerReview),
    requireLastPushApproval: String(policy.requireLastPushApproval),
    strictRequiredStatusChecks: String(policy.strictRequiredStatusChecks),
    rulesetWorkflowRequired: String(policy.rulesetWorkflowRequired),
    globallyRequiredGovernanceSelfTest: String(policy.globallyRequiredGovernanceSelfTest),
    requireConversationResolution: String(policy.requireConversationResolution),
    blockForcePushes: String(policy.blockForcePushes),
    blockDeletions: String(policy.blockDeletions),
    allowDirectMainPush: String(policy.allowDirectMainPush),
    liveExchangeWriteAuthorized: String(policy.liveExchangeWriteAuthorized),
    deploymentAuthorized: String(policy.deploymentAuthorized),
    mergeMethod: policy.mergeMethod,
    integrationOrder: policy.integrationOrder.join("->"),
    frozenPhase2CandidateHead: policy.frozenPhase2CandidateHead,
    acceptedPhase1Head: policy.acceptedPhase1Head,
    acceptedPhase0Head: policy.acceptedPhase0Head,
    requiredStatusCheck1: policy.requiredStatusChecks[0],
    requiredStatusCheck2: policy.requiredStatusChecks[1],
  };
  for (const [key, value] of Object.entries(expected)) {
    if (bindings[key] !== value) reasons.push(`docs_policy_mismatch_${key}`);
  }

  const forbiddenCurrentClaims = [
    "Required approvals: at least 2 independent reviewers.",
    "Require branches to be up to date before merging.",
    "ruleset required workflow from `refs/heads/main` is required",
    "trusted-governance-self-test` as a globally required status",
    "Code Owner approval can be supplied by the current PR author",
    "Phase 2 candidate must be updated after governance reaches main",
  ];
  for (const claim of forbiddenCurrentClaims) {
    if (markdown.includes(claim)) reasons.push("docs_forbidden_current_claim");
  }
  if (!markdown.includes("ACTIVE: SOLO_OWNER_BOOTSTRAP"))
    reasons.push("docs_active_profile_section_missing");
  if (!markdown.includes("FUTURE: STRICT_MULTI_REVIEWER"))
    reasons.push("docs_future_profile_section_missing");
  if (!markdown.includes("does not provide independent human separation of duties")) {
    reasons.push("docs_reduced_assurance_missing");
  }
  for (const step of ["STEP 1", "STEP 2", "STEP 3", "STEP 4", "STEP 5", "STEP 6", "STEP 7"]) {
    if (!markdown.includes(step)) reasons.push("docs_bootstrap_step_missing");
  }
  return { ok: reasons.length === 0, reasons: unique(reasons) };
}

export function loadCommittedRepositoryGovernancePolicy(repoRoot) {
  const jsonText = readFileSync(path.join(repoRoot, POLICY_PATH), "utf8");
  return parseRepositoryGovernancePolicy(jsonText);
}

function validateSoloEffective(value, prefix, reasons) {
  for (const [key, expected] of Object.entries(SOLO_OWNER_BOOTSTRAP_EFFECTIVE)) {
    if (value[key] !== expected) reasons.push(`${prefix}${camelToReason(key)}`);
  }
  if (value.globallyRequiredGovernanceSelfTest === true) {
    reasons.push(`${prefix}globally_required_governance_self_test`);
  }
  if (
    Array.isArray(value.requiredStatusChecks) &&
    value.requiredStatusChecks.includes(GOVERNANCE_SELF_TEST_CONTEXT)
  ) {
    reasons.push(`${prefix}governance_self_test_in_required_checks`);
  }
}

function validateStrictActiveRoot(value, reasons) {
  for (const [key, expected] of Object.entries(STRICT_MULTI_REVIEWER_DEFINED)) {
    if (key === "dismissStaleReviews") continue;
    if (value[key] !== expected) reasons.push(`policy_strict_active_${camelToReason(key)}`);
  }
  if (
    Array.isArray(value.requiredStatusChecks) &&
    value.requiredStatusChecks.includes(GOVERNANCE_SELF_TEST_CONTEXT)
  ) {
    reasons.push("policy_strict_active_governance_self_test_in_required_checks");
  }
}

function assertRootMatchesStrictProfile(root, profile, reasons) {
  for (const key of SOLO_PROFILE_FIELDS) {
    if (key === "requiredStatusChecks") {
      if (!sameStringList(root.requiredStatusChecks, profile.requiredStatusChecks)) {
        reasons.push("policy_root_profile_drift");
      }
      continue;
    }
    if (root[key] !== profile[key]) reasons.push("policy_root_profile_drift");
  }
}

function validateSoloProfile(profile, reasons) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    reasons.push("policy_solo_profile_entry");
    return;
  }
  rejectUnknownFields(profile, SOLO_PROFILE_FIELDS, "policy_solo_profile_unknown_field", reasons);
  validateSoloEffective(profile, "policy_solo_profile_", reasons);
  validateRequiredStatusChecks(profile.requiredStatusChecks, "policy_solo_profile", reasons);
}

function validateStrictProfile(profile, reasons) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    reasons.push("policy_strict_profile_entry");
    return;
  }
  rejectUnknownFields(
    profile,
    STRICT_PROFILE_FIELDS,
    "policy_strict_profile_unknown_field",
    reasons,
  );
  for (const [key, expected] of Object.entries(STRICT_MULTI_REVIEWER_DEFINED)) {
    if (profile[key] !== expected) reasons.push(`policy_strict_profile_${camelToReason(key)}`);
  }
  validateRequiredStatusChecks(profile.requiredStatusChecks, "policy_strict_profile", reasons);
  if (
    Array.isArray(profile.requiredStatusChecks) &&
    profile.requiredStatusChecks.includes(GOVERNANCE_SELF_TEST_CONTEXT)
  ) {
    reasons.push("policy_strict_profile_governance_self_test_in_required_checks");
  }
  const prerequisites = profile.activationPrerequisites;
  if (prerequisites === null || typeof prerequisites !== "object" || Array.isArray(prerequisites)) {
    reasons.push("policy_strict_profile_prerequisites");
    return;
  }
  rejectUnknownFields(
    prerequisites,
    PREREQUISITE_FIELDS,
    "policy_strict_prerequisite_unknown_field",
    reasons,
  );
  for (const [key, expected] of Object.entries(STRICT_ACTIVATION_PREREQUISITES)) {
    if (prerequisites[key] !== expected)
      reasons.push(`policy_strict_prerequisite_${camelToReason(key)}`);
  }
}

function validateRequiredStatusChecks(checks, prefix, reasons) {
  if (!Array.isArray(checks)) {
    reasons.push(`${prefix}_required_status_checks`);
    return;
  }
  if (checks.length === 0) {
    reasons.push(`${prefix}_required_status_checks_empty`);
    return;
  }
  const seen = new Set();
  for (const item of checks) {
    if (typeof item !== "string" || item.length === 0) {
      reasons.push(`${prefix}_required_status_check_entry`);
      continue;
    }
    if (seen.has(item)) reasons.push(`${prefix}_required_status_checks_duplicate`);
    seen.add(item);
    if (item === GOVERNANCE_SELF_TEST_CONTEXT) {
      reasons.push(`${prefix}_governance_self_test_in_required_checks`);
    }
  }
  if (!sameStringList(checks, REQUIRED_STATUS_CHECKS)) {
    reasons.push(`${prefix}_required_status_checks`);
  }
}

function assertRootMatchesProfile(root, profile, reasons) {
  for (const key of SOLO_PROFILE_FIELDS) {
    if (key === "requiredStatusChecks") {
      if (!sameStringList(root.requiredStatusChecks, profile.requiredStatusChecks)) {
        reasons.push("policy_root_profile_drift");
      }
      continue;
    }
    if (root[key] !== profile[key]) reasons.push("policy_root_profile_drift");
  }
}

function validateBoolean(object, key, reasons, prefix) {
  if (typeof object[key] !== "boolean") reasons.push(`${prefix}${camelToReason(key)}`);
}

function rejectUnknownFields(value, allowed, reason, reasons) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reasons.push(reason);
  }
}

function sameStringList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index])
  );
}

function camelToReason(key) {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function unique(items) {
  return [...new Set(items)];
}

function failParse(reason, reasons) {
  reasons.push(reason);
  return { ok: false, policy: null, reasons: unique(reasons) };
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = loadCommittedRepositoryGovernancePolicy(repoRoot());
  if (!parsed.ok) {
    process.stdout.write(`governancePolicyOk=false\nreasonCodes=${parsed.reasons.join(",")}\n`);
    process.exit(1);
  }
  const evaluated = evaluateRepositoryGovernancePolicy(
    parsed.policy,
    SOLO_OWNER_BOOTSTRAP_OBSERVED,
  );
  if (!evaluated.ok) {
    process.stdout.write(`governancePolicyOk=false\nreasonCodes=${evaluated.reasons.join(",")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    [
      "governancePolicyOk=true",
      `activeProfile=${parsed.policy.activeProfile}`,
      `postBootstrapTargetProfile=${parsed.policy.postBootstrapTargetProfile}`,
      `rulesetWorkflowRequired=${parsed.policy.rulesetWorkflowRequired}`,
      `globallyRequiredGovernanceSelfTest=${parsed.policy.globallyRequiredGovernanceSelfTest}`,
      `strictRequiredStatusChecks=${parsed.policy.strictRequiredStatusChecks}`,
    ].join("\n") + "\n",
  );
  process.exit(0);
}
