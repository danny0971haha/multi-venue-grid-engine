# INDEX — PR #12 evidence publication (not a new review)

Repository: `danny0971haha/multi-venue-grid-engine`  
PR: [#12](https://github.com/danny0971haha/multi-venue-grid-engine/pull/12)  
Task: **publish existing review evidence only**. This packet is not acceptance, merge authorization, live authorization, or a new byte-identity re-review.

## Dates (keep distinct)

| Event | When |
| --- | --- |
| Named historical review reports (`multi-pr12-evidence-review.md` and siblings) | **NOT_FOUND** |
| PR created / CI run 33967073453 | 2026-09-05T12:45:52Z / 2026-09-05T12:48:10Z |
| Readonly original-child-log observation | 2026-09-07T12:33:28Z → 2026-09-07T12:39:40Z |
| This publication | 2026-09-07T16:43:26Z |

## Identities (distinct)

| Kind | Value |
| --- | --- |
| Reviewed branch | `fix/multi-evidence-byte-identity-20260905` |
| Reviewed HEAD | `4ead28400903ad6c62616835aa9459f67c6d8cd9` |
| Reviewed tree | `3a10f7645b30a33f27ecde824c16e0e36cacae6c` |
| Base | `fix/multi-format-evidence-20260905` @ `9c0f63b1ab0e8c58796f63a1e4f86a9cae12d690` |
| Evidence-only publication branch | see `identity.json` `publication.branch` |
| Publication commit | **different** from reviewed HEAD; this directory is added on that commit |

Reviewed HEAD permalink: https://github.com/danny0971haha/multi-venue-grid-engine/commit/4ead28400903ad6c62616835aa9459f67c6d8cd9

At publication time (2026-09-07T16:43:26Z) remote PR #12 still matched the reviewed pin (OPEN, Draft, `mergedAt=null`). See `publication/pr12-view-before.json`.

## Reviewer / tools

- Independent reviewer named in originals: **UNKNOWN**
- GitHub review threads on 2026-09-07 observation: empty (`originals/logs/pr12-reviews.json`, `pr12-review-comments.json`, `pr12-issue-comments.json`)
- Tools recorded in originals: Cursor agent; `gh` 2.95.0; git 2.50.1
- GitHub actor used for API reads: `danny0971haha` (not an independent review)

## Packet files

| Path | What it is |
| --- | --- |
| [REVIEW.md](REVIEW.md) | Publication narrative citing originals; not a new verdict |
| [identity.json](identity.json) | Reviewed vs publication identity |
| [evidence-manifest.json](evidence-manifest.json) | Per-file source, bytes, SHA-256, bound HEAD/tree |
| [SHA256SUMS.txt](SHA256SUMS.txt) | Hashes of this packet **excluding itself** |
| [NOT_FOUND.md](NOT_FOUND.md) | Named originals that were not obtained |
| [blob-compare-entry-vs-reviewed-git.json](blob-compare-entry-vs-reviewed-git.json) | Workdir `entry/` copies vs reviewed-tree git bytes (packaging check only) |
| [originals/](originals/) | Byte copies of `/Users/apple/multi-pr12-readonly-log-verify-20260907T123234Z` |
| [originals/multi-pr12-log-handoff.md](originals/multi-pr12-log-handoff.md) | Existing 2026-09-07 handoff report |
| [originals/status.json](originals/status.json) | Existing status object |
| [originals/commands/source-ledger.md](originals/commands/source-ledger.md) | Command / source ledger |
| [originals/sources/](originals/sources/) | Source inventory and new-source list |
| [originals/found/NOT_OBTAINED.txt](originals/found/NOT_OBTAINED.txt) | Native original still not obtained |
| [originals/logs/](originals/logs/) | PR/CI/artifact metadata logs |
| [originals/entry/](originals/entry/) | Copies of selected PR #12 HEAD files observed 2026-09-07 |
| [publication/](publication/) | This publication's remote identity snapshot (not the 2026-09-07 review) |

## `artifacts/offline-candidate/test/01.log`

**NOT_OBTAINED_FROM_AVAILABLE_SOURCES.** Do not treat wrapper TAP, committed `integration-summary.json`, local same-named files, or a future rerun as the CI original.

Claimed (unobtained) identity from the 2026-09-07 originals:

- path: `artifacts/offline-candidate/test/01.log`
- claimed SHA-256: `93ed10bd4541a22d16a7c44b5761dcf76b4e9afde8c9f64a7373ca8353c1ef07`
- CI: run `33967073453` / job `101308992804` / attempt `1`
- obtained bytes / length / raw reporter counts: **UNKNOWN** (unobtained ≠ length 0)

## Artifact ZIP (metadata only)

- id `9969805255`
- GitHub digest `sha256:f3642d425b6c1aa41b485be45f0f3f60c7b8567969924444e89cc951da73f6ff`
- name `multi-venue-phase2d-c4-v2-4ead28400903ad6c62616835aa9459f67c6d8cd9`
- bound headSha `4ead28400903ad6c62616835aa9459f67c6d8cd9`
- 2026-09-07 action: **not re-downloaded**; local recomputation of ZIP bytes **NOT_RUN**

Source: `originals/logs/artifact-9969805255.json`, `originals/logs/ci-run-artifacts.json`.

## This upload is not

PASS / ACCEPT / MERGE AUTHORIZED / LIVE AUTHORIZED / a new CI run / a restoration of the missing child log.
