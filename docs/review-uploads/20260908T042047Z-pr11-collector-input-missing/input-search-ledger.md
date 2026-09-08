# Input search ledger — existing owner collector (2026-09-08)

Required order. No full-disk scan. No substitute collector.

## Expected identity (not observed on disk)

```
collect-owner-protection.py
SHA-256=347c046aab4088d8bd9c7e2ebaffb727ee824ec59dea2df10a885893fa80a73f

OWNER-INSTRUCTIONS.md
SHA-256=fef438d84c18d11dc35c31c980157e0dd79d632b1a8135863d6002a050a1de23
```

Source of expected hashes: prior owner task text (2026-09-07) and published `NOT_FOUND.md` on `c448e2a1`. **No file was hashed this round.**

## Step 1 — PR comment → pinned commit

| Check | Result |
| --- | --- |
| `GET .../issues/11/comments` | 1 comment, 5573669044, 2026-09-07T16:55:33Z |
| Points to | `c448e2a1` / `evidence/multi-pr11-review-upload-20260907-bf4a1c` / batch `20260907T164326Z-pr11-owner-protection-verify` |
| Collector in comment | no |
| Collector in that commit tree | no |

## Step 2 — evidence-only index

| Check | Result |
| --- | --- |
| INDEX collector field | not obtained; not executed |
| INDEX SHA-256 reverify | `20b39d9ba97bc1174a28d1422f7d1fd2037eaa8ac7529eece841b6d0cd0963b1` = published SHA256SUMS |
| Complete live protection export in that packet | no — cannot skip recovery by citing it as complete |

## Step 3 — known packages here

| Path | Collector py / OWNER-INSTRUCTIONS |
| --- | --- |
| `/Users/apple/multi-pr11-readonly-verify-20260907T095010Z` | absent |
| `/tmp/mvge-evidence-publish-20260907T164326Z` | absent |
| workspace `multi-venue-grid-engine-starter` | absent |
| `$HOME/multi-pr11-owner-protection-*` | directory absent |
| Cursor / known Codex-attachments project | absent |

PR #12 directory exists and was **not** used as input.

## Result

`INPUT_MISSING`. Stop. Do not run `python3 collect-owner-protection.py ...`.
