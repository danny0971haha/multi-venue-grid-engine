# Phase 2E Evidence Packet — Runtime Corrective 2

Version: `0.1.2`
Checkpoint: `PHASE_2E_RUNTIME_CORRECTIVE_2`
Requested reviewer decision: independent review of Phase 2E runtime corrective 2 only
The implementation agent does **not** declare `PHASE_2E=PASS`, `GATE_2=PASS`, or live readiness.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2E
CHECKPOINT=PHASE_2E_RUNTIME_CORRECTIVE_2
REQUESTED_GATE=PHASE_2E_REVIEW
BRANCH=experiment/v0.1-phase2e-halt-ack
STACKED_PR_BASE=experiment/v0.1-phase2
BASE_SHA=7f196d367e39640eee9517f742b0d61424f9d4cc
BASE_TREE=1b0afe805269972cf7af40f7fbf0e4e6b3e35894
REVIEWED_STARTING_HEAD=f24421d9c80d96d7279d9626fc6bb95941031cf5
REVIEWED_STARTING_TREE=be500d1ec4268269672cf1e1bb8f6cca29e5d397
PREVIOUS_HEAD=f24421d9c80d96d7279d9626fc6bb95941031cf5
PREVIOUS_TREE=be500d1ec4268269672cf1e1bb8f6cca29e5d397
IMPLEMENTATION_HEAD=04751c18a247df7c9a81036585d06c14bf131140
IMPLEMENTATION_TREE=fd63e5139632b18d7fcd6d789701eda9e45b0e0d
FEAT_COMMIT=a68a8a4f14b2bddc4211923bf2f71a3f4bc0d279
TEST_COMMIT=04751c18a247df7c9a81036585d06c14bf131140
WORKTREE_CLEAN_BEFORE=NO
WORKTREE_CLEAN_AFTER=YES
PHASE_2E_CORRECTIVE_2_IMPLEMENTATION=REVIEW_CANDIDATE
PHASE_2E_SELF_DECLARED_PASS=NO
GATE_2_DECLARED=NO
PHASE_2F_STARTED=NO
LIVE_TRADING_AUTHORIZED=NO
CONTINUATION_REQUIRES_CURRENT_LEASE=YES
SNAPSHOT_FRESH_FLAG_ENFORCED=YES
FINAL_PRECOMMIT_AUTHORITY_RECHECK=YES
AMBIGUOUS_RISK_ORDER_BLOCKS_ACK=YES
AMBIGUOUS_RISK_ORDER_RESERVES_EXPOSURE=YES
DURABLE_RISK_BASELINES_REQUIRED=YES
CALLER_RESUME_EVIDENCE_AUTHORITATIVE=NO
CALLER_RISK_INPUT_AUTHORITATIVE=NO
PR8_REBIND_REQUIRED=YES
```

`RESULT_HEAD` / `RESULT_TREE` are the evidence commit that adds this packet. Pre-existing untracked `.omo/` session files were present before this checkpoint and were not committed. Gitignored leftover `artifacts/phase2d-corrective4` JSON was moved aside so biome did not rewrite Phase 2D evidence artifacts.

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

Host `PATH` used the already-present pinned binary at `/Users/apple/.local/node-v22.23.2/bin`. Pinned-runtime authority for Gate review remains GitHub Actions on `ubuntu-latest` using the repository Node pin.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2E runtime corrective 2: continuation lease authority; ACK snapshot.fresh plus observedAt; ambiguous risk-increasing exposure; final pre-persist resume recheck; durable equity baselines; restore frozen npm test expansion
ALLOWED_WRITE_PATHS=src/halt/**; test/halt/**; test/fixtures/phase2e-crash-worker.ts; package.json scripts only; docs/PHASE_2E_EVIDENCE.md
FILES_ADDED=test/halt/p2e-corrective-2.test.ts
FILES_CHANGED=package.json; src/halt/engine.ts; src/halt/types.ts; test/halt/helpers.ts; docs/PHASE_2E_EVIDENCE.md
FILES_DELETED=NONE
CONTRACT_CHANGES=NO
EXPERIMENT_ENVELOPE_CHANGED=NO
INTENTIONALLY_UNTOUCHED_AREAS=Phase 2A/2B/2C/2D source bytes; Phase 2A/2B/2C/2D evidence and verifier bytes; authoritative contracts; AI_START_HERE.md; package-lock.json; dependencies and devDependencies; .github/**; scripts/governance/**; .github/trusted/**; venue adapters; network/signing/authentication; Phase 2F telemetry/manifest/supervisor; live mode; experiment/v0.1-phase2; main; PR #8 / governance/phase2e-trusted-gate
```

