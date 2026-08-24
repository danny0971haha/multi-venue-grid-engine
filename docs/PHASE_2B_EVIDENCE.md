# Phase 2B Evidence Packet — Backup-First Atomic Persistence and Real Process-Crash Matrix

Version: `0.1.0`  
Checkpoint: backup-first atomic exact-pair persistence + real child-process SIGKILL matrix  
Requested reviewer decision: independent review of Phase 2B only  
The implementation agent does **not** declare `PHASE_2B=PASS` or `GATE_2=PASS`.

## 1. Identity

```text
PHASE=2B
REQUESTED_GATE=PHASE_2B_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2B
CHECKPOINT=BACKUP_FIRST_ATOMIC_PERSISTENCE_AND_REAL_PROCESS_CRASH_MATRIX
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
BASE_HEAD=51400c0f5a43c96f691115383e565743f543c9ee
BASE_TREE=fa5068d6e0de0281f52f64a8a5539f054b64961d
IMPLEMENTATION_HEAD=a35f6230e242c83d5494fca70c6a442288cc0c55
IMPLEMENTATION_TREE=b8d71abb0f7c9aabc4fa06e376b8aa8059a723fa
ACCEPTED_PHASE_2A_HEAD=51400c0f5a43c96f691115383e565743f543c9ee
ACCEPTED_PHASE_2A_TREE=fa5068d6e0de0281f52f64a8a5539f054b64961d
ACCEPTED_PHASE_2A_CI_RUN=32703392519
WORKTREE_CLEAN_BEFORE=YES
PHASE_2B_SELF_DECLARED_PASS=NO
```

Exact `RESULT_HEAD` / `RESULT_TREE` after this evidence commit, and GitHub Actions run IDs for that HEAD, are recorded on Draft PR #3 after push.

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

