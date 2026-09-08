# Implementation Evidence Packet

Version: 0.2.0. Independent protection collector v2 corrective checkpoint. This is an implementation handoff, not a reviewer decision.

## 1. Identity

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=Bounded protection collector v2 corrective implementation
CHECKPOINT=API contract, observed ref identities, permission evidence, incomplete data
REQUESTED_GATE=Independent review of this corrective tool only
BRANCH=fix/multi-protection-collector-v2-20260909
BASE_SHA=b2ea605d5ed507b634f9a2ee5907db39bf129d13
RESULT_SHA=cc7614195661ffb18da44d9c5ba6e31c100281b2
RESULT_TREE=16000a1c6a643862fd1bb077c62053f6731cc1e3
REMOTE_BRANCH_SHA=Recorded in the final PR body and final receipt after publication
WORKTREE_CLEAN_BEFORE=YES in isolated corrective worktree; NO in original worktree
WORKTREE_CLEAN_AFTER=YES at checkpoint commit; this evidence-only publication follows it
```

RESULT_SHA binds the final tool bytes and tests. The following publication commit only packages this handoff and a losslessly archived formatter diagnostic. Its exact head/tree and complete final diff are reported in the Draft PR body and final receipt, avoiding a self-referential commit hash in this file. No old task or branch is rewritten.

Pre-edit branch, SHA, tree, status, toolchain and current ref reconciliation are in precollection-reconciliation.json and CORRECTIONS.md. Original local tooling advanced to 3a59255; original local main is stale at b1e035d; remote tooling/main match the requested b2ea605/22665d7. Original .omo and caches remain untouched.

## 2. Toolchain

```text
OS=Darwin 25.3.0
ARCH=arm64
NODE_VERSION=v26.5.0
NPM_VERSION=11.17.0
TYPESCRIPT_VERSION=7.0.2 declared in unchanged package.json; not invoked
PACKAGE_MANAGER_VERSION=npm 11.17.0; no install performed
PYTHON_VERSION=3.13.14
GH_VERSION=2.95.0
GIT_VERSION=2.50.1 (Apple Git-155)
BIOME_VERSION=2.5.10 existing local binary, no dependency installation
```

Node/npm differ from the Phase 0 baseline 22.23.2/10.9.8. This Python-only tool checkpoint does not claim runtime/Phase 0 validation with those host versions.

## 3. Scope

```text
PRIMARY_OBJECTIVE=Prevent false complete/absent protection conclusions and bind actual identities
ALLOWED_WRITE_PATHS=tools/review/protection-collector-v2/; docs/evidence/protection-v2-corrective-20260909/
FILES_CHANGED=Exact final diff in the PR and final receipt; tool patch archived below
FILES_ADDED=Same-repository v2 tests/fixtures, validation.py, scoped .gitignore, new evidence
FILES_DELETED=Only task-owned unarchived evidence replaced by lossless archives/byte-preserving renames
DIFF_STAT=Exact output in final receipt; candidate acquisition output in candidate-byte-evidence.json
INTENTIONALLY_UNTOUCHED_AREAS=src, runtime/trading tests, dependencies, lockfiles, governance workflows, trusted baselines, settings, rulesets, original branches/PRs
```

No third-party implementation was imported. Existing later-local v2 tests/fixtures came from this repository's 3a59255 lineage; fixture and assertion changes are documented in CORRECTIONS.md. No old collector review conclusion is inherited.

## 4. Current-byte evidence

`final-tool.patch.gz` decompresses to the complete tool diff from b2ea605 through the final tool checkpoint. Exact git status/diff/name-status/stat/numstat outputs for the acquisition checkpoint are in candidate-byte-evidence.json; final publication outputs are in the final receipt and PR body.

```text
PR_OR_PATCH_REFERENCE=New Draft PR against main, published by this task; final-tool.patch.gz
PATCH_SHA256=ff8478133a258a9e0738d1b6e17b1b7df50ceceb3d41a0a24acad1b29311c08b
PATCH_BYTES=173214
PATCH_LF_COUNT=3641
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
GENERATED_SCHEMA_HASHES=Official raw schema SHA256 17100b7b203d6ea39ddc85b76e36b213d54d6d749ded368cc22e7297b1f27c79; not a generated runtime schema
FIXTURE_HASHES=Per-file final tool manifest in final receipt; initial manifest retained as tool-files-precommit.json
```

Patch metrics refer to uncompressed final tool patch bytes. The initial tool-corrective.patch.gz is a separate earlier checkpoint, not silently replaced. SHA256SUMS covers the publication files; the native archive has its own internal SHA256SUMS and provenance.

## 5. Dependency evidence

```text
PACKAGE=NONE
OLD_VERSION=N/A
NEW_VERSION=N/A
RUNTIME_OR_DEV=N/A
PURPOSE=N/A
LICENSE=N/A
LOCKFILE_CHANGED=NO
WHY_EXISTING_TOOLS_INSUFFICIENT=N/A; Python standard library and existing gh suffice
```

## 6. Validation commands

```text
INSTALL_COMMAND=NOT_RUN (no dependency changes)
INSTALL_EXIT=N/A
INSTALL_RESULT=Not needed for Python standard-library tool
TYPECHECK_COMMAND=NOT_RUN (no TypeScript changes)
TYPECHECK_EXIT=N/A
TYPECHECK_RESULT=Outside this tool checkpoint
LINT_COMMAND=NOT_RUN for unchanged runtime
LINT_EXIT=N/A
LINT_RESULT=No runtime lint claim
FORMAT_CHECK_COMMAND=Existing Biome format on tool fixtures and new non-native evidence; native bodies remain byte-preserved
FORMAT_CHECK_EXIT=0 for final bounded checks
FORMAT_CHECK_RESULT=Fixture/evidence formatting completed; interrupted earlier evidence check retained separately
TEST_COMMAND=python3 -m unittest discover -s tools/review/protection-collector-v2/tests -t tools/review/protection-collector-v2 -v
TEST_EXIT=0
TEST_RESULT=OK; tests-final.txt
TEST_TOTAL=60
TEST_PASS=60
TEST_FAIL=0
TEST_SKIP=0
BUILD_COMMAND=NOT_RUN (Python collector)
BUILD_EXIT=N/A
BUILD_RESULT=No runtime build claim
DRY_RUN_COMMAND=Read-only collection command in collection-command.json; offline repack command below
DRY_RUN_EXIT=1 for original packaging scan; 0 for offline repack
DRY_RUN_RESULT=67 responses collected; complete redacted packet produced offline with provenance
SECRET_SCAN_COMMAND=node scripts/check-secrets.mjs plus full unpacked packet evidence scan
SECRET_SCAN_EXIT=0 after correction
SECRET_SCAN_RESULT=No credential findings; 145 packet hashes verified
DIFF_CHECK_COMMAND=git diff --check b2ea605 HEAD
DIFF_CHECK_EXIT=0 for final publication; initial evidence whitespace failures are preserved
```

All earlier red results remain visible: baseline b2ea605 test discovery exits 1 because no tests directory exists; first corrective run has 13 fixture-route errors; second has 1 missing-classic-URL fixture failure; subsequent 53/55/59/60-test runs succeed. Schema alias introspection exits 1 before the successful query. Initial evidence diff checks flag verbatim patch/log whitespace; those bytes are losslessly archived. The optional evidence formatter was terminated while generating a huge schema diff, not reported as a successful check. No test failure or packaging failure was reclassified as a pass.

## 7. Contract conformance

```text
CONTRACT_FILES_READ=AGENTS.md; docs/EVIDENCE_TEMPLATE.md; docs/IMPLEMENTATION_CONTRACT.md; docs/REVIEW_CHANGE_PROTOCOL.md; docs/TRUSTED_PHASE2D_REVIEW_BOUNDARY.md; .github/trusted/repository-governance-policy.json; collector README; PR11 trusted workflow diff
CONTRACT_FILES_CHANGED=NONE
EXPERIMENT_ENVELOPE_CHANGED=NO
ARCHITECTURE_SEMANTICS_CHANGED=NO
CONTRACT_CHANGE_REQUEST_ID=N/A
```

## 8. Safety claims and evidence

```text
DRY_RUN_DEFAULT=Collector is read-only; no trading mode
LIVE_MODE_FAIL_CLOSED=NOT_IMPLEMENTED_THIS_PHASE
NO_LIVE_WRITE_PATH=REST method guard accepts GET only; GraphQL operation guard accepts queries only; actual ledger verified
DECIMAL_ARITHMETIC_AUTHORITY=NOT_IMPLEMENTED_THIS_PHASE
CANCEL_NOT_FILL=NOT_IMPLEMENTED_THIS_PHASE
DISAPPEARANCE_NOT_FILL=NOT_IMPLEMENTED_THIS_PHASE
AUTHORITATIVE_FILL_PROVENANCE=NOT_IMPLEMENTED_THIS_PHASE
PARTIAL_FILL_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
UNKNOWN_WRITE_RECONCILIATION=NOT_IMPLEMENTED_THIS_PHASE
ORDER_OWNERSHIP_CLASSIFICATION=NOT_IMPLEMENTED_THIS_PHASE
PLANNED_NOTIONAL_CAP=NOT_IMPLEMENTED_THIS_PHASE
ACTUAL_NOTIONAL_REDUCTION=NOT_IMPLEMENTED_THIS_PHASE
DAILY_LOSS_HALT=NOT_IMPLEMENTED_THIS_PHASE
START_DRAWDOWN_HALT=NOT_IMPLEMENTED_THIS_PHASE
BOUNDARY_HALT=NOT_IMPLEMENTED_THIS_PHASE
STALE_INPUT_HALT=NOT_IMPLEMENTED_THIS_PHASE
HALT_PERSISTENCE=NOT_IMPLEMENTED_THIS_PHASE
DURABLE_HALT_ACK=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_PERSISTENCE_LATCH=NOT_IMPLEMENTED_THIS_PHASE
RUNTIME_LEASE_FENCING=NOT_IMPLEMENTED_THIS_PHASE
RESTART_RECONCILIATION=NOT_IMPLEMENTED_THIS_PHASE
DUPLICATE_ORDER_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
ORPHAN_ORDER_HANDLING=NOT_IMPLEMENTED_THIS_PHASE
FATAL_RUNTIME_FAIL_CLOSED=NOT_IMPLEMENTED_THIS_PHASE
```

Collector-specific evidence: test_corrective.py exercises null/missing shapes, partial GraphQL data, HTTP faults mid-page, repeated/missing cursors, duplicate identities/count mismatches, before/after ref moves, permission confusion and non-applicability prerequisites. test_schema_contract.py verifies the query against the saved official schema. test_safety.py and real-transport mock tests reject mutations before subprocess execution. test_redact.py covers both masked tokens and bare prefixes in synthetic code.

## 9. Fault-injection matrix

```text
MATRIX_REQUIRED_THIS_PHASE=Collector identity/API/completeness/permission regression cases
MATRIX_RUN=60 unittest methods, including parameterized counterexamples
MATRIX_PASS=60
MATRIX_FAIL=0
MATRIX_SKIP=0
```

fault-matrix.json lists every executed test identity and observed result. HTTP/GraphQL fault injection uses local scripted transports; actual transport subprocess calls are mocked. PROCESS_ISOLATION=NO; no process-crash claim is made. tests-final.txt retains individual outcomes; source methods show inputs and asserted final classifications.

## 10. Real process-crash evidence

```text
CHILD_PROCESS_CRASH_TESTS_RUN=NO
TERMINATION_METHOD=N/A
FRESH_PROCESS_RELOAD=N/A
BACKUP_WINDOWS_TESTED=N/A
PRIMARY_WINDOWS_TESTED=N/A
HALT_TRANSITION_WINDOWS_TESTED=N/A
ACK_TRANSITION_WINDOWS_TESTED=N/A
POST_CRASH_DISK_CLASSIFICATIONS=N/A
```

No trading persistence code changed.

## 11. Durable-state artifacts

```text
OLD_EXACT_PAIR_SHA256=N/A
NEW_EXACT_PAIR_SHA256=N/A
CORRUPT_PRIMARY_FIXTURE_SHA256=N/A
CORRUPT_BACKUP_FIXTURE_SHA256=N/A
CONFLICT_PAIR_FIXTURE_SHA256=N/A
STATE_SCHEMA_VERSION=N/A; no runtime state migration
```

## 12. Venue audit evidence

```text
VENUE=N/A
AUDIT_FILE=N/A
AUDIT_DATE=N/A
OFFICIAL_DOC_SOURCES=API-CONTRACT.md (GitHub only)
API_VERSION=REST 2026-03-10; live GraphQL schema verified on 2026-09-09 Asia/Taipei
READ_ONLY_EVIDENCE=67 GET/query requests in archived ledger; offline repack issued zero requests
AUTHENTICATED_READ_ONLY_USED=YES, GitHub only
CREDENTIAL_PERMISSION_SCOPE=Existing gh; repo permissions.admin=true before/after and GraphQL viewerPermission=ADMIN
AUTHORITATIVE_FILL_PATH=N/A
CANARY_CAPABILITY_STATUS=INELIGIBLE
UNPROVEN_CAPABILITIES=All live exchange/trading capabilities outside scope
```

Accepted-permission headers were not used as caller grants. No token was requested or put on argv/chat/evidence.

## 13. Telemetry/manifest evidence

```text
MANIFEST_PATH=collection-repacked.tar.gz -> collection/tool-manifest.json and repack-provenance.json
MANIFEST_SHA256=Listed in the archive's SHA256SUMS
EVENTS_PATH=collection/request-ledger.json
EVENT_LINE_COUNT=67 request records; not trading telemetry
EVENTS_SHA256=Listed in the archive's SHA256SUMS
COMMIT_SHA_IN_MANIFEST=9b13a7fd3c0d7b354d6a5bf8ceefab4c838d112b acquisition; 43e9a371492bf807db23b3046824807c52beeefe offline packaging
SPEC_VERSION_IN_MANIFEST=2.0.1-independent-corrective
SECRET_SCAN_OF_ARTIFACTS=Completed after prefix masking; no unredacted credential findings
ARCHIVE_SHA256=2706e664f55a596357fb5a4ee92d947e2d6029d9d0f27197bafaf3ef4739c6f2
```

See packaging-note.md for original exit 1, the two old/new body hash pairs, unchanged analysis bytes and offline repack exit 0. The failed first packet is preserved locally. This is one new collection, not restoration of any historical run.

## 14. CI evidence

```text
CI_RUN_URL_OR_ID=Observe only after new branch/PR publication; final response/receipt reports available status
CI_COMMIT_SHA=Must equal final published head to apply
CI_STATUS=NOT_RUN at tool checkpoint; no inherited CI conclusion
CI_JOBS=No runtime/retention/trusted gate work in this checkpoint
```

Existing PR13 native run 34205089339/artifact 10047503719 was not redone. Historical 33967073453 remains NOT_OBTAINED (user-supplied boundary). Trusted 34205091382 MODULE_NOT_FOUND remains the existing stacked-base/governance adoption issue; it was not made green by editing PR13 or weakening governance.

## 15. Unresolved risks

```text
KNOWN_GAPS=No source UNKNOWN remained in this particular applicable-source snapshot; independent tool/governance acceptance remains outstanding
UNVERIFIED_ASSUMPTIONS=Sequential reads are not an atomic or future settings guarantee
VENUE_DEPENDENCIES=NONE
PLATFORM_DEPENDENCIES=GitHub schema/permissions may change; future runs must retain failures as UNKNOWN
FOLLOW_UP_REQUIRED=Independent review of final collector bytes and separate PR11 adoption
```

Confirmed snapshot: ruleset 21580900 is active and includes refs/heads/main; expected context is tied to integration 15368. Classic rule pattern main also requires that context and the CI context, both app 15368. The before/after main/PR11/frozen SHA/tree identities match the supplied expectations. All observed pages and allowances in this run completed. Official product scope plus exact User-owned, non-fork repository observations support organization/enterprise NOT_APPLICABLE. Non-main required context is NOT_PRESENT_IN_COMPLETE_EXPORT for this verified window, not a permanent absence claim.

General remaining coverage limits are explicit: allowances beyond 20, unsupported rule parameter schemas, complex wildcard language, unknown/fork ownership and unexported organizational coverage remain incomplete/UNKNOWN when encountered. Confirmed rules are not discarded when another source is incomplete.

PR11 adoption requires an independent review bound to head de2f5c0fd055e418d0b6d806f994b52baa743544/tree 1b443a620670216968b95cc43de96397550c24f2 and actual main base; review its main-only trigger and trusted-base/scope changes, required-context app binding, adoption order and current protections. This collection does not authorize adopting or merging PR11.

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
SETTINGS_OR_RULESET_WRITE=NO
PR11_PR12_PR13_REWRITTEN=NO
MERGE_REBASE_FORCE_PUSH=NO
```

