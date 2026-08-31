# Phase 2E Evidence Packet — Runtime Corrective 3

Version: `0.1.3`
Checkpoint: `PHASE_2E_RUNTIME_CORRECTIVE_3`
Requested reviewer decision: independent review of Phase 2E runtime corrective 3 only
The implementation agent does **not** declare `PHASE_2E=PASS`, `GATE_2=PASS`, or live readiness.
Independent review is `NOT_PERFORMED`. Governance/PR #8 baseline rebind is still required.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2E
CHECKPOINT=PHASE_2E_RUNTIME_CORRECTIVE_3
REQUESTED_GATE=PHASE_2E_REVIEW
BRANCH=experiment/v0.1-phase2e-halt-ack
RUNTIME_PR=7
STACKED_PR_BASE=experiment/v0.1-phase2
BASE_SHA=7f196d367e39640eee9517f742b0d61424f9d4cc
BASE_TREE=1b0afe805269972cf7af40f7fbf0e4e6b3e35894
REVIEWED_STARTING_HEAD=80a86c8f3374711ad939a93e94292f177dc8f9e4
REVIEWED_STARTING_TREE=54ff4c1221f16a9d2c77ac5650435b1c5e2e849b
PREVIOUS_HEAD=80a86c8f3374711ad939a93e94292f177dc8f9e4
PREVIOUS_TREE=54ff4c1221f16a9d2c77ac5650435b1c5e2e849b
IMPLEMENTATION_HEAD=1541277fe114c4eeec3fe33f2446089b726dcaeb
IMPLEMENTATION_TREE=f4c503001ef3becae28dbf6f9bec02d5913fd219
FEAT_AND_TEST_COMMIT=1541277fe114c4eeec3fe33f2446089b726dcaeb
WORKTREE_CLEAN_BEFORE=NO
WORKTREE_CLEAN_AFTER=YES
PHASE_2E_CORRECTIVE_3_IMPLEMENTATION=REVIEW_CANDIDATE
INDEPENDENT_REVIEW=NOT_PERFORMED
PHASE_2E_SELF_DECLARED_PASS=NO
GATE_2_DECLARED=NO
PHASE_2F_STARTED=NO
LIVE_TRADING_AUTHORIZED=NO
CONTINUE_USES_SHARED_RUNNING_AUTHORIZATION=YES
CALLER_RESUME_EVIDENCE_AUTHORITATIVE=NO
CALLER_RISK_INPUT_AUTHORITATIVE=NO
PR8_REBIND_REQUIRED=YES
GOVERNANCE_BASELINE_REBIND_REQUIRED=YES
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

