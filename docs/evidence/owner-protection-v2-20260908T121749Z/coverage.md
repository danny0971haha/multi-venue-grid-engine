# Protection coverage (collector v2)

This file is **derived analysis**. Raw HTTP bodies are in `raw/`. Do not treat this markdown as the raw export.

This collector is **new and independent**. It is not a restoration of any prior collector, not the same bytes, and does not inherit prior tool review.

Historical `COLLECTOR_INPUT_MISSING` publication `59d10c476de54be81b822d1eb592e7f76955c794` remains a separate observation.

```text
ADOPTION=NOT_PERFORMED
NOT_DECLARED=PASS, ACCEPT, MERGE AUTHORIZED, LIVE AUTHORIZED
```

## Collection window

- started_at: `2026-09-08T12:17:49Z`
- finished_at: `2026-09-08T12:18:15Z`
- actor_login: `danny0971haha` (token not recorded)
- oauth_scopes: `['gist', 'read:org', 'repo', 'workflow']`
- identity drift: `False`
- default_branch: `main`
- expected_context: `trusted-phase2d-freeze-gate`
- known_ruleset_id requested: `21580900`

## Confirmed rules

- `{'kind': 'ruleset', 'id': 21580900, 'name': 'main-solo-owner-bootstrap', 'enforcement': 'active', 'include': ['refs/heads/main'], 'expected_context_bindings': [{'context': 'trusted-phase2d-freeze-gate', 'integration_id': 15368, 'strict': False}]}`
- `{'kind': 'classic_branchProtectionRules_patterns', 'count': 1, 'patterns': ['main']}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'main', 'http_class': 'OK'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'fix/multi-evidence-byte-identity-20260905', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'fix/multi-ci-native-log-retention-20260908', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'fix/multi-format-evidence-20260905', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'fix/multi-trusted-base-scope-20260905', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'docs/multi-agent-autonomy-20260905', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'chore/current-candidate-verification-20260905-dc6fcc', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'governance/phase2e-trusted-gate', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'experiment/v0.1-phase2', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`
- `{'kind': 'classic_rest_exact_name', 'branch': 'experiment/v0.1-phase2e-halt-ack', 'http_class': 'CLASSIC_NOT_PROTECTED_MESSAGE'}`

## Unconfirmed sources or branches

- `{'source': 'enterprise_inherited_rulesets', 'status': 'UNKNOWN'}`

## non-main required context

- conclusion: **NOT_PRESENT_IN_COMPLETE_EXPORT**
- method: Full include/exclude and classic pattern analysis. Not inferred from a sample of branches.

- basis: Complete paginated ruleset lists, each detail, and complete GraphQL branchProtectionRules patterns were analyzed. No active ruleset or classic pattern that can match outside the default branch required the expected context. This is not a claim about unread enterprise overlays.

## PR #11 main-only trigger scope conflict

PR #11 adds `branches: [main]` to `.github/workflows/trusted-phase2d-freeze.yml`.
That stops the workflow from running for non-main bases. A conflict exists when a
required check named `trusted-phase2d-freeze-gate` (any app/integration identity) still applies
outside main.

- conflict: **NO_CONFLICT_IN_REPOSITORY_EXPORT**
- reason: Within the complete repository ruleset list/details (includes_parents true and false) and complete GraphQL classic pattern list, the expected context is not required on non-default-capable active rulesets or classic patterns. Evaluate/disabled hits are listed separately. Effective-rules endpoint evidence is listed separately and does not replace classic protection. Enterprise overlays remain UNKNOWN.

Effective rules (rulesets, active only) and classic branch protection are listed separately above.
Neither is treated as a complete substitute for the other.

Open PR identities, including PR #12, are collected only so their bases can be checked for
applicable protection. PR #12 evidence is not PR #11 acceptance evidence.

## Owner adoption prerequisites still missing

- Enterprise inherited rulesets remain UNKNOWN.
- This packet is an adoption-prerequisite assessment only. ADOPTION is not performed.

## Interpretation limits

- HTTP 401/403/404/429, malformed bodies, and incomplete pagination are coverage gaps, not 'no rule'.
- Empty arrays are usable only when the request was OK, pagination completed, and the caller had sufficient permission for that source.
- `GET /repos/.../rules/branches/{branch}` omits evaluate/disabled rulesets and does not export classic protection.
- `bypass_actors` omitted means UNKNOWN bypass, not an empty bypass list.
- Sampling existing branches is not used to conclude that every possible non-main name lacks a requirement.

