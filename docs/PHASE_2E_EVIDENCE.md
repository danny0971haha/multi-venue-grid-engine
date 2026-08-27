# Phase 2E Evidence Packet — Runtime Corrective 1

Version: `0.1.1`
Checkpoint: `PHASE_2E_RUNTIME_CORRECTIVE_1`
Requested reviewer decision: independent review of Phase 2E runtime corrective 1 only
The implementation agent does **not** declare `PHASE_2E=PASS`, `GATE_2=PASS`, or live readiness.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2E
CHECKPOINT=PHASE_2E_RUNTIME_CORRECTIVE_1
REQUESTED_GATE=PHASE_2E_REVIEW
BRANCH=experiment/v0.1-phase2e-halt-ack
STACKED_PR_BASE=experiment/v0.1-phase2
BASE_SHA=7f196d367e39640eee9517f742b0d61424f9d4cc
BASE_TREE=1b0afe805269972cf7af40f7fbf0e4e6b3e35894
PREVIOUS_HEAD=7b98c888543b980dee48b27f4497db1bf93a7970
PREVIOUS_TREE=1a0232ff0fbb0116b7879e1e27ba8ffb66d2b71f
IMPLEMENTATION_HEAD=597f4c25ee9558bc797eeb68dadf0fd6587f75a4
IMPLEMENTATION_TREE=4058b003cc77303dcb2ed5aa3b6d1239593f2d38
FEAT_COMMIT=08af13763c183ab17dec6485448adba8818d50da
TEST_COMMIT=597f4c25ee9558bc797eeb68dadf0fd6587f75a4
WORKTREE_CLEAN_BEFORE=NO
WORKTREE_CLEAN_AFTER=YES
PHASE_2E_SELF_DECLARED_PASS=NO
GATE_2_DECLARED=NO
PHASE_2F_STARTED=NO
LIVE_TRADING_AUTHORIZED=NO
CALLER_RESUME_EVIDENCE_AUTHORITATIVE=NO
INTERNAL_ACK_SNAPSHOT_PROVEN=YES
LEASE_RECHECK_BEFORE_ACK_COMMIT=YES
FINAL_PAIR_REINSPECTED=YES
TRANSPORT_EXCEPTIONS_FAIL_CLOSED=YES
DEFAULT_CI_INCLUDES_PHASE2E=YES
```

`RESULT_HEAD` / `RESULT_TREE` are the evidence commit that adds this packet. Pre-existing untracked `.omo/` session files were present before this checkpoint and were not committed.

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

Host `PATH` used the already-present pinned binary at `/tmp/node-v22.23.2-darwin-arm64/bin`. Pinned-runtime authority for Gate review remains GitHub Actions on `ubuntu-latest` using the repository Node pin.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2E runtime corrective 1: internally sourced ACK authority; hard-halt transport exception boundary; default CI executes test/halt
ALLOWED_WRITE_PATHS=src/halt/**; test/halt/**; test/fixtures/phase2e-crash-worker.ts; package.json scripts only; docs/PHASE_2E_EVIDENCE.md
FILES_ADDED=test/halt/p2e-corrective-1.test.ts
FILES_CHANGED=package.json; src/halt/engine.ts; src/halt/index.ts; src/halt/record.ts; src/halt/transport.ts; src/halt/types.ts; test/fixtures/phase2e-crash-worker.ts; test/halt/halt-crash-matrix.test.ts; test/halt/helpers.ts; test/halt/p2-h-matrix.test.ts; docs/PHASE_2E_EVIDENCE.md
FILES_DELETED=NONE
CONTRACT_CHANGES=NO
EXPERIMENT_ENVELOPE_CHANGED=NO
INTENTIONALLY_UNTOUCHED_AREAS=Phase 2A/2B/2C/2D source bytes; Phase 2A/2B/2C/2D evidence and verifier bytes; authoritative contracts; AI_START_HERE.md; package-lock.json; dependencies and devDependencies; .github/**; scripts/governance/**; .github/trusted/**; venue adapters; network/signing/authentication; Phase 2F telemetry/manifest/supervisor; live mode; experiment/v0.1-phase2; main
```

`package.json` scripts only: `npm test` now includes `test/halt/*.test.ts`. `dependencies` and `devDependencies` were not modified. `package-lock.json` SHA-256 remained `a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51`.

## 4. ACK authority proof

`acknowledgeHalt` public request is `HaltAcknowledgeRequest` with `suppliedHaltId` plus non-authoritative operator metadata. `resumeEvidence` and `resumeRiskInput`, if present, are ignored and emit `CALLER_RESUME_EVIDENCE_IGNORED` / `CALLER_RISK_INPUT_IGNORED`. `ignoredCallerState` still emits `FORGED_CALLER_STATE_IGNORED`.

Inside `acknowledgeHalt`:

