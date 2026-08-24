# Phase 2C Corrective 2 Evidence Packet

Version: `0.1.0`  
Checkpoint: recoverable host-local coordination claims after empty-lock and orphaned-recover crashes  
Requested reviewer decision: independent review of Phase 2C Corrective 2 only  
The implementation agent does **not** declare `PHASE_2C=PASS`, `PHASE_2C_CORRECTIVE_2=PASS`, `PHASE_2D=PASS`, or `GATE_2=PASS`.

## 1. Identity

```text
PHASE=2C_CORRECTIVE_2
REQUESTED_GATE=PHASE_2C_CORRECTIVE_2_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2C_CORRECTIVE_2
CHECKPOINT=COORDINATION_RECOVERY_IDENTITY
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
AUTHORITATIVE_START_HEAD=c1420039030d83e427c0e96ad2bd1c654e68951a
AUTHORITATIVE_START_TREE=d233ed875d395b10c3bffa5a8e869cb2b42d3e82
ACCEPTED_PHASE_2B_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
ACCEPTED_PHASE_2B_TREE=8163e36c676f8b1d5332cdbc713b0672ea4fe148
WORKTREE_CLEAN_BEFORE=YES
PHASE_2C_CORRECTIVE_1=REJECT
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

Local workstation Node/npm are not the pinned pair. Static checks, tests, build, secret scan, dry-run, and audit below used the local toolchain against the already-present `node_modules` tree. GitHub Actions on `ubuntu-latest` using `.node-version` is the pinned-runtime authority.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2C Corrective 2 only: verifiable ownership identity on every coordination claim, including recovery; empty/in-progress llock and orphaned llock.recover become recoverable without two valid guards
ALLOWED_WRITE_PATHS=src/persistence/lease-coordination.ts; src/persistence/coordination-claim.ts; test/persistence/runtime-lease-corrective-2.test.ts; test/fixtures/phase2c-coordination-crash-worker.ts; package.json test registration; docs/PHASE_2C_CONTRACT.md corrective addendum; docs/PHASE_2C_CORRECTIVE_2_EVIDENCE.md; bounded implementation-contract status
FILES_ADDED=src/persistence/coordination-claim.ts; test/fixtures/phase2c-coordination-crash-worker.ts; test/persistence/runtime-lease-corrective-2.test.ts; docs/PHASE_2C_CORRECTIVE_2_EVIDENCE.md
FILES_CHANGED=src/persistence/lease-coordination.ts; docs/PHASE_2C_CONTRACT.md; docs/IMPLEMENTATION_CONTRACT.md; package.json
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; src/persistence/exact-pair-inspection.ts; src/persistence/atomic-pair-store.ts; src/persistence/runtime-persistence-latch.ts; src/persistence/runtime-lease.ts; src/persistence/lease-witness.ts; src/risk/**; Phase 2A/2B tests; prior Phase 2C and 2C-C1 tests; venue adapters; execution coordinator; halt/ACK; telemetry; lockfile; live-mode behavior; Phase 2D+
```

No prior Phase 2C, 2C-L, or 2C-C1 test was removed or weakened.

## 4. Current-byte evidence versus authoritative start HEAD

`git diff --name-status c1420039030d83e427c0e96ad2bd1c654e68951a` before the evidence commit:

```text
M	docs/IMPLEMENTATION_CONTRACT.md
M	docs/PHASE_2C_CONTRACT.md
M	package.json
M	src/persistence/lease-coordination.ts
A	src/persistence/coordination-claim.ts
A	test/fixtures/phase2c-coordination-crash-worker.ts
A	test/persistence/runtime-lease-corrective-2.test.ts
A	docs/PHASE_2C_CORRECTIVE_2_EVIDENCE.md
```

```text
PR_OR_PATCH_REFERENCE=Draft PR #3 against experiment/v0.1-phase1
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
LOCKFILE_CHANGED=NO
GENERATED_SCHEMA_HASHES=N/A
```

CI timeout-minutes remains 35. No deploy job was added.

## 5. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Coordination still uses exclusive `O_EXCL` create plus PID, unpredictable token, inode/device identity, creation timestamp, and post-write path-identity fencing. Recovery coordination uses the same identity rules for `llock.recover` and `llock.recover2`.

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

TEST_PHASE2C_CORRECTIVE_2_COMMAND=npm run test:phase2c-corrective-2
TEST_PHASE2C_CORRECTIVE_2_EXIT=0
TEST_PHASE2C_CORRECTIVE_2_TOTAL=10
TEST_PHASE2C_CORRECTIVE_2_PASS=10
TEST_PHASE2C_CORRECTIVE_2_FAIL=0
TEST_PHASE2C_CORRECTIVE_2_SKIP=0

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=314
TEST_PASS=314
TEST_FAIL=0
TEST_SKIP=0

BUILD_COMMAND=npm run build
BUILD_EXIT=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (97 tracked files inspected before this evidence file).

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
PRIOR_BRANCH_HEAD_TEST_TOTAL=304
STAGE_1_TEST_TOTAL=314
PRIOR_304_REMAIN_WITHOUT_WEAKENING=YES
```

## 7. Contract conformance

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2B_CONTRACT.md; docs/PHASE_2C_CONTRACT.md; docs/PHASE_2C_CORRECTIVE_1_EVIDENCE.md; docs/PHASE_2D_CONTRACT.md; docs/PHASE_2D_EVIDENCE.md; docs/EVIDENCE_TEMPLATE.md
CONTRACT_FILES_CHANGED=docs/PHASE_2C_CONTRACT.md (Corrective 2 recovery-identity addendum; does not weaken parents); docs/IMPLEMENTATION_CONTRACT.md (narrow status block only); docs/PHASE_2C_CORRECTIVE_2_EVIDENCE.md (this packet)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
PHASE_2A_CURRENT_BYTE_CHANGED=NO
PHASE_2B_CURRENT_BYTE_CHANGED=NO
PHASE_2D_BEHAVIOR_CHANGED=NO
```

