# Implementation Evidence Packet

Version: `0.2.0`

Return this packet after every bounded implementation checkpoint or phase.

The packet must describe the **actual current bytes**. Do not replace evidence with a prose claim that the implementation is complete.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=
CHECKPOINT=
REQUESTED_GATE=
BRANCH=
BASE_SHA=
RESULT_SHA=
REMOTE_BRANCH_SHA=
WORKTREE_CLEAN_BEFORE=YES|NO
WORKTREE_CLEAN_AFTER=YES|NO
```

If `RESULT_SHA` does not exist because the reviewer is inspecting an uncommitted candidate, provide the exact patch identity in Section 4.

## 2. Toolchain

```text
OS=
ARCH=
NODE_VERSION=
NPM_VERSION=
TYPESCRIPT_VERSION=
PACKAGE_MANAGER_VERSION=
```

For Phase 0 expected baseline:

```text
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
```

Report mismatches; do not normalize them away in prose.

## 3. Scope

```text
PRIMARY_OBJECTIVE=
ALLOWED_WRITE_PATHS=
FILES_CHANGED=
FILES_ADDED=
FILES_DELETED=
DIFF_STAT=
INTENTIONALLY_UNTOUCHED_AREAS=
```

State every out-of-scope area that was intentionally left untouched.

If any changed path is outside the phase contract, explain it explicitly. Reviewer decides whether that invalidates the candidate.

## 4. Current-byte evidence

Provide exact outputs/identities for:

```bash
git rev-parse HEAD
git status --short
git diff --check
git diff --name-status <base>...HEAD
git diff --stat <base>...HEAD
git diff --numstat <base>...HEAD
```

Provide:

```text
PR_OR_PATCH_REFERENCE=
PATCH_SHA256=
PATCH_BYTES=
PATCH_LF_COUNT=
LOCKFILE_SHA256=
GENERATED_SCHEMA_HASHES=
FIXTURE_HASHES=
```

Use `N/A` only when genuinely not applicable.

For an uncommitted candidate, full patch bytes or a reviewable attached patch are mandatory. Include SHA-256 and exact byte size.

## 5. Dependency evidence

For each dependency added/changed after Gate 0:

```text
PACKAGE=
OLD_VERSION=
NEW_VERSION=
RUNTIME_OR_DEV=
PURPOSE=
LICENSE=
LOCKFILE_CHANGED=YES|NO
WHY_EXISTING_TOOLS_INSUFFICIENT=
```

Do not hide incidental dependency upgrades.

## 6. Validation commands

Report each actual command, exit code, and concise observed result:

```text
INSTALL_COMMAND=
INSTALL_EXIT=
INSTALL_RESULT=

TYPECHECK_COMMAND=
TYPECHECK_EXIT=
TYPECHECK_RESULT=

LINT_COMMAND=
LINT_EXIT=
LINT_RESULT=

FORMAT_CHECK_COMMAND=
FORMAT_CHECK_EXIT=
FORMAT_CHECK_RESULT=

TEST_COMMAND=
TEST_EXIT=
TEST_RESULT=
TEST_TOTAL=
TEST_PASS=
TEST_FAIL=
TEST_SKIP=

BUILD_COMMAND=
BUILD_EXIT=
BUILD_RESULT=

DRY_RUN_COMMAND=
DRY_RUN_EXIT=
DRY_RUN_RESULT=

SECRET_SCAN_COMMAND=
SECRET_SCAN_EXIT=
SECRET_SCAN_RESULT=

DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=
```

Never omit a red command that was executed.

## 7. Contract conformance

```text
CONTRACT_FILES_READ=
CONTRACT_FILES_CHANGED=
EXPERIMENT_ENVELOPE_CHANGED=YES|NO
ARCHITECTURE_SEMANTICS_CHANGED=YES|NO
CONTRACT_CHANGE_REQUEST_ID=
```

Expected for normal bounded implementation:

```text
CONTRACT_FILES_CHANGED=NONE
EXPERIMENT_ENVELOPE_CHANGED=NO
```

## 8. Safety claims and evidence

For every applicable claim, point to the exact test/code path/evidence that proves it.

```text
DRY_RUN_DEFAULT=
LIVE_MODE_FAIL_CLOSED=
NO_LIVE_WRITE_PATH=
DECIMAL_ARITHMETIC_AUTHORITY=
CANCEL_NOT_FILL=
DISAPPEARANCE_NOT_FILL=
AUTHORITATIVE_FILL_PROVENANCE=
PARTIAL_FILL_HANDLING=
UNKNOWN_WRITE_RECONCILIATION=
ORDER_OWNERSHIP_CLASSIFICATION=
PLANNED_NOTIONAL_CAP=
ACTUAL_NOTIONAL_REDUCTION=
DAILY_LOSS_HALT=
START_DRAWDOWN_HALT=
BOUNDARY_HALT=
STALE_INPUT_HALT=
HALT_PERSISTENCE=
DURABLE_HALT_ACK=
RUNTIME_PERSISTENCE_LATCH=
RUNTIME_LEASE_FENCING=
RESTART_RECONCILIATION=
DUPLICATE_ORDER_HANDLING=
ORPHAN_ORDER_HANDLING=
FATAL_RUNTIME_FAIL_CLOSED=
```

Use `NOT_IMPLEMENTED_THIS_PHASE` where the phase contract intentionally defers a claim.

## 9. Fault-injection matrix

List every matrix test implemented/run in this checkpoint.

Recommended row format:

```text
TEST_ID=
TEST_FILE=
TEST_NAME=
PROCESS_ISOLATION=YES|NO
FAULT_METHOD=
EXPECTED_FINAL_STATE=
OBSERVED_FINAL_STATE=
EXIT_CODE=
RESULT=PASS|FAIL|SKIP
```

Summary:

```text
MATRIX_REQUIRED_THIS_PHASE=
MATRIX_RUN=
MATRIX_PASS=
MATRIX_FAIL=
MATRIX_SKIP=
```

Mandatory matrix cases skipped without reviewer-approved reason block PASS.

## 10. Real process-crash evidence

For Phase 2 durability checkpoints, include separately:

```text
CHILD_PROCESS_CRASH_TESTS_RUN=YES|NO
TERMINATION_METHOD=
FRESH_PROCESS_RELOAD=YES|NO
BACKUP_WINDOWS_TESTED=
PRIMARY_WINDOWS_TESTED=
HALT_TRANSITION_WINDOWS_TESTED=
ACK_TRANSITION_WINDOWS_TESTED=
POST_CRASH_DISK_CLASSIFICATIONS=
```

Do not report exception injection as a process crash.

## 11. Durable-state artifacts

Where applicable provide hashes/metadata for representative fixtures:

```text
OLD_EXACT_PAIR_SHA256=
NEW_EXACT_PAIR_SHA256=
CORRUPT_PRIMARY_FIXTURE_SHA256=
CORRUPT_BACKUP_FIXTURE_SHA256=
CONFLICT_PAIR_FIXTURE_SHA256=
STATE_SCHEMA_VERSION=
```

Do not include production account data or secrets in fixtures.

## 12. Venue audit evidence

For Phase 4/5 only:

```text
VENUE=
AUDIT_FILE=
AUDIT_DATE=
OFFICIAL_DOC_SOURCES=
API_VERSION=
READ_ONLY_EVIDENCE=
AUTHENTICATED_READ_ONLY_USED=YES|NO
CREDENTIAL_PERMISSION_SCOPE=
AUTHORITATIVE_FILL_PATH=PROVEN|UNPROVEN|UNSUPPORTED
CANARY_CAPABILITY_STATUS=ELIGIBLE|INELIGIBLE|BLOCKED
UNPROVEN_CAPABILITIES=
```

Never print the credential itself.

## 13. Telemetry/manifest evidence

Where applicable:

```text
MANIFEST_PATH=
MANIFEST_SHA256=
EVENTS_PATH=
EVENT_LINE_COUNT=
EVENTS_SHA256=
COMMIT_SHA_IN_MANIFEST=
SPEC_VERSION_IN_MANIFEST=
SECRET_SCAN_OF_ARTIFACTS=
```

Missing financial metrics remain `null`; do not invent zero-valued evidence.

## 14. CI evidence

```text
CI_RUN_URL_OR_ID=
CI_COMMIT_SHA=
CI_STATUS=
CI_JOBS=
```

A CI result from a different SHA does not validate the candidate.

## 15. Unresolved risks

```text
KNOWN_GAPS=
UNVERIFIED_ASSUMPTIONS=
VENUE_DEPENDENCIES=
PLATFORM_DEPENDENCIES=
FOLLOW_UP_REQUIRED=
```

Do not omit a known concern just because it is outside the current gate.

## 16. Prohibited-action attestation

The implementation agent must explicitly return:

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
```

If any value would be `YES`, stop and explain before requesting gate acceptance.

## 17. Requested reviewer decision

```text
REQUESTED_DECISION=PASS|REJECT|BLOCKED
```

This is only the implementation agent's request. The agent must not phrase it as the actual gate outcome.

## 18. Reviewer response binding

Reviewer should respond with:

```text
REVIEWED_REPOSITORY=
REVIEWED_BRANCH=
REVIEWED_BASE_SHA=
REVIEWED_RESULT_SHA_OR_PATCH_SHA256=
GATE=
DECISION=PASS|REJECT|BLOCKED
P0_FINDINGS=
P1_FINDINGS=
P2_FINDINGS=
P3_FINDINGS=
NEXT_AUTHORIZED_STATE=
LIVE_TRADING_AUTHORIZED=NO
```

If rejected, the corrective prompt should remain bounded to the rejected phase/candidate.
