# multi-owner-protection-v2 handoff

Independent protection collector v2 for danny0971haha/multi-venue-grid-engine PR #11 owner-protection evidence.

This is **not** a restoration of `collect-owner-protection.py`, not the same bytes, and does not inherit prior tool review. Historical `COLLECTOR_INPUT_MISSING` publication `59d10c476de54be81b822d1eb592e7f76955c794` remains a separate observation.

This is **not** governance implementation, settings change, PR #11 adoption, merge authorization, or live-trading authorization.

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=OWNER_PROTECTION_COLLECTOR_V2
CHECKPOINT=owner-protection-v2-20260908T121749Z
REQUESTED_GATE=NONE
BRANCH=tooling/protection-collector-v2-20260908
BASE_SHA=22665d7fa9274dfc05de043c8e9663e24e75087e
TOOL_COMMIT_USED_FOR_LIVE=355b83bd34ba99545ee3d084fe817ac4bb477dcf
TOOL_TREE_USED_FOR_LIVE=e43833cf11699517d2c5ee972359fb841364e991
RESULT_SHA=PENDING_EVIDENCE_COMMIT
REVIEW_PR=11
REVIEW_HEAD=de2f5c0fd055e418d0b6d806f994b52baa743544
REVIEW_TREE=1b443a620670216968b95cc43de96397550c24f2
EXPECTED_MAIN=22665d7fa9274dfc05de043c8e9663e24e75087e
IDENTITY_MATCH=YES
IDENTITY_DRIFT_DURING_LIVE=NO
```

## Status (split)

```text
TOOL_IMPLEMENTATION=COMPLETE
TOOL_TESTS=PASS
TOOL_TESTS_COMMAND=python3 -m unittest discover -s tools/review/protection-collector-v2/tests -t tools/review/protection-collector-v2 -v
TOOL_TESTS_TOTAL=30
TOOL_TESTS_FAIL=0
TOOL_TESTS_EXIT=0
LIVE_COLLECTION=COMPLETE
PROTECTION_COVERAGE=COMPLETE_FOR_REPOSITORY_SOURCES_ENTERPRISE_UNKNOWN
OWNER_ACTION_REQUIRED=false
ADOPTION=NOT_PERFORMED
OWNER_STEP.md=NOT_WRITTEN (live gh OAuth scopes gist,read:org,repo,workflow were sufficient for repository sources)
```

Not declared: PASS, ACCEPT, MERGE AUTHORIZED, LIVE AUTHORIZED.

## Scope

```text
ALLOWED_WRITE_PATHS=tools/review/protection-collector-v2/**, docs/evidence/owner-protection-v2-20260908T121749Z/**, docs/multi-owner-protection-v2-handoff.md
INTENTIONALLY_UNTOUCHED_AREAS=PR #11 branch/files, main, runtime, scripts/governance, trusted workflows, baseline, GitHub rulesets, branch protection settings, PR #12 evidence as acceptance
```

## Live window (do not merge with other times)

```text
LIVE_STARTED=2026-09-08T12:17:49Z
LIVE_FINISHED=2026-09-08T12:18:15Z
ACTOR=danny0971haha
OAUTH_SCOPES=gist, read:org, repo, workflow
TOKEN_RECORDED=NO
```

An earlier unpublished attempt at `2026-09-08T12:15:20Z` used GraphQL field `rateLimit.reset`, which GitHub rejected (`Field 'reset' doesn't exist on type 'RateLimit'`). That packet was not published (masked `gho_****` also tripped the evidence scanner). The query was corrected to `resetAt` in `355b83b` and the live export below is the replacement. Those two times are not one snapshot.

## Repository-source findings (limited)

Confirmed in this export:

- One repository ruleset, id `21580900`, name `main-solo-owner-bootstrap`, enforcement `active`, include `refs/heads/main` only, exclude empty.
- Required checks on that ruleset: `trusted-phase2d-freeze-gate` and `Clean install, static checks, tests, secret scan, and dry-run`, both `integration_id=15368`, `strict=false`.
- `bypass_actors` was present and `[]` (not omitted).
- `includes_parents=true` and `includes_parents=false` each returned one page, one ruleset, pagination complete. Owner type is User; `GET /orgs/danny0971haha/rulesets` returned 404.
- GraphQL `branchProtectionRules` completed with `totalCount=1`, pattern `main` only. That classic rule requires both contexts from GitHub Actions app `15368` and is admin-enforced.
- Classic REST `GET .../branches/main/protection` was 200. Named non-main targets returned `404` with message `Branch not protected`.
- Effective ruleset-rules endpoint (`GET .../rules/branches/{branch}`) showed the expected context on `main` only among requested names. That endpoint is not a substitute for classic protection.

non-main required context (`trusted-phase2d-freeze-gate`): **NOT_PRESENT_IN_COMPLETE_EXPORT** of repository rulesets + classic patterns. This used full include/exclude and the complete classic pattern list, not a sample of branches.

PR #11 main-only trigger: **NO_CONFLICT_IN_REPOSITORY_EXPORT**. Restricting `pull_request_target` to `main` matches the only repository ruleset include and the only classic pattern. Dual enforcement on `main` (ruleset + classic) remains a fact for the reviewer; it is not a non-main scope conflict.

Still UNKNOWN / not adoption:

- Enterprise inherited rulesets were not read.
- This packet does not adopt PR #11, merge it, or change settings.
- PR #12 was listed only as an open-PR identity/base. It is not PR #11 acceptance evidence.

## Validation

```text
TYPECHECK=NOT_RUN (Python stdlib tool; no package.json change)
LINT=NOT_RUN for this Python tool
TEST_COMMAND=python3 -m unittest discover -s tools/review/protection-collector-v2/tests -t tools/review/protection-collector-v2 -v
TEST_EXIT=0
TEST_TOTAL=30
TEST_PASS=30
TEST_FAIL=0
LIVE_COMMAND=python3 tools/review/protection-collector-v2/collect.py --repo danny0971haha/multi-venue-grid-engine --review-pr 11 --expected-main 22665d7fa9274dfc05de043c8e9663e24e75087e --review-head de2f5c0fd055e418d0b6d806f994b52baa743544 --review-tree 1b443a620670216968b95cc43de96397550c24f2 --known-ruleset-id 21580900 --expected-context trusted-phase2d-freeze-gate --frozen-ref experiment/v0.1-phase2 --frozen-ref experiment/v0.1-phase2e-halt-ack --frozen-ref governance/phase2e-trusted-gate --out docs/evidence/owner-protection-v2-20260908T121749Z
LIVE_EXIT=0
SECRET_SCAN_OF_PACKET=no unmasked token prefixes
LOCKFILE_CHANGED=NO
```

## Packet

`docs/evidence/owner-protection-v2-20260908T121749Z/`

- `tool-manifest.json`
- `request-ledger.json`
- `raw/` (response bodies + safe headers)
- `derived/` (analysis separated from raw)
- `coverage.md`
- `status.json`
- `SHA256SUMS` (excludes itself)
- `github-sha-pinned-index.md`
- `tests-offline.txt`

`OWNER_STEP.md` was not required.

## Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
PR11_MERGED=NO
GITHUB_RULESETS_MODIFIED=NO
BRANCH_PROTECTION_MODIFIED=NO
FAKE_SUCCESS_CHECK_CREATED=NO
```

Independent reviewer decides. This agent does not declare PASS, ACCEPT, MERGE AUTHORIZED, or LIVE AUTHORIZED.