`package.json` scripts only: `npm test` restored to the exact frozen Phase 2D expansion. `test:phase2e` remains `test/halt/*.test.ts`. `dependencies` and `devDependencies` were not modified. `package-lock.json` SHA-256 remained `a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51`.

## 4. File identities (implementation commits)

| Path | Git blob SHA-1 | SHA-256 | Bytes |
|---|---|---|---|
| `package.json` | `bbceec77e34558173ccbcec99807ba75d3f2d37f` | `f440fc2f027de8232c2ed3d215c7042f5b2d7f3e43cb7dbef1b9d28f8c24cd61` | 2640 |
| `src/halt/engine.ts` | `39aac6ba530572bd575495017e7ac84c52da06f5` | `16b690a5155407035dac3ffe0b75ca0ce28587276aade942a9663f0385a73d33` | 46870 |
| `src/halt/types.ts` | `dc0a6122e060da1d00dcecf48f09566af3851518` | `d04f6ce3fe777c3c7313769220ab491b48b046cd4a967454e732357062b3473c` | 5183 |
| `test/halt/helpers.ts` | `5da9aa56511358f5fb480ffe836b0eb26d07aa0c` | `c1d36017ef43df45f82c6217fc90cffac411054dfdbb2c1fcc274cb1c44c48f9` | 7546 |
| `test/halt/p2e-corrective-2.test.ts` | `73a1720baa2763fac21b22f2018460dcbec4626f` | `79738aa0f11464f88a7e79031ee3d2c57e08bf140a1eec4ff1d6a0aa16cd4cbc` | 25378 |

`docs/PHASE_2E_EVIDENCE.md` identity is the evidence commit that adds this packet.

## 5. Corrective behavior

### A. Continuation lease authority

`inspectHaltContinuation` still reports durable non-RUNNING states as non-running and risk blocked without claiming `runtimeDisposition=RUNNING`.

A continuation may return `durableStatus=RUNNING`, `runtimeDisposition=RUNNING`, and `allowRiskIncrease=true` / `systemAllowRiskIncrease=true` only after:

1. the durable exact pair is authoritative;
2. durable status is RUNNING;
3. `proveLease` freshly proves the current runtime lease;
4. proven lease generation and lease-envelope SHA match `context.leaseAuthority`;
5. the persistence latch is not blocked;
6. the process fence is not tripped;
7. `unresolvedPossibleExposure` is false.

Any missing or uncertain requirement returns `runtimeDisposition=FAIL_CLOSED`, `allowRiskIncrease=false`, `systemAllowRiskIncrease=false`, and a precise existing reason code (`LEASE_UNCERTAIN`, `LATCH_ALREADY_BLOCKED`, `RISK_INCREASE_FENCED`, or `UNRESOLVED_UNKNOWN`).

### B. Snapshot freshness contract

ACK authorization requires both engine-controlled `observedAt` classification and `snapshot.fresh === true`. `snapshot.fresh=false` cannot be overridden by a current `observedAt`. Stale, future, and malformed `observedAt` still reject ACK. Non-authoritative snapshots, lease-generation mismatch, and source-ID mismatch still reject ACK.

Internal `RiskInput.boundedReduction.snapshotFresh` is taken from the validated snapshot's `fresh` flag. It is not hardcoded `true`.

### C. Ambiguous risk-increasing orders

Hard halt never cancels `UNOWNED` or `AMBIGUOUS` orders. An `AMBIGUOUS` + `riskIncreasing` order sets `unresolvedPossibleExposure`, records `AMBIGUOUS_ORDERS_PRESENT`, prefers `RECONCILIATION_REQUIRED`, and cannot become `HALTED_FLAT` even if the position snapshot is flat.

ACK re-reads open orders through the lease-fenced transport. Current `OWNED`+`riskIncreasing` or `AMBIGUOUS`+`riskIncreasing` orders reject ACK. Transport exceptions / UNKNOWN results reject ACK and preserve the halt. An `AMBIGUOUS` non-risk-increasing order keeps prior halt/ACK semantics.

### D. ACK snapshot-to-commit race