Host `PATH` used the already-present pinned binary at `/Users/apple/.local/node-v22.23.2/bin`. Pinned-runtime authority for Gate review remains GitHub Actions on `ubuntu-latest` using the repository Node pin.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Phase 2E runtime corrective 3: applyRiskDecision CONTINUE uses the same current-running authorization as inspectHaltContinuation
ALLOWED_WRITE_PATHS=src/halt/**; test/halt/**; docs/PHASE_2E_EVIDENCE.md
FILES_ADDED=test/halt/p2e-corrective-3.test.ts
FILES_CHANGED=src/halt/engine.ts; docs/PHASE_2E_EVIDENCE.md
FILES_DELETED=NONE
CONTRACT_CHANGES=NO
EXPERIMENT_ENVELOPE_CHANGED=NO
INTENTIONALLY_UNTOUCHED_AREAS=Phase 2A/2B/2C/2D source bytes; Phase 2A/2B/2C/2D evidence and verifier bytes; authoritative contracts; package.json dependencies and scripts; package-lock.json; .github/**; scripts/governance/**; .github/trusted/**; venue adapters; network/signing/authentication; Phase 2F; live mode; experiment/v0.1-phase2; main; PR #8 / governance/phase2e-trusted-gate
```

`package-lock.json` SHA-256 remained `a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51`. Dependency versions were not modified. Frozen Phase 2D HEAD/tree remained `7f196d367e39640eee9517f742b0d61424f9d4cc` / `1b0afe805269972cf7af40f7fbf0e4e6b3e35894`.

## 4. File identities (implementation commit)

| Path | Git blob SHA-1 | SHA-256 | Bytes |
|---|---|---|---|
| `src/halt/engine.ts` | `33f5fb5256341d9171c6ad7b39641c068a5c2bba` | `018a18aca1a7221f0d091957e8bbe3d491cfa82cc26b7e0e95ffbbe9cacd3330` | 46252 |
| `test/halt/p2e-corrective-3.test.ts` | `c7285684e96bf43ea676f4e92d5f28ae0577ad97` | `be9d4ce877c5d76fbe28cb8bb4ada004e2ce6c41b36a3268f95b4e67cb378933` | 8251 |

`docs/PHASE_2E_EVIDENCE.md` identity is the evidence commit that adds this packet.

## 5. Corrective behavior

`applyRiskDecision()` still evaluates the caller `RiskInput` only to select HALT / REDUCE / CONTINUE. HALT and REDUCE paths are unchanged.

When the durable exact pair is a current RUNNING record and the risk decision is CONTINUE, the result is produced by `authorizeCurrentRunningContinuation()` — the same helper used by `inspectHaltContinuation()`. CONTINUE no longer returns `runtimeDisposition="RUNNING"` merely because `proveLease()` succeeded.

CONTINUE is fail-closed (`runtimeDisposition=FAIL_CLOSED`, `allowRiskIncrease=false`, `systemAllowRiskIncrease=false`) when any of the following is present:

- `processFence.tripped`
- persistence latch blocked
- `unresolvedPossibleExposure`
- lease absent, expired, mismatched, stale, or unproven
- loaded record is not an exact current RUNNING authority (existing non-running / unproven-pair paths remain)

A blocked continuation cannot report `runtimeDisposition="RUNNING"`. Direct `applyRiskDecision()` tests assert alignment with `inspectHaltContinuation()` for the same process conditions. Caller CONTINUE inputs are not mutated. Repeated evaluation is deterministic.

`authorizationFrom()`, `proveLease()`, durable persistence, process-fence checks, ACK, crash, exact-pair, and first-wins halt semantics were not weakened.

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

TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0

LINT_COMMAND=npm run lint
LINT_EXIT=0

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=Checked 96 files.

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
PHASE2E_TEST_TOTAL=79
PHASE2E_TEST_PASS=79
PHASE2E_TEST_FAIL=0
PHASE2E_TEST_SKIP=0
PHASE2E_TEST_TODO=0
PHASE2E_TEST_CANCELLED=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (143 tracked files inspected before the evidence commit; post-commit count follows this commit).

BUILD_COMMAND=npm run build
BUILD_EXIT=0

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
```

## 7. Corrective-3 test matrix

| ID | Test | Result |
|---|---|---|
| P2E-C3-01 | valid CONTINUE remains RUNNING | PASS |
| P2E-C3-02 | tripped process fence blocks CONTINUE | PASS |
| P2E-C3-03 | blocked latch blocks CONTINUE | PASS |
| P2E-C3-04 | unresolved possible exposure blocks CONTINUE | PASS |
| P2E-C3-05 | expired lease blocks CONTINUE | PASS |
| P2E-C3-06 | lease generation mismatch blocks CONTINUE | PASS |
| P2E-C3-07 | lease envelope SHA mismatch blocks CONTINUE | PASS |
| P2E-C3-08 | repeated CONTINUE evaluation is deterministic | PASS |
| P2E-C3-09 | caller CONTINUE inputs remain unmodified | PASS |

```text
P2_H01_TO_H13_MATRIX=PASS
P2E_C1_01_TO_C1_17_MATRIX=PASS
P2E_C2_01_TO_C2_29_MATRIX=PASS
P2E_C3_01_TO_C3_09_MATRIX=PASS
HALT_CRASH_CASE_TOTAL=32
HALT_CRASH_CASE_PASS=32
ACK_CRASH_CASE_TOTAL=16
ACK_CRASH_CASE_PASS=16
CHILD_PROCESS_CRASH_TESTS_RUN=YES
```

## 8. Safety claims for this checkpoint

```text
DRY_RUN_DEFAULT=PROVEN liveExchangeWrites=false
NO_LIVE_WRITE_PATH=PROVEN
CONTINUE_USES_SHARED_RUNNING_AUTHORIZATION=YES P2E-C3-01..C3-07
CALLER_RISK_INPUT_UNMODIFIED=YES P2E-C3-09
REPEATED_CONTINUE_DETERMINISTIC=YES P2E-C3-08
INDEPENDENT_REVIEW=NOT_PERFORMED
GOVERNANCE_BASELINE_REBIND_REQUIRED=YES
PR8_REBIND_REQUIRED=YES
PHASE2D_LIMITS_UNCHANGED=PROVEN src/risk/** untouched
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
INDEPENDENT_REVIEW=NOT_PERFORMED
PR8_EDITED=NO
PR8_REBIND_REQUIRED=YES
```

## 10. Known limitations

```text
KNOWN_GAPS=Phase 2F telemetry/manifest and integrated restart supervisor are not implemented; evaluateRisk() still emits DURABLE_HALT_OR_ACK_UNAVAILABLE because Phase 2D bytes were frozen; halt-layer systemAllowRiskIncrease is a halt/ACK authority bit, not live-write authorization; host-local lease fencing remains HOST_LOCAL_FILESYSTEM_ONLY; flatten/cancel transports are simulator/test doubles only; PR #8 trusted-gate historical-mismatch baseline still expects a prior stacked SHA and must be rebound
UNVERIFIED_ASSUMPTIONS=GitHub Actions Ubuntu SIGKILL matrix will match local Darwin results
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=parent-delivered SIGKILL; directory fsync
FOLLOW_UP_REQUIRED=independent Phase 2E current-byte review; rebind PR #8 / trusted governance baseline to this candidate SHA; do not start Phase 2F without authorization
```

## 11. Requested reviewer decision

```text
REQUESTED_DECISION=independent Phase 2E runtime corrective 3 current-byte review
PHASE_2E_CORRECTIVE_3_IMPLEMENTATION=REVIEW_CANDIDATE
INDEPENDENT_REVIEW=NOT_PERFORMED
SELF_DECLARED_PASS=NO
NEXT_ACTION=INDEPENDENT_PHASE_2E_CURRENT_BYTE_REVIEW
GOVERNANCE_BASELINE_REBIND_REQUIRED=YES
```