## 8. Safety claims and evidence

```text
DRY_RUN_DEFAULT=YES; npm run dry-run liveExchangeWrites=false
LIVE_MODE_FAIL_CLOSED=YES; no live path added
NO_LIVE_WRITE_PATH=YES
RUNTIME_LEASE_FENCING=YES; corrective matrices P2C-C2-01..10
ALLOW_RISK_INCREASE=false
SYSTEM_ALLOW_RISK_INCREASE=false
HOST_LOCAL_FILESYSTEM_ONLY=YES
DISTRIBUTED_FENCING_PROVEN=false
AUTOMATIC_LEASE_PAIR_REPAIR=NO
EXACT_LEASE_AUTHORITY_MATCHING=UNCHANGED
DURABLE_WITNESS_BEHAVIOR=UNCHANGED
```

## 9. Coordination crash/recovery matrix

```text
TEST_ID=P2C-C2-01
TEST_FILE=test/persistence/runtime-lease-corrective-2.test.ts
PROCESS_ISOLATION=YES
FAULT_METHOD=SIGKILL after llock exclusive create, before metadata write
EXPECTED_FINAL_STATE=exactly one fresh guard
RESULT=PASS

TEST_ID=P2C-C2-02
PROCESS_ISOLATION=YES
FAULT_METHOD=delayed original creator resumes after empty lock reclaimed
EXPECTED_FINAL_STATE=no guard; callbackCount=0
RESULT=PASS

TEST_ID=P2C-C2-03
PROCESS_ISOLATION=YES
FAULT_METHOD=SIGKILL after metadata write, before path-identity validation
EXPECTED_FINAL_STATE=fresh process recovers one guard
RESULT=PASS

TEST_ID=P2C-C2-04
PROCESS_ISOLATION=YES
FAULT_METHOD=SIGKILL immediately after llock.recover exclusive create
EXPECTED_FINAL_STATE=fresh recoverer recovers stale llock
RESULT=PASS

TEST_ID=P2C-C2-05
PROCESS_ISOLATION=YES
FAULT_METHOD=SIGKILL after stale llock unlink, before recover cleanup
EXPECTED_FINAL_STATE=fresh process acquires
RESULT=PASS

TEST_ID=P2C-C2-06
PROCESS_ISOLATION=YES
FAULT_METHOD=live recoverer holds identified recover claim
EXPECTED_FINAL_STATE=recover bytes unchanged; contender fail-closed
RESULT=PASS

TEST_ID=P2C-C2-07
PROCESS_ISOLATION=YES
FAULT_METHOD=replace recover file under an older recoverer
EXPECTED_FINAL_STATE=replacement bytes remain
RESULT=PASS

TEST_ID=P2C-C2-08
PROCESS_ISOLATION=NO
FAULT_METHOD=malformed recover metadata
EXPECTED_FINAL_STATE=COORDINATION_LOCK_UNCERTAIN; no lease write
RESULT=PASS

TEST_ID=P2C-C2-09
PROCESS_ISOLATION=YES
FAULT_METHOD=two fresh children after stale-lock recovery condition
EXPECTED_FINAL_STATE=exactly one successful guard
RESULT=PASS

TEST_ID=P2C-C2-10
PROCESS_ISOLATION=NO
FAULT_METHOD=presence of prior Phase 2C / 2C-L / 2C-C1 IDs
RESULT=PASS
```

```text
CHILD_PROCESS_CRASH_TESTS_RUN=YES
TERMINATION_METHOD=SIGKILL
FRESH_PROCESS_RELOAD=YES
BLIND_AGE_ONLY_DELETION=NO
GRACE_PLUS_PATH_IDENTITY_FENCE=YES
```

## 10. Prior matrices remain

```text
PHASE_2A_73=PASS
PHASE_2B_26=PASS
PHASE_2C_30=PASS
PHASE_2C_CORRECTIVE_1_25=PASS
```

## 11. CI evidence

```text
CURRENT_HEAD_PUSH_CI=PENDING_AFTER_PUSH
CURRENT_HEAD_PR_CI=PENDING_AFTER_PUSH
CI_COMMIT_SHA=PENDING_AFTER_EVIDENCE_COMMIT
```

A CI result from a different SHA does not validate this candidate.

## 12. Unresolved risks / known limitations

```text
KNOWN_GAPS=HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION; COORDINATION_CAPABILITY=HOST_LOCAL_FILESYSTEM_ONLY; DISTRIBUTED_FENCING_PROVEN=false; empty-claim grace uses host filesystem mtime versus wall clock; last-level recover2 reclaim still has a theoretical unlink TOCTOU that is fenced by inode+liveness revalidation and delayed-creator path-identity failure
UNVERIFIED_ASSUMPTIONS=NFS/SMB/multi-host lock durability remain unproven
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=POSIX exclusive create, fstat inode/dev identity, process.kill(pid, 0)
FOLLOW_UP_REQUIRED=independent review of Corrective 2; bind exact push and pull_request CI run IDs to RESULT_HEAD; Stage 2 / Phase 2D Corrective 1 must not start unless this hard internal gate is fully green
```

## 13. Prohibited-action attestation

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

## 14. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
REQUESTED_GATE=PHASE_2C_CORRECTIVE_2
PHASE_2C_SELF_DECLARED_PASS=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
