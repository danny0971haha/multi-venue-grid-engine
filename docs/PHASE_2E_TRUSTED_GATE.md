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
RUNTIME_CANDIDATE_HEAD_BOUND=f24421d9c80d96d7279d9626fc6bb95941031cf5
RUNTIME_CANDIDATE_TREE=be500d1ec4268269672cf1e1bb8f6cca29e5d397
BASELINE_PATH=.github/trusted/phase2e-corrective1-baseline.json
SCHEMA=multi-venue-phase2e-trusted-baseline/1
```

The bound HEAD is Runtime Corrective 1. It is not `7b98c888543b980dee48b27f4497db1bf93a7970`.

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
7. `npm test` TAP failures confined to `test/evidence/phase2d-corrective4-evidence.test.ts` are recorded as ignored frozen-identity failures and are not treated as Phase 2E success evidence.

## Exact Phase 2E changed-file inventory

No `src/**` exemption. Allowed paths are the exact stacked diff versus `7f196d367e39640eee9517f742b0d61424f9d4cc`:

- `docs/PHASE_2E_EVIDENCE.md`
- `package.json` (scripts-only: `test` glob and added `test:phase2e`)
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
