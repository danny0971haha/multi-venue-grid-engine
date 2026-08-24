# Phase 2C Evidence Packet — Runtime Lease and Fencing

Version: `0.1.0`  
Checkpoint: durable runtime lease, host-local coordination, fencing generation, real child-process contention/SIGKILL matrix  
Requested reviewer decision: independent review of Phase 2C only  
The implementation agent does **not** declare `PHASE_2C=PASS` or `GATE_2=PASS`.

## 1. Identity

```text
PHASE=2C
REQUESTED_GATE=PHASE_2C_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2C
CHECKPOINT=RUNTIME_LEASE_AND_FENCING
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
BASE_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
BASE_TREE=8163e36c676f8b1d5332cdbc713b0672ea4fe148
IMPLEMENTATION_HEAD=78f8010a7c247936dbd6c5a50ea98e222f350bac
IMPLEMENTATION_TREE=d015838983e85fb56e000240fa343ad02e64972d
ACCEPTED_PHASE_2B_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
ACCEPTED_PHASE_2B_TREE=8163e36c676f8b1d5332cdbc713b0672ea4fe148
ACCEPTED_PHASE_2B_CI_RUN=32708431819
WORKTREE_CLEAN_BEFORE=YES
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_STARTED=NO
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
PRIMARY_OBJECTIVE=Phase 2C only: durable runtime lease, exactly-one owner per scope, host-local atomic coordination, monotonic fencing generation, heartbeat, expiry, takeover, release, mutation-adjacent fencing, real child-process contention and SIGKILL evidence
ALLOWED_WRITE_PATHS=docs/PHASE_2C_CONTRACT.md; docs/PHASE_2C_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md (status block); src/persistence/runtime-lease.ts; src/persistence/lease-coordination.ts; src/persistence/index.ts; test/persistence/runtime-lease.test.ts; test/fixtures/phase2c-lease-worker.ts; package.json; CI workflow timeout only
FILES_ADDED=docs/PHASE_2C_CONTRACT.md; src/persistence/lease-coordination.ts; src/persistence/runtime-lease.ts; test/fixtures/phase2c-lease-worker.ts; test/persistence/runtime-lease.test.ts
FILES_CHANGED=docs/IMPLEMENTATION_CONTRACT.md; package.json; src/persistence/index.ts; .github/workflows/ci.yml
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; src/persistence/exact-pair-inspection.ts; src/persistence/atomic-pair-store.ts; src/persistence/runtime-persistence-latch.ts; test/fixtures/phase2a-canonical-vector.ts; Phase 2A/2B tests; src/simulator/**; src/domain/**; src/strategy/**; src/math/**; src/bootstrap/**; src/index.ts; venue adapters; risk engine; halt/ACK; telemetry; lockfile; live-mode behavior; Phase 2D+
```

Phase 2A and Phase 2B current-byte files were not modified.

## 4. Current-byte evidence versus accepted Phase 2B HEAD

`git diff --name-status 41eb277a7d6dfe36dbb864bc8190d5a20663dc4a` for implementation commit `78f8010a7c247936dbd6c5a50ea98e222f350bac`:

```text
M	.github/workflows/ci.yml
M	docs/IMPLEMENTATION_CONTRACT.md
A	docs/PHASE_2C_CONTRACT.md
M	package.json
M	src/persistence/index.ts
A	src/persistence/lease-coordination.ts
A	src/persistence/runtime-lease.ts
A	test/fixtures/phase2c-lease-worker.ts
A	test/persistence/runtime-lease.test.ts
```

`git diff --stat` for that implementation commit:

```text
 .github/workflows/ci.yml               |    2 +-
 docs/IMPLEMENTATION_CONTRACT.md        |   10 +-
 docs/PHASE_2C_CONTRACT.md              |  424 +++++++++++
 package.json                           |    1 +
 src/persistence/index.ts               |   43 ++
 src/persistence/lease-coordination.ts  |  177 +++++
 src/persistence/runtime-lease.ts       | 1245 ++++++++++++++++++++++++++++++++
 test/fixtures/phase2c-lease-worker.ts  |  383 ++++++++++
 test/persistence/runtime-lease.test.ts | 1191 ++++++++++++++++++++++++++++++
 9 files changed, 3471 insertions(+), 5 deletions(-)
```

