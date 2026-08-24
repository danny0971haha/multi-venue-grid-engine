# Phase 2D Corrective 1 Evidence Packet

Version: `0.1.0`  
Checkpoint: full proposed-batch exposure and fail-closed invalid grid / runtime discriminants  
Requested reviewer decision: independent review of Phase 2D Corrective 1 only  
The implementation agent does **not** declare `PHASE_2D=PASS`, `PHASE_2D_CORRECTIVE_1=PASS`, `PHASE_2C=PASS`, or `GATE_2=PASS`.

## Cumulative Phase 1 integration refresh (2026-08-25)

This packet is rebound to the cumulative Phase 2 integration candidate. It does **not** declare PASS.

```text
CUMULATIVE_PHASE_2_BASELINE=REVIEW_CANDIDATE
PHASE_2C_CORRECTIVE_2=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_AUTHORIZED=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
RAW_PHASE_2_HEAD=a2869d68b452b7295a0baec6e98835094d87e17c
MERGE_BASE_BEFORE=31cfe078c09a15d4906b56fb64731449ca1c598a
INTEGRATION_MERGE_HEAD=5b0fd685586ec57b110159ccc36e5b21ba23ac28
INTEGRATION_MERGE_TREE=420c4184209a0c919829e5fc1b66b653d37b8460
PHASE1_IS_ANCESTOR_OF_INTEGRATION=YES
CONFLICTS=NONE
TEST_REMOVAL=NO
ASSERTION_WEAKENING=NO
HISTORICAL_STAGE_1_TEST_TOTAL=314
HISTORICAL_STAGE_2_TEST_TOTAL=332
HISTORICAL_TOTALS_AUTHORITATIVE=NO
CUMULATIVE_LOCAL_TEST_TOTAL=358
CUMULATIVE_LOCAL_TEST_FAIL=0
CUMULATIVE_LOCAL_TEST_SKIP=0
CUMULATIVE_LOCAL_TEST_TODO=0
CUMULATIVE_LOCAL_TEST_CANCELLED=0
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
BRANCH_HEAD_CI_RUN=PENDING_AFTER_PUSH
PR_MERGE_CI_RUN=PENDING_AFTER_PUSH
```

314 / 332 totals below are **historical / non-authoritative**. They describe earlier raw-branch heads that did not contain accepted Phase 1 Corrective 6/7. The current cumulative local `npm test` total is 358.

## 1. Identity

```text
PHASE=2D_CORRECTIVE_1
REQUESTED_GATE=PHASE_2D_CORRECTIVE_1_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2D_CORRECTIVE_1
CHECKPOINT=FULL_BATCH_EXPOSURE_AND_INVALID_GRID
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
AUTHORITATIVE_START_HEAD=c1420039030d83e427c0e96ad2bd1c654e68951a
AUTHORITATIVE_START_TREE=d233ed875d395b10c3bffa5a8e869cb2b42d3e82
STAGE_1_RESULT_HEAD=260dbd7ed292db7e2aa27575af6a4bb801221c70
STAGE_1_RESULT_TREE=d4a5467f6002dd81c4f4fd53cfa793d2cfe37f75
STAGE_1_TEST_TOTAL=314
STAGE_1_PUSH_CI=32742336568
STAGE_1_PR_CI=32742341518
WORKTREE_CLEAN_BEFORE=YES
PHASE_2C_CORRECTIVE_2=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
CUMULATIVE_PHASE_2_BASELINE=REVIEW_CANDIDATE
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
INTEGRATION_MERGE_HEAD=5b0fd685586ec57b110159ccc36e5b21ba23ac28
INTEGRATION_MERGE_TREE=420c4184209a0c919829e5fc1b66b653d37b8460
PHASE1_IS_ANCESTOR_OF_INTEGRATION=YES
```

Exact `STAGE_2_RESULT_HEAD` / `STAGE_2_RESULT_TREE` after the evidence commit, and GitHub Actions run IDs for that HEAD, are recorded on Draft PR #3 after push.

## 2. Toolchain

```text
OS=Darwin
ARCH=arm64
LOCAL_NODE_VERSION=v26.5.0
LOCAL_NPM_VERSION=11.17.0
CUMULATIVE_REFRESH_NODE_VERSION=v22.23.2
CUMULATIVE_REFRESH_NPM_VERSION=10.9.8
PINNED_NODE_VERSION=v22.23.2
PINNED_NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
```