1. reload current durable exact-pair halt authority;
2. verify exact current `haltId`;
3. prove the current runtime lease;
4. obtain a fresh snapshot under `runLeaseFencedMutation`;
5. obtain open orders under the same lease-fenced exception-classifying boundary;
6. classify `observedAt` from engine-controlled halt clock vs snapshot time (stale / future / malformed), not from caller or adapter booleans alone;
7. verify snapshot source identity against `expectedSnapshotSourceId`;
8. verify authoritative flag, exact lease generation, no unresolved possible exposure, no owned risk-increasing orders, and no unknown reservations;
9. build trusted `RiskInput` from the internal snapshot and durable record, then `evaluateRisk`;
10. require `action=CONTINUE` and `riskMetricsWithinLimits=true`, frozen 150U planned/actual envelope, and snapshot/metrics equality;
11. re-prove the lease immediately before the durable ACK transition (`beforeAckPersistLeaseRecheck`);
12. persist acknowledgement lineage including `snapshotSourceId`, `snapshotObservedAt`, and `snapshotLeaseGeneration`;
13. reload and prove the final exact RUNNING pair, including snapshot identity fields;
14. clear `HaltProcessFence` only after that final proof.

Any snapshot failure, exception, stale/future/malformed observation, lease mismatch, non-authoritative state, unsafe exposure, remaining owned risk-increasing order, unresolved reservation, risk breach, or final-pair uncertainty rejects ACK, keeps durable state non-RUNNING, keeps the process fence tripped, and keeps `allowRiskIncrease=false` / `systemAllowRiskIncrease=false`.

## 5. Hard-halt exception boundary

`listOpenOrders` executes inside `runLeaseFencedMutation`. Thrown or rejected `listOpenOrders` is classified `UNKNOWN` / `RECONCILIATION_REQUIRED`. Thrown cancel, flatten, reduce, and `freshSnapshot` remain deterministic `UNKNOWN` outcomes via the same fencing. An unexpected remediation exception after HALTING is committed returns a structured fail-closed result that preserves proven HALTING authority. Flatness is never inferred from a flatten ACK. `HALTED_FLAT` still requires a fresh internally time-checked authoritative snapshot. UNOWNED and AMBIGUOUS orders are never cancelled. UNKNOWN writes are not retried as NOT_SENT.

## 6. Validation commands

```text
NODE_COMMAND=node --version
NODE_EXIT=0
NODE_RESULT=v22.23.2

NPM_COMMAND=npm --version
NPM_EXIT=0
NPM_RESULT=10.9.8

INSTALL_COMMAND=npm ci
INSTALL_EXIT=0
INSTALL_RESULT=added 11 packages; found 0 vulnerabilities; package-lock.json SHA-256 unchanged

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=Checked 94 files. Gitignored leftover artifacts/phase2d-corrective4 JSON was moved aside so biome did not rewrite Phase 2D evidence artifacts.

LINT_COMMAND=npm run lint
LINT_EXIT=0

TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0

TEST_COMMAND=npm test
TEST_EXIT=1
TEST_TOTAL=516
TEST_PASS=473
TEST_FAIL=43
TEST_SKIP=0
TEST_FAIL_SCOPE=test/evidence/phase2d-corrective4-evidence.test.ts identity suite; first assertion PACKAGE_SCRIPT: npm test script is not the exact expected expansion. Halt tests in the same npm test run all passed. This failure was not relabeled as success and Phase 2D evidence/verifier bytes were not edited.

TEST_PHASE2E_COMMAND=npm run test:phase2e
TEST_PHASE2E_EXIT=0
PHASE2E_TEST_TOTAL=42
PHASE2E_TEST_PASS=42
PHASE2E_TEST_FAIL=0

TEST_PHASE2D_CORRECTIVE_4_COMMAND=npm run test:phase2d-corrective-4
TEST_PHASE2D_CORRECTIVE_4_EXIT=0
TEST_PHASE2D_CORRECTIVE_4_TOTAL=15
TEST_PHASE2D_CORRECTIVE_4_PASS=15

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (141 files inspected before the evidence commit; post-commit count follows this commit).

BUILD_COMMAND=npm run build
BUILD_EXIT=0

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

AUDIT_COMMAND=npm audit --json
AUDIT_EXIT=0
AUDIT_HIGH=0
AUDIT_CRITICAL=0
AUDIT_TOTAL_VULNERABILITIES=0

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
```

Default CI (`npm test` in `.github/workflows/ci.yml`, unchanged) now expands to `test/halt/*.test.ts`. A green `npm test` on this stacked branch is not claimed: the frozen Phase 2D evidence suite still requires the prior `npm test` expansion and `experiment/v0.1-phase2`.

## 7. Corrective-1 test matrix

