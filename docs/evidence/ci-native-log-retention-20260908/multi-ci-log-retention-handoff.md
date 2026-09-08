# multi-ci-log-retention handoff

This is a bounded CI/evidence implementation. It is not a restore of historical JSON and does not recover the historical child log.

```text
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=CI_NATIVE_LOG_RETENTION
CHECKPOINT=ci-native-log-retention-20260908
REQUESTED_GATE=NONE
BRANCH=fix/multi-ci-native-log-retention-20260908
BASE_SHA=4ead28400903ad6c62616835aa9459f67c6d8cd9
RESULT_SHA=82105054f9aac595e767e5203d3e581ec3c10126
RESULT_TREE=fbeb1194203ad280587070416e2461114b1bcfb4
DRAFT_PR=https://github.com/danny0971haha/multi-venue-grid-engine/pull/13
SOURCE_PR=12
SOURCE_BRANCH=fix/multi-evidence-byte-identity-20260905
SOURCE_BRANCH_PUSHED=NO
PR_12_REWRITTEN=NO
PR_11_TOUCHED=NO
```

## Historical vs fresh

```text
HISTORICAL_RUN_ID=33967073453
HISTORICAL_JOB_ID=101308992804
HISTORICAL_ATTEMPT=1
HISTORICAL_MISSING_PATH=artifacts/offline-candidate/test/01.log
HISTORICAL_ORIGINAL_LOG=NOT_OBTAINED

FRESH_EXECUTION_LOG=OBTAINED
FRESH_PACKET_VERIFICATION=VERIFIED_FROM_DOWNLOAD
FRESH_RUN_ID=34203992314
FRESH_JOB_KEY=verify
FRESH_JOB_DATABASE_ID_IN_PACKET=UNKNOWN
FRESH_JOB_DATABASE_ID_FROM_GITHUB_API=101989088499
FRESH_ATTEMPT=1
FRESH_ARTIFACT_ID=10047050163
```

The downloaded native log is from run `34203992314` on `82105054f9aac595e767e5203d3e581ec3c10126`. It is not the original log from run `33967073453`. This does not close the historical acceptance gap.

## What changed

CI now captures, in one run-scoped packet:

- original `npm run test:offline-integration` stdout and stderr
- a byte copy of `artifacts/offline-candidate/test/01.log`
- `evidence-manifest.json` with repository, source HEAD/tree, tested HEAD/tree, workflow, run/job/attempt, UTC, command, observed exit/signal, and per-file bytes/SHA-256

`finalize` and packet upload use `if: always()`. There is no `continue-on-error` and no `|| true`. A later-step failure still leaves the job red.

Packet JSON is biome-formatted after write so the existing Phase 2D evidence generator's later `format:check` is not tripped by our metadata. Native logs are not rewritten.

## Scope

```text
ALLOWED_WRITE_PATHS=.github/workflows/ci.yml, scripts/ci-native-log-retention/**, docs/evidence/ci-native-log-retention-20260908/**
FILES_CHANGED=.github/workflows/ci.yml
FILES_ADDED=scripts/ci-native-log-retention/*, docs/evidence/ci-native-log-retention-20260908/**
INTENTIONALLY_UNTOUCHED_AREAS=src/, scripts/offline-candidate.py, package.json, package-lock.json, Node/npm pins, immutable current-candidate evidence, trusted governance workflows/rulesets/required checks, existing integration/halt/risk tests, original CI job name, existing Action pins
```

## Toolchain

Local reporter host (not the CI runner):

```text
OS=Darwin
ARCH=arm64
NODE_VERSION=v26.5.0
NPM_VERSION=11.17.0
```

CI runner used the repo pin:

```text
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
```

Local Node/npm do not match the pin. Cloud results are authoritative for this packet.

## Validation

New tool tests (separate TAP group, not added to 25/474/13/79):

```text
COMMAND=node --test --test-reporter=tap scripts/ci-native-log-retention/ci-native-log-retention.test.mjs
LOCAL_AND_CI_TAP=tests 12 / pass 12 / fail 0 / cancelled 0 / skipped 0 / todo 0
```

Covered failure cases: child non-zero exit; missing native log without a fake empty file; log/manifest hash mismatch; packet verifies after child test failure; NOT_RUN when integration did not run; TAP missing/duplicate/wrong totals; stale packet id / wrong tested SHA / undeclared extra file.

Existing suites were not mixed into those 12 counts. Cloud `npm test` / offline-integration / phase2e TAP groups remain their own steps.

## Fresh downloaded packet

Verified with `scripts/ci-native-log-retention/verify.mjs` on the extracted download, not the pre-upload directory.

```text
ZIP_BYTES=3786
ZIP_SHA256=eabc5add87f77316d6cb7116b0f98adb9e997f00da3df4449cb013181bc4dddc
GITHUB_ARTIFACT_DIGEST=sha256:eabc5add87f77316d6cb7116b0f98adb9e997f00da3df4449cb013181bc4dddc
NATIVE_LOG_BYTES=2418
NATIVE_LOG_SHA256=8e377fa0b818364f0bc42afdb5b90fb5c999bddc8ba3800e96d6bf356c514849
TAP_FROM_NATIVE_LOG=tests 13 pass 13 fail 0 cancelled 0 skipped 0 todo 0
WRAPPER_LOGSHA256_MATCHES_NATIVE=YES
TESTED_CHECKOUT_SHA=82105054f9aac595e767e5203d3e581ec3c10126
SOURCE_HEAD=4ead28400903ad6c62616835aa9459f67c6d8cd9
CHILD_EXIT_OBSERVED=0
CHILD_SIGNAL_OBSERVED=null
```

`jobDatabaseId` in the in-job manifest is `UNKNOWN` because the runner does not expose the numeric GitHub job id as an observed shell value. `101989088499` is recorded from the GitHub API after download and is not used as a fabricated shell exit code.

## Ordinary CI vs trusted gate

```text
ORDINARY_CI_WORKFLOW=Phase 0 CI
ORDINARY_CI_RUN=34203992314
ORDINARY_CI_CONCLUSION=success

TRUSTED_GATE_WORKFLOW=Trusted Phase 2D freeze gate
TRUSTED_GATE_RUN=34203994256
TRUSTED_GATE_CONCLUSION=failure
TRUSTED_GOVERNANCE_SETTINGS_CHANGED=NO
```

The trusted gate was not modified to turn green on a non-main branch.

## Prior always-run demonstration

Run `34194812274` on `b8fb38d1405a6b12fba585d7f97b73a8b76fe17f` failed at `Generate Phase 2D Corrective 4 evidence` (`format:check` on unformatted packet JSON). Integration had already succeeded. Finalize and native-log upload still succeeded. That run is not this packet.

## Unresolved

```text
KNOWN_GAPS=historical run 33967073453 native 01.log remains NOT_OBTAINED; in-job numeric jobDatabaseId remains UNKNOWN; trusted Phase 2D freeze gate is red on this non-main draft PR
UNVERIFIED_ASSUMPTIONS=none for the downloaded 34203992314 packet hashes above
FOLLOW_UP_REQUIRED=independent reviewer decision; do not treat this as closing the historical log gap
```

## Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
FROZEN_REFS_MODIFIED=NO
```

## Requested reviewer decision

```text
REQUESTED_DECISION=BLOCKED
```

Blocked for historical-original-log still `NOT_OBTAINED`, and because this agent must not declare PASS / ACCEPT / MERGE AUTHORIZED / LIVE AUTHORIZED. The independent reviewer decides.