The initial internal resume acquisition remains. Immediately before constructing and persisting RUNNING:

1. `beforeAckPersistLeaseRecheck` runs;
2. the lease is re-proved;
3. `obtainInternalResumeAuthority` runs again under the lease-fenced transport (final snapshot, orders, observedAt, freshness, authority, source ID, lease generation, unknown reservations, owned/ambiguous risk-increasing orders, fresh RiskInput, `evaluateRisk`).

Lineage and the RUNNING record use the final snapshot and final risk decision. Any second-check failure rejects ACK, keeps durable state non-RUNNING, keeps the process fence tripped, and keeps `allowRiskIncrease=false`. Final exact-pair reinspection remains. `HaltProcessFence` clears only after that proof.

### E. Durable equity baselines

ACK fails closed with `DURABLE_RISK_BASELINE_MISSING` when `startingEquityUsd` or `highWaterEquityUsd` is null. Missing baselines are not replaced with current snapshot equity. Valid bootstrap/test setup persists both baselines explicitly. Frozen Phase 2D risk-engine bytes were not modified.

### F. Normal CI expansion

Default `npm test` is restored to the exact frozen Phase 2D expansion. Dedicated `npm run test:phase2e` still executes `test/halt/*.test.ts`. The previous 43 evidence-suite identity failures were not relabeled as success. PR #8 historical-mismatch baseline was not edited and must be rebound because this candidate's SHA and expected CI behavior changed.

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
INSTALL_RESULT=added 11 packages; found 0 vulnerabilities; package-lock.json SHA-256 unchanged a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=Checked 95 files. Gitignored leftover artifacts/phase2d-corrective4 JSON was moved aside so biome did not rewrite Phase 2D evidence artifacts.

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
TEST_TODO=0
TEST_CANCELLED=0

TEST_PHASE2E_COMMAND=npm run test:phase2e
TEST_PHASE2E_EXIT=0
PHASE2E_TEST_TOTAL=70
PHASE2E_TEST_PASS=70
PHASE2E_TEST_FAIL=0
PHASE2E_TEST_SKIP=0
PHASE2E_TEST_TODO=0
PHASE2E_TEST_CANCELLED=0

TEST_PHASE2D_CORRECTIVE_4_COMMAND=npm run test:phase2d-corrective-4
TEST_PHASE2D_CORRECTIVE_4_EXIT=0
TEST_PHASE2D_CORRECTIVE_4_TOTAL=15
TEST_PHASE2D_CORRECTIVE_4_PASS=15

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (142 tracked files inspected before the evidence commit; post-commit count follows this commit).

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

## 7. Corrective-2 test matrix

| ID | Test | PROCESS_ISOLATION | Result |
|---|---|---|---|
| P2E-C2-01 | RUNNING durable record plus expired lease => FAIL_CLOSED | NO | PASS |
| P2E-C2-02 | RUNNING durable record plus mismatched lease generation => FAIL_CLOSED | NO | PASS |
| P2E-C2-03 | RUNNING durable record plus mismatched lease envelope SHA => FAIL_CLOSED | NO | PASS |
| P2E-C2-04 | RUNNING durable record plus blocked latch => risk blocked | NO | PASS |
| P2E-C2-05 | RUNNING durable record plus tripped process fence => not runtime RUNNING | NO | PASS |
| P2E-C2-06 | proven current RUNNING authority still succeeds | NO | PASS |
| P2E-C2-07 | snapshot.fresh=false plus current observedAt rejects ACK | NO | PASS |
| P2E-C2-08 | snapshot.fresh=true plus stale observedAt rejects ACK | NO | PASS |
| P2E-C2-09 | future observedAt rejects ACK | NO | PASS |
| P2E-C2-10 | malformed observedAt rejects ACK | NO | PASS |
| P2E-C2-11 | valid fresh authoritative snapshot still succeeds | NO | PASS |
| P2E-C2-12 | ambiguous risk-increasing order during hard halt produces unresolved exposure | NO | PASS |
| P2E-C2-13 | it cannot result in HALTED_FLAT | NO | PASS |
| P2E-C2-14 | it is not cancelled | NO | PASS |
| P2E-C2-15 | ACK rejects an ambiguous risk-increasing order | NO | PASS |
| P2E-C2-16 | ambiguous non-risk-increasing order preserves existing semantics | NO | PASS |
| P2E-C2-17 | lease changes after the first snapshot => ACK rejected | NO | PASS |
| P2E-C2-18 | clock advances beyond ACK_SNAPSHOT_MAX_STALE_MS before final authority => ACK rejected | NO | PASS |
| P2E-C2-19 | new OWNED risk-increasing order between validations => ACK rejected | NO | PASS |
| P2E-C2-20 | new AMBIGUOUS risk-increasing order between validations => ACK rejected | NO | PASS |
| P2E-C2-21 | final snapshot becomes unsafe while initial was safe => ACK rejected | NO | PASS |
| P2E-C2-22 | final snapshot transport throws => ACK rejected | NO | PASS |
| P2E-C2-23 | final listOpenOrders throws => ACK rejected | NO | PASS |
| P2E-C2-24 | successful ACK lineage records the final snapshot, not the initial snapshot | NO | PASS |
| P2E-C2-25 | process fence clears only after final exact-pair proof | NO | PASS |
| P2E-C2-26 | missing startingEquityUsd rejects ACK | NO | PASS |
| P2E-C2-27 | missing highWaterEquityUsd rejects ACK | NO | PASS |
| P2E-C2-28 | both explicit baselines permit the valid ACK path | NO | PASS |
| P2E-C2-29 | no fallback to current snapshot equity | NO | PASS |
| P2E-C2-CATALOG | DURABLE_RISK_BASELINE_MISSING is in the Phase 2E catalog | NO | PASS |

