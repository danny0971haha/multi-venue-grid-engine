# Trusted Phase 2E gate

This document is governance evidence for extending the stable required context `trusted-phase2d-freeze-gate` so it can route the frozen Phase 2D candidate, the exact Phase 2E stacked candidate, trusted governance changes, unrelated PRs, and malformed inputs.

```text
REQUESTED_REVIEW=TRUSTED_PHASE2E_GATE
PHASE_2E_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
CANDIDATE_CODE_EXECUTED_BEFORE_CLASSIFICATION=NO
STABLE_REQUIRED_CONTEXT=trusted-phase2d-freeze-gate
```

This workflow and manifest do not emit `ACCEPT`, `PASS`, a gate decision, or a release decision.

## Bound identities

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
MAIN_BASE_SHA=22665d7fa9274dfc05de043c8e9663e24e75087e
RUNTIME_PR=7
RUNTIME_BRANCH=experiment/v0.1-phase2e-halt-ack
RUNTIME_BASE_BRANCH=experiment/v0.1-phase2
RUNTIME_BASE_SHA=7f196d367e39640eee9517f742b0d61424f9d4cc
RUNTIME_CANDIDATE_HEAD_BOUND=704afa2dd858c52dad06aa22941d463aa5ce4d69
RUNTIME_CANDIDATE_TREE=bda9793acd2fb8de033f65739b8c092cbdec7d9b
BASELINE_PATH=.github/trusted/phase2e-corrective3-baseline.json
SCHEMA=multi-venue-phase2e-trusted-baseline/1
INVALIDATED_CORRECTIVE1_HEAD=f24421d9c80d96d7279d9626fc6bb95941031cf5
INVALIDATED_CORRECTIVE1_TREE=be500d1ec4268269672cf1e1bb8f6cca29e5d397
INVALIDATED_CORRECTIVE1_BASELINE=.github/trusted/phase2e-corrective1-baseline.json
```

The live bound HEAD is Runtime Corrective 3. It is not Runtime Corrective 1 `f24421d9c80d96d7279d9626fc6bb95941031cf5` / tree `be500d1ec4268269672cf1e1bb8f6cca29e5d397`. It is not `7b98c888543b980dee48b27f4497db1bf93a7970`. The Corrective 1 baseline file remains only as an invalidated historical artifact and is not the live pin.

## Modes

The existing required check name is unchanged. Modes returned into that context:

- `PHASE2D_ENFORCE` — exact Phase 2D freeze checker (semantic successor of the previous `ENFORCE` string)
- `PHASE2E_ENFORCE` — exact Phase 2E integrity checker, then trusted runtime commands
- `GOVERNANCE_REVIEW_REQUIRED` — trusted governance-only same-repository PR
- `NOT_APPLICABLE` — unrelated paths
- `FAIL_CLOSED` — malformed, incomplete, forked, stale, extra-path, or otherwise non-exact inputs

## Trust boundary

1. `pull_request_target` executes governance from `${{ github.workflow_sha }}`.
2. Classification and path validation run before any candidate checkout.
3. Permissions are `contents: read` and `pull-requests: read`.
4. Credentials are not persisted.
5. Candidate bytes do not control classification, allowed paths, expected SHAs, protected hashes, required commands, or final disposition.
6. The Phase 2D evidence verifier is not executed as a Phase 2E result.
7. Trusted runtime on the exact candidate HEAD is, in this order:
   - `npm ci`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run format:check`
   - `npm test`
   - `npm run test:phase2e`
   - `npm run build`
   - `npm run scan:secrets`
   - `npm run dry-run`
8. `npm test` TAP from Runtime Corrective 3 must be green. Historical Corrective 1 evidence-identity failures are not ignored. The trusted runner may continue only when stdout TAP matches the exact pin in `.github/trusted/phase2e-corrective3-baseline.json` / `PHASE2E_NPM_TEST_HISTORICAL_MISMATCH`:
   - bound Runtime HEAD `704afa2dd858c52dad06aa22941d463aa5ce4d69`
   - expected counts `# tests 474`, `# pass 474`, `# fail 0`, cancelled/skipped/todo `0`
   - process exit `0` with no signal
   - no failed tests or failed suites
   `npm run test:phase2e` must also be TAP-green: exit `0`, fail/skip/todo/cancelled `0`.
   Any failure, skip/todo/cancelled, missing/malformed TAP, stderr-only spoof, non-zero exit, timeout, OOM, or signal fails closed.

