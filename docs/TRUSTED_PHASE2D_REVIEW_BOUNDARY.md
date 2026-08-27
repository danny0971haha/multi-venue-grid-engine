# Trusted Phase 2D review boundary

This document describes an independent trust boundary for Phase 2D Corrective 4. It lives on `main` after review. It is not part of the Phase 2 candidate branch and must not be rewritten by that candidate to declare itself closed.

```text
REQUESTED_REVIEW=TRUSTED_PHASE2D_REVIEW_BOUNDARY
PHASE_2D_OVERALL=NOT_CLOSED
GATE_2=NOT_REVIEWED
PHASE_2E_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
```

This workflow and manifest do not emit `ACCEPT`, `PASS`, a gate decision, or a release decision.

Machine-readable policy:

`.github/trusted/repository-governance-policy.json`

Schema: `multi-venue-repository-governance-policy/1`

```text
MACHINE_POLICY_BINDINGS
activeProfile=SOLO_OWNER_BOOTSTRAP
postBootstrapTargetProfile=STRICT_MULTI_REVIEWER
requiredApprovingReviewCount=0
requireCodeOwnerReview=false
requireLastPushApproval=false
strictRequiredStatusChecks=false
rulesetWorkflowRequired=false
globallyRequiredGovernanceSelfTest=false
requireConversationResolution=true
blockForcePushes=true
blockDeletions=true
allowDirectMainPush=false
liveExchangeWriteAuthorized=false
deploymentAuthorized=false
mergeMethod=merge
integrationOrder=PR1->PR2->PR4->RETARGET_PR3
frozenPhase2CandidateHead=7f196d367e39640eee9517f742b0d61424f9d4cc
acceptedPhase1Head=057732cee021889d17573425ee4f24e2065df1e9
acceptedPhase0Head=ee0c25664f14ea8ef7e68d070d46e544c3c93ee4
requiredStatusCheck1=trusted-phase2d-freeze-gate
requiredStatusCheck2=Clean install, static checks, tests, secret scan, and dry-run
```

## 1. Why this exists

Phase 2 candidate `experiment/v0.1-phase2` can add evidence scripts and CI steps that re-verify themselves. That is not a trusted review boundary.

This repository therefore records frozen Git object identities for accepted Corrective 4 implementation bytes on a governance surface that the candidate PR cannot execute.

