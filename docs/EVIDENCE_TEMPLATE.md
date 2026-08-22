# Implementation Evidence Packet

Return this packet after every bounded checkpoint.

## 1. Identity

```text
REPOSITORY=
BRANCH=
HEAD_SHA=
BASE_SHA=
WORKTREE_CLEAN_BEFORE=
WORKTREE_CLEAN_AFTER=
NODE_VERSION=
BUN_VERSION=
PACKAGE_MANAGER_VERSION=
```

## 2. Scope

```text
CHECKPOINT=
PRIMARY_OBJECTIVE=
FILES_CHANGED=
DIFF_STAT=
```

State every intentionally untouched area.

## 3. Current-byte evidence

Provide:

- exact `git diff --stat <base>...HEAD`;
- exact changed-file list;
- relevant current file SHA/blob IDs where available;
- patch or PR URL;
- any generated contract/schema/fixture checksums.

Do not rely only on prose summaries.

## 4. Validation

```text
INSTALL_COMMAND=
INSTALL_RESULT=
TYPECHECK_COMMAND=
TYPECHECK_RESULT=
LINT_COMMAND=
LINT_RESULT=
TEST_COMMAND=
TEST_RESULT=
DRY_RUN_COMMAND=
DRY_RUN_RESULT=
SECRET_SCAN_COMMAND=
SECRET_SCAN_RESULT=
```

Include failing tests exactly; do not omit red results.

## 5. Safety claims with evidence

For each applicable claim, give the test or code path that proves it:

- dry-run default;
- no live write;
- cancel != fill;
- authoritative fill provenance;
- partial-fill handling;
- notional cap;
- active reduction;
- daily loss halt;
- drawdown halt;
- boundary halt;
- stale input halt;
- halt persistence;
- unique acknowledgement;
- runtime lease/fencing;
- restart reconciliation;
- duplicate/orphan handling;
- ambiguous API outcome handling.

## 6. Fault injection

List each injected fault and observed final state.

## 7. Unresolved risks

```text
KNOWN_GAPS=
UNVERIFIED_ASSUMPTIONS=
VENUE_DEPENDENCIES=
```

## 8. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_DIRECTLY_MODIFIED=NO
```

## 9. Requested reviewer decision

Implementation agent may request review, but must not self-declare the gate PASS.
