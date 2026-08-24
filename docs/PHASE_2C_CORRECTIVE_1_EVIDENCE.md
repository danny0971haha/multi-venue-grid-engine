# Phase 2C Corrective 1 Evidence Packet

Version: `0.1.0`  
Checkpoint: fresh-clock fencing, exact lease tokens, async-safe mutation, durable monotonic witness  
Requested reviewer decision: independent review of Phase 2C Corrective 1 only  
The implementation agent does **not** declare `PHASE_2C=PASS`, `PHASE_2C_CORRECTIVE_1=PASS`, `PHASE_2D=PASS`, or `GATE_2=PASS`.

## 1. Identity

```text
PHASE=2C_CORRECTIVE_1
REQUESTED_GATE=PHASE_2C_CORRECTIVE_1_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2C_CORRECTIVE_1
CHECKPOINT=LEASE_CLOCK_TOKEN_ASYNC_WITNESS
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
EXPECTED_START_HEAD=ba4d1048afb72466a1f93244a5213901595cb7fd
EXPECTED_START_TREE=01848e7a3bd424cf10a8af5e89d16f816d39be9f
REJECTED_PHASE_2C_HEAD=ba4d1048afb72466a1f93244a5213901595cb7fd
REJECTED_PHASE_2C_TREE=01848e7a3bd424cf10a8af5e89d16f816d39be9f
ACCEPTED_PHASE_2B_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
ACCEPTED_PHASE_2B_TREE=8163e36c676f8b1d5332cdbc713b0672ea4fe148
WORKTREE_CLEAN_BEFORE=YES
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_STARTED=NO
```

Exact `STAGE_1_RESULT_HEAD` / `STAGE_1_RESULT_TREE` after the evidence commit, and GitHub Actions run IDs for that HEAD, are recorded on Draft PR #3 after push. They must not be substituted from a different SHA.

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