## 2. Pinned identities

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
ACCEPTED_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
CURRENT_ACCEPTED_CANDIDATE_SOURCE_HEAD=7f196d367e39640eee9517f742b0d61424f9d4cc
BASELINE_PATH=.github/trusted/phase2d-corrective4-baseline.json
POLICY_PATH=.github/trusted/repository-governance-policy.json
SCHEMA=multi-venue-phase2d-trusted-baseline/2
POLICY_SCHEMA=multi-venue-repository-governance-policy/1
MINIMUM_TRUSTED_ANCESTOR=ed320fbf6558fcf249a6685031f5280a0e402def
CANDIDATE_HEAD_REF=experiment/v0.1-phase2
```

The implementation-base **tree SHA** is derived from the Git object at the implementation base, not invented in prose. Protected file entries record Git mode, object type, blob SHA, and SHA-256 of blob bytes. Schema v2 also records the exact candidate changed-file manifest, both-side Git identities, and per-file SHA-256 values.

The protected-main checkout is not required to remain forever equal to its pre-merge SHA. Instead, the checker requires a clean checkout whose `HEAD` contains `MINIMUM_TRUSTED_ANCESTOR` using `git merge-base --is-ancestor`. It then verifies an exact manifest for the trusted workflow, governance scripts, CODEOWNERS, and the machine-readable policy. The baseline validates its own strict schema and rejects unknown fields; it is sourced only from the protected base checkout.

`experiment/v0.1-phase2` must remain at the candidate SHA above until a new independent review updates the baseline. Do not rebase, merge `main`, amend, or force-push that branch to manufacture a new HEAD. Do not update the Phase 2 candidate after governance reaches `main`.

## 3. What is frozen vs what is allowlisted

Protected path rules (Git bytes must match the implementation base):

- `src/**`
- `test/risk/**`
- `test/persistence/**`
- `test/simulator/**`
- `package-lock.json`
- `docs/RISK_PERSISTENCE_CONTRACT.md`
- `docs/EXPERIMENT_SPEC.md`
- `docs/PHASE_1_CONTRACT.md`
- `docs/DOMAIN_CONTRACTS.md`
- `docs/ACCEPTANCE_GATES.md`

`docs/PHASE_2D_CONTRACT.md` may change for evidence/status text, but the frozen v0.1 numeric contract body (`## 2. Frozen v0.1 limits` until `## 11. Corrective 4 evidence-closure addendum`) is hashed from the pinned candidate source HEAD. Both markers must appear exactly once. A decoy copy of those headings cannot hide a later mutated limits table. Required numeric substrings are checked inside that unique slice, not merely anywhere in the file.

Current evidence-only changed-path rules (not a content approval):

- `.github/workflows/README.md`
- `.github/workflows/ci.yml`
- `.gitignore`
- `docs/IMPLEMENTATION_CONTRACT.md`
- `docs/PHASE_2D_CONTRACT.md`
- `docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md`
- `docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md`
- `package.json`
- `scripts/evidence/**`
- `test/evidence/**`

An allowlisted path only means the freeze checker will not treat that path as a frozen-risk-byte change. Independent review still has to read the text.

## 4. Trusted workflow security model

File: `.github/workflows/trusted-phase2d-freeze.yml`

Job `trusted-phase2d-freeze-gate`:

- trigger: `pull_request_target` for every pull request targeting protected `main`
- permissions: `contents: read`, `pull-requests: read`
- no write permissions
- no production secrets (only the default `GITHUB_TOKEN`)
- checkout is hardcoded to `danny0971haha/multi-venue-grid-engine` at `${{ github.workflow_sha }}` (the trusted default-branch workflow commit). It does not execute governance scripts from the pull-request base SHA.
- classifies first using trusted workflow bytes and GitHub metadata only
- Phase 2D: does not checkout the PR head; compares GitHub Git objects against the pinned implementation base
- Phase 2E: checks out the exact bound candidate HEAD only after trusted classification and API integrity succeed, with `persist-credentials: false`, then runs pinned Node commands from a runner copied out of the trusted tree
- does not checkout the PR merge commit
- does not import candidate JavaScript as policy
- does not run `npm run evidence:phase2d-corrective4:verify`
- third-party action pins: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1), `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0), `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2)
- PR title, branch, and filenames are not interpolated into the shell
- source repo, ref, and exact HEAD are taken from the event via environment
- comparison uses GitHub Git object APIs against the pinned identities

The stable job always executes. It prints an explicit mode:

```text
trustedPhase2dGateMode=PHASE2D_ENFORCE|PHASE2E_ENFORCE|NOT_APPLICABLE|GOVERNANCE_REVIEW_REQUIRED
trustedPhase2dFreezeGateExecuted=true
```

`PHASE2D_ENFORCE` runs the complete Phase 2D freeze checker. A renamed branch or fork touching Phase 2 paths is still enforced and then fails the exact repo/ref/SHA checks. A candidate change to trusted governance paths is enforced and fails the exact manifest. Unrelated work receives an actual successful `NOT_APPLICABLE` run rather than a skipped job. A new candidate SHA fails closed until this baseline is updated on `main` by a separate governance change.

`PHASE2E_ENFORCE` is allowed only for the exact stacked Runtime Corrective 1 candidate bound in `.github/trusted/phase2e-corrective1-baseline.json`. Near-miss identity, extra paths, forks, and governance/lockfile/dependency changes fail closed. See `docs/PHASE_2E_TRUSTED_GATE.md`.

The classifier has no Phase 0 or Phase 1 path whitelist. Predecessor PRs that touch `src/**` while this workflow is already the PR base would be classified `PHASE2D_ENFORCE`. That is why governance reaches `main` only after PR #1 and PR #2 are integrated. The predecessor solution is the bootstrap sequence below, not a freeze-checker bypass.

Workflow `.github/workflows/trusted-governance-self-test.yml` provides job `trusted-governance-self-test` on governance-path changes. It parses both workflow YAML files, checks every governance script with `node --check`, validates the machine-readable policy, runs temporary Git repository fixtures including the post-merge ancestor case and negative controls, and emits `trustedGovernanceSelfTestExecuted=true`. It does not checkout or execute the Phase 2 candidate.

`trusted-governance-self-test` remains mandatory evidence for governance PRs. It is not a globally required status context. The workflow has path filters, so listing it as a global required check would leave unrelated PRs Pending.

This workflow must exist on `main` before `pull_request_target` can load it as the PR base. This is a personal-account repository, not an organization or enterprise ruleset deployment. Do not configure an organization-level required workflow sourced from `refs/heads/main`. `rulesetWorkflowRequired=false`. Copying this workflow onto the Phase 2 candidate branch is not an acceptable substitute. After governance is on `main`, retarget PR #3 to `main` so the freeze job attaches from the protected base.

## 5. CODEOWNERS

`.github/CODEOWNERS` assigns the repository owner `@danny0971haha` (the only collaborator with admin rights) on workflows, trusted manifests, evidence/governance scripts, contract docs, `package.json` / `package-lock.json`, and `src/risk/**` / `src/persistence/**`.

CODEOWNERS does nothing until a ruleset enables “require review from Code Owners”. The active profile does not enable that requirement. The only Code Owner is also the current PR author and therefore cannot supply a countable Code Owner approval. Placeholder reviewer accounts are not used. Two accounts controlled by the same owner are not independent review.

## 6. Governance profiles

### A. ACTIVE: SOLO_OWNER_BOOTSTRAP

This is the only currently active GitHub ruleset profile. It is a reduced-assurance bootstrap. It does not provide independent human separation of duties.

It provides:

- mechanical branch protection (block force pushes, block deletions, no direct `main` push);
- exact required-status contexts after they exist on `main`;
- exact-byte Phase 2 freeze enforcement after the freeze workflow is the PR base;
- conversation resolution before merge.

It does not provide:

- independent human separation of duties;
- a countable GitHub approval requirement;
- Code Owner review as a merge gate;
- last-push re-approval;
- strict/up-to-date required-status mode;
- a ruleset-required workflow sourced from `main`;
- live exchange writes;
- deployment authorization.

Independent reviewer evidence remains desirable. It is not a countable GitHub approval requirement in this profile. Live exchange writes and deployment remain unauthorized.

Exact active values:

```text
activeProfile=SOLO_OWNER_BOOTSTRAP
requiredApprovingReviewCount=0
requireCodeOwnerReview=false
requireLastPushApproval=false
strictRequiredStatusChecks=false
requireConversationResolution=true
blockForcePushes=true
blockDeletions=true
allowDirectMainPush=false
rulesetWorkflowRequired=false
globallyRequiredGovernanceSelfTest=false
liveExchangeWriteAuthorized=false
deploymentAuthorized=false
mergeMethod=merge
```

Globally required status checks:

1. `trusted-phase2d-freeze-gate`
2. `Clean install, static checks, tests, secret scan, and dry-run`

Do not add `trusted-governance-self-test` to that global list.

Strict/up-to-date required-status mode must remain false while the frozen Phase 2 source HEAD stays at `7f196d367e39640eee9517f742b0d61424f9d4cc` and remains unmerged. Requiring the source branch to become up to date would invalidate the exact reviewed Phase 2 HEAD.

### B. FUTURE: STRICT_MULTI_REVIEWER

This profile is defined and inactive. It must not become active until:

- the repository has at least two real eligible independent collaborators;
- two accounts controlled by the same owner are not counted as independent;
- placeholder reviewer accounts are not used;
- the frozen Phase 2 bootstrap sequence below has completed.

When those prerequisites are actually true, the future profile may require:

- at least two real eligible reviewers;
- Code Owner review;
- stale-approval dismissal;
- last-push approval;
- strict up-to-date status checks.

It still must not authorize live exchange writes or deployment. It still must not list `trusted-governance-self-test` as a global required status. It still must not assume an organization-level required workflow on this personal repository.

## 7. Safe bootstrap order

Exact integration order: PR #1 -> PR #2 -> PR #4 -> retarget/review PR #3.

Merge method for every integration step: GitHub merge-commit. Do not squash. Do not rebase-merge.

### STEP 1

Merge PR #1 into `main` using GitHub merge-commit method.

Required identity preserved as an ancestor:

`ee0c25664f14ea8ef7e68d070d46e544c3c93ee4`

Do not squash.
Do not rebase-merge.

### STEP 2

Retarget PR #2 from `experiment/v0.1-phase0` to `main`.
Keep the Phase 1 branch HEAD unchanged at:

`057732cee021889d17573425ee4f24e2065df1e9`

Run/verify fresh exact-head CI.
Merge PR #2 into `main` using merge-commit method.
Do not squash.
Do not rebase-merge.

### STEP 3

Merge governance PR #4 into the now-integrated `main` using merge-commit method, provided governance review and exact-head self-test succeed.

Do not rewrite the Phase 2 branch.
Do not copy trusted governance files onto the Phase 2 candidate branch.

### STEP 4

Retarget PR #3 from `experiment/v0.1-phase1` to `main`.
The source branch must remain exactly:

```text
experiment/v0.1-phase2
7f196d367e39640eee9517f742b0d61424f9d4cc
```

Do not:

- rebase it;
- merge `main` into it;
- amend it;
- update it;
- force-push it;
- manufacture a new evidence HEAD.

After retargeting, close/reopen PR #3 if necessary to trigger both:

- `trusted-phase2d-freeze-gate`
- `Clean install, static checks, tests, secret scan, and dry-run`

### STEP 5

After the two exact check contexts have actually appeared and succeeded, configure a repository branch ruleset targeting `main` with the SOLO_OWNER_BOOTSTRAP policy.

Required-status strict/up-to-date mode must remain false during this frozen candidate bootstrap. Requiring the source branch to become up to date would invalidate the exact reviewed Phase 2 HEAD.

Owner ruleset values for this profile:

1. Restrict creations: no.
2. Restrict updates: block force pushes.
3. Restrict deletions: yes.
4. Require a pull request before merging.
5. Required approvals: 0.
6. Do not dismiss stale approvals as a bootstrap merge gate.
7. Do not require review from Code Owners.
8. Require conversation resolution before merging.
9. Require status checks to pass, non-strict:
   - `trusted-phase2d-freeze-gate`
   - `Clean install, static checks, tests, secret scan, and dry-run`
10. Do not require branches to be up to date.
11. Do not require the Phase 2 source HEAD to move. Evidence remains bound to `7f196d367e39640eee9517f742b0d61424f9d4cc`.
12. Include administrators.
13. Block direct pushes to `main`.
14. Do not add a ruleset-required workflow. This personal repository cannot deploy an organization-level required workflow sourced from `refs/heads/main`.

Do not auto-merge the governance PR. Do not auto-merge Phase 2 PR #3.

### STEP 6

Create a disposable negative-control PR from a separate branch.
The negative-control PR must deliberately mutate one protected Phase 2 byte or exact candidate identity and must demonstrate:

`trusted-phase2d-freeze-gate = failure`

Close the negative-control PR without merging it.
Never perform a negative test on the real Phase 2 candidate branch.

### STEP 7

Run an independent final Gate 2 review only after:

- PR #1 is integrated by merge commit;
- PR #2 is integrated by merge commit;
- PR #4 is integrated by merge commit;
- PR #3 targets `main`;
- Phase 2 source HEAD is still exactly `7f196d367e39640eee9517f742b0d61424f9d4cc`;
- both required status contexts succeed;
- ruleset read-back matches SOLO_OWNER_BOOTSTRAP;
- the negative-control PR proves fail-closed enforcement;
- a synthetic merge/integration checkout passes the complete test suite.

This document does not itself issue `GATE_2=PASS`.

### Screenshots the owner should attach after applying the bootstrap ruleset

If a later token cannot read rulesets (HTTP 403), record `SETTINGS_EVIDENCE=BLOCKED` and attach:

- Settings → Rules → Rulesets (full list and the `main` ruleset body)
- Bypass list / include administrators
- Required checks list showing exactly the two global contexts above
- Conversation resolution enabled; Code Owner review and last-push approval disabled
- Block force push / block deletions / block direct pushes
- Strict/up-to-date required-status mode disabled
- Branch `main` “protected” state
- CODEOWNERS file on `main` at the merged governance SHA

A 403 is not evidence that protection is absent. Empty rulesets before STEP 5 are an expected operator-pending state, not a repository implementation failure.

Current read of settings:

```text
SETTINGS_EVIDENCE=READ_OK
RULESETS=HTTP_200_EMPTY_ARRAY
CLASSIC_BRANCH_PROTECTION_MAIN=HTTP_404_BRANCH_NOT_PROTECTED
BRANCH_MAIN_PROTECTED=false
ORG_RULESETS=HTTP_404_NOT_AN_ORG
COLLABORATORS=danny0971haha
```

## 8. Updating the baseline

After a new independent review of a new exact candidate SHA:

1. Keep `experiment/v0.1-phase2` untouched until the review record exists.
2. On a new governance commit, regenerate `.github/trusted/phase2d-corrective4-baseline.json` from committed Git objects:
   `node scripts/governance/generate-phase2d-corrective4-baseline.mjs`
3. Merge that governance change to `main` through the active profile’s review rules.
4. Do not ask the candidate branch to rewrite this file.

A later trusted-verifier replacement (Phase 2E gate files, this document’s workflow, or the Phase 2E baseline) is a governance-only PR. Current `main` remains the executing authority until that PR is independently reviewed and merge-committed. Candidate verifier bytes are not executed, and `GOVERNANCE_REVIEW_REQUIRED` is not self-declared acceptance. After merge, runtime PRs are trusted only by governance bytes then present on `main`. See `docs/PHASE_2E_TRUSTED_GATE.md`.

## 9. What this does not do

- It does not close Phase 2D overall.
- It does not review Gate 2.
- It does not authorize Phase 2E, live exchange writes, merge, or deployment.
- It does not replace independent review of allowlisted evidence files.
- It does not copy or modify Phase 2 risk implementation.
- It does not claim independent human separation of duties under SOLO_OWNER_BOOTSTRAP.
- Generator/verifier code on the candidate branch still must not write reviewer `ACCEPT`.
