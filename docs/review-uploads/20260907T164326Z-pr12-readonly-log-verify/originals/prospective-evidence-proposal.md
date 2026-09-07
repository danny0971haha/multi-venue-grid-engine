# Prospective evidence proposal (not executed)

This is a proposal only. It does **not** restore CI run `33967073453` native `artifacts/offline-candidate/test/01.log`.

**Do not** treat a future execution as that run's original. **Do not** edit PR #12 verifier, governance pins, or workflows in this round. Governance red lamp on trusted run `33967581058` / job `101310303078` remains **PR #11** work.

Operator / independent reviewer chooses A, B, both, or neither.

## A. New isolated execution of the same candidate

Purpose: produce a **new** native stdout/stderr child log with its own execution identity.

Suggested bounds (reviewer may tighten):

- Checkout exact HEAD `4ead28400903ad6c62616835aa9459f67c6d8cd9` / tree `3a10f7645b30a33f27ecde824c16e0e36cacae6c` in a **new** worktree, not the PR #11 governance checkout.
- Run `npm run test:offline-integration` (`python3 scripts/offline-candidate.py test`) under documented isolation.
- Preserve unmodified `artifacts/offline-candidate/test/01.log` **outside** the repository: bytes, length, SHA-256, process exit, TAP `tests/pass/fail/cancelled/skipped/todo`.
- Record new execution identity: timestamp, host, command, env isolation, HEAD/tree, worktree status. Do **not** label it `CI_RUN=33967073453`.

This can corroborate wrapper 13/13 behavior on the same bytes. It cannot close the original-CI-log gap.

## B. Minimal future CI artifact retention (separate change)

Purpose: keep native child logs **for future runs**, including failures.

Suggested bounds:

- Separate PR from both #12 evidence-byte work and #11 trusted-gate work.
- Upload `artifacts/offline-candidate/` (or the specific `test/01.log`) with the same run's identity/manifest.
- `if-no-files-found: error` on the path that must exist; retain on failure as well as success.
- Do not rewrite historical run `33967073453`.

This only helps **later** runs.

## What this proposal does not do

- Does not claim the TARGET SHA-256 has been obtained.
- Does not authorize merge, live trading, workflow dispatch, or rerun of `33967073453`.
- Does not mix PR #11 governance enforcement into this log-gap.

## Reviewer decision needed

- [ ] A — authorize a new isolated execution and retain native logs
- [ ] B — authorize a future-CI retention PR
- [ ] Neither — leave original log `NOT_OBTAINED_FROM_AVAILABLE_SOURCES`
- [ ] Owner statement — if the original was never saved, record `OWNER_CONFIRMED_NOT_RETAINED` with time (only the owner can say this)
