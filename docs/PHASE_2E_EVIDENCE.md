# Phase 2E Evidence Packet — Halt / Kill-Switch / Durable ACK

Version: `0.1.0`
Checkpoint: durable halt state machine, kill-switch remediation, durable-authoritative acknowledgement
Requested reviewer decision: independent review of Phase 2E only
The implementation agent does **not** declare `PHASE_2E=PASS`, `GATE_2=PASS`, or live readiness.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2E
CHECKPOINT=HALT_KILL_SWITCH_DURABLE_ACK
REQUESTED_GATE=PHASE_2E_REVIEW
BRANCH=experiment/v0.1-phase2e-halt-ack
STACKED_PR_BASE=experiment/v0.1-phase2
BASE_SHA=7f196d367e39640eee9517f742b0d61424f9d4cc
BASE_TREE=1b0afe805269972cf7af40f7fbf0e4e6b3e35894
CURRENT_MAIN_HEAD=22665d7fa9274dfc05de043c8e9663e24e75087e
OLD_PR_NUMBER=3
WORKTREE_CLEAN_BEFORE=NO
WORKTREE_CLEAN_AFTER=YES
PHASE_2E_SELF_DECLARED_PASS=NO
GATE_2_DECLARED=NO
PHASE_2F_STARTED=NO
LIVE_TRADING_AUTHORIZED=NO
```

`RESULT_SHA` / `RESULT_TREE_SHA` / `STACKED_PR_NUMBER` / `CI_RUN_ID` are bound in the implementation handoff packet after the evidence commit and stacked Draft PR exist.

Pre-existing untracked `.omo/` session files were present before this checkpoint and were not committed.

## 2. Toolchain

```text
OS=Darwin
ARCH=arm64
KERNEL=Darwin 25.3.0 arm64
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
PACKAGE_MANAGER_VERSION=npm@10.9.8
```

Pinned-runtime authority for Gate review remains GitHub Actions on `ubuntu-latest` using the repository Node pin.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2E only: durable halt state, unique current haltId, kill-switch sequence, durable-authoritative ACK, safe resume gates, and real SIGKILL crash matrices for HALT and ACK transitions
ALLOWED_WRITE_PATHS=src/halt/**; src/persistence/**; src/risk/**; src/domain/**; src/simulator/**; src/index.ts; test/halt/**; test/persistence/**; test/risk/**; test/simulator/**; test/fixtures/phase2e-*; package.json scripts only; docs/PHASE_2E_EVIDENCE.md
FILES_ADDED=src/halt/*; test/halt/*; test/fixtures/phase2e-crash-worker.ts; docs/PHASE_2E_EVIDENCE.md
FILES_CHANGED=package.json
FILES_DELETED=NONE
CONTRACT_CHANGES=NO
EXPERIMENT_ENVELOPE_CHANGED=NO
INTENTIONALLY_UNTOUCHED_AREAS=Phase 2A/2B/2C/2D source bytes; authoritative contracts; AI_START_HERE.md; package-lock.json; dependencies; .github/**; trusted governance; venue adapters; network/signing/authentication; Phase 2F telemetry/manifest/supervisor; live mode; experiment/v0.1-phase2; PR #3 source HEAD; main
```

`src/risk/**`, `src/persistence/**`, `src/domain/**`, `src/simulator/**`, and `src/index.ts` were not modified. Phase 2D `evaluateRisk()` remains metrics-only with `systemAllowRiskIncrease=false`. Halt-layer `allowRiskIncrease` / `systemAllowRiskIncrease` are composed in `src/halt` after durable exact-pair proof.

The frozen `npm test` script expansion was left byte-identical so Phase 2D Corrective 4 evidence identity remains valid. Phase 2E tests run through `npm run test:phase2e`.

## 4. Validation commands