The 2026-08-25 cumulative refresh executed `npm ci` and the full validation suite under official Node `v22.23.2` / npm `10.9.8`. Historical Stage 1 push CI `32742336568` (`# tests 314` on SHA `260dbd7ed292db7e2aa27575af6a4bb801221c70`) is non-authoritative for the cumulative candidate. GitHub Actions on `ubuntu-latest` using `.node-version` remains the branch-head / PR-merge pinned-runtime authority.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2D Corrective 1 only: count every reduceOnly=false proposed intent in directional exposure; fail closed on invalid grid domain and malformed runtime discriminants
ALLOWED_WRITE_PATHS=src/risk/risk-types.ts; src/risk/exposure.ts; src/risk/risk-engine.ts; src/risk/risk-input-validation.ts; test/risk/risk-engine-corrective-1.test.ts; package.json test registration; docs/PHASE_2D_CONTRACT.md; docs/PHASE_2D_CORRECTIVE_1_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md status block
FILES_ADDED=src/risk/risk-input-validation.ts; test/risk/risk-engine-corrective-1.test.ts; docs/PHASE_2D_CORRECTIVE_1_EVIDENCE.md
FILES_CHANGED=src/risk/risk-types.ts; src/risk/exposure.ts; src/risk/risk-engine.ts; test/risk/risk-engine.test.ts=UNCHANGED; package.json; docs/PHASE_2D_CONTRACT.md; docs/IMPLEMENTATION_CONTRACT.md
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/** after accepted Stage 1; venue adapters; execution coordinator; halt/ACK; Phase 2E/2F; network/auth/signing; live mode; lockfile; dependency additions; 100U/5x/30U/150U/-5U/10U limits
```

No original Phase 2D test was removed or weakened. `test/risk/risk-engine.test.ts` is byte-unchanged.

## 4. Validation

```text
TYPECHECK_EXIT=0
LINT_EXIT=0
FORMAT_CHECK_EXIT=0
TEST_PHASE2A_TOTAL=73 PASS=73 FAIL=0 SKIP=0
TEST_PHASE2B_TOTAL=26 PASS=26 FAIL=0 SKIP=0
TEST_PHASE2C_TOTAL=30 PASS=30 FAIL=0 SKIP=0
TEST_PHASE2C_CORRECTIVE_TOTAL=25 PASS=25 FAIL=0 SKIP=0
TEST_PHASE2C_CORRECTIVE_2_TOTAL=10 PASS=10 FAIL=0 SKIP=0
TEST_PHASE2D_TOTAL=30 PASS=30 FAIL=0 SKIP=0
TEST_PHASE2D_CORRECTIVE_1_TOTAL=18 PASS=18 FAIL=0 SKIP=0
TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=332
TEST_PASS=332
TEST_FAIL=0
TEST_SKIP=0
TEST_TODO=0
BUILD_EXIT=0
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (101 tracked files inspected).
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}
AUDIT_VULNERABILITIES_TOTAL=0
DIFF_CHECK_EXIT=0
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITES=false
PHASE_2E_STARTED=NO
PRIOR_BRANCH_HEAD_TEST_TOTAL=304
STAGE_1_TEST_TOTAL=314
STAGE_2_TEST_TOTAL=332
HISTORICAL_STAGE_1_TEST_TOTAL_AUTHORITATIVE=NO
HISTORICAL_STAGE_2_TEST_TOTAL_AUTHORITATIVE=NO
CUMULATIVE_LOCAL_TEST_TOTAL=358
CUMULATIVE_LOCAL_TEST_PASS=358
CUMULATIVE_LOCAL_TEST_FAIL=0
CUMULATIVE_LOCAL_TEST_SKIP=0
CUMULATIVE_LOCAL_TEST_TODO=0
CUMULATIVE_LOCAL_TEST_CANCELLED=0
CUMULATIVE_SECRET_SCAN_RESULT=Secret scan passed (108 tracked files inspected).
CUMULATIVE_DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}
```

## 5. Corrective matrix

```text
P2D-C1-01 GRID_EXIT reduceOnly=false counted PASS
P2D-C1-02 RISK_REDUCTION reduceOnly=false counted PASS
P2D-C1-03 EMERGENCY_FLATTEN reduceOnly=false bounded price counted PASS
P2D-C1-04 non-reduce-only null price UNBOUNDED/HALT PASS
P2D-C1-05 inconsistent CANCEL INVALID/HALT PASS
P2D-C1-06 mixed batch aggregated and blocks above 150 PASS
P2D-C1-07 exact 150 accepted at metrics layer PASS
P2D-C1-08 valid reduce-only does not increase planned exposure PASS
P2D-C1-09 gridLower<=0 HALT INVALID_RISK_INPUT PASS
P2D-C1-10 gridUpper<=0 HALT INVALID_RISK_INPUT PASS
P2D-C1-11 gridLower==gridUpper HALT PASS
P2D-C1-12 gridLower>gridUpper HALT PASS
P2D-C1-13 invalid side/purpose/fundingConvention HALT PASS
P2D-C1-14 invalid/stale input riskMetricsWithinLimits=false PASS
P2D-C1-15 exact long/short boundary equality unchanged PASS
P2D-C1-16 caller objects unmodified PASS
P2D-C1-17 repeated evaluations byte-identical PASS
P2D-C1-18 original Phase 2D tests remain PASS
```

`CONTINUE` still includes `DURABLE_HALT_OR_ACK_UNAVAILABLE` and `systemAllowRiskIncrease=false`. Invalid input never includes `CONTINUE_METRICS_ONLY`.

## 6. Known limitations

```text
KNOWN_GAPS=Phase 2E durable halt/ACK unimplemented; Phase 2F restart integration unimplemented; CONTINUE is not live authorization; HOST_LOCAL_FILESYSTEM_ONLY coordination remains
UNVERIFIED_ASSUMPTIONS=venue fee/funding sign conventions remain caller-supplied
FOLLOW_UP_REQUIRED=independent review of Phase 2C Corrective 2 and Phase 2D Corrective 1 on the cumulative baseline; bind exact branch-head and PR-merge CI run IDs; do not start Phase 2E, Gate 2, merge, or live testing
```

## 7. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
MERGE=NO
DEPLOYMENT=NO
FORCE_PUSH=NO
```

## 8. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
REQUESTED_GATE=PHASE_2D_CORRECTIVE_1
PHASE_2D_SELF_DECLARED_PASS=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