Only the new corrective branch and its new Draft PR are published. Publication is separate from the collector's GET/query-only network boundary.

## 17. Requested reviewer decision

```text
REQUESTED_DECISION=Independent reviewer to decide PASS / REJECT / BLOCKED for this exact corrective candidate
IMPLEMENTATION_AGENT_VERDICT=NOT_DECLARED
```

## 18. Reviewer response binding

```text
REVIEWED_REPOSITORY=danny0971haha/multi-venue-grid-engine
REVIEWED_BRANCH=fix/multi-protection-collector-v2-20260909
REVIEWED_BASE_SHA=b2ea605d5ed507b634f9a2ee5907db39bf129d13 (corrective base); 22665d7fa9274dfc05de043c8e9663e24e75087e (PR main base)
REVIEWED_RESULT_SHA_OR_PATCH_SHA256=Reviewer records final PR head/tree and final-tool patch hash above
GATE=Protection collector v2 corrective review only
DECISION=Reviewer supplies PASS / REJECT / BLOCKED
P0_FINDINGS=Reviewer supplies
P1_FINDINGS=Reviewer supplies
P2_FINDINGS=Reviewer supplies
P3_FINDINGS=Reviewer supplies
NEXT_AUTHORIZED_STATE=Reviewer supplies; no implicit governance/trading progression
LIVE_TRADING_AUTHORIZED=NO
```