```text
PR_OR_PATCH_REFERENCE=Draft PR #3 against experiment/v0.1-phase1
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
LOCKFILE_CHANGED=NO
GENERATED_SCHEMA_HASHES=N/A
```

CI timeout-minutes changed from 10 to 25 so the added child-process matrices can finish. No deploy job was added.

## 5. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Coordination uses `node:fs` exclusive create plus `process.kill(pid, 0)` liveness. Lease writes reuse Phase 2B `initializeExactPair` / `persistExactPairTransition`.

## 6. Contract changes

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2B_CONTRACT.md; docs/PHASE_2B_EVIDENCE.md; docs/RISK_PERSISTENCE_CONTRACT.md; docs/TEST_FAULT_MATRIX.md; docs/ACCEPTANCE_GATES.md; docs/REVIEW_CHANGE_PROTOCOL.md; docs/EVIDENCE_TEMPLATE.md
CONTRACT_FILES_CHANGED=docs/PHASE_2C_CONTRACT.md (new, does not weaken parents); docs/IMPLEMENTATION_CONTRACT.md (narrow status block only); docs/PHASE_2C_EVIDENCE.md (this packet)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
PHASE_2A_CURRENT_BYTE_CHANGED=NO
PHASE_2B_CURRENT_BYTE_CHANGED=NO
PHASE_2D_STARTED=NO
```

`docs/IMPLEMENTATION_CONTRACT.md` status block now records:

```text
GATE_0=PASS
GATE_1=PASS
PHASE_2A=PASS
PHASE_2B=PASS
ACCEPTED_PHASE_2B_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
AUTHORIZED_CHECKPOINT=PHASE_2C_ONLY
PHASE_2C=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_AUTHORIZED=NO
GATE_2=NOT_REVIEWED
ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```

## 7. Lease record schema

```text
LEASE_RECORD_SCHEMA=
  schemaVersion: 1
  scopeKey: string
  ownerId: string
  processInstanceId: string
  generation: canonical positive decimal string
  status: ACTIVE | RELEASED
  acquiredAt: canonical unix-ms decimal string
  heartbeatAt: canonical unix-ms decimal string
  expiresAt: heartbeatAt + LEASE_TTL_MS
  updatedAt: canonical unix-ms decimal string