| ID | Test | PROCESS_ISOLATION | Result |
|---|---|---|---|
| P2E-C1-01 | forged caller resumeEvidence cannot authorize RUNNING | NO | PASS |
| P2E-C1-02 | safe caller claims plus unsafe internal snapshot remain halted | NO | PASS |
| P2E-C1-03 | safe caller risk input plus internally observed over-cap actual notional remains halted | NO | PASS |
| P2E-C1-04 | internal snapshot lease-generation mismatch rejects ACK | NO | PASS |
| P2E-C1-05 | stale observedAt rejects ACK | NO | PASS |
| P2E-C1-06 | future or malformed observedAt rejects ACK | NO | PASS |
| P2E-C1-07 | non-authoritative internal snapshot rejects ACK | NO | PASS |
| P2E-C1-08 | owned risk-increasing orders remaining reject ACK | NO | PASS |
| P2E-C1-09 | unresolved UNKNOWN reservation rejects ACK | NO | PASS |
| P2E-C1-10 | lease changes after snapshot but before ACK persistence | NO | PASS |
| P2E-C1-11 | final exact-pair uncertainty never clears the process fence | NO | PASS |
| P2E-C1-12 | listOpenOrders throw returns structured non-running result | NO | PASS |
| P2E-C1-13 | cancel throw remains reconciliation-required/non-running | NO | PASS |
| P2E-C1-14 | flatten throw remains reconciliation-required/non-running | NO | PASS |
| P2E-C1-15 | freshSnapshot throw rejects ACK and remains non-running | NO | PASS |
| P2E-C1-16 | restart after every rejected ACK remains halted | NO (fresh latch/fence) | PASS |
| P2E-C1-17 | real parent-delivered SIGKILL during corrected ACK windows | YES | PASS |

P2-H01 through P2-H13, P2E-I01 through P2E-I05, the 32-case HALT crash matrix, and the 16-case ACK crash matrix were preserved and rerun; all passed. C1-17 reruns BACKUP+PRIMARY A..H ACK windows and accepts only proven old halt pair, proven complete new RUNNING pair with ACK lineage plus internally sourced snapshot identity, or fail-closed/unproven state.

```text
P2_H01_TO_H13_MATRIX=PASS
P2E_C1_01_TO_C1_17_MATRIX=PASS
HALT_CRASH_CASE_TOTAL=32
HALT_CRASH_CASE_PASS=32
ACK_CRASH_CASE_TOTAL=16
ACK_CRASH_CASE_PASS=16
C1_17_ACK_CRASH_WINDOWS=16
CHILD_PROCESS_CRASH_TESTS_RUN=YES
TERMINATION_METHOD=parent SIGKILL
FRESH_PROCESS_RELOAD=YES
```

## 8. Safety claims for this checkpoint

```text
DRY_RUN_DEFAULT=PROVEN liveExchangeWrites=false
NO_LIVE_WRITE_PATH=PROVEN
CALLER_RESUME_EVIDENCE_AUTHORITATIVE=NO P2E-C1-01/C1-03/P2-H10
INTERNAL_ACK_SNAPSHOT_PROVEN=YES P2E-C1-01..C1-11 and successful ACK snapshot identity
LEASE_RECHECK_BEFORE_ACK_COMMIT=YES P2E-C1-10
FINAL_PAIR_REINSPECTED=YES P2E-C1-11
TRANSPORT_EXCEPTIONS_FAIL_CLOSED=YES P2E-C1-12..C1-15
DURABLE_HALT_ACK=PROVEN P2-H08/H09/H12 plus corrective-1
FLATTEN_ACK_NOT_FLATNESS=PROVEN P2-H05 unchanged
UNOWNED_CANCEL_REFUSED=PROVEN P2-H01/H02
CANCEL_UNKNOWN_RESERVED=PROVEN P2-H03/C1-13
DEFAULT_CI_INCLUDES_PHASE2E=YES package.json npm test includes test/halt/*.test.ts
PHASE2D_LIMITS_UNCHANGED=PROVEN src/risk/** byte-identical in this corrective
FATAL_RUNTIME_FAIL_CLOSED=NOT_IMPLEMENTED_THIS_PHASE
TELEMETRY_MANIFEST=NOT_IMPLEMENTED_THIS_PHASE
```

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
PHASE_2D_EVIDENCE_RELABELED_SUCCESS=NO
```

## 10. Known limitations

```text
KNOWN_GAPS=Phase 2F telemetry/manifest and integrated restart supervisor are not implemented; evaluateRisk() still emits DURABLE_HALT_OR_ACK_UNAVAILABLE because Phase 2D bytes were frozen; halt-layer systemAllowRiskIncrease is a halt/ACK authority bit, not live-write authorization; host-local lease fencing remains HOST_LOCAL_FILESYSTEM_ONLY; flatten/cancel transports are simulator/test doubles only; npm test on this stacked branch exits 1 because the frozen Phase 2D evidence verifier still requires the prior npm test expansion and branch experiment/v0.1-phase2
UNVERIFIED_ASSUMPTIONS=GitHub Actions Ubuntu SIGKILL matrix will match local Darwin results
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=parent-delivered SIGKILL; directory fsync
FOLLOW_UP_REQUIRED=independent Phase 2E review; do not start Phase 2F without authorization; do not treat npm test EXIT=1 evidence-suite identity failure as Phase 2E implementation success or as a reason to edit Phase 2D evidence bytes
```

## 11. Requested reviewer decision

```text
REQUESTED_DECISION=independent Phase 2E runtime corrective 1 review
SELF_DECLARED_PASS=NO
```
