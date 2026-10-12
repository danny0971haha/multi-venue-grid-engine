# Phase 2D Corrective 3 Evidence Packet

Version: `0.1.0`  
Checkpoint: bounded risk input admission and availability fail-closed  
Requested reviewer decision: independent review of Phase 2D Corrective 3 only  
The implementation agent does **not** declare `PHASE_2D=PASS`, `PHASE_2D_CORRECTIVE_3=PASS`, or `GATE_2=PASS`.

```text
CUMULATIVE_PHASE_2_BASELINE=PASS
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2D_CORRECTIVE_2=ACCEPT
PHASE_2D_CORRECTIVE_3=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
AUTHORITATIVE_START_HEAD=848006f9f9397097a8a099fe82970ffd3d9c97c4
AUTHORITATIVE_START_TREE=a841d62390bb0e07a32b44ec71bb3bc9255e0ce1
WORKTREE_CLEAN_BEFORE=YES
LOCAL_EQUALS_REMOTE_BEFORE=YES
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
TEST_TOTAL=413
TEST_PASS=413
TEST_FAIL=0
TEST_SKIP=0
TEST_TODO=0
TEST_CANCELLED=0
PRIOR_CUMULATIVE_TEST_TOTAL=378
TEST_PHASE2D_CORRECTIVE_3_TOTAL=35
AUDIT_VULNERABILITIES=0
LIVE_EXCHANGE_WRITES=false
liveExchangeWrite=false
productionCredentialUsed=false
mergePerformed=false
deployPerformed=false
```

Exact result HEAD/TREE and GitHub Actions run IDs for that HEAD are recorded on Draft PR #3 after push.

## 1. Identity

```text
PHASE=2D_CORRECTIVE_3
REQUESTED_GATE=PHASE_2D_CORRECTIVE_3_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2D_CORRECTIVE_3
CHECKPOINT=BOUNDED_RISK_INPUT_ADMISSION
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
AUTHORITATIVE_START_HEAD=848006f9f9397097a8a099fe82970ffd3d9c97c4
AUTHORITATIVE_START_TREE=a841d62390bb0e07a32b44ec71bb3bc9255e0ce1
WORKTREE_CLEAN_BEFORE=YES
PHASE_2D_CORRECTIVE_2=ACCEPT
PHASE_2D_CORRECTIVE_3=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
CUMULATIVE_PHASE_2_BASELINE=PASS
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
```

## 2. Toolchain

```text
OS=Darwin
ARCH=arm64
PINNED_NODE_VERSION=v22.23.2
PINNED_NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
```

Local default `node` was v26.5.0. Validation used the official `node-v22.23.2-darwin-arm64` binary so the recorded toolchain matches the pin.

## 3. Frozen resource budgets

These limits apply only at the risk admission boundary. Default persistence canonical serialization is unchanged.

```text
MAX_RISK_INPUT_UTF8_BYTES=65536
MAX_RISK_INPUT_DEPTH=8
MAX_RISK_INPUT_NODES=2048
MAX_RISK_COLLECTION_LENGTH=128
MAX_RISK_OBJECT_PROPERTIES=64
MAX_RISK_STRING_CHARS=256
MAX_RISK_OBJECT_KEY_CHARS=128
MAX_RISK_DECIMAL_CHARS=128
```

Exact cap is allowed. Cap + 1 is `RISK_INPUT_LIMIT_EXCEEDED` HALT.

## 4. Trust boundary

- External adapters, fixtures, CLI, and future network bytes use `evaluateRiskFromJsonBytes(raw: string | Uint8Array)`.
- UTF-8 byte length is computed before `JSON.parse`. Oversize returns fail-closed without parse.
- `Uint8Array` uses fatal UTF-8 decode. Invalid UTF-8 and malformed JSON HALT with `INVALID_RISK_INPUT`, not the limit code.
- `evaluateRisk(unknown)` remains for in-process tests and already-bounded finite objects. It is defensive fail-closed for finite returning observation. It is not a DoS-proof guarantee and has no hard completion-time timeout. Non-returning Proxy traps and process OOM can prevent a return. `Promise.race` cannot abort synchronous work. Worker/process isolation is not implemented in this checkpoint.
- Diagnostics do not echo raw input or secret-like values. `evaluatedAt` is only a canonical non-negative integer millisecond string of at most 13 digits; otherwise `"0"`.

## 5. Reason-code contract

`RISK_INPUT_LIMIT_EXCEEDED` is appended after `HIGH_WATER_OBSERVED`. Other catalog entries keep their relative order. Limit failures include `INVALID_RISK_INPUT`, `STALE_OR_MISSING_INPUT`, and `DURABLE_HALT_OR_ACK_UNAVAILABLE`, with `action=HALT`, `systemAllowRiskIncrease=false`, and `riskMetricsWithinLimits=false`.

## 6. Changed files