kind=runtime-lease
stateName=runtime-lease
generation never converted through JavaScript number
```

`LeaseAuthority` binds `scopeKey`, `ownerId`, `processInstanceId`, `generation`, `leaseEnvelopeSha256`, `leaseStoreGeneration`, `observedExpiresAt`. A loose `{ isOwner: true }` boolean is not returned.

## 8. Coordination capability

```text
COORDINATION_CAPABILITY=HOST_LOCAL_FILESYSTEM_ONLY
DISTRIBUTED_FENCING_PROVEN=NO
```

Atomic primitive: exclusive `O_EXCL` create of `llock`, PID written as a liveness hint only, `process.kill(pid, 0)` to distinguish live vs crashed holder, exclusive `llock.recover` before stale unlink. Unexpected residue is not recursively deleted.

Shared / multi-host coordination requests return `DISTRIBUTED_FENCING_UNPROVEN` and do not continue (`2C-L26`).

PID is not lease authority.

## 9. Protocols

```text
ACQUISITION_PROTOCOL=latch-unblocked -> host-local guard -> exact-pair inspect -> initializeExactPair on clean BOTH_ABSENT OR takeover via persistExactPairTransition when RELEASED/expired -> final exact-pair readback -> LeaseAuthority; unexpired ACTIVE second owner BLOCKED without write
HEARTBEAT_PROTOCOL=guard -> fresh exact pair -> exact scope/owner/process/generation -> ACTIVE unexpired -> generation and acquiredAt unchanged -> heartbeatAt monotonic -> expiresAt=heartbeatAt+TTL -> compare-and-commit -> readback; failure blocks latch
EXPIRY_RULE=expired <=> nowMs >= expiresAtMs; nowMs == expiresAtMs-1 blocked; exact expiry allows takeover after guard + durable generation+1
CLOCK_SKEW_RULE=LEASE_TTL_MS=30000; MAX_CLOCK_SKEW_MS=1000; MAX_FORWARD_JUMP_MS=86400000; CLOCK_REGRESSION if heartbeatAt-now > skew; FUTURE_TIMESTAMP if acquiredAt-now > skew; CLOCK_FORWARD_JUMP if now-heartbeatAt > 24h; malformed/excessive timestamps fail closed
TAKEOVER_PROTOCOL=guard -> prove RELEASED or expired ACTIVE -> new owner/processInstance -> fencing generation+1 via Phase 2B backup-first compare-and-commit -> new LeaseAuthority
RELEASE_PROTOCOL=exact current tuple only -> durable status=RELEASED; files not deleted; stale release cannot overwrite newer owner
FENCED_MUTATION_PROTOCOL=guard -> fresh inspect -> latch/scope/owner/process/generation/ACTIVE/unexpired -> optional test-only pre-callback hook (default null) -> synchronous readFileSync pair reconfirm -> callback at most once; failure NOT_SENT count=0; callback throw UNKNOWN count=1; SENT still allowRiskIncrease=false
```

## 10. Concurrent contender matrix

Real child processes, assertions from result files and fresh-process disk inspect:

| ID | Contenders | Observed |
|---|---|---|
| 2C-L02 | 2 children, shared start flag | exactly 1 `ACQUIRED`, 1 `BLOCKED`; disk one owner generation `"1"` |
| 2C-L03 | 32 children, shared start flag | exactly 1 `ACQUIRED`, 31 not acquired; disk one owner generation `"1"` |
| 2C-L04 | second owner same clock | `BLOCKED` / `LEASE_HELD_BY_OTHER`; disk unchanged first owner |

```text
CONCURRENT_CONTENDER_MATRIX=2C-L02:1/2 ACQUIRED; 2C-L03:1/32 ACQUIRED; no dual owner on disk
```

## 11. Real SIGKILL matrix

Termination method: `SIGKILL`. Fresh-process inspect only. Ubuntu must not skip.

### 2C-L20 active owner

```text
pre-expiry contender BLOCKED
SIGKILL owner
pre-expiry contender still BLOCKED
post-expiry takeover ACQUIRED generation=2
allowRiskIncrease=false
```

### 2C-L21 crash during initial acquisition (BACKUP+PRIMARY A..H)

Allowed observed classes only: `CLEAN_ABSENT` / `EXACT_LEASE` / `UNPROVEN`. Never two owners. `allowRiskIncrease=false`.

Lease writes use the accepted Phase 2B backup-first windows, so observed classes follow that persist matrix: backup A–E typically `CLEAN_ABSENT`; backup F–H `UNPROVEN`; primary A–E `UNPROVEN`; primary F–H `EXACT_LEASE`.

### 2C-L22 crash during heartbeat (BACKUP+PRIMARY A..H)

Allowed: old exact / new exact / unproven. Proven pairs kept `ownerA` generation `"1"`.

### 2C-L23 crash during takeover (BACKUP+PRIMARY A..H)

Allowed: old owner / new owner / unproven. Never both authorized. Proven `ownerA` stays generation `"1"`; proven `ownerB` is generation `"2"`.

```text
REAL_SIGKILL_MATRIX=2C-L20 + 2C-L21 16 windows + 2C-L22 16 windows + 2C-L23 16 windows; 2C-L29 Phase 2B A..H remain present and green
CHILD_PROCESS_CRASH_TESTS_RUN=YES
FRESH_PROCESS_RELOAD=YES
```

## 12. Stale-owner fencing results

```text
STALE_OWNER_MATRIX=
  2C-L08 old heartbeat after takeover rejected; pair bytes unchanged
  2C-L09 old mutation NOT_SENT callbackCount=0
  2C-L10 generation replaced before callback NOT_SENT callbackCount=0
  2C-L11 mid-sequence loss: later mutations NOT_SENT
  2C-L12 rewrite of old exact bytes cannot restore authority
  2C-L13 forged ownerId/processInstanceId/generation rejected
  2C-L24 release fences old token; next acquire generation 2
  2C-L25 stale release cannot overwrite new owner
