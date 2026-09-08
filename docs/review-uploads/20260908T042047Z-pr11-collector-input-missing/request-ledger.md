# Request ledger — PR #11 collector recovery (2026-09-08)

Protection collection APIs were **not called**. This ledger is identity, git, and tool-recovery search only.

Authorization / Cookie / token values / credential URLs were not saved. `gh auth status` was recorded only with a masked token (`gho_***`).

Response header capture (`x-github-request-id`, per-page `Link`) was **not persisted** at call time. A later header-dump script was not used. Request IDs below are therefore **UNKNOWN** (not invented). HTTP status is recorded where the client surfaced it.

Collection of live rulesets did **not** start or end. Identity/search window:

- Start: 2026-09-08T04:19:04Z / Asia/Taipei 2026-09-08T12:19:04+0800
- Search pass: 2026-09-08T04:20:47Z / Asia/Taipei 2026-09-08T12:20:47+0800
- Packet stage: 2026-09-08T04:23:16Z / Asia/Taipei 2026-09-08T12:23:16+0800

| # | Method / path | Query | HTTP | Pages complete | Request ID | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `GET /repos/danny0971haha/multi-venue-grid-engine/pulls/11` | none | 200 (JSON returned) | single | UNKNOWN | head/base/title/state/draft |
| 2 | `GET /repos/danny0971haha/multi-venue-grid-engine/issues/11/comments` | paginate | 200 | 1 comment; no further page observed | UNKNOWN | publication comment 5573669044 |
| 3 | `GET /repos/danny0971haha/multi-venue-grid-engine/issues/11/comments/5573669044` | none | **404** | n/a | UNKNOWN | list #2 already returned the body; do not treat as missing publication |
| 4 | `GET /repos/danny0971haha/multi-venue-grid-engine/pulls/11/comments` | paginate | 200 | 0 comments | UNKNOWN | |
| 5 | `GET /repos/danny0971haha/multi-venue-grid-engine/pulls/11/reviews` | paginate | 200 | empty | UNKNOWN | |
| 6 | `GET /repos/danny0971haha/multi-venue-grid-engine/pulls/11/files` | none | 200 | 3 files, one page | UNKNOWN | |
| 7 | `GET /repos/danny0971haha/multi-venue-grid-engine/pulls/11/commits` | none | 200 | 2 commits, one page | UNKNOWN | `f1347c2`, `de2f5c0` |
| 8 | `GET /repos/danny0971haha/multi-venue-grid-engine/git/commits/de2f5c0fd055e418d0b6d806f994b52baa743544` | none | 200 | single | UNKNOWN | tree `1b443a62` |
| 9 | `GET /repos/danny0971haha/multi-venue-grid-engine/git/commits/22665d7fa9274dfc05de043c8e9663e24e75087e` | none | 200 | single | UNKNOWN | tree `6981c112` |
| 10 | `GET /repos/danny0971haha/multi-venue-grid-engine/git/commits/c448e2a1b21c7e3cbcb9785478caa3919aec1fad` | none | 200 | single | UNKNOWN | parent `de2f5c0`; evidence-only |
| 11 | `GET /user` | none | 200 | single | UNKNOWN | `danny0971haha` / User / id 202909309 |
| 12 | `GET /repos/danny0971haha/multi-venue-grid-engine` | jq subset | 200 | single | UNKNOWN | owner User; wiki flag true |
| 13 | `GET /users/danny0971haha/gists` | none | 200 | empty array | UNKNOWN | |
| 14 | `GET /search/issues` | `q=repo:danny0971haha/multi-venue-grid-engine collect-owner-protection` | 200 | total_count=0 | UNKNOWN | |
| 15 | `GET /search/issues` | `q=repo:danny0971haha/multi-venue-grid-engine OWNER-INSTRUCTIONS` | 200 | total_count=0 | UNKNOWN | |
| 16 | `GET /repos/danny0971haha/multi-venue-grid-engine/releases` | none | 200 | empty | UNKNOWN | |
| 17 | git ls-remote (HTTPS, no auth header saved) | selected refs/heads and refs/pull/11/head | n/a (git) | n/a | n/a | see identity.json |
| 18 | `git show c448e2a1:.../INDEX.md` + SHA-256 | n/a | n/a | n/a | n/a | hash matches published SHA256SUMS |
| 19 | git ls-remote wiki.git | n/a | remote: repository not found | n/a | n/a | |

## Explicitly not requested (not a substitute collector)

- `GET /repos/.../rulesets` and ruleset detail
- org/enterprise inherited rulesets endpoints
- `GET /repos/.../branches/{branch}/protection`
- `GET /repos/.../rules/branches/{branch}` (effective rules)
- GraphQL mutations; any PATCH/POST/PUT/DELETE on settings
- Repeating a 403 as “progress”

## Pagination

No protection list was fetched, so protection pagination completeness is **not demonstrated**. Search/comment lists above were single-page results as returned by `gh`.
