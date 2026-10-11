import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyGate } from "./phase2d-trusted-gate.mjs";
import {
  evaluateTrustedFreeze,
  parseBaseline,
  TRUSTED_BASELINE_PATH,
} from "./phase2d-trusted-freeze-lib.mjs";
import {
  ACTIVE_PROFILE,
  FROZEN_PHASE2_CANDIDATE_HEAD,
  FUTURE_PROFILE,
  GOVERNANCE_SELF_TEST_CONTEXT,
  INTEGRATION_ORDER,
  POLICY_DOCS_PATH,
  POLICY_PATH,
  POLICY_SCHEMA_VERSION,
  REQUIRED_STATUS_CHECKS,
  SOLO_OWNER_BOOTSTRAP_EFFECTIVE,
  SOLO_OWNER_BOOTSTRAP_OBSERVED,
  comparePolicyToDocs,
  evaluateRepositoryGovernancePolicy,
  loadCommittedRepositoryGovernancePolicy,
  parseRepositoryGovernancePolicy,
} from "./repository-governance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(root, "scripts", "governance", "fixtures", "policy");
const negativeDir = path.join(fixtureDir, "negative");

function committedPolicyText() {
  return readFileSync(path.join(root, POLICY_PATH), "utf8");
}

function cloneCommittedPolicy() {
  return JSON.parse(committedPolicyText());
}

function parseMutated(mutator) {
  const value = cloneCommittedPolicy();
  mutator(value);
  return parseRepositoryGovernancePolicy(JSON.stringify(value));
}

describe("repository governance policy parser positive fixtures", () => {
  it("accepts the committed SOLO_OWNER_BOOTSTRAP policy", () => {
    const parsed = loadCommittedRepositoryGovernancePolicy(root);
    assert.equal(parsed.ok, true, parsed.reasons.join(","));
    assert.equal(parsed.policy.schemaVersion, POLICY_SCHEMA_VERSION);
    assert.equal(parsed.policy.activeProfile, ACTIVE_PROFILE);
    assert.equal(parsed.policy.postBootstrapTargetProfile, FUTURE_PROFILE);
    assert.deepEqual(parsed.policy.integrationOrder, [...INTEGRATION_ORDER]);
    assert.deepEqual(parsed.policy.requiredStatusChecks, [...REQUIRED_STATUS_CHECKS]);
    assert.equal(parsed.policy.frozenPhase2CandidateHead, FROZEN_PHASE2_CANDIDATE_HEAD);
    for (const [key, expected] of Object.entries(SOLO_OWNER_BOOTSTRAP_EFFECTIVE)) {
      assert.equal(parsed.policy[key], expected, key);
    }
    const evaluated = evaluateRepositoryGovernancePolicy(
      parsed.policy,
      SOLO_OWNER_BOOTSTRAP_OBSERVED,
    );
    assert.equal(evaluated.ok, true, evaluated.reasons.join(","));
  });

  it("accepts the positive fixture copy of the committed policy", () => {
    const text = readFileSync(path.join(fixtureDir, "positive-solo-owner-bootstrap.json"), "utf8");
    const parsed = parseRepositoryGovernancePolicy(text);
    assert.equal(parsed.ok, true, parsed.reasons.join(","));
  });
});

