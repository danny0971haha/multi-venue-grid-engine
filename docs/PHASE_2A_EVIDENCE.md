# Phase 2A Evidence Packet — Corrective 2

Version: `0.3.0`  
Checkpoint: canonical durable envelope + exact-pair inspection  
Corrective: single-observation metadata snapshot in `buildDurableEnvelope`  
Requested reviewer decision: independent review of Phase 2A Corrective 2 only  
The implementation agent does **not** declare `PHASE_2A=PASS` or `GATE_2=PASS`.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2A
CHECKPOINT=canonical envelope + exact-pair inspection
CORRECTIVE=PHASE_2A_CORRECTIVE_2
REQUESTED_GATE=PHASE_2A_REVIEW
BRANCH=experiment/v0.1-phase2
REJECTED_BASE_HEAD=12c4a4e4dff34d14356f93e0682a3b1e9eaff511
REJECTED_BASE_TREE=81e1e9b84cc96e4ea8b5d44b3057caa3f2cdb88d
PHASE_1_BASE_SHA=31cfe078c09a15d4906b56fb64731449ca1c598a
PHASE_1_BASE_TREE=7cbb90ebee0897132df6e0c23b27b1ae33c12e2f
WORKTREE_CLEAN_BEFORE=YES
```

Corrective 2 commits relative to the rejected Corrective 1 HEAD are listed in the git log after this packet is committed. Exact final HEAD/TREE and GitHub Actions identity for that HEAD are recorded on Draft PR #3 after push. Updating PR metadata does not create another commit.

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

Local `npm ci` failed with `EBADENGINE` because the workstation is not the pinned Node/npm pair. That is recorded as a failure, not a pass. Static checks, tests, build, secret scan, and dry-run below were executed with the local toolchain against the already-present `node_modules` tree. GitHub Actions on `ubuntu-latest` using `.node-version` is the pinned-runtime authority.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Correct P2A-BLOCKER-01: capture each caller-owned envelope field once at buildDurableEnvelope entry (Approach A)
ALLOWED_WRITE_PATHS=src/persistence/durable-envelope.ts; test/persistence/durable-envelope.test.ts; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md; docs/ACCEPTANCE_GATES.md
FILES_CHANGED=docs/ACCEPTANCE_GATES.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md; src/persistence/durable-envelope.ts; test/persistence/durable-envelope.test.ts
FILES_ADDED=NONE
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/canonical-json.ts; src/persistence/exact-pair-inspection.ts; test frozen fixture literals; src/simulator/**; src/domain/**; src/strategy/**; src/math/**; src/bootstrap/**; src/index.ts; venue adapters; runtime lease; risk engine; halt/ACK; telemetry; CI workflow; lockfile; live-mode behavior; Phase 2B write protocol
```

## 4. Chosen observation approach

```text
APPROACH=A
DESCRIPTION=explicitly read schemaVersion, kind, scopeKey, storeGeneration, previousEnvelopeSha256, and payload once into locals at function entry
DOCUMENTED_OBSERVATION_COUNT_PER_ACCEPTED_FIELD=1
NO_OBJECT_SPREAD_OF_CALLER_FIELDS=YES
CALLER_FIELDS_NOT_OBSERVED_AFTER_SNAPSHOT=YES
ERROR_DIAGNOSTICS_DO_NOT_REREAD_CALLER_FIELDS=YES
PAYLOAD_CANONICALIZED_ONCE=YES
DETACHED_PAYLOAD_USED_FOR_HASH_AND_RETURN=YES
```

## 5. Current-byte evidence versus rejected HEAD

`git diff --name-status 12c4a4e4dff34d14356f93e0682a3b1e9eaff511` at evidence-bind time (includes this documentation commit):

```text
M	docs/ACCEPTANCE_GATES.md
M	docs/IMPLEMENTATION_CONTRACT.md
M	docs/PHASE_2A_CONTRACT.md
M	docs/PHASE_2A_EVIDENCE.md
M	src/persistence/durable-envelope.ts
M	test/persistence/durable-envelope.test.ts
```

`git diff --numstat 12c4a4e4dff34d14356f93e0682a3b1e9eaff511` before this evidence file rewrite:

```text
2	1	docs/ACCEPTANCE_GATES.md
1	1	docs/IMPLEMENTATION_CONTRACT.md
1	1	docs/PHASE_2A_CONTRACT.md
40	22	src/persistence/durable-envelope.ts
435	0	test/persistence/durable-envelope.test.ts
```

```text
PR_OR_PATCH_REFERENCE=Draft PR #3 against experiment/v0.1-phase1
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
GENERATED_SCHEMA_HASHES=N/A
```