P2E-C2-12, P2E-C2-13, and P2E-C2-14 are asserted together in one deterministic test.

```text
P2_H01_TO_H13_MATRIX=PASS
P2E_C1_01_TO_C1_17_MATRIX=PASS
P2E_C2_01_TO_C2_29_MATRIX=PASS
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
CALLER_RISK_INPUT_AUTHORITATIVE=NO P2E-C1-03/P2-H10/C2-29
CONTINUATION_REQUIRES_CURRENT_LEASE=YES P2E-C2-01..C2-06
SNAPSHOT_FRESH_FLAG_ENFORCED=YES P2E-C2-07..C2-11
AMBIGUOUS_RISK_ORDER_RESERVES_EXPOSURE=YES P2E-C2-12..C2-14
AMBIGUOUS_RISK_ORDER_BLOCKS_ACK=YES P2E-C2-15/C2-20
FINAL_PRECOMMIT_AUTHORITY_RECHECK=YES P2E-C2-17..C2-25
DURABLE_RISK_BASELINES_REQUIRED=YES P2E-C2-26..C2-29
TRANSPORT_EXCEPTIONS_FAIL_CLOSED=YES P2E-C1-12..C1-15 and C2-22/C2-23
UNOWNED_CANCEL_REFUSED=PROVEN P2-H01/H02/C2-12
DEFAULT_CI_INCLUDES_PHASE2E=NO npm test restored to frozen Phase 2D expansion; halt suite is npm run test:phase2e
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
PR8_EDITED=NO
PR8_REBIND_REQUIRED=YES
```

## 10. Known limitations

```text
KNOWN_GAPS=Phase 2F telemetry/manifest and integrated restart supervisor are not implemented; evaluateRisk() still emits DURABLE_HALT_OR_ACK_UNAVAILABLE because Phase 2D bytes were frozen; halt-layer systemAllowRiskIncrease is a halt/ACK authority bit, not live-write authorization; host-local lease fencing remains HOST_LOCAL_FILESYSTEM_ONLY; flatten/cancel transports are simulator/test doubles only; PR #8 trusted-gate historical-mismatch baseline still expects the prior stacked npm test expansion and SHA and must be rebound
UNVERIFIED_ASSUMPTIONS=GitHub Actions Ubuntu SIGKILL matrix will match local Darwin results
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=parent-delivered SIGKILL; directory fsync
FOLLOW_UP_REQUIRED=independent Phase 2E current-byte review; rebind PR #8 to this candidate SHA and green npm test / dedicated test:phase2e split; do not start Phase 2F without authorization
```

## 11. Requested reviewer decision

```text
REQUESTED_DECISION=independent Phase 2E runtime corrective 2 current-byte review
PHASE_2E_CORRECTIVE_2_IMPLEMENTATION=REVIEW_CANDIDATE
SELF_DECLARED_PASS=NO
NEXT_ACTION=INDEPENDENT_PHASE_2E_CURRENT_BYTE_REVIEW
```