describe("repository governance policy parser negative fixtures", () => {
  it("rejects malformed JSON", () => {
    const parsed = parseRepositoryGovernancePolicy("{");
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_malformed_json"));
  });

  it("rejects every committed negative fixture", () => {
    const files = readdirSync(negativeDir).filter(
      (name) => name.endsWith(".json") || name.endsWith(".json.txt"),
    );
    assert.ok(files.length >= 15, "expected dedicated negative fixtures");
    for (const name of files) {
      const text = readFileSync(path.join(negativeDir, name), "utf8");
      const parsed = parseRepositoryGovernancePolicy(text);
      if (name === "strict-active.json") {
        assert.equal(parsed.ok, true, `${name} should parse so evaluation can reject it`);
        const evaluated = evaluateRepositoryGovernancePolicy(
          parsed.policy,
          SOLO_OWNER_BOOTSTRAP_OBSERVED,
        );
        assert.equal(evaluated.ok, false, name);
        assert.ok(evaluated.reasons.includes("strict_profile_prerequisites_unsatisfied"));
        assert.ok(evaluated.reasons.includes("strict_up_to_date_while_phase2_unmerged"));
        continue;
      }
      assert.equal(parsed.ok, false, name);
    }
  });

  it("rejects unknown root fields", () => {
    const parsed = parseMutated((value) => {
      value.unexpectedReviewers = ["alice"];
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_unknown_field"));
  });

  it("rejects unknown profile names", () => {
    const parsed = parseMutated((value) => {
      value.profiles.PLACEHOLDER_REVIEWER = { requiredApprovingReviewCount: 1 };
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_unknown_profile"));
  });

  it("rejects duplicate required check contexts", () => {
    const parsed = parseMutated((value) => {
      value.requiredStatusChecks = [REQUIRED_STATUS_CHECKS[0], REQUIRED_STATUS_CHECKS[0]];
      value.profiles.SOLO_OWNER_BOOTSTRAP.requiredStatusChecks = value.requiredStatusChecks;
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_required_status_checks_duplicate"));
  });

  it("rejects an empty required check list", () => {
    const parsed = parseMutated((value) => {
      value.requiredStatusChecks = [];
      value.profiles.SOLO_OWNER_BOOTSTRAP.requiredStatusChecks = [];
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_required_status_checks_empty"));
  });

  it("rejects SOLO_OWNER_BOOTSTRAP values that recreate the bootstrap deadlock", () => {
    const cases = [
      [
        (value) => {
          value.requiredApprovingReviewCount = 2;
        },
        "policy_solo_required_approving_review_count",
      ],
      [
        (value) => {
          value.requireCodeOwnerReview = true;
        },
        "policy_solo_require_code_owner_review",
      ],
      [
        (value) => {
          value.requireLastPushApproval = true;
        },
        "policy_solo_require_last_push_approval",
      ],
      [
        (value) => {
          value.strictRequiredStatusChecks = true;
        },
        "policy_solo_strict_required_status_checks",
      ],
      [
        (value) => {
          value.rulesetWorkflowRequired = true;
        },
        "policy_solo_ruleset_workflow_required",
      ],
      [
        (value) => {
          value.globallyRequiredGovernanceSelfTest = true;
        },
        "policy_solo_globally_required_governance_self_test",
      ],
      [
        (value) => {
          value.mergeMethod = "squash";
        },
        "policy_solo_merge_method",
      ],
      [
        (value) => {
          value.frozenPhase2CandidateHead = "a".repeat(40);
        },
        "policy_frozen_phase2_candidate_head",
      ],
      [
        (value) => {
          value.liveExchangeWriteAuthorized = true;
        },
        "policy_solo_live_exchange_write_authorized",
      ],
      [
        (value) => {
          value.deploymentAuthorized = true;
        },
        "policy_solo_deployment_authorized",
      ],
    ];
    for (const [mutator, reason] of cases) {
      const parsed = parseMutated(mutator);
      assert.equal(parsed.ok, false, reason);
      assert.ok(parsed.reasons.includes(reason), `${reason} in ${parsed.reasons.join(",")}`);
    }
  });

  it("rejects trusted-governance-self-test in the global required-check set", () => {
    const parsed = parseMutated((value) => {
      value.requiredStatusChecks = [...REQUIRED_STATUS_CHECKS, GOVERNANCE_SELF_TEST_CONTEXT];
      value.profiles.SOLO_OWNER_BOOTSTRAP.requiredStatusChecks = value.requiredStatusChecks;
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_governance_self_test_in_required_checks"));
    const committed = loadCommittedRepositoryGovernancePolicy(root);
    assert.equal(
      committed.policy.requiredStatusChecks.includes(GOVERNANCE_SELF_TEST_CONTEXT),
      false,
    );
    assert.equal(committed.policy.globallyRequiredGovernanceSelfTest, false);
  });

  it("rejects rulesetWorkflowRequired=true for the active personal-repository profile", () => {
    const parsed = parseMutated((value) => {
      value.rulesetWorkflowRequired = true;
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_solo_ruleset_workflow_required"));
    const committed = loadCommittedRepositoryGovernancePolicy(root);
    assert.equal(committed.policy.rulesetWorkflowRequired, false);
  });

  it("rejects a STRICT_MULTI_REVIEWER profile falsely marked active without prerequisites", () => {
    const value = cloneCommittedPolicy();
    value.activeProfile = FUTURE_PROFILE;
    value.requiredApprovingReviewCount = 2;
    value.requireCodeOwnerReview = true;
    value.requireLastPushApproval = true;
    value.strictRequiredStatusChecks = true;
    const parsed = parseRepositoryGovernancePolicy(JSON.stringify(value));
    assert.equal(parsed.ok, true, parsed.reasons.join(","));
    const evaluated = evaluateRepositoryGovernancePolicy(
      parsed.policy,
      SOLO_OWNER_BOOTSTRAP_OBSERVED,
    );
    assert.equal(evaluated.ok, false);
    assert.ok(evaluated.reasons.includes("strict_profile_prerequisites_unsatisfied"));
  });

  it("rejects the wrong integration order", () => {
    const parsed = parseMutated((value) => {
      value.integrationOrder = ["PR1", "PR2", "RETARGET_PR3", "PR4"];
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_integration_order"));
  });

  it("rejects required checks that differ from the exact approved contexts", () => {
    const parsed = parseMutated((value) => {
      value.requiredStatusChecks = ["trusted-phase2d-freeze-gate", "unit-tests"];
      value.profiles.SOLO_OWNER_BOOTSTRAP.requiredStatusChecks = value.requiredStatusChecks;
    });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.reasons.includes("policy_required_status_checks"));
  });
});

describe("bootstrap sequence vs classifier whitelist", () => {
  it("keeps predecessor src/** PRs ENFORCE and records PR1->PR2->PR4->RETARGET_PR3", () => {
    const gateSource = readFileSync(
      path.join(root, "scripts", "governance", "phase2d-trusted-gate.mjs"),
      "utf8",
    );
    assert.doesNotMatch(gateSource, /experiment\/v0\.1-phase0/);
    assert.doesNotMatch(gateSource, /experiment\/v0\.1-phase1/);
    assert.doesNotMatch(gateSource, /whitelist/);
    assert.doesNotMatch(gateSource, /bypass/);

    const baseline = {
      repository: "danny0971haha/multi-venue-grid-engine",
      candidateHeadRef: "experiment/v0.1-phase2",
      protectedPathRules: ["src/**"],
      allowedEvidenceOnlyChangedPathRules: ["scripts/evidence/**"],
      trustedGovernancePathRules: ["scripts/governance/**"],
    };
    assert.equal(
      classifyGate({
        baseline,
        changedPaths: ["src/index.ts"],
        headRef: "experiment/v0.1-phase0",
        headRepository: baseline.repository,
        baseRepository: baseline.repository,
      }).mode,
      "ENFORCE",
    );
    assert.equal(
      classifyGate({
        baseline,
        changedPaths: ["src/domain/types.ts"],
        headRef: "experiment/v0.1-phase1",
        headRepository: baseline.repository,
        baseRepository: baseline.repository,
      }).mode,
      "ENFORCE",
    );

    const parsed = loadCommittedRepositoryGovernancePolicy(root);
    assert.deepEqual(parsed.policy.integrationOrder, ["PR1", "PR2", "PR4", "RETARGET_PR3"]);
  });

  it("rejects strict up-to-date mode while the exact frozen Phase 2 candidate remains unmerged", () => {
    const solo = parseMutated((value) => {
      value.strictRequiredStatusChecks = true;
    });
    assert.equal(solo.ok, false);
    assert.ok(solo.reasons.includes("policy_solo_strict_required_status_checks"));

    const value = cloneCommittedPolicy();
    value.activeProfile = FUTURE_PROFILE;
    value.requiredApprovingReviewCount = 2;
    value.requireCodeOwnerReview = true;
    value.requireLastPushApproval = true;
    value.strictRequiredStatusChecks = true;
    const parsed = parseRepositoryGovernancePolicy(JSON.stringify(value));
    assert.equal(parsed.ok, true, parsed.reasons.join(","));
    const evaluated = evaluateRepositoryGovernancePolicy(parsed.policy, {
      ...SOLO_OWNER_BOOTSTRAP_OBSERVED,
      phase2CandidateMerged: false,
    });
    assert.equal(evaluated.ok, false);
    assert.ok(evaluated.reasons.includes("strict_up_to_date_while_phase2_unmerged"));
  });
});

describe("docs and machine policy consistency", () => {
  it("does not contradict the committed policy", () => {
    const parsed = loadCommittedRepositoryGovernancePolicy(root);
    const markdown = readFileSync(path.join(root, POLICY_DOCS_PATH), "utf8");
    const compared = comparePolicyToDocs(parsed.policy, markdown);
    assert.equal(compared.ok, true, compared.reasons.join(","));
  });
});

describe("trusted freeze remains fail-closed", () => {
  it("still fails closed when a protected Phase 2 byte changes", () => {
    const jsonText = readFileSync(path.join(root, TRUSTED_BASELINE_PATH), "utf8");
    const parsed = parseBaseline(jsonText);
    assert.equal(parsed.ok, true, parsed.reasons.join(","));
    const evaluation = evaluateTrustedFreeze({
      baseline: parsed.baseline,
      repositoryFullName: parsed.baseline.repository,
      prHeadRepositoryFullName: parsed.baseline.repository,
      prHeadRef: parsed.baseline.candidateHeadRef,
      sourceHeadSha: parsed.baseline.currentAcceptedCandidateSourceHead,
      eventSourceHeadSha: parsed.baseline.currentAcceptedCandidateSourceHead,
      ancestorCheckComplete: true,
      implementationBaseIsAncestor: true,
      baseTreeComplete: false,
      headTreeComplete: false,
      baseTree: [],
      headTree: [],
    });
    assert.equal(evaluation.trustedBaselineIntegrityOk, false);
  });
});