This document does not emit `ACCEPT`, `PASS`, `PHASE2E_GOVERNANCE_PASS`, or `PHASE2E_RUNTIME_ACCEPTED`.

## Governance bootstrap

A trusted verifier cannot approve its own replacement using candidate-controlled bytes.

```text
CURRENT_MAIN_AUTHORITY=YES
TRUSTED_GOVERNANCE_CODE_IDENTITY=github.workflow_sha
CANDIDATE_SCRIPTS_EXECUTED_WITH_SECRETS=NO
GOVERNANCE_CANDIDATE_SELF_DECLARED_ACCEPTED=NO
PHASE2E_RUNTIME_ACCEPTED=NO
```

1. `pull_request_target` loads `.github/workflows/trusted-phase2d-freeze.yml` from the PR base. For PRs targeting `main`, that is current `main`. `github.workflow_sha` is the executing governance-code identity. Candidate HEAD is not the executing identity.
2. Classification and integrity use only the checked-out `workflow_sha` tree. Candidate JavaScript is not imported as policy.
3. A same-repository PR that touches only trusted governance paths is `GOVERNANCE_REVIEW_REQUIRED`. That mode records `governanceCandidateAccepted=false` and does not check out or execute the candidate. It is not runtime acceptance and not a gate `PASS`.
4. Classification is disjoint:
   - exact frozen Phase 2D candidate → `PHASE2D_ENFORCE`
   - exact bound Phase 2E stacked candidate → `PHASE2E_ENFORCE`
   - trusted-governance-only same-repository PR → `GOVERNANCE_REVIEW_REQUIRED`
   - unrelated paths → `NOT_APPLICABLE`
   - mixed governance + runtime / extra path / lockfile / fork / stale SHA / malformed event → `FAIL_CLOSED` or `PHASE2D_ENFORCE` then exact-identity fail
5. After independent review merge-commits this governance change onto `main`, later runtime PRs are classified and integrity-checked only by the governance bytes then present on `main`. A moving branch name is not authorization. Runtime HEAD and tree must match the pinned SHAs.
6. A later commit on `experiment/v0.1-phase2e-halt-ack` that is not `704afa2dd858c52dad06aa22941d463aa5ce4d69` / tree `bda9793acd2fb8de033f65739b8c092cbdec7d9b` fails closed until this baseline is versioned again on `main`. The invalidated Corrective 1 identity `f24421d9c80d96d7279d9626fc6bb95941031cf5` / tree `be500d1ec4268269672cf1e1bb8f6cca29e5d397` is not authorized.

Do not execute untrusted candidate scripts with secrets to land this PR. Do not treat `GOVERNANCE_REVIEW_REQUIRED` as self-declared acceptance.

If GitHub branch protection still makes a reviewed governance-only update unmergeable after Phase 0 CI and `trusted-phase2d-freeze-gate` are green, that is an operator settings problem, not a code bypass:

```text
BOOTSTRAP_EXTERNAL_ACTION_REQUIRED=YES
```

Required repository-level action in that case: keep `enforce_admins` and the two required contexts; do not add `continue-on-error` or skip trusted checks. If classic protection has required-status `strict: true` while machine policy is `strictRequiredStatusChecks=false`, set classic strict/up-to-date to false so it matches `SOLO_OWNER_BOOTSTRAP`. Do not disable admin enforcement or the required contexts. This personal-account repository cannot deploy an organization-level required workflow.

If both required contexts are actually green on a governance-only candidate, merge remains an independent-review decision:

```text
BOOTSTRAP_EXTERNAL_ACTION_REQUIRED=NO
PR8_MERGE_AUTHORIZED=NO
```

## Exact Phase 2E changed-file inventory

No `src/**` exemption. Allowed paths are the exact stacked diff versus `7f196d367e39640eee9517f742b0d61424f9d4cc`:

- `docs/PHASE_2E_EVIDENCE.md`
- `package.json` (scripts-only: added `test:phase2e`; `test` matches frozen Phase 2D)
- `src/halt/engine.ts`
- `src/halt/halt-id.ts`
- `src/halt/index.ts`
- `src/halt/record.ts`
- `src/halt/store.ts`
- `src/halt/transport.ts`
- `src/halt/types.ts`
- `test/fixtures/phase2e-crash-worker.ts`
- `test/halt/halt-crash-matrix.test.ts`
- `test/halt/helpers.ts`
- `test/halt/p2-h-matrix.test.ts`
- `test/halt/p2e-corrective-1.test.ts`
- `test/halt/p2e-corrective-2.test.ts`
- `test/halt/p2e-corrective-3.test.ts`