Local `npm ci` is expected to fail `EBADENGINE` because the workstation is not the pinned Node/npm pair. That is recorded as a mismatch, not a pass. Static checks, tests, build, secret scan, dry-run, and audit below were executed with the local toolchain against the already-present `node_modules` tree. GitHub Actions on `ubuntu-latest` using `.node-version` is the pinned-runtime authority.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2C Corrective 1 only: post-lock fresh clocks, exact LeaseAuthority matching, async-safe fenced mutation, durable append-only witness, real child-process rollback/crash matrix
ALLOWED_WRITE_PATHS=src/persistence/runtime-lease.ts; src/persistence/lease-coordination.ts; src/persistence/lease-witness.ts; src/persistence/index.ts; test/persistence/runtime-lease.test.ts; test/persistence/runtime-lease-corrective-1.test.ts; test/fixtures/phase2c-lease-worker.ts; test/fixtures/phase2c-witness-crash-worker.ts; docs/PHASE_2C_CONTRACT.md; docs/PHASE_2C_CORRECTIVE_1_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md status block; package.json; CI timeout; PR #3 metadata
FILES_ADDED=src/persistence/lease-witness.ts; test/persistence/runtime-lease-corrective-1.test.ts; test/fixtures/phase2c-witness-crash-worker.ts; docs/PHASE_2C_CORRECTIVE_1_EVIDENCE.md
FILES_CHANGED=src/persistence/runtime-lease.ts; src/persistence/lease-coordination.ts; src/persistence/index.ts; test/persistence/runtime-lease.test.ts; docs/PHASE_2C_CONTRACT.md; docs/IMPLEMENTATION_CONTRACT.md; package.json; .github/workflows/ci.yml
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; src/persistence/exact-pair-inspection.ts; src/persistence/atomic-pair-store.ts; src/persistence/runtime-persistence-latch.ts; test/fixtures/phase2a-canonical-vector.ts; Phase 2A/2B tests; src/simulator/**; src/domain/**; src/strategy/**; src/math/**; src/bootstrap/**; src/index.ts; venue adapters; risk engine; halt/ACK; telemetry; lockfile; live-mode behavior; Phase 2D+
```

`test/persistence/runtime-lease.test.ts` only gained a witness seed in `writeExactLeasePair` so 2C-L07 remains green without weakening assertions. No prior 2C-L / P2-L assertion was relaxed.

Phase 2A and Phase 2B current-byte files were not modified.

## 4. Current-byte evidence versus rejected Phase 2C HEAD

`git diff --name-status ba4d1048afb72466a1f93244a5213901595cb7fd` before the evidence commit:

```text
M	.github/workflows/ci.yml
M	docs/IMPLEMENTATION_CONTRACT.md
M	docs/PHASE_2C_CONTRACT.md
M	package.json
M	src/persistence/index.ts
M	src/persistence/lease-coordination.ts
M	src/persistence/runtime-lease.ts
M	test/persistence/runtime-lease.test.ts
A	src/persistence/lease-witness.ts
A	test/fixtures/phase2c-witness-crash-worker.ts
A	test/persistence/runtime-lease-corrective-1.test.ts
A	docs/PHASE_2C_CORRECTIVE_1_EVIDENCE.md
```

`git diff --stat` for implementation files before this evidence file:

```text
 .github/workflows/ci.yml               |   2 +-
 docs/IMPLEMENTATION_CONTRACT.md        |   7 +-
 docs/PHASE_2C_CONTRACT.md              |  91 +++++-
 package.json                           |   1 +
 src/persistence/index.ts               |  19 ++
 src/persistence/lease-coordination.ts  |  64 +++-
 src/persistence/runtime-lease.ts       | 569 +++++++++++++++++++++++++--------
 test/persistence/runtime-lease.test.ts |  12 +
 8 files changed, 617 insertions(+), 148 deletions(-)
```

```text
PR_OR_PATCH_REFERENCE=Draft PR #3 against experiment/v0.1-phase1
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
LOCKFILE_CHANGED=NO
GENERATED_SCHEMA_HASHES=N/A
```

CI timeout-minutes changed from 25 to 35 so the added witness crash matrix can finish. No deploy job was added.

## 5. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Witness uses `node:fs` append + `fsync` file + `fsync` parent directory, `canonicalSerialize`, and `sha256HexBytes`. Coordination still uses exclusive `O_EXCL` create plus an unpredictable guard token and inode-equivalent identity.

## 6. Validation commands

```text
TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0

LINT_COMMAND=npm run lint
LINT_EXIT=0

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0

TEST_PHASE2A_COMMAND=npm run test:phase2a
TEST_PHASE2A_EXIT=0
TEST_PHASE2A_TOTAL=73
TEST_PHASE2A_PASS=73
TEST_PHASE2A_FAIL=0
TEST_PHASE2A_SKIP=0

TEST_PHASE2B_COMMAND=npm run test:phase2b
TEST_PHASE2B_EXIT=0
TEST_PHASE2B_TOTAL=26
TEST_PHASE2B_PASS=26
TEST_PHASE2B_FAIL=0
TEST_PHASE2B_SKIP=0

TEST_PHASE2C_COMMAND=npm run test:phase2c
TEST_PHASE2C_EXIT=0
TEST_PHASE2C_TOTAL=30
TEST_PHASE2C_PASS=30
TEST_PHASE2C_FAIL=0
TEST_PHASE2C_SKIP=0

TEST_PHASE2C_CORRECTIVE_COMMAND=npm run test:phase2c-corrective
TEST_PHASE2C_CORRECTIVE_EXIT=0
TEST_PHASE2C_CORRECTIVE_TOTAL=25
TEST_PHASE2C_CORRECTIVE_PASS=25
TEST_PHASE2C_CORRECTIVE_FAIL=0
TEST_PHASE2C_CORRECTIVE_SKIP=0

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=274
TEST_PASS=274
TEST_FAIL=0
TEST_SKIP=0

BUILD_COMMAND=npm run build
BUILD_EXIT=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (85 tracked files inspected).

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

AUDIT_COMMAND=npm audit --json
AUDIT_EXIT=0
AUDIT_VULNERABILITIES_TOTAL=0

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
```

```text
PRIOR_ACCEPTED_TEST_TOTAL=219
REJECTED_CANDIDATE_LOCAL_TEST_TOTAL=249
CORRECTIVE_LOCAL_TEST_TOTAL=274
PRIOR_249_REMAIN_OR_SUPERSEDED_WITHOUT_WEAKENING=YES
```

The previous 249 candidate tests remain. 25 corrective tests were added. Skip=0 on the local Darwin run. Ubuntu skip=0 is a CI claim and must be bound to this HEAD.

## 7. Contract conformance

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2B_CONTRACT.md; docs/PHASE_2C_CONTRACT.md; docs/PHASE_2C_EVIDENCE.md; docs/RISK_PERSISTENCE_CONTRACT.md; docs/TEST_FAULT_MATRIX.md; docs/EVIDENCE_TEMPLATE.md
CONTRACT_FILES_CHANGED=docs/PHASE_2C_CONTRACT.md (corrective clock/token/async/witness addenda; does not weaken parents); docs/IMPLEMENTATION_CONTRACT.md (narrow status block only); docs/PHASE_2C_CORRECTIVE_1_EVIDENCE.md (this packet)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
PHASE_2A_CURRENT_BYTE_CHANGED=NO
PHASE_2B_CURRENT_BYTE_CHANGED=NO
PHASE_2D_STARTED=NO
```

## 8. Safety claims and evidence

```text
DRY_RUN_DEFAULT=YES; npm run dry-run liveExchangeWrites=false; 2C-L30
LIVE_MODE_FAIL_CLOSED=YES; no live path added
NO_LIVE_WRITE_PATH=YES
DECIMAL_ARITHMETIC_AUTHORITY=NOT_IMPLEMENTED_THIS_PHASE
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
RUNTIME_PERSISTENCE_LATCH=YES; latch still no-reset; 2C-L15/L16
RUNTIME_LEASE_FENCING=YES; corrective matrices 2C-C1-01..24
RESTART_RECONCILIATION=NOT_IMPLEMENTED_THIS_PHASE
DUPLICATE_ORDER_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
ORPHAN_ORDER_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
FATAL_RUNTIME_FAIL_CLOSED=NOT_IMPLEMENTED_THIS_PHASE
ALLOW_RISK_INCREASE=false
SYSTEM_ALLOW_RISK_INCREASE=false
```

## 9. Fresh-clock test matrix

```text
TEST_ID=2C-C1-01
TEST_FILE=test/persistence/runtime-lease-corrective-1.test.ts
TEST_NAME=guard wait crosses expiry -> zero callback
PROCESS_ISOLATION=NO
FAULT_METHOD=hold llock; advance clock past expiry before release
EXPECTED_FINAL_STATE=NOT_SENT callbackCount=0
OBSERVED_FINAL_STATE=NOT_SENT callbackCount=0
RESULT=PASS

TEST_ID=2C-C1-02
TEST_FILE=test/persistence/runtime-lease-corrective-1.test.ts
TEST_NAME=pre-callback delay crosses expiry -> zero callback
PROCESS_ISOLATION=NO
FAULT_METHOD=preCallbackHook advances clock to exact expiry
EXPECTED_FINAL_STATE=NOT_SENT callbackCount=0
OBSERVED_FINAL_STATE=NOT_SENT callbackCount=0
RESULT=PASS

TEST_ID=2C-C1-20
TEST_FILE=test/persistence/runtime-lease-corrective-1.test.ts
TEST_NAME=negative/excessive/throwing clock -> explicit result
PROCESS_ISOLATION=NO
FAULT_METHOD=invalid clock providers
EXPECTED_FINAL_STATE=explicit fail-closed LeaseResult; later valid acquire succeeds
OBSERVED_FINAL_STATE=same
RESULT=PASS

TEST_ID=2C-C1-21
TEST_FILE=test/persistence/runtime-lease-corrective-1.test.ts
TEST_NAME=within-skew heartbeat record remains valid
PROCESS_ISOLATION=NO
FAULT_METHOD=now = heartbeatAt - 500ms
EXPECTED_FINAL_STATE=HEARTBEAT_COMMITTED and parseLeaseRecord ok
OBSERVED_FINAL_STATE=same
RESULT=PASS
```

## 10. Async mutation test matrix

```text
TEST_ID=2C-C1-03 RESULT=PASS  async resolve -> SENT callbackCount=1
TEST_ID=2C-C1-04 RESULT=PASS  async reject -> UNKNOWN callbackCount=1
TEST_ID=2C-C1-05 RESULT=PASS  pending Promise does not settle early as SENT
TEST_ID=2C-C1-06 RESULT=PASS  sync throw -> UNKNOWN callbackCount=1
```

```text
HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION=DOCUMENTED
GUARD_HELD_UNTIL_PROMISE_SETTLES=YES
CONTENDER_TIMEOUT_FAIL_CLOSED=YES
LIVE_AUTHORIZATION_FROM_THIS_API=NO
```

## 11. Exact-token test matrix

```text
TEST_ID=2C-C1-07 RESULT=PASS  forged leaseEnvelopeSha256 rejected
TEST_ID=2C-C1-08 RESULT=PASS  forged leaseStoreGeneration rejected
TEST_ID=2C-C1-09 RESULT=PASS  forged observedExpiresAt rejected
TEST_ID=2C-C1-10 RESULT=PASS  pre-heartbeat token stale for assert/release/mutate
TEST_ID=2C-C1-11 RESULT=PASS  current heartbeat token succeeds
```

Silent token upgrade is forbidden. `matchDurableToken()` requires all seven authority fields.

## 12. Durable witness crash/rollback matrix

```text
TEST_ID=2C-C1-12 RESULT=PASS  PROCESS_ISOLATION=YES fresh child sees LEASE_ROLLBACK_DETECTED
TEST_ID=2C-C1-13 RESULT=PASS  PROCESS_ISOLATION=YES old authority after rollback callbackCount=0
TEST_ID=2C-C1-14 RESULT=PASS  PROCESS_ISOLATION=YES malformed/truncated/hash-conflict witness blocked
TEST_ID=2C-C1-15 RESULT=PASS  PROCESS_ISOLATION=YES SIGKILL after PREPARE fsync; pair BOTH_ABSENT; blocked
TEST_ID=2C-C1-16 RESULT=PASS  PROCESS_ISOLATION=YES pair proven matching PREPARE; no auto COMMIT; INCOMPLETE_WITNESS_FINALIZATION
TEST_ID=2C-C1-17 RESULT=PASS  PROCESS_ISOLATION=YES latest COMMIT + exact pair accepts heartbeat
TEST_ID=2C-C1-18 RESULT=PASS  PROCESS_ISOLATION=YES heartbeat rollback to older store generation blocked
TEST_ID=2C-C1-19 RESULT=PASS  PROCESS_ISOLATION=YES release rollback blocked
TEST_ID=2C-C1-22 RESULT=PASS  replaced llock not unlinked by old guard release
```

Additional real-child SIGKILL coverage: initialize / heartbeat / takeover / release ×

```text
AFTER_PREPARE_FSYNC
AFTER_BACKUP
AFTER_PRIMARY
BEFORE_COMMIT_WITNESS
AFTER_COMMIT_WITNESS
```

```text
CHILD_PROCESS_CRASH_TESTS_RUN=YES
TERMINATION_METHOD=SIGKILL
FRESH_PROCESS_RELOAD=YES
WITNESS_WINDOWS_TESTED=5
OPERATIONS_TESTED=INITIALIZE,HEARTBEAT,TAKEOVER,RELEASE
INCOMPLETE_WITNESS_AUTO_REPAIR=NO
```

2C-C1-16 reports incomplete witness finalization explicitly. The pair may be storage-proven. Normal continuation is not granted and COMMIT is not appended automatically.

## 13. Prior matrices remain

```text
TEST_ID=2C-C1-23 RESULT=PASS  all P2-L / 2C-L01..L30 names and key fail-closed assertions remain
TEST_ID=2C-C1-24 RESULT=PASS  Phase 2B backup/primary A..H SIGKILL cases remain present
TEST_ID=2C-L21..L23 RESULT=PASS  prior lease pair crash classifications remain
```

## 14. CI evidence

```text
CURRENT_HEAD_PUSH_CI=PENDING_AFTER_PUSH
CURRENT_HEAD_PR_CI=PENDING_AFTER_PUSH
CI_COMMIT_SHA=PENDING_AFTER_EVIDENCE_COMMIT
```

A CI result from a different SHA does not validate this candidate.

## 15. Unresolved risks / known limitations

```text
KNOWN_GAPS=HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION; COORDINATION_CAPABILITY=HOST_LOCAL_FILESYSTEM_ONLY; DISTRIBUTED_FENCING_PROVEN=NO; incomplete PREPARE+pair is fail-closed and not auto-repaired; deleting the witness file is not itself a rollback proof if an attacker also replaces the pair
UNVERIFIED_ASSUMPTIONS=NFS/SMB/multi-host lock and witness durability remain unproven
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=POSIX fsync of regular files and parent directories; inode/dev identity for lock ownership
FOLLOW_UP_REQUIRED=independent review of Corrective 1; bind exact push and pull_request CI run IDs to RESULT_HEAD; Stage 2 / Phase 2D must not start unless the hard internal gate is fully green
```

```text
HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION=holding the coordination guard until the mutation Promise settles reduces liveness; contenders wait then fail closed. This prevents dual owners on one host. It is not live authorization.
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
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
MERGE=NO
DEPLOYMENT=NO
FORCE_PUSH=NO
```

## 17. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
REQUESTED_GATE=PHASE_2C_CORRECTIVE_1
PHASE_2C_SELF_DECLARED_PASS=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
