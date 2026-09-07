# REVIEW.md — PR #12 existing evidence publication

This file is a **publication wrapper**. It does not re-run formatters, manifest verifiers, tests, artifact downloads, or historical log hunts. Conclusions below are traced to files under `originals/` or explicitly marked **NOT_FOUND** / **INHERITED_NOT_REVERIFIED**.

Reviewer: **UNKNOWN**. Tools: Cursor agent + `gh`/`git` as recorded in `originals/identity-before.txt` and `originals/commands/source-ledger.md`.

## 1. Remote identity vs pin (publication time vs observation)

The 2026-09-07 originals recorded a match to the reviewed pin (`originals/multi-pr12-log-handoff.md` §1, `originals/status.json`, `originals/logs/pr12-view.json`, `originals/logs/ls-remote-refs-after.txt`).

This publication re-read GitHub at 2026-09-07T16:43:26Z (`publication/pr12-view-before.json`, `publication/ls-remote-before.txt`):

- PR #12 OPEN, Draft, `mergedAt=null`
- head `4ead28400903ad6c62616835aa9459f67c6d8cd9` tree `3a10f7645b30a33f27ecde824c16e0e36cacae6c`
- base `fix/multi-format-evidence-20260905` @ `9c0f63b1ab0e8c58796f63a1e4f86a9cae12d690`

**No identity drift** versus the 2026-09-07 report. This packet is **not** re-labeled as a review of a different SHA.

Reviewed HEAD and the evidence-only publication commit are **different identities**.

## 2. What exists vs what is missing

### Found (published as `originals/`)

- `multi-pr12-log-handoff.md` — 2026-09-07 readonly original-child-log check
- `status.json` — `original_log_obtained=NOT_OBTAINED_FROM_AVAILABLE_SOURCES`; provenance/hash verified false; reporter counts UNKNOWN
- `identity-before.txt` / `identity-after.txt`
- `commands/source-ledger.md`
- `sources/source-inventory.json`, `sources/new-sources-list.md`
- `found/NOT_OBTAINED.txt`
- `prospective-evidence-proposal.md` (proposal only; **not executed**)
- `SHA256SUMS` of that workdir (verified against files before copy)
- `logs/*` PR/CI/artifact metadata
- `entry/*` selected PR #12 HEAD file copies observed that round

### NOT_FOUND (do not treat as pass)

See `NOT_FOUND.md`. Named historical reports `multi-pr12-integration-log-delta.md`, `multi-pr12-closure.md`, `multi-pr12-evidence-review.md`, `multi-handoff.md` were already **NOT_FOUND** on 2026-09-07. This publication does not reconstruct them from chat or the PR body.

`originals/sources/source-inventory.json` records inherited completed items with `"inheritance": "承接既有結論，本輪未重驗"`. Because those named reports are still **NOT_FOUND**, this packet **does not** treat fixtures 25 / historical 474 / halt 79 / wrapper 13/13 as independently proven here.

## 3. Committed evidence bytes / manifest (reviewed tree)

`originals/entry/docs_evidence_current-candidate_files.json` lists six JSON payloads plus `integration-summary.json` with SHA-256 values. Packaging compared those `entry/` copies to `git show` of reviewed HEAD (see `blob-compare-entry-vs-reviewed-git.json`). Matching git bytes means the 2026-09-07 copies are the reviewed-tree files; it is **not** a new verifier run.

Those committed packets bind **runtime candidate** identity in `integration-summary.json`:

- `candidate`: `704afa2dd858c52dad06aa22941d463aa5ce4d69`
- `candidateTree`: `bda9793acd2fb8de033f65739b8c092cbdec7d9b`
- `workingTreeStatus`: dirty tree listed in that JSON
- wrapper TAP `logSha256`: `7b0acec7f565862f6a7d0db4120e3551da7a4d2d44f755c5e45b4bf8d250b3f5`
- wrapper counts: tests 13 / pass 13 / fail 0 / cancelled 0 / skipped 0 / todo 0, exit 0

That wrapper summary is **not** CI run `33967073453` native `artifacts/offline-candidate/test/01.log`.

`originals/sources/source-inventory.json` also records nested citation hash `45b73513…` inside `raw-logs.json` `09.txt` as **not obtained as a file** and **not** the CI original.

## 4. Artifact ZIP

GitHub metadata only (`originals/logs/artifact-9969805255.json`):

| Field | Value |
| --- | --- |
| id | 9969805255 |
| GitHub `digest` | `sha256:f3642d425b6c1aa41b485be45f0f3f60c7b8567969924444e89cc951da73f6ff` |
| size_in_bytes (API) | 32854 |
| expired | false (as of 2026-09-07T12:34:42Z) |
| workflow_run.id | 33967073453 |
| head_sha | `4ead28400903ad6c62616835aa9459f67c6d8cd9` |
| upload path in workflow | `artifacts/phase2d-corrective4/` only (`originals/entry/ci.yml`) |

**Local recomputation of ZIP bytes:** NOT_RUN (2026-09-07 explicitly did not re-download). This publication also did not download the ZIP.

Therefore: GitHub digest is **metadata**; actual local SHA-256 of ZIP bytes is **NOT_FOUND** in this packet.

The retained artifact path does **not** include `artifacts/offline-candidate/test/01.log` (`originals/multi-pr12-log-handoff.md` §4, `originals/sources/new-sources-list.md`).

## 5. CI result vs local result vs wrapper (bound identities)

| Kind | Bound identity | Result in originals | Is native 01.log from run 33967073453? |
| --- | --- | --- | --- |
| Phase 0 CI run 33967073453 job 101308992804 attempt 1 | headSha `4ead2840…` | conclusion **success** (`originals/logs/ci-run-33967073453.json`) | **No** — job succeeded; child file not in retained artifact |
| Trusted-gate runs 33967075000 / 33967581058 | PR #12 head | **FAILURE** on `trusted-phase2d-freeze-gate` (`originals/logs/pr12-view.json`) | **No** — governance/stacked-base issue; not this child-log gap |
| Committed wrapper `integration-summary.json` | runtime candidate `704afa2…` dirty tree | 13/13 exit 0, logSha256 `7b0acec7…` | **No** |
| Local same-named 01.log `d3b340fa…` (2416 bytes) | prior record | **file not found** 2026-09-07; operator had said not original | **No** |
| Native CI 01.log claimed `93ed10bd…` | run 33967073453 | **NOT_OBTAINED** | n/a |

Independent child logs beside the wrapper summary: **not obtained** as original CI files. Unobtained ≠ proven nonexistent. Owner retention: **UNKNOWN** (no owner confirmation in originals).

## 6. `artifacts/offline-candidate/test/01.log` acquisition status

| Question | Answer | Source |
| --- | --- | --- |
| Original CI file obtained? | **NOT_OBTAINED_FROM_AVAILABLE_SOURCES** | `originals/status.json`, `originals/found/NOT_OBTAINED.txt` |
| Provenance verified? | false | `originals/status.json` |
| Hash verified on obtained bytes? | false | `originals/status.json` |
| Byte length | UNKNOWN | `originals/status.json` |
| Raw TAP reporter counts | UNKNOWN | `originals/status.json` |
| Job-log download used as substitute? | **No** (forbidden and not done) | `originals/multi-pr12-log-handoff.md` §5 |
| This publication re-executed tests? | **No** | task constraint |

Gap remains open. Prospective A/B in `originals/prospective-evidence-proposal.md` were **not executed** and would only prove **new** runs.

## 7. Publication limits

No merge, force-push, rebase, workflow rerun, settings change, or live exchange write. PR #11 evidence is not used here.