## 6. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Persistence still uses `node:crypto` and `node:fs`.

## 7. Validation commands

Local workstation, Node `v26.5.0` / npm `11.17.0`, after Corrective 2 implementation:

```text
INSTALL_COMMAND=npm ci
INSTALL_EXIT=1
INSTALL_RESULT=EBADENGINE Required {"node":"22.23.2","npm":"10.9.8"} Actual {"node":"v26.5.0","npm":"11.17.0"}
NPM_CI_PINNED_RUNTIME=NOT_RUN_ON_WORKSTATION

TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0

LINT_COMMAND=npm run lint
LINT_EXIT=0
LINT_RESULT=biome lint clean, 39 files

FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
FORMAT_CHECK_RESULT=biome format clean, 39 files

FOCUSED_PHASE2A_COMMAND=npm run test:phase2a
FOCUSED_PHASE2A_EXIT=0
FOCUSED_PHASE2A_TOTAL=73
FOCUSED_PHASE2A_PASS=73
FOCUSED_PHASE2A_FAIL=0
FOCUSED_PHASE2A_SKIP=0
FOCUSED_PHASE2A_PREVIOUS=58
FOCUSED_PHASE2A_ADDED_C2=15

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=193
TEST_PASS=193
TEST_FAIL=0
TEST_SKIP=0
EXISTING_PHASE1_TOTAL=120
EXISTING_PHASE1_PASS=120

BUILD_COMMAND=npm run build
BUILD_EXIT=0

SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=passed (73 tracked files inspected)

DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
```

Pinned Node `v22.23.2` / npm `10.9.8` `npm ci` was not executed on this workstation. Do not treat the local `npm ci` failure as a pinned-runtime pass.