Local `npm ci` failed with `EBADENGINE` because the workstation is not the pinned Node/npm pair. That is recorded as a failure, not a pass. Static checks, tests, build, secret scan, dry-run, and audit below were executed with the local toolchain against the already-present `node_modules` tree. GitHub Actions on `ubuntu-latest` using `.node-version` is the pinned-runtime authority.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2B only: backup-first atomic exact-pair persistence, explicit initialization, compare-and-commit, dispositions, process-lifetime latch, real SIGKILL matrix
ALLOWED_WRITE_PATHS=docs/PHASE_2B_CONTRACT.md; docs/PHASE_2B_EVIDENCE.md; src/persistence/atomic-pair-store.ts; src/persistence/runtime-persistence-latch.ts; src/persistence/index.ts; test/persistence/atomic-pair-store.test.ts; test/fixtures/phase2b-crash-worker.ts; package.json; docs/IMPLEMENTATION_CONTRACT.md (status block)
FILES_ADDED=docs/PHASE_2B_CONTRACT.md; docs/PHASE_2B_EVIDENCE.md; src/persistence/atomic-pair-store.ts; src/persistence/runtime-persistence-latch.ts; test/persistence/atomic-pair-store.test.ts; test/fixtures/phase2b-crash-worker.ts
FILES_CHANGED=docs/IMPLEMENTATION_CONTRACT.md; package.json; src/persistence/index.ts
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; src/persistence/exact-pair-inspection.ts; test/fixtures/phase2a-canonical-vector.ts; Phase 2A tests; src/simulator/**; src/domain/**; src/strategy/**; src/math/**; src/bootstrap/**; src/index.ts; venue adapters; runtime lease; risk engine; halt/ACK; telemetry; CI workflow; lockfile; live-mode behavior; Phase 2C+
```

Phase 2A current-byte files were not modified.

## 4. Current-byte evidence versus accepted Phase 2A HEAD

`git diff --name-status 51400c0f5a43c96f691115383e565743f543c9ee` for the implementation commit `a35f6230e242c83d5494fca70c6a442288cc0c55`:

```text
M	docs/IMPLEMENTATION_CONTRACT.md
A	docs/PHASE_2B_CONTRACT.md
M	package.json
A	src/persistence/atomic-pair-store.ts
M	src/persistence/index.ts
A	src/persistence/runtime-persistence-latch.ts
A	test/fixtures/phase2b-crash-worker.ts
A	test/persistence/atomic-pair-store.test.ts
```

`git diff --stat` for that implementation commit:

```text
 docs/IMPLEMENTATION_CONTRACT.md              |  12 +-
 docs/PHASE_2B_CONTRACT.md                    | 380 +++++++++++
 package.json                                 |   3 +-
 src/persistence/atomic-pair-store.ts         | 919 +++++++++++++++++++++++++++
 src/persistence/index.ts                     |  24 +
 src/persistence/runtime-persistence-latch.ts |  51 ++
 test/fixtures/phase2b-crash-worker.ts        | 108 ++++
 test/persistence/atomic-pair-store.test.ts   | 904 ++++++++++++++++++++++++++
 8 files changed, 2396 insertions(+), 5 deletions(-)
```

```text
PR_OR_PATCH_REFERENCE=Draft PR #3 against experiment/v0.1-phase1
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
LOCKFILE_CHANGED=NO
GENERATED_SCHEMA_HASHES=N/A
```

## 5. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Persistence uses `node:crypto`, `node:fs`, `node:fs/promises`, and `node:child_process`.

## 6. Contract changes

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2A_CONTRACT.md; docs/RISK_PERSISTENCE_CONTRACT.md; docs/TEST_FAULT_MATRIX.md; docs/REVIEW_CHANGE_PROTOCOL.md; docs/EVIDENCE_TEMPLATE.md
CONTRACT_FILES_CHANGED=docs/PHASE_2B_CONTRACT.md (new, does not weaken parents); docs/IMPLEMENTATION_CONTRACT.md (narrow status block only); docs/PHASE_2B_EVIDENCE.md (this packet)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
PHASE_2A_CURRENT_BYTE_CHANGED=NO
PHASE_2C_STARTED=NO
```

`docs/IMPLEMENTATION_CONTRACT.md` status block now records:

```text
GATE_0=PASS
GATE_1=PASS
PHASE_2A=PASS
ACCEPTED_PHASE_2A_HEAD=51400c0f5a43c96f691115383e565743f543c9ee
AUTHORIZED_CHECKPOINT=PHASE_2B_ONLY
PHASE_2B=REVIEW_CANDIDATE
PHASE_2B_SELF_DECLARED_PASS=NO
PHASE_2C_AUTHORIZED=NO
GATE_2=NOT_REVIEWED
ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```

## 7. Persistence API

```text
initializeExactPair(...)
persistExactPairTransition(...)
RuntimePersistenceLatch
PersistResult / PersistDisposition
setPersistenceFaultHookForTests(...)   # test-only
ATOMIC_WRITE_HOOKS = A..H
```

`PersistDisposition`:

```text
REQUESTED_STATE_COMMITTED
PREDECESSOR_UNPROVEN
PARTIAL_COMMIT
FINAL_PAIR_UNPROVEN
IO_FAILURE
```

`PersistResult` always includes `allowRiskIncrease=false`, `reasonCodes`, `committedEnvelopeSha256`, `committedGeneration`, `inspection`, and `latchState`. `state` is the committed detached payload only on `REQUESTED_STATE_COMMITTED`; otherwise `null`.

## 8. Initialization protocol

`initializeExactPair` is the only creation path. General read and transition do not initialize.

Required before create:

- primary absent;
- backup absent;
- no sibling `${stateName}.json*` historical / temp evidence;
- expected kind and scope known;
- caller `bootstrapAuthorization.mode=NON_LIVE_BOOTSTRAP` and `allowLive=false`;
- generation `"1"`;
- `previousEnvelopeSha256=null`;
- payload canonicalizable;
- final exact-pair inspection of identical primary/backup bytes.

One-copy, corrupt, conflicting, or leftover-temp states return `PREDECESSOR_UNPROVEN`, block the latch, and are not treated as clean initialization.

## 9. Backup-first protocol

```text
inspect exact predecessor pair
-> compare-and-commit re-inspect
-> buildDurableEnvelope next bytes once
-> atomic commit BACKUP
-> reopen/read/validate BACKUP
-> require exact requested bytes
-> atomic commit PRIMARY
-> reopen/read/validate PRIMARY
-> final inspect PRIMARY + BACKUP
-> require exact next pair
```

Each target write: validate `stateName`; exclusive `O_EXCL` temp in the same directory; directory `0700`; files `0600`; full write loop; temp `fsync`; close; atomic rename; parent-directory `fsync`; reopen/readback; `parseAndValidateDurableEnvelope`; field checks. Rename success alone is not a durable-commit proof.

Generation increment uses `BigInt` decimal-string arithmetic and never JavaScript `number`. Proven by `2B-P02` with `9007199254740993 -> 9007199254740994`.

## 10. Latch semantics

`RuntimePersistenceLatch` is process-lifetime. It exposes `blocked`, `reasonCodes`, and `blockedAt`. There is no reset / unblock method.

The following permanently block the current process: predecessor unproven, partial commit, I/O failure, readback mismatch, final pair unproven, stale generation/hash, wrong kind/scope, ambiguous initialization, unsupported durability operation.

A later `REQUESTED_STATE_COMMITTED` write cannot clear the latch (`2B-P17`). `allowRiskIncrease` remains `false`. Only a fresh process plus full durable inspection may construct a new latch. The latch is persistence authority only, not trading authorization.

## 11. Fault-hook mapping A to H

Stable hooks, independently for `BACKUP` and `PRIMARY`:

```text
A  BEFORE_TEMP_OPEN
B  AFTER_TEMP_OPEN
C  AFTER_TEMP_WRITE
D  AFTER_TEMP_FSYNC
E  AFTER_TEMP_CLOSE
F  AFTER_RENAME
G  AFTER_DIR_FSYNC
H  AFTER_TARGET_INSPECTION
```

Child worker: `test/fixtures/phase2b-crash-worker.ts`. Parent creates a fresh directory and old exact pair, child executes exactly one transition, child writes a ready file at the named hook, parent sends real `SIGKILL`, parent does not reuse child module state, a fresh inspect process reads disk only.

## 12. Real SIGKILL matrix — BACKUP

Observed on this workstation after fresh-process reload. Termination method: `SIGKILL`. No case skipped.

| Hook | Classification | pairStatus | generation | allowRiskIncrease |
|---|---|---|---|---|
| A BEFORE_TEMP_OPEN | OLD_EXACT_PAIR | EXACT_PAIR | 1 | false |
| B AFTER_TEMP_OPEN | OLD_EXACT_PAIR | EXACT_PAIR | 1 | false |
| C AFTER_TEMP_WRITE | OLD_EXACT_PAIR | EXACT_PAIR | 1 | false |
| D AFTER_TEMP_FSYNC | OLD_EXACT_PAIR | EXACT_PAIR | 1 | false |
| E AFTER_TEMP_CLOSE | OLD_EXACT_PAIR | EXACT_PAIR | 1 | false |
| F AFTER_RENAME | PAIR_UNPROVEN | UNPROVEN | null | false |
| G AFTER_DIR_FSYNC | PAIR_UNPROVEN | UNPROVEN | null | false |
| H AFTER_TARGET_INSPECTION | PAIR_UNPROVEN | UNPROVEN | null | false |

## 13. Real SIGKILL matrix — PRIMARY

| Hook | Classification | pairStatus | generation | allowRiskIncrease |
|---|---|---|---|---|
| A BEFORE_TEMP_OPEN | PAIR_UNPROVEN | UNPROVEN | null | false |
| B AFTER_TEMP_OPEN | PAIR_UNPROVEN | UNPROVEN | null | false |
| C AFTER_TEMP_WRITE | PAIR_UNPROVEN | UNPROVEN | null | false |
| D AFTER_TEMP_FSYNC | PAIR_UNPROVEN | UNPROVEN | null | false |
| E AFTER_TEMP_CLOSE | PAIR_UNPROVEN | UNPROVEN | null | false |
| F AFTER_RENAME | NEW_EXACT_PAIR | EXACT_PAIR | 2 | false |
| G AFTER_DIR_FSYNC | NEW_EXACT_PAIR | EXACT_PAIR | 2 | false |
| H AFTER_TARGET_INSPECTION | NEW_EXACT_PAIR | EXACT_PAIR | 2 | false |

No fourth outcome occurred. No crash outcome authorized risk increase. GitHub Actions Ubuntu must execute the same tests without skip (`2B-P22`, `2B-P23`, `2B-P24`).

## 14. Commands and exit codes

Local workstation, Node `v26.5.0` / npm `11.17.0`:

```text
INSTALL_COMMAND=npm ci
INSTALL_EXIT=1
INSTALL_RESULT=EBADENGINE Required {"node":"22.23.2","npm":"10.9.8"} Actual {"node":"v26.5.0","npm":"11.17.0"}
NPM_CI_PINNED_RUNTIME=NOT_RUN_ON_WORKSTATION

TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0

LINT_COMMAND=npm run lint
LINT_EXIT=0
LINT_RESULT=biome lint clean, 43 files

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=biome format clean, 43 files

FOCUSED_PHASE2A_COMMAND=npm run test:phase2a
FOCUSED_PHASE2A_EXIT=0
FOCUSED_PHASE2A_TOTAL=73
FOCUSED_PHASE2A_PASS=73
FOCUSED_PHASE2A_FAIL=0
FOCUSED_PHASE2A_SKIP=0

FOCUSED_PHASE2B_COMMAND=npm run test:phase2b
FOCUSED_PHASE2B_EXIT=0
FOCUSED_PHASE2B_TOTAL=26
FOCUSED_PHASE2B_PASS=26
FOCUSED_PHASE2B_FAIL=0
FOCUSED_PHASE2B_SKIP=0

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=219
TEST_PASS=219
TEST_FAIL=0
TEST_SKIP=0
EXISTING_TESTS_REMAINING=193
NEW_PHASE_2B_TESTS=26

BUILD_COMMAND=npm run build
BUILD_EXIT=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=passed (73 tracked files inspected before this packet commit)

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

AUDIT_COMMAND=npm audit
AUDIT_EXIT=0
AUDIT_RESULT=found 0 vulnerabilities

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
```

Pinned Node `v22.23.2` / npm `10.9.8` `npm ci` was not executed on this workstation. Do not treat the local `npm ci` failure as a pinned-runtime pass.

## 15. Test totals

```text
TEST_TOTAL=219
TEST_PASS=219
TEST_FAIL=0
TEST_SKIP=0
PHASE_2A_FOCUSED=73/73
PHASE_2B_FOCUSED=26/26
EXISTING_193=present and green
SIGKILL_SKIPPED_ON_UBUNTU=must be 0; local Darwin also 0 skipped
```

Required IDs `2B-P01` through `2B-P26` are present in `test/persistence/atomic-pair-store.test.ts`.

## 16. Audit result

```text
AUDIT_RESULT=found 0 vulnerabilities
AUDIT_WORSENED=NO
LOCKFILE_CHANGED=NO
```

## 17. Safety claims and evidence

```text
ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
DRY_RUN_DEFAULT=npm run dry-run liveExchangeWrites=false
NO_LIVE_WRITE_PATH=src/index.ts unchanged; no venue adapter
RUNTIME_PERSISTENCE_LATCH=src/persistence/runtime-persistence-latch.ts; tests 2B-P14..2B-P17
BACKUP_FIRST=src/persistence/atomic-pair-store.ts; tests 2B-P01, 2B-P14
EXPLICIT_INITIALIZATION=initializeExactPair; tests 2B-P11..2B-P13
COMPARE_AND_COMMIT=re-inspect before first target write
REAL_SIGKILL=2B-P22, 2B-P23, 2B-P24
FROZEN_PHASE_2A_VECTORS=2B-P25
EXISTING_193=2B-P26 + npm test 219=193+26
RUNTIME_LEASE_FENCING=NOT_IMPLEMENTED_THIS_PHASE
RISK_GATE=NOT_IMPLEMENTED_THIS_PHASE
HALT_PERSISTENCE=NOT_IMPLEMENTED_THIS_PHASE
DURABLE_HALT_ACK=NOT_IMPLEMENTED_THIS_PHASE
TELEMETRY=NOT_IMPLEMENTED_THIS_PHASE
```

## 18. Known limitations

```text
KNOWN_GAPS=no runtime lease/fencing; no risk calculations; no CONTINUE/REDUCE/HALT gate; no halt state machine; no durable halt ACK; no telemetry/manifest; no execution coordinator; no venue adapter; HALT-transition and ACK-transition crash matrices deferred to later authorized checkpoints; allowRiskIncrease remains false even after REQUESTED_STATE_COMMITTED
UNVERIFIED_ASSUMPTIONS=local workstation is not the pinned Node/npm pair; directory fsync is attempted on every platform and is required on Linux/GitHub Actions; leftover temp files from a failed in-process write are preserved as evidence and are non-authoritative for an otherwise exact pair; arbitrary malicious Proxy traps remain an unverified Phase 2A limitation
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=Unix SIGKILL; Node fs exclusive create / fsync / rename; parent-directory fsync; child_process.spawn of TypeScript worker via --import tsx
FOLLOW_UP_REQUIRED=independent Phase 2B review; Phase 2C is not authorized
```

## 19. CI evidence

```text
CI_BINDING=PR_#3_METADATA_AFTER_PUSH
NPM_CI_PINNED_RUNTIME=GITHUB_ACTIONS_AUTHORITY
CI_RUN_IDS=recorded on Draft PR #3 after branch push
```

A CI result from a different SHA does not validate this candidate.

## 20. Prohibited-action attestation

```text
ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
PHASE_2C_STARTED=NO
PHASE_2C_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH=NO
NETWORK_ACCESS_IN_TESTS=NO
```

## 21. Requested reviewer decision

```text
PHASE_2B=REVIEW_CANDIDATE
PHASE_2B_SELF_DECLARED_PASS=NO
GATE_2=NOT_REVIEWED
REQUESTED_DECISION=PASS
CURRENT_CANDIDATE=PHASE_2B_ONLY
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
