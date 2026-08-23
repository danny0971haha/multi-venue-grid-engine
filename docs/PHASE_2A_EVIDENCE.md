# Phase 2A Evidence Packet

Version: `0.2.0`  
Checkpoint: canonical durable envelope + exact-pair inspection  
Requested reviewer decision: independent review of Phase 2A only  
The implementation agent does **not** declare `PHASE_2A=PASS` or `GATE_2=PASS`.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2A
CHECKPOINT=canonical envelope + exact-pair inspection
REQUESTED_GATE=PHASE_2A_REVIEW
BRANCH=experiment/v0.1-phase2
BASE_SHA=31cfe078c09a15d4906b56fb64731449ca1c598a
BASE_TREE=7cbb90ebee0897132df6e0c23b27b1ae33c12e2f
IMPLEMENTATION_HEAD=90a3ad21a79d307d24e54ae12211135b982250b2
IMPLEMENTATION_TREE=1f44d384408a996d5e64df8304eb336fbb9124f0
FORMAT_FIX_HEAD=626ca5b2a0d0f7b8304bb36dd9901503e5911697
FORMAT_FIX_TREE=d76d027582a0cdb7e6ebf7e4d738204e85f9acc8
WORKTREE_CLEAN_BEFORE=YES
WORKTREE_CLEAN_AFTER=YES
```

## 2. Toolchain

```text
OS=Darwin
ARCH=arm64
LOCAL_NODE_VERSION=v26.5.0
LOCAL_NPM_VERSION=11.17.0
PINNED_NODE_VERSION=v22.23.2
PINNED_NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
PACKAGE_MANAGER_VERSION=npm@10.9.8
```

Local `npm ci` failed with `EBADENGINE` because the workstation is not the pinned Node/npm pair. Static checks, tests, build, secret scan, and dry-run were executed with the local toolchain. CI on `ubuntu-latest` using `.node-version` is the pinned-runtime authority.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2A read-side canonical serialization, checksummed DurableEnvelope, independent exact-pair inspection
ALLOWED_WRITE_PATHS=src/persistence/**; test/persistence/**; test/fixtures/**; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md; docs/ACCEPTANCE_GATES.md; package.json
FILES_CHANGED=docs/ACCEPTANCE_GATES.md; docs/IMPLEMENTATION_CONTRACT.md; package.json
FILES_ADDED=docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md; src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; src/persistence/exact-pair-inspection.ts; src/persistence/index.ts; test/fixtures/phase2a-canonical-vector.ts; test/persistence/canonical-json.test.ts; test/persistence/durable-envelope.test.ts; test/persistence/exact-pair-inspection.test.ts
FILES_DELETED=NONE
DIFF_STAT=12 files changed, 2090 insertions(+), 1 deletion(-) before this evidence file
INTENTIONALLY_UNTOUCHED_AREAS=src/simulator/**; src/domain/**; src/strategy/**; src/math/**; src/bootstrap/**; src/index.ts; venue adapters; runtime lease; risk engine; halt/ACK; telemetry; CI workflow; lockfile; live-mode behavior
```

## 4. Current-byte evidence

```text
PR_OR_PATCH_REFERENCE=Draft PR against experiment/v0.1-phase1
PATCH_SHA256=N/A committed branch
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
GENERATED_SCHEMA_HASHES=N/A
```

Implementation commits:

```text
0d5d84b153f940be8aa6a1e5ccdf50bf82ce8971 docs(phase2): define bounded phase 2a contract
db115082f47ad122f6e108a14c0b1a01814b732c feat(persistence): add canonical durable envelope
ab4287167196960c9a33bbe6703bfb927724eba9 feat(persistence): add exact-pair inspection
9a04f14e9be9ac9f84d40cdb62ea5bcea696727f test(persistence): add canonical and P2-D inspection matrix
90a3ad21a79d307d24e54ae12211135b982250b2 fix(persistence): reject UTF-8 BOM and bind envelope validation errors
365f7da090c1e5319815688a773c9388ae97d91f docs(review): bind phase 2a evidence
626ca5b2a0d0f7b8304bb36dd9901503e5911697 fix(persistence): apply biome format to exact-pair inspection
```

`git diff --name-status 31cfe078c09a15d4906b56fb64731449ca1c598a...90a3ad21a79d307d24e54ae12211135b982250b2`:

```text
M	docs/ACCEPTANCE_GATES.md
M	docs/IMPLEMENTATION_CONTRACT.md
A	docs/PHASE_2A_CONTRACT.md
M	package.json
A	src/persistence/canonical-json.ts
A	src/persistence/durable-envelope.ts
A	src/persistence/exact-pair-inspection.ts
A	src/persistence/index.ts
A	test/fixtures/phase2a-canonical-vector.ts
A	test/persistence/canonical-json.test.ts
A	test/persistence/durable-envelope.test.ts
A	test/persistence/exact-pair-inspection.test.ts
```