```text
ALLOWED_WRITE_PATHS=src/risk/**; src/math/decimal.ts; src/persistence/canonical-json.ts; src/persistence/index.ts; test/risk/risk-engine-corrective-3.test.ts; package.json; docs/PHASE_2D_CONTRACT.md; docs/PHASE_2D_CORRECTIVE_3_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md; .github/workflows/ci.yml
FILES_ADDED=src/risk/risk-input-admission.ts; test/risk/risk-engine-corrective-3.test.ts; docs/PHASE_2D_CORRECTIVE_3_EVIDENCE.md
FILES_CHANGED=src/risk/risk-engine.ts; src/risk/risk-input-parser.ts; src/risk/risk-input-validation.ts; src/risk/risk-types.ts; src/risk/index.ts; src/risk/exposure.ts; src/math/decimal.ts; src/persistence/canonical-json.ts; src/persistence/index.ts; package.json; docs/PHASE_2D_CONTRACT.md; docs/IMPLEMENTATION_CONTRACT.md; .github/workflows/ci.yml
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=Phase 2C coordination; accepted Phase 1 simulator; venue adapters; execution coordinator; network/auth/signing; live mode; Phase 2E; Phase 2F; capital/leverage/risk limits; lockfile; zero-quantity policy; persistence accepted-byte vectors
```

`canonical-json.ts` gained optional `CanonicalSerializeLimits`. Calls without limits keep historical accepted-byte output. C3-29 asserts frozen Phase 2A payload/envelope vectors byte-for-byte.

## 7. Corrective 3 matrix

```text
C3-01 raw JSON exact 65536 bytes PASS
C3-02 raw JSON 65537 bytes PASS
C3-03 invalid UTF-8 PASS
C3-04 malformed JSON PASS
C3-05 depth exactly 8 PASS
C3-06 depth 9 PASS
C3-07 node count exactly 2048 PASS
C3-08 node count 2049 PASS
C3-09 collection length exactly 128 PASS
C3-10 collection length 129 PASS
C3-11 object properties exactly 64 PASS
C3-12 object properties 65 PASS
C3-13 string exactly 256 chars PASS
C3-14 string 257 chars PASS
C3-15 key exactly 128 chars PASS
C3-16 key 129 chars PASS
C3-17 decimal exactly 128 chars valid/invalid PASS
C3-18 decimal 129 chars PASS
C3-19 giant evaluatedAt does not echo PASS
C3-20 malformed evaluatedAt returns 0 PASS
C3-21 large ownedActiveOrders PASS
C3-22 large unknownReservations PASS
C3-23 large proposedBatch PASS
C3-24 deeply nested unknown property PASS
C3-25 limit failure deterministic PASS
C3-26 no caller mutation PASS
C3-27 no secret-like diagnostic leakage PASS
C3-28 valid in-budget RiskDecision compatible PASS
C3-29 persistence canonical vectors unchanged PASS
C3-30 thrown getter still HALT PASS
C3-31 finite throwing Proxy still HALT PASS
C3-32 object API limitation documented PASS
C3-33 raw-byte API rejects before Decimal work PASS
C3-34 raw-byte API rejects before exposure iteration PASS
C3-35 reason-code ordering remains deterministic PASS
```

C3-02/C3-18/C3-33/C3-34 use instrumentation counters (`jsonParseCalls`, `decimalConstructorStats.calls`, `exposureIterationStats.calls`) rather than wall-clock thresholds.

## 8. Validation commands

```text
INSTALL_COMMAND=npm ci
INSTALL_EXIT=0
TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0
LINT_COMMAND=npm run lint
LINT_EXIT=0
FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
TEST_PHASE2D_CORRECTIVE_3_COMMAND=npm run test:phase2d-corrective-3
TEST_PHASE2D_CORRECTIVE_3_TOTAL=35 PASS=35 FAIL=0 SKIP=0 TODO=0
TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=413
TEST_PASS=413
TEST_FAIL=0
TEST_SKIP=0
TEST_TODO=0
TEST_CANCELLED=0
BUILD_COMMAND=npm run build
BUILD_EXIT=0
SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (tracked files inspected).
DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}
AUDIT_COMMAND=npm audit --json
AUDIT_EXIT=0
AUDIT_VULNERABILITIES_TOTAL=0
DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITES=false
PHASE_2E_STARTED=NO
PERSISTENCE_CANONICAL_VECTORS=BYTE_FOR_BYTE_UNCHANGED
```

CI hardening: `actions/checkout` remains SHA-pinned; `persist-credentials: false`; frozen dry-run `phase: 0` is unchanged; independent metadata `implementationCheckpoint=PHASE_2D_CORRECTIVE_3`.

## 9. Unresolved risks

```text
KNOWN_GAPS=Phase 2E durable halt/ACK unimplemented; Phase 2F restart integration unimplemented; CONTINUE is not live authorization; evaluateRisk(unknown) is not DoS-proof against non-returning Proxy traps or process OOM; no worker isolation in this checkpoint
UNVERIFIED_ASSUMPTIONS=raw-byte API is the external trust boundary going forward; object API remains in-process only
FOLLOW_UP_REQUIRED=independent review of Phase 2D Corrective 3; do not start Phase 2E, Gate 2, merge, live mode, or deploy
```

## 10. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
RESET_REBASE_AMEND_FORCE_PUSH=NO
PHASE_2E_STARTED=NO
PHASE_2F_STARTED=NO
LOCKFILE_CHANGED=NO
ZERO_QUANTITY_POLICY_CHANGED=NO
liveExchangeWrite=false
productionCredentialUsed=false
mergePerformed=false
deployPerformed=false
```

## 11. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
REQUESTED_GATE=PHASE_2D_CORRECTIVE_3
PHASE_2D_SELF_DECLARED_PASS=NO
```

This is only the implementation agent's request. The independent reviewer owns ACCEPT / REJECT / BLOCKED.
