# Phase 2A Evidence Packet — Corrective 1

Version: `0.2.0`  
Checkpoint: canonical durable envelope + exact-pair inspection  
Corrective: own-property descriptor canonicalization + single-snapshot envelope build  
Requested reviewer decision: independent review of Phase 2A Corrective 1 only  
The implementation agent does **not** declare `PHASE_2A=PASS` or `GATE_2=PASS`.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2A
CHECKPOINT=canonical envelope + exact-pair inspection
CORRECTIVE=PHASE_2A_CORRECTIVE_1
REQUESTED_GATE=PHASE_2A_REVIEW
BRANCH=experiment/v0.1-phase2
REJECTED_BASE_HEAD=5dd582335322ee85980ebb4240ed7345f32d7ba9
REJECTED_BASE_TREE=45d9beff14e4093d44145ce424205c3d6a2156f6
PHASE_1_BASE_SHA=31cfe078c09a15d4906b56fb64731449ca1c598a
PHASE_1_BASE_TREE=7cbb90ebee0897132df6e0c23b27b1ae33c12e2f
WORKTREE_CLEAN_BEFORE=YES
```

Corrective commits relative to the rejected candidate:

```text
8f1805c105d671ba9ef4b1abd7c76313e9dd21d8 fix(persistence): reject hidden and accessor canonical properties
e34540c1451dfe64756c361656738ad087497a98 fix(persistence): build envelopes from a single detached payload snapshot
d381422ca5959498154fb61265ed6f6f7a2aeb5b test(persistence): cover descriptor and single-snapshot adversarial cases
```

Exact `FINAL_HEAD` / `FINAL_TREE` after this evidence commit, and exact branch-push CI, are recorded in the following `docs(review)` commit. This file does not leave CI fields as `PENDING`.

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
PRIMARY_OBJECTIVE=Correct Phase 2A blockers: descriptor-based canonicalization, single detached payload snapshot, runtime scalar type checks
ALLOWED_WRITE_PATHS=src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; src/persistence/exact-pair-inspection.ts; src/persistence/index.ts; test/persistence/**; test/fixtures/**; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md; docs/ACCEPTANCE_GATES.md; package.json
FILES_CHANGED=docs/ACCEPTANCE_GATES.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md; src/persistence/canonical-json.ts; src/persistence/durable-envelope.ts; test/persistence/canonical-json.test.ts; test/persistence/durable-envelope.test.ts
FILES_ADDED=NONE
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/simulator/**; src/domain/**; src/strategy/**; src/math/**; src/bootstrap/**; src/index.ts; venue adapters; runtime lease; risk engine; halt/ACK; telemetry; CI workflow; lockfile; live-mode behavior; Phase 2B write protocol
```

`src/persistence/exact-pair-inspection.ts` and `src/persistence/index.ts` were not modified. Frozen canonical vector literals were not modified.

## 4. Current-byte evidence versus rejected HEAD

`git diff --name-status 5dd582335322ee85980ebb4240ed7345f32d7ba9` at evidence-bind time (includes this documentation commit):

```text
M	docs/ACCEPTANCE_GATES.md
M	docs/IMPLEMENTATION_CONTRACT.md
M	docs/PHASE_2A_CONTRACT.md
M	docs/PHASE_2A_EVIDENCE.md
M	src/persistence/canonical-json.ts
M	src/persistence/durable-envelope.ts
M	test/persistence/canonical-json.test.ts
M	test/persistence/durable-envelope.test.ts
```

`git diff --numstat 5dd582335322ee85980ebb4240ed7345f32d7ba9` before this evidence file rewrite:

```text
2	1	docs/ACCEPTANCE_GATES.md
3	2	docs/IMPLEMENTATION_CONTRACT.md
29	0	docs/PHASE_2A_CONTRACT.md
91	17	src/persistence/canonical-json.ts
12	6	src/persistence/durable-envelope.ts
87	0	test/persistence/canonical-json.test.ts
147	1	test/persistence/durable-envelope.test.ts
```

```text
PR_OR_PATCH_REFERENCE=Draft PR #3 against experiment/v0.1-phase1
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
GENERATED_SCHEMA_HASHES=N/A
```

## 5. Dependency evidence

```text
PACKAGE=NONE
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A
```

No new dependency. Persistence still uses `node:crypto` and `node:fs`.

## 6. Validation commands

Local workstation, Node `v26.5.0` / npm `11.17.0`, after Corrective 1 implementation commits:

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
FOCUSED_PHASE2A_TOTAL=58
FOCUSED_PHASE2A_PASS=58
FOCUSED_PHASE2A_FAIL=0
FOCUSED_PHASE2A_SKIP=0

TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=178
TEST_PASS=178
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

## 7. Contract conformance

```text
CONTRACT_FILES_READ=AGENTS.md; docs/IMPLEMENTATION_CONTRACT.md; docs/RISK_PERSISTENCE_CONTRACT.md; docs/TEST_FAULT_MATRIX.md; docs/ACCEPTANCE_GATES.md; docs/EVIDENCE_TEMPLATE.md; docs/PHASE_2A_CONTRACT.md; docs/PHASE_2A_EVIDENCE.md
CONTRACT_FILES_CHANGED=docs/IMPLEMENTATION_CONTRACT.md (narrow status/reference); docs/ACCEPTANCE_GATES.md (narrow status/reference); docs/PHASE_2A_CONTRACT.md (narrow own-property descriptor and single-snapshot clarification); docs/PHASE_2A_EVIDENCE.md (this packet)
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
PHASE_2B_STARTED=NO
```