## 8. Contract conformance

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/RISK_PERSISTENCE_CONTRACT.md; docs/TEST_FAULT_MATRIX.md; docs/ACCEPTANCE_GATES.md; docs/EVIDENCE_TEMPLATE.md; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md
CONTRACT_FILES_CHANGED=docs/IMPLEMENTATION_CONTRACT.md (narrow status/reference); docs/ACCEPTANCE_GATES.md (narrow status/reference); docs/PHASE_2A_CONTRACT.md (narrow Approach A single-observation clarification); docs/PHASE_2A_EVIDENCE.md (this packet)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
PHASE_2B_STARTED=NO
```

## 9. Getter / observation-count matrix

Documented maximum observations per accepted input field: **1**.

| ID | Scenario | Observed | Result |
|---|---|---|---|
| C2-01 | stateful `schemaVersion` getter (1 then 99) | 1 | successful; envelope uses first value; bytes self-validate |
| C2-02 | stateful `kind` getter | 1 | successful; envelope uses first value; bytes self-validate |
| C2-03 | stateful `scopeKey` getter | 1 | successful; envelope uses first value; bytes self-validate |
| C2-04 | stateful `storeGeneration` getter | 1 | successful; envelope uses first value; bytes self-validate |
| C2-05 | stateful `previousEnvelopeSha256` getter | 1 | successful; envelope uses first value; bytes self-validate |
| C2-06 | stateful `payload` getter | 1 | first payload canonicalized once; detached snapshot used |
| C2-07 | Proxy get counters for all six fields | 1 each | no field observed more than the documented count |
| C2-08 | invalid `kind` getter / invalid `schemaVersion` with payload getter | 1 | `EnvelopeValidationError` reason code only; second getter call not used for diagnostics |
| C2-09 | adversarial successful-build table | n/a | every `parseAndValidateDurableEnvelope(result.fullEnvelopeBytes).ok === true` |
| C2-10 | same table | n/a | `canonicalBytes` equal `fullEnvelopeBytes` exactly |
| C2-11 | same table | n/a | returned envelope scalars equal hash-input scalars |
| C2-12 | same table | n/a | SHA-256(envelope-minus-hash) equals returned `envelopeSha256` |
| C2-13 | mutate all caller scalar backing values after build | n/a | returned envelope and bytes unchanged |
| C2-14 | mutate nested payload after build | n/a | detached snapshot unchanged; C11 remains green |
| C2-15 | getter changes on second call for every field | 1 | no successful internally inconsistent result |

## 10. Safety claims and evidence

```text
DRY_RUN_DEFAULT=test/bootstrap/runtimeMode.test.ts + npm run dry-run
LIVE_MODE_FAIL_CLOSED=test/bootstrap/runtimeMode.test.ts LIVE_MODE_NOT_IMPLEMENTED
NO_LIVE_WRITE_PATH=src/index.ts unchanged; persistence is read/validation only
SINGLE_OBSERVATION_METADATA=src/persistence/durable-envelope.ts Approach A locals; tests C2-01..C2-08, C2-15
SINGLE_SNAPSHOT_ENVELOPE=captured payload canonicalized once; detached JSON snapshot reused; tests C2-06, C2-09..C2-14
RUNTIME_SCALAR_TYPECHECK=validateEnvelopeFields typeof checks before regex; test C14 and C2-08
FROZEN_VECTORS=tests C15 plus existing literal assertions; CANONICAL_PAYLOAD_BYTES unchanged
ALLOW_RISK_INCREASE=always false in Phase 2A inspectExactPair
EXACT_PAIR_INSPECTION=read-only; src/persistence/exact-pair-inspection.ts unmodified
CANCEL_NOT_FILL=NOT_IMPLEMENTED_THIS_PHASE
HALT_PERSISTENCE=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_PERSISTENCE_LATCH=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_LEASE_FENCING=NOT_IMPLEMENTED_THIS_PHASE
```

## 11. Fault-injection matrix

```text
MATRIX_REQUIRED_THIS_PHASE=P2-D01..P2-D14 plus 2A-C01..2A-C20 plus Corrective 1 C1..C15 plus Corrective 2 C2-01..C2-15
MATRIX_RUN=14 P2-D + 2A-C01..2A-C20 + C1..C15 + C2-01..C2-15
MATRIX_PASS=all executed Phase 2A cases
MATRIX_FAIL=0
MATRIX_SKIP=0
```

## 12. Real process-crash evidence

```text
CHILD_PROCESS_CRASH_TESTS_RUN=NO
POST_CRASH_DISK_CLASSIFICATIONS=NOT_IMPLEMENTED_THIS_PHASE
```

SIGKILL atomic-write matrix is Phase 2B and was not implemented.

## 13. Durable-state artifacts

```text
CANONICAL_PAYLOAD_BYTES={"levels":10,"marker":"phase2a-canonical-vector","notionalUsd":"100"}
PAYLOAD_SHA256=1e0e100c04353644249d0ce2e438b2401a91c21155943635ffd63422f6d382c2
ENVELOPE_SHA256=0cab9a0f0be80d3aba5ceb1d01d26d568af8bfedfc50f3f17dda3ebbd47e71d2
STATE_SCHEMA_VERSION=1
```

Frozen vector literals were not changed. C15 asserts byte-identity of `CANONICAL_PAYLOAD_BYTES`, `PAYLOAD_SHA256`, `CANONICAL_ENVELOPE_HASH_INPUT_BYTES`, `ENVELOPE_SHA256`, and `FULL_ENVELOPE_BYTES`.

## 14. Venue audit evidence

```text
N/A Phase 2A
```

## 15. Telemetry/manifest evidence

```text
N/A Phase 2A
```

## 16. CI evidence

Pinned-runtime proof is GitHub Actions on `ubuntu-latest` with `.node-version` (`v22.23.2` / npm `10.9.8`). Local `npm ci` EBADENGINE is not a pinned pass.

Exact final HEAD, TREE, run ID, event, `headSha`, and conclusion are recorded on Draft PR #3 after the branch push. This packet does not create a follow-up commit solely to record CI.

```text
CI_BINDING=PR_#3_METADATA_AFTER_PUSH
NPM_CI_PINNED_RUNTIME=GITHUB_ACTIONS_AUTHORITY
```

## 17. Unresolved risks

```text
KNOWN_GAPS=no backup-first write protocol; no runtime latch; no lease; no risk gate; no halt/ACK; no historical archive; allowRiskIncrease remains false even for an exact pair
UNVERIFIED_ASSUMPTIONS=local workstation is not the pinned Node/npm pair; arbitrary malicious Proxy traps are not a claimed hostile-object guarantee; Approach A copies primitives/references once and does not attempt to defeat traps that lie across later observations of the caller object because that object is not observed again
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=Node TextDecoder fatal UTF-8; fs readFile/readdir; SHA-256 via node:crypto; single property reads of caller-owned fields at buildDurableEnvelope entry
FOLLOW_UP_REQUIRED=Phase 2B backup-first atomic write + real process-crash matrix after separate authorization
```

## 18. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
PHASE_2B_STARTED=NO
PHASE_2B_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH=NO
```

## 19. Requested reviewer decision

```text
PHASE_2A_SELF_DECLARED_PASS=NO
REQUESTED_DECISION=PASS
INDEPENDENT_REVIEW_GATE_1=PASS
CURRENT_CANDIDATE=PHASE_2A_CORRECTIVE_2
PHASE_2A=REVIEW_CANDIDATE
PHASE_2B_AUTHORIZED=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