```

## 13. Persistence latch composition

```text
PERSISTENCE_LATCH_COMPOSITION=
  unproven/missing/corrupt/conflicting/ahead pair blocks latch (2C-L14)
  already-blocked latch fails acquire/heartbeat/mutation (2C-L15)
  later REQUESTED_STATE_COMMITTED persist cannot clear latch (2C-L16)
  clock-rule and persist ambiguity block latch
  normal second-owner rejection does not block latch
  setPersistenceFaultHookForTests remains default null with no env/CLI activation
```

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
LINT_RESULT=biome lint clean, 47 files

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=biome format clean, 47 files

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

FOCUSED_PHASE2C_COMMAND=npm run test:phase2c
FOCUSED_PHASE2C_EXIT=0
FOCUSED_PHASE2C_TOTAL=30
FOCUSED_PHASE2C_PASS=30
FOCUSED_PHASE2C_FAIL=0
FOCUSED_PHASE2C_SKIP=0

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=249
TEST_PASS=249
TEST_FAIL=0
TEST_SKIP=0
EXISTING_TESTS_REMAINING=219
NEW_PHASE_2C_TESTS=30

BUILD_COMMAND=npm run build
BUILD_EXIT=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=passed (79 tracked files inspected before this packet commit)

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
TEST_TOTAL=249
TEST_PASS=249
TEST_FAIL=0
TEST_SKIP=0
PHASE_2A_FOCUSED=73/73
PHASE_2B_FOCUSED=26/26
PHASE_2C_FOCUSED=30/30
EXISTING_219=present and green
SIGKILL_SKIPPED_ON_UBUNTU=must be 0; local Darwin also 0 skipped
```

Required IDs `P2-L01`–`P2-L08` and `2C-L01`–`2C-L30` are present in `test/persistence/runtime-lease.test.ts`.

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
RUNTIME_LEASE_FENCING=src/persistence/runtime-lease.ts; tests 2C-L01..2C-L27
HOST_LOCAL_COORDINATION=src/persistence/lease-coordination.ts; 2C-L02, 2C-L03, 2C-L26
RUNTIME_PERSISTENCE_LATCH=composed unchanged; 2C-L14..2C-L16
REAL_SIGKILL=2C-L20..2C-L23; 2C-L29
FROZEN_PHASE_2A_VECTORS=untouched; 2B-P25 still green
EXISTING_219=2C-L28 + npm test 249=219+30
RISK_GATE=NOT_IMPLEMENTED_THIS_PHASE
HALT_PERSISTENCE=NOT_IMPLEMENTED_THIS_PHASE
DURABLE_HALT_ACK=NOT_IMPLEMENTED_THIS_PHASE
TELEMETRY=NOT_IMPLEMENTED_THIS_PHASE
```

## 18. Known limitations

```text
KNOWN_GAPS=no risk calculations; no CONTINUE/REDUCE/HALT gate; no halt state machine; no durable halt ACK; no telemetry/manifest; no execution coordinator; no venue adapter; mutation fencing is network-free and does not connect a venue; allowRiskIncrease remains false even after ACQUIRED/SENT
UNVERIFIED_ASSUMPTIONS=local workstation is not the pinned Node/npm pair; coordination is HOST_LOCAL_FILESYSTEM_ONLY; PID liveness is not lease authority and can fail closed on PID-reuse uncertainty; a fresh process that never observed a higher fencing generation cannot detect an offline smash of both exact-pair files back to an older exact pair without a durable generation archive (not in Phase 2C scope); stale-owner rewrite is rejected for the fenced process and for expired/diverged records
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=Unix process.kill(pid, 0) liveness; Node fs exclusive create; child_process.spawn of TypeScript worker via --import tsx; SIGKILL
FOLLOW_UP_REQUIRED=independent Phase 2C review; Phase 2D is not authorized
DISTRIBUTED_FENCING_PROVEN=NO
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
PHASE_2D_STARTED=NO
PHASE_2D_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH=NO
NETWORK_ACCESS_IN_TESTS=NO
```

## 21. Requested reviewer decision

```text
PHASE_2C=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
GATE_2=NOT_REVIEWED
REQUESTED_DECISION=PASS
CURRENT_CANDIDATE=PHASE_2C_ONLY
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