## 8. Safety claims and evidence

```text
DRY_RUN_DEFAULT=test/bootstrap/runtimeMode.test.ts + npm run dry-run
LIVE_MODE_FAIL_CLOSED=test/bootstrap/runtimeMode.test.ts LIVE_MODE_NOT_IMPLEMENTED
NO_LIVE_WRITE_PATH=src/index.ts unchanged; persistence is read/validation only
DESCRIPTOR_CANONICALIZATION=src/persistence/canonical-json.ts uses Object.getOwnPropertyDescriptors / Reflect.ownKeys / descriptor.value; tests C1-C8
SINGLE_SNAPSHOT_ENVELOPE=src/persistence/durable-envelope.ts canonicalizes payload once, JSON.parse detach, reuses snapshot; tests C9-C13
RUNTIME_SCALAR_TYPECHECK=validateEnvelopeFields typeof checks before regex; test C14
FROZEN_VECTORS=test C15 plus existing literal assertions; CANONICAL_PAYLOAD_BYTES unchanged
ALLOW_RISK_INCREASE=always false in Phase 2A inspectExactPair
CANCEL_NOT_FILL=NOT_IMPLEMENTED_THIS_PHASE
HALT_PERSISTENCE=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_PERSISTENCE_LATCH=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_LEASE_FENCING=NOT_IMPLEMENTED_THIS_PHASE
```

## 9. Fault-injection matrix

```text
MATRIX_REQUIRED_THIS_PHASE=P2-D01..P2-D14 plus 2A-C01..2A-C20 plus Corrective 1 C1..C20
MATRIX_RUN=14 P2-D + 2A-C01..2A-C20 + C1..C15 new descriptor/snapshot cases
MATRIX_PASS=all executed Phase 2A cases
MATRIX_FAIL=0
MATRIX_SKIP=0
```

C16–C20 are existing-suite invariants: 2A-C01..2A-C20 remain, P2-D01..P2-D14 remain, 120 Phase 1 tests remain green, inspection still performs no writes (2A-C16), `allowRiskIncrease` remains false (P2-D01 and every Phase 2A inspection result).

## 10. Real process-crash evidence

```text
CHILD_PROCESS_CRASH_TESTS_RUN=NO
POST_CRASH_DISK_CLASSIFICATIONS=NOT_IMPLEMENTED_THIS_PHASE
```

SIGKILL atomic-write matrix is Phase 2B and was not implemented.

## 11. Durable-state artifacts

```text
CANONICAL_PAYLOAD_BYTES={"levels":10,"marker":"phase2a-canonical-vector","notionalUsd":"100"}
PAYLOAD_SHA256=1e0e100c04353644249d0ce2e438b2401a91c21155943635ffd63422f6d382c2
ENVELOPE_SHA256=0cab9a0f0be80d3aba5ceb1d01d26d568af8bfedfc50f3f17dda3ebbd47e71d2
STATE_SCHEMA_VERSION=1
```

Frozen vector literals were not changed.

## 12. Venue audit evidence

```text
N/A Phase 2A
```

## 13. Telemetry/manifest evidence

```text
N/A Phase 2A
```

## 14. CI evidence

This evidence-bind commit is recorded before the branch-push that produces GitHub Actions. Exact `CI_RUN_ID`, `CI_EVENT=push`, `CI_HEAD_SHA`, and `CI_CONCLUSION` for the final review HEAD are written in the subsequent `docs(review): record exact final SHA and exact branch-push CI` commit after that run exists. No field in this section is set to `PENDING`.

Pinned-runtime `npm ci` authority is GitHub Actions (`node-version-file: .node-version`, required `v22.23.2` / `10.9.8`), not the local workstation.

## 15. Unresolved risks

```text
KNOWN_GAPS=no backup-first write protocol; no runtime latch; no lease; no risk gate; no halt/ACK; no historical archive; allowRiskIncrease remains false even for an exact pair
UNVERIFIED_ASSUMPTIONS=local workstation is not the pinned Node/npm pair; arbitrary malicious Proxy traps are not a claimed hostile-object guarantee; canonicalization uses one Object.getOwnPropertyDescriptors snapshot and does not attempt to defeat traps that lie across repeated observations
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=Node TextDecoder fatal UTF-8; fs readFile/readdir; SHA-256 via node:crypto; Object.getOwnPropertyDescriptors / Reflect.ownKeys
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
PHASE_2B_STARTED=NO
PHASE_2B_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH=NO
```

## 17. Requested reviewer decision

```text
PHASE_2A_SELF_DECLARED_PASS=NO
REQUESTED_DECISION=PASS
INDEPENDENT_REVIEW_GATE_1=PASS
CURRENT_CANDIDATE=PHASE_2A_CORRECTIVE_1
PHASE_2A=REVIEW_CANDIDATE
PHASE_2B_AUTHORIZED=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
