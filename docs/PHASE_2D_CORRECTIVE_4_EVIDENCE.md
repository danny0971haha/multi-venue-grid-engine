# Phase 2D Corrective 4 Evidence Packet

Version: `0.1.0`  
Checkpoint: object/raw UTF-8 budget parity and ambiguous JSON fail-closed  
Requested reviewer decision: independent review of Phase 2D Corrective 4 only  
The implementation agent does **not** declare `PHASE_2D=PASS`, `PHASE_2D_CORRECTIVE_4=PASS`, or `GATE_2=PASS`.

```text
CUMULATIVE_PHASE_2_BASELINE=PASS
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2D_CORRECTIVE_2=ACCEPT
PHASE_2D_CORRECTIVE_3=REJECT
PHASE_2D_CORRECTIVE_4=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
AUTHORITATIVE_START_HEAD=4af26dac5f2e50b335e998e925e0a1d97b4164b4
AUTHORITATIVE_START_TREE=a46a3d8a72dfda6bb5f3a16b7b649ed0d08e0e93
CORRECTIVE_2_BASE=848006f9f9397097a8a099fe82970ffd3d9c97c4
WORKTREE_CLEAN_BEFORE=YES
LOCAL_EQUALS_REMOTE_BEFORE=YES
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
TEST_TOTAL=428
TEST_PASS=428
TEST_FAIL=0
TEST_SKIP=0
TEST_TODO=0
TEST_CANCELLED=0
PRIOR_CUMULATIVE_TEST_TOTAL=413
TEST_PHASE2D_CORRECTIVE_3_TOTAL=35
TEST_PHASE2D_CORRECTIVE_4_TOTAL=15
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
PHASE=2D_CORRECTIVE_4
REQUESTED_GATE=PHASE_2D_CORRECTIVE_4_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2D_CORRECTIVE_4
CHECKPOINT=OBJECT_RAW_UTF8_BUDGET_PARITY
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
PR_BASE=057732cee021889d17573425ee4f24e2065df1e9
AUTHORITATIVE_START_HEAD=4af26dac5f2e50b335e998e925e0a1d97b4164b4
AUTHORITATIVE_START_TREE=a46a3d8a72dfda6bb5f3a16b7b649ed0d08e0e93
WORKTREE_CLEAN_BEFORE=YES
PHASE_2D_CORRECTIVE_3=REJECT
PHASE_2D_CORRECTIVE_4=REVIEW_CANDIDATE
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

Local default `node` was v26.5.0. Validation used `/Users/apple/.local/node-v22.23.2/bin/node` so the recorded toolchain matches the pin.

## 3. Reproduction (Corrective 3 bytes)

Structurally in-budget valid fixture with 100 ownedActiveOrders, 100 unknownReservations, 100 proposedBatch entries, and 128-character decimal strings:

```text
CANONICAL_UTF8_BYTES=97850
STRUCTURAL_DEPTH=4
STRUCTURAL_NODES=1637
COLLECTION_MAXIMA=100
MAX_RISK_INPUT_UTF8_BYTES=65536
OBJECT_API_BEFORE=CONTINUE with Decimal calls=9929 exposureCalls=1
RAW_BYTE_API_BEFORE=HALT RISK_INPUT_LIMIT_EXCEEDED jsonParseCalls=0 Decimal=0 exposure=0
PARITY=BROKEN
```

Inclusive raw-byte cap observed on Corrective 3: 65,535 and 65,536 admit; 65,537 rejects before `JSON.parse`. Corrective 4 preserves that boundary on both APIs.

## 4. Corrective behavior

1. Canonical serialize with existing structural limits.
2. Measure UTF-8 byte length of the canonical result.
3. Apply `MAX_RISK_INPUT_UTF8_BYTES` via `enforceRiskUtf8ByteLimit` (shared by the raw-byte path).
4. Reject before snapshot `JSON.parse` and before Decimal/exposure.
5. Return `RISK_INPUT_LIMIT_EXCEEDED` without echoing payload.
6. Object admission delegates to `parseRiskInputFromJsonBytes` after serialize.
7. Duplicate JSON keys fail closed as `INVALID_RISK_INPUT` (not the limit code) before math.
8. Unpaired JS surrogates on string input fail closed before parse, matching fatal UTF-8 `Uint8Array` policy.

## 5. Changed files

```text
ALLOWED_WRITE_PATHS=src/risk/**; test/risk/risk-engine-corrective-4.test.ts; package.json; docs/PHASE_2D_CONTRACT.md; docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md; .github/workflows/ci.yml
FILES_ADDED=src/risk/risk-json-text.ts; test/risk/risk-engine-corrective-4.test.ts; docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md
FILES_CHANGED=src/risk/risk-engine.ts; src/risk/risk-input-parser.ts; src/risk/risk-input-admission.ts; package.json; docs/PHASE_2D_CONTRACT.md; docs/IMPLEMENTATION_CONTRACT.md; .github/workflows/ci.yml
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=Phase 2C coordination; accepted Phase 1 simulator; venue adapters; execution coordinator; network/auth/signing; live mode; Phase 2E; Phase 2F; capital/leverage/risk limits; lockfile; zero-quantity policy; persistence accepted-byte vectors; Corrective 1/2/3 test files
```

## 6. Corrective 4 matrix

```text
C4-01 structurally valid oversized object/raw parity PASS
C4-02 exact 65535 canonical bytes object/raw parity PASS
C4-03 exact 65536 canonical bytes object/raw parity PASS
C4-04 exact 65537 canonical bytes object/raw parity PASS
C4-05 raw ASCII padding 65535/65536/65537 PASS
C4-06 oversized multibyte UTF-8 within structural caps PASS
C4-07 exact 65537 multibyte object/raw parity PASS
C4-08 structurally invalid and oversized input PASS
C4-09 oversized rejection deterministic PASS
C4-10 no payload echo on limit failure PASS
C4-11 duplicate equity keys fail closed before math PASS
C4-12 escaped/nested duplicate keys fail closed PASS
C4-13 sibling objects with the same key names remain valid PASS
C4-14 unpaired surrogate JS string fails closed before parse PASS
C4-15 in-budget valid object remains byte-identical PASS
```

Corrective 1 (18), Corrective 2 (20), and Corrective 3 (35) suites remain present and passing.

## 7. Unresolved risks

```text
KNOWN_GAPS=Phase 2E durable halt/ACK unimplemented; Phase 2F restart integration unimplemented; CONTINUE is not live authorization; evaluateRisk(unknown) is not DoS-proof against non-returning Proxy traps or process OOM; no worker isolation in this checkpoint
UNVERIFIED_ASSUMPTIONS=raw-byte API is the external trust boundary going forward; object API remains in-process only
FOLLOW_UP_REQUIRED=independent review of Phase 2D Corrective 4; do not start Phase 2E, Gate 2, merge, live mode, or deploy
```

Duplicate-key policy is now fail-closed at the raw JSON boundary. Unpaired JS surrogates on string input are rejected before parse. Valid JSON `\uD800` escapes remain ordinary string content.

## 8. Prohibited-action attestation

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

## 9. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
REQUESTED_GATE=PHASE_2D_CORRECTIVE_4
PHASE_2D_SELF_DECLARED_PASS=NO
```

This is only the implementation agent's request. The independent reviewer owns ACCEPT / REJECT / BLOCKED.