## 5. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Persistence uses `node:crypto` and `node:fs`.

## 6. Validation commands

```text
INSTALL_COMMAND=npm ci
INSTALL_EXIT=1
INSTALL_RESULT=EBADENGINE local node v26.5.0 / npm 11.17.0 vs pinned 22.23.2 / 10.9.8

TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0
TYPECHECK_RESULT=tsc --noEmit clean after BOM/catalog fixes

LINT_COMMAND=npm run lint
LINT_EXIT=0
LINT_RESULT=biome lint clean, 39 files

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=biome format failed on 90a3ad2 exact-pair-inspection wrapping; clean after 626ca5b

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_RESULT=163 pass / 0 fail / 0 skip
TEST_TOTAL=163
TEST_PASS=163
TEST_FAIL=0
TEST_SKIP=0

FOCUSED_PHASE2A_COMMAND=npm run test:phase2a
FOCUSED_PHASE2A_TOTAL=43
FOCUSED_PHASE2A_PASS=43

EXISTING_SUITE_TOTAL=120
EXISTING_SUITE_PASS=120

BUILD_COMMAND=npm run build
BUILD_EXIT=0
BUILD_RESULT=tsc --project tsconfig.build.json succeeded

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=passed (72 tracked files inspected at implementation HEAD)

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
```

