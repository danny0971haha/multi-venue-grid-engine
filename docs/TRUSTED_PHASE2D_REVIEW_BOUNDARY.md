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

## 1. Why this exists

Phase 2 candidate `experiment/v0.1-phase2` can add evidence scripts and CI steps that re-verify themselves. That is not a trusted review boundary.

This repository therefore records frozen Git object identities for accepted Corrective 4 implementation bytes on a governance surface that the candidate PR cannot execute.

## 2. Pinned identities

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
ACCEPTED_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
CURRENT_ACCEPTED_CANDIDATE_SOURCE_HEAD=7f196d367e39640eee9517f742b0d61424f9d4cc
BASELINE_PATH=.github/trusted/phase2d-corrective4-baseline.json
SCHEMA=multi-venue-phase2d-trusted-baseline/2
MINIMUM_TRUSTED_ANCESTOR=ed320fbf6558fcf249a6685031f5280a0e402def
CANDIDATE_HEAD_REF=experiment/v0.1-phase2
```

The implementation-base **tree SHA** is derived from the Git object at the implementation base, not invented in prose. Protected file entries record Git mode, object type, blob SHA, and SHA-256 of blob bytes. Schema v2 also records the exact candidate changed-file manifest, both-side Git identities, and per-file SHA-256 values.

The protected-main checkout is not required to remain forever equal to its pre-merge SHA. Instead, the checker requires a clean checkout whose `HEAD` contains `MINIMUM_TRUSTED_ANCESTOR` using `git merge-base --is-ancestor`. It then verifies an exact manifest for the trusted workflow, governance scripts, and CODEOWNERS. The baseline validates its own strict schema and rejects unknown fields; it is sourced only from the protected base checkout.

`experiment/v0.1-phase2` must remain at the candidate SHA above until a new independent review updates the baseline. Do not rebase, merge `main`, amend, or force-push that branch to manufacture a new HEAD.

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
- checkout is hardcoded to `danny0971haha/multi-venue-grid-engine` at the exact pull-request base SHA
- does not checkout the PR head
- does not checkout the PR merge commit
- does not run `npm install` / `npm ci`
- does not import JavaScript/TypeScript from the PR
- does not run tests from the PR
- third-party action pin: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
- PR title, branch, and filenames are not interpolated into the shell
- source repo, ref, and exact HEAD are taken from the event via environment
- comparison uses GitHub Git object APIs against the pinned implementation base and that source HEAD

The stable job always executes. It prints an explicit mode:

```text
trustedPhase2dGateMode=ENFORCE|NOT_APPLICABLE|GOVERNANCE_REVIEW_REQUIRED
trustedPhase2dFreezeGateExecuted=true
```

`ENFORCE` runs the complete freeze checker. A renamed branch or fork touching Phase 2 paths is still enforced and then fails the exact repo/ref/SHA checks. A candidate change to trusted governance paths is enforced and fails the exact manifest. Unrelated work receives an actual successful `NOT_APPLICABLE` run rather than a skipped job. A new candidate SHA fails closed until this baseline is updated on `main` by a separate governance change.

Workflow `.github/workflows/trusted-governance-self-test.yml` provides job `trusted-governance-self-test` on governance changes. It parses both workflow YAML files, checks every governance script with `node --check`, runs temporary Git repository fixtures including the post-merge ancestor case and negative controls, and emits `trustedGovernanceSelfTestExecuted=true`. It does not checkout or execute the Phase 2 candidate.

This workflow must be merged to protected `main` before it can be a required check. `pull_request_target` reads the workflow from the PR base. Pull request #3 currently targets `experiment/v0.1-phase1`, so a GitHub ruleset required workflow from `refs/heads/main` is required before the freeze job attaches to that PR. Copying this workflow onto the Phase 2 candidate branch is not an acceptable substitute.

## 5. CODEOWNERS

`.github/CODEOWNERS` assigns the repository owner `@danny0971haha` (the only collaborator with admin rights) on workflows, trusted manifests, evidence/governance scripts, contract docs, `package.json` / `package-lock.json`, and `src/risk/**` / `src/persistence/**`.

CODEOWNERS does nothing until branch protection / a ruleset enables “require review from Code Owners”.

## 6. GitHub ruleset checklist (owner action)

Read of current settings on 2026-08-25 with `repo` scope (HTTP 200), not a 403:

```text
SETTINGS_EVIDENCE=READ_OK
RULESETS=HTTP_200_EMPTY_ARRAY
CLASSIC_BRANCH_PROTECTION_MAIN=HTTP_404_BRANCH_NOT_PROTECTED
BRANCH_MAIN_PROTECTED=false
ORG_RULESETS=HTTP_404_NOT_AN_ORG
COLLABORATORS=danny0971haha
```

Empty rulesets and “Branch not protected” mean **no protection is configured**. They do not mean the API was forbidden.

Owner should create a repository ruleset targeting `main` (and, separately, a ruleset or required workflow targeting the Phase 2 PR base `experiment/v0.1-phase1`) with:

1. Restrict creations: no.
2. Restrict updates: block force pushes.
3. Restrict deletions: yes.
4. Require a pull request before merging.
5. Required approvals: at least 2 independent reviewers.
6. Dismiss stale pull request approvals when new commits are pushed.
7. Require review from Code Owners.
8. Require conversation resolution before merging.
9. Require status checks to pass:
   - `trusted-phase2d-freeze-gate` (only after this workflow exists on `main` and an actual check run confirms this exact context)
   - `trusted-governance-self-test`
   - current ordinary Phase 2 CI check name: `Clean install, static checks, tests, secret scan, and dry-run`
10. Require branches to be up to date before merging.
11. Do **not** require the Phase 2 source HEAD to move in order to refresh evidence. Evidence for the current closure is bound to `7f196d367e39640eee9517f742b0d61424f9d4cc`.
12. Include administrators.
13. Block direct pushes to `main`.
14. Optional but required for PR #3: ruleset required workflow from `refs/heads/main` `.github/workflows/trusted-phase2d-freeze.yml`.

Do not auto-merge the governance PR. Do not auto-merge Phase 2 PR #3.

### Screenshots the owner should attach after applying settings

If a later token cannot read rulesets (HTTP 403), record `SETTINGS_EVIDENCE=BLOCKED` and attach:

- Settings → Rules → Rulesets (full list and the `main` ruleset body)
- Bypass list / include administrators
- Required checks list showing the trusted freeze job name and the ordinary CI job name
- “Require review from Code Owners”, dismiss stale reviews, conversation resolution
- Block force push / block deletions / block direct pushes
- Required workflow source ref `refs/heads/main` if used
- Branch `main` “protected” state
- CODEOWNERS file on `main` at the merged governance SHA

A 403 is not evidence that protection is absent.

## 7. Updating the baseline

After a new independent review of a new exact candidate SHA:

1. Keep `experiment/v0.1-phase2` untouched until the review record exists.
2. On a new governance commit, regenerate `.github/trusted/phase2d-corrective4-baseline.json` from Git objects:
   `node scripts/governance/generate-phase2d-corrective4-baseline.mjs`
3. Merge that governance change to `main` through CODEOWNERS review.
4. Do not ask the candidate branch to rewrite this file.

## 8. What this does not do

- It does not close Phase 2D overall.
- It does not review Gate 2.
- It does not authorize Phase 2E, live exchange writes, merge, or deployment.
- It does not replace independent review of allowlisted evidence files.
- It does not copy or modify Phase 2 risk implementation.
- Generator/verifier code on the candidate branch still must not write reviewer `ACCEPT`.