```text
NODE_COMMAND=node --version
NODE_EXIT=0
NODE_RESULT=v22.23.2

NPM_COMMAND=npm --version
NPM_EXIT=0
NPM_RESULT=10.9.8

INSTALL_COMMAND=npm ci
INSTALL_EXIT=0
INSTALL_RESULT=added 11 packages; found 0 vulnerabilities

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0

LINT_COMMAND=npm run lint
LINT_EXIT=0

TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=474
TEST_PASS=474
TEST_FAIL=0
TEST_SKIP=0

TEST_PHASE2D_CORRECTIVE_4_COMMAND=npm run test:phase2d-corrective-4
TEST_PHASE2D_CORRECTIVE_4_EXIT=0
TEST_PHASE2D_CORRECTIVE_4_TOTAL=15
TEST_PHASE2D_CORRECTIVE_4_PASS=15

TEST_EVIDENCE_PHASE2D_CORRECTIVE4_COMMAND=npm run test:evidence:phase2d-corrective4
TEST_EVIDENCE_PHASE2D_CORRECTIVE4_EXIT=0
TEST_EVIDENCE_PHASE2D_CORRECTIVE4_TOTAL=46
TEST_EVIDENCE_PHASE2D_CORRECTIVE4_PASS=46

EVIDENCE_PHASE2D_CORRECTIVE4_COMMAND=npm run evidence:phase2d-corrective4
EVIDENCE_PHASE2D_CORRECTIVE4_EXIT=0
EVIDENCE_PHASE2D_CORRECTIVE4_RESULT=schema v2 generated; fullTests=474; gateStatus=NOT_EMITTED

EVIDENCE_PHASE2D_CORRECTIVE4_VERIFY_COMMAND=npm run evidence:phase2d-corrective4:verify
EVIDENCE_PHASE2D_CORRECTIVE4_VERIFY_EXIT=1
EVIDENCE_PHASE2D_CORRECTIVE4_VERIFY_RESULT=IDENTITY: sourceBranch must be experiment/v0.1-phase2

TEST_PHASE2E_COMMAND=npm run test:phase2e
TEST_PHASE2E_EXIT=0
PHASE2E_TEST_TOTAL=24
PHASE2E_TEST_PASS=24
PHASE2E_TEST_FAIL=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (129 tracked files inspected). Post-commit count follows the evidence commit.

BUILD_COMMAND=npm run build
BUILD_EXIT=0

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

AUDIT_COMMAND=npm audit --json
AUDIT_EXIT=0
AUDIT_TOTAL_VULNERABILITIES=0

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
DIFF_CHECK_NOTE=Trailing markdown hard-breaks in this packet were removed before the final evidence commit so git diff --check is clean against the frozen Phase 2 base.
```

The Phase 2D evidence verifier fail-closes on this stacked branch name. That is expected: the verifier is bound to `experiment/v0.1-phase2`. It is not a Phase 2E implementation defect and was not “fixed” by editing governance or the verifier.

## 5. P2-H matrix

| ID | Test | PROCESS_ISOLATION | Result |
|---|---|---|---|
| P2-H01 | hard breach creates and persists unique halt ID | NO | PASS |
| P2-H02 | cancel failure remains non-running | NO | PASS |
| P2-H03 | cancel UNKNOWN remains halted/reconciliation-required | NO | PASS |
| P2-H04 | flatten failure becomes HALTED_UNFLAT or HALT_FAILED | NO | PASS |
| P2-H05 | flatten ACK plus stale snapshot is not HALTED_FLAT | NO | PASS |
| P2-H06 | fresh authoritative flat snapshot may persist HALTED_FLAT | NO | PASS |
| P2-H07 | restart without ACK remains halted | NO (fresh latch/fence, disk authority) | PASS |
| P2-H08 | stale previous halt ID is rejected | NO | PASS |
| P2-H09 | random or mismatched halt ID is rejected | NO | PASS |
| P2-H10 | forged caller state cannot override current durable exact pair | NO | PASS |
| P2-H11 | correct ID plus unsafe fresh state does not authorize RUNNING | NO | PASS |
| P2-H12 | correct ID plus every safe gate reaches RUNNING only after exact durable commit | NO | PASS |
| P2-H13 | crash during ACK persistence never infers caller-memory clearance | YES for storage matrix; NO for in-process caller-memory assertion | PASS |

```text
P2_H01_TO_H13_MATRIX=PASS
DURABLE_HALT_ID_PROVEN=YES
STALE_ID_REJECTION_PROVEN=YES
FORGED_CALLER_STATE_REJECTION_PROVEN=YES
SAFE_RESUME_EXACT_COMMIT_PROVEN=YES
ACTIVE_LEASE_RECHECK_PROVEN=YES
UNRESOLVED_UNKNOWN_RESERVED=YES
```

Each P2-H test asserts durable status, runtime disposition, `allowRiskIncrease`, `systemAllowRiskIncrease`, halt ID, durable generation/hash, lease generation, mutation invocation, and unresolved possible-exposure reservation.

## 6. Real process-crash matrix