## 7. Contract conformance

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/RISK_PERSISTENCE_CONTRACT.md; docs/TEST_FAULT_MATRIX.md; docs/ACCEPTANCE_GATES.md; docs/EVIDENCE_TEMPLATE.md; docs/DOMAIN_CONTRACTS.md; docs/PHASE_2A_CONTRACT.md
CONTRACT_FILES_CHANGED=docs/IMPLEMENTATION_CONTRACT.md (narrow additive status); docs/ACCEPTANCE_GATES.md (narrow additive status); docs/PHASE_2A_CONTRACT.md (new)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
```

Lineage interpretation (not blocked): Phase 2A has no historical archive. Optional `expectedGeneration` / `expectedPreviousEnvelopeSha256` is the only restart-time predecessor check. Generation `>1` without an expected anchor reports `lineageStatus=UNVERIFIED` and may still report `pairAuthorityProven=true` as storage-pair evidence only.

## 8. Safety claims and evidence

```text
DRY_RUN_DEFAULT=test/bootstrap/runtimeMode.test.ts + npm run dry-run
LIVE_MODE_FAIL_CLOSED=test/bootstrap/runtimeMode.test.ts LIVE_MODE_NOT_IMPLEMENTED
NO_LIVE_WRITE_PATH=src/index.ts unchanged; persistence is read/validation only
DECIMAL_ARITHMETIC_AUTHORITY=unchanged Phase 1; Phase 2A financial payload values remain decimal strings
CANCEL_NOT_FILL=NOT_IMPLEMENTED_THIS_PHASE
DISAPPEARANCE_NOT_FILL=NOT_IMPLEMENTED_THIS_PHASE
AUTHORITATIVE_FILL_PROVENANCE=NOT_IMPLEMENTED_THIS_PHASE
PARTIAL_FILL_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
UNKNOWN_WRITE_RECONCILIATION=NOT_IMPLEMENTED_THIS_PHASE
ORDER_OWNERSHIP_CLASSIFICATION=NOT_IMPLEMENTED_THIS_PHASE
PLANNED_NOTIONAL_CAP=NOT_IMPLEMENTED_THIS_PHASE
ACTUAL_NOTIONAL_REDUCTION=NOT_IMPLEMENTED_THIS_PHASE
DAILY_LOSS_HALT=NOT_IMPLEMENTED_THIS_PHASE
START_DRAWDOWN_HALT=NOT_IMPLEMENTED_THIS_PHASE
BOUNDARY_HALT=NOT_IMPLEMENTED_THIS_PHASE
STALE_INPUT_HALT=NOT_IMPLEMENTED_THIS_PHASE
HALT_PERSISTENCE=NOT_IMPLEMENTED_THIS_PHASE
DURABLE_HALT_ACK=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_PERSISTENCE_LATCH=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_LEASE_FENCING=NOT_IMPLEMENTED_THIS_PHASE
RESTART_RECONCILIATION=NOT_IMPLEMENTED_THIS_PHASE
DUPLICATE_ORDER_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
ORPHAN_ORDER_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
FATAL_RUNTIME_FAIL_CLOSED=NOT_IMPLEMENTED_THIS_PHASE
ALLOW_RISK_INCREASE=always false in Phase 2A inspectExactPair
```

## 9. Fault-injection matrix

```text
TEST_ID=P2-D01
TEST_FILE=test/persistence/exact-pair-inspection.test.ts
TEST_NAME=valid identical canonical pair is storage-proven and still blocks risk increase
PROCESS_ISOLATION=NO
FAULT_METHOD=fresh temp exact pair
EXPECTED_FINAL_STATE=pairAuthorityProven=true; allowRiskIncrease=false
OBSERVED_FINAL_STATE=pairAuthorityProven=true; allowRiskIncrease=false
RESULT=PASS
```

```text
TEST_ID=P2-D02
TEST_FILE=test/persistence/exact-pair-inspection.test.ts
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D03
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D04
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D05
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D06
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D07
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D08
EXPECTED_FINAL_STATE=unproven; no newer-copy selection
RESULT=PASS
```

```text
TEST_ID=P2-D09
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D10
EXPECTED_FINAL_STATE=unproven; lineage MISMATCH
RESULT=PASS
```

```text
TEST_ID=P2-D11
EXPECTED_FINAL_STATE=unproven; lineage MISMATCH
RESULT=PASS
```

```text
TEST_ID=P2-D12
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D13
EXPECTED_FINAL_STATE=unproven
RESULT=PASS
```

```text
TEST_ID=P2-D14
EXPECTED_FINAL_STATE=temp non-authoritative; exact old pair still proven
RESULT=PASS
```

```text
MATRIX_REQUIRED_THIS_PHASE=P2-D01..P2-D14 plus 2A-C01..2A-C20 read-side cases
MATRIX_RUN=14 P2-D + applicable 2A-C
MATRIX_PASS=all executed Phase 2A cases
MATRIX_FAIL=0
MATRIX_SKIP=0
```

## 10. Real process-crash evidence

```text
CHILD_PROCESS_CRASH_TESTS_RUN=NO
TERMINATION_METHOD=N/A
FRESH_PROCESS_RELOAD=NO
BACKUP_WINDOWS_TESTED=NO
PRIMARY_WINDOWS_TESTED=NO
HALT_TRANSITION_WINDOWS_TESTED=NO
ACK_TRANSITION_WINDOWS_TESTED=NO
POST_CRASH_DISK_CLASSIFICATIONS=NOT_IMPLEMENTED_THIS_PHASE
```

SIGKILL atomic-write matrix is Phase 2B and was not implemented.

## 11. Durable-state artifacts

```text
CANONICAL_PAYLOAD_BYTES={"levels":10,"marker":"phase2a-canonical-vector","notionalUsd":"100"}
PAYLOAD_SHA256=1e0e100c04353644249d0ce2e438b2401a91c21155943635ffd63422f6d382c2
ENVELOPE_SHA256=0cab9a0f0be80d3aba5ceb1d01d26d568af8bfedfc50f3f17dda3ebbd47e71d2
STATE_SCHEMA_VERSION=1
OLD_EXACT_PAIR_SHA256=N/A Phase 2A has no write protocol
NEW_EXACT_PAIR_SHA256=N/A
```

Independent `openssl dgst -sha256` of `CANONICAL_PAYLOAD_BYTES` matched `PAYLOAD_SHA256`.

Fixture secret-like string is `phase2a-local-fixture-not-a-credential`. It is not a credential.

## 12. Venue audit evidence

```text
N/A Phase 2A
```

## 13. Telemetry/manifest evidence

```text
N/A Phase 2A
```

## 14. CI evidence

```text
CI_RUN_URL_OR_ID=PENDING_AFTER_BRANCH_PUSH
CI_COMMIT_SHA=PENDING
CI_STATUS=PENDING
CI_JOBS=PENDING
```

## 15. Unresolved risks

```text
KNOWN_GAPS=no backup-first write protocol; no runtime latch; no lease; no risk gate; no halt/ACK; no historical archive; allowRiskIncrease remains false even for an exact pair
UNVERIFIED_ASSUMPTIONS=local workstation is not the pinned Node/npm pair; CI is the pinned-runtime proof
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=Node TextDecoder fatal UTF-8; fs readFile/readdir; SHA-256 via node:crypto
FOLLOW_UP_REQUIRED=Phase 2B backup-first atomic write + real process-crash matrix after separate authorization
```

## 16. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
PHASE_2B_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

## 17. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
INDEPENDENT_REVIEW_GATE_1=PASS
CURRENT_CANDIDATE=PHASE_2A
PHASE_2A=REVIEW_CANDIDATE
PHASE_2B_AUTHORIZED=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
