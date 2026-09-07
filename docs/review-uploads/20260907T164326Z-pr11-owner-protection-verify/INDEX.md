# INDEX — PR #11 evidence publication (not a new review)

Repository: `danny0971haha/multi-venue-grid-engine`  
PR: [#11](https://github.com/danny0971haha/multi-venue-grid-engine/pull/11)  
Task: **publish existing review evidence only**. This packet is not acceptance, merge authorization, settings change, or owner adoption.

## Dates (keep distinct)

| Event | When |
| --- | --- |
| Named follow-up/closure reports | **NOT_FOUND** |
| Committed corrective note date | 2026-09-05 (`docs/TRUSTED_BASE_SCOPE_CORRECTIVE_20260905.md`) |
| Readonly owner-protection observation | 2026-09-07T09:50:10Z → 2026-09-07T09:54:51Z |
| Intended extra handoff write | attempted ~2026-09-07T09:55:10Z; **blocked; files never created** |
| This publication | 2026-09-07T16:43:26Z |

## Identities (distinct)

| Kind | Value |
| --- | --- |
| Reviewed branch | `fix/multi-trusted-base-scope-20260905` |
| Reviewed HEAD | `de2f5c0fd055e418d0b6d806f994b52baa743544` |
| Reviewed tree | `1b443a620670216968b95cc43de96397550c24f2` |
| Base | `main` @ `22665d7fa9274dfc05de043c8e9663e24e75087e` (tree `6981c1124524895273fb09b53d769ca9dbb722bc`) |
| Evidence-only publication branch | see `identity.json` `publication.branch` |
| Publication commit | **different** from reviewed HEAD |

Reviewed HEAD permalink: https://github.com/danny0971haha/multi-venue-grid-engine/commit/de2f5c0fd055e418d0b6d806f994b52baa743544

At publication time, remote PR #11 still matched the reviewed pin (OPEN, Draft, `mergedAt=null`). See `publication/pr11-view-before.json`.

`merge_commit_sha=a61b1f87ecb7d14fd7dc2a73f68e7db4921f0160` in `originals/logs/pr11-rest-get.json` is the ephemeral test-merge while `merged=false`. It is **not** a merge.

## Reviewer / tools

- Independent reviewer named in on-disk originals: **UNKNOWN**
- Tools: Cursor agent; `gh` 2.95.0; git 2.50.1; python3 3.13.14 (`originals/identity-before.txt`)
- GitHub actor for reads: `danny0971haha`
- Collector: **not obtained, not executed** → **沒有 owner 執行證據**

## Packet files

| Path | What it is |
| --- | --- |
| [REVIEW.md](REVIEW.md) | Publication narrative citing on-disk originals |
| [identity.json](identity.json) | Reviewed vs publication identity |
| [evidence-manifest.json](evidence-manifest.json) | Per-file source, bytes, SHA-256 |
| [SHA256SUMS.txt](SHA256SUMS.txt) | Packet hashes **excluding itself** |
| [NOT_FOUND.md](NOT_FOUND.md) | Missing originals, including blocked handoff files |
| [blob-compare-corrective-note-vs-reviewed-git.json](blob-compare-corrective-note-vs-reviewed-git.json) | Workdir note copy vs reviewed git bytes |
| [originals/](originals/) | Byte copies of `/Users/apple/multi-pr11-readonly-verify-20260907T095010Z` |
| [originals/identity-before.txt](originals/identity-before.txt) / [identity-after.txt](originals/identity-after.txt) | Local/remote identity snapshots |
| [originals/logs/](originals/logs/) | PR/git/REST identity logs |
| [originals/governance-read/](originals/governance-read/) | Extracted PR #11 note and diffs |
| [publication/](publication/) | This publication's remote identity snapshot |

## Owner protection / ruleset exports

**None from a collector run.** Collector original `collect-owner-protection.py` / `OWNER-INSTRUCTIONS.md`: **INPUT_MISSING**.

Historical ruleset 21580900 appears only as a **citation inside the committed PR note** (2026-09-05), not as a live paginated export in this packet.

HTTP 401/403/404 for protection APIs were **not observed** this round and are **not** used as proof that other effective rules do not exist.

## This upload is not

PASS / ACCEPT / MERGE AUTHORIZED / LIVE AUTHORIZED / owner adoption / a settings change / integration of PR #11.