```text
CHILD_PROCESS_CRASH_TESTS_RUN=YES
TERMINATION_METHOD=parent SIGKILL
FRESH_PROCESS_RELOAD=YES
BACKUP_WINDOWS_TESTED=A,B,C,D,E,F,G,H
PRIMARY_WINDOWS_TESTED=A,B,C,D,E,F,G,H
HALT_TRANSITION_WINDOWS_TESTED=RUNNING->HALTING backup/primary A..H; HALTING->HALTED_FLAT backup/primary A..H
ACK_TRANSITION_WINDOWS_TESTED=HALTED_FLAT->RUNNING backup/primary A..H
HALT_CRASH_CASE_TOTAL=32
HALT_CRASH_CASE_PASS=32
ACK_CRASH_CASE_TOTAL=16
ACK_CRASH_CASE_PASS=16
FRESH_PROCESS_RELOAD_PROVEN=YES
```

Allowed post-crash outcomes only:

```text
proven old exact pair
proven complete new exact pair
fail-closed / halted / risk blocked
```

A new RUNNING pair is accepted only when acknowledgement lineage binds `acknowledgedHaltId=h1`. Caller memory is not consulted by the fresh inspect worker.

Worker: `test/fixtures/phase2e-crash-worker.ts`. Parent never uses child in-memory state.

## 7. Safety claims for this checkpoint

```text
DRY_RUN_DEFAULT=PROVEN (unchanged bootstrap)
LIVE_MODE_FAIL_CLOSED=PROVEN (unchanged)
NO_LIVE_WRITE_PATH=PROVEN dry-run liveExchangeWrites=false; halt mutations are simulator/test doubles
DECIMAL_ARITHMETIC_AUTHORITY=UNCHANGED Phase 2D
HALT_PERSISTENCE=PROVEN P2-H01/H06 exact-pair HALTING then terminal status
DURABLE_HALT_ACK=PROVEN P2-H08/H09/H10/H11/H12
RUNTIME_PERSISTENCE_LATCH=PROVEN P2E-I03 same-process ACK rejected when latched
RUNTIME_LEASE_FENCING=PROVEN lease rechecked before persist and each fenced mutation
UNOWNED_CANCEL_REFUSED=PROVEN P2-H01/H02 foreign orders never cancelled
CANCEL_FAILURE_NON_RUNNING=PROVEN P2-H02
CANCEL_UNKNOWN_RESERVED=PROVEN P2-H03
FLATTEN_ACK_NOT_FLATNESS=PROVEN P2-H05
FRESH_SNAPSHOT_FLATNESS=PROVEN P2-H06
REDUCE_DISTINCT_FROM_HALT=PROVEN P2E-I01
CONTINUE_CANNOT_OVERRIDE_HALT=PROVEN P2E-I02
PHASE2D_LIMITS_UNCHANGED=PROVEN 150U / -5U / 10U / boundary / freshness / lease via evaluateRisk composition
FATAL_RUNTIME_FAIL_CLOSED=NOT_IMPLEMENTED_THIS_PHASE
TELEMETRY_MANIFEST=NOT_IMPLEMENTED_THIS_PHASE
INTEGRATED_RESTART_SUPERVISOR=NOT_IMPLEMENTED_THIS_PHASE
```

## 8. Integration with Phase 2D

- `HALT` from `evaluateRisk` enters `executeHardHalt`.
- `REDUCE` remains a distinct non-halt path (`runtimeDisposition=REDUCING`, no haltId).
- `CONTINUE` cannot override a current durable non-RUNNING halt.
- Current exact-pair halt state is loaded before risk increase.
- Stale/missing risk inputs still fail closed inside unchanged `evaluateRisk`.
- Unresolved `UNKNOWN` cancel/flatten remains exposure-reserved.
- Frozen 150U / -5U / 10U / boundary / freshness / lease metric rules are unchanged.

## 9. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
NETWORK_MUTATION=NO
PHASE_2F_STARTED=NO
GATE_2_DECLARED=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
SELF_DECLARED_PASS=NO
```

## 10. Known limitations

```text
KNOWN_GAPS=Phase 2F telemetry/manifest and integrated restart supervisor are not implemented; evaluateRisk() still emits DURABLE_HALT_OR_ACK_UNAVAILABLE because Phase 2D bytes were frozen; halt-layer systemAllowRiskIncrease is a halt/ACK authority bit, not live-write authorization; host-local lease fencing remains HOST_LOCAL_FILESYSTEM_ONLY; flatten/cancel transports are simulator/test doubles only
UNVERIFIED_ASSUMPTIONS=GitHub Actions Ubuntu SIGKILL matrix will match local Darwin results
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=parent-delivered SIGKILL; directory fsync
FOLLOW_UP_REQUIRED=independent Phase 2E review; do not start Phase 2F without authorization; Phase 2D evidence verifier is branch-bound to experiment/v0.1-phase2
```

## 11. Requested reviewer decision

```text
REQUESTED_DECISION=independent Phase 2E review
SELF_DECLARED_PASS=NO
```
