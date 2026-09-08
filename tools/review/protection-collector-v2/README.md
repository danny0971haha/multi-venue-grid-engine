# Protection collector v2 (independent)

This directory is a **new, independently authored** read-only GitHub protection collector.

It is **not** a restoration of `collect-owner-protection.py`, **not** the same bytes as any missing original, and **does not** inherit any prior tool review. Historical `COLLECTOR_INPUT_MISSING` evidence remains a separate observation.

The collector:

- uses the Python standard library and the existing `gh` authentication (keyring or environment). It does not add package.json dependencies or lockfile changes.
- allows REST **GET** only.
- allows GraphQL **query** only (HTTP POST to `/graphql` with a query document). Mutations are rejected before any request.
- never places a token on the command line, in logs, or in the evidence packet.
- stores raw HTTP bodies separately from derived analysis.

## Tests (offline)

From the repository root:

```bash
python3 -m unittest discover -s tools/review/protection-collector-v2/tests -t tools/review/protection-collector-v2 -v
```

Offline tests do not call GitHub.

## Live read (existing gh auth only)

```bash
python3 tools/review/protection-collector-v2/collect.py \
  --repo danny0971haha/multi-venue-grid-engine \
  --review-pr 11 \
  --expected-main 22665d7fa9274dfc05de043c8e9663e24e75087e \
  --review-head de2f5c0fd055e418d0b6d806f994b52baa743544 \
  --review-tree 1b443a620670216968b95cc43de96397550c24f2 \
  --known-ruleset-id 21580900 \
  --expected-context trusted-phase2d-freeze-gate \
  --frozen-ref experiment/v0.1-phase2=7f196d367e39640eee9517f742b0d61424f9d4cc \
  --frozen-ref experiment/v0.1-phase2e-halt-ack=704afa2dd858c52dad06aa22941d463aa5ce4d69 \
  --frozen-ref governance/phase2e-trusted-gate=52445f4c2b3eb65f13ae00dbef80f07b417a7d53 \
  --out docs/evidence/owner-protection-v2-<stamp>
```

Do not paste a token into this command or into chat. If `gh auth status` is invalid, refresh it locally.

This tool does not modify repository settings, rulesets, branch protection, PR status, or required checks. It does not adopt PR #11.

## Corrective evidence semantics

Expected commits are separate from observed refs. Both captures resolve main and frozen refs, read the actual PR head/base, and fetch each tree by its observed SHA. Use `--frozen-ref NAME=SHA`; a legacy name without an expectation remains unverified. Collection is sequential, not an atomic settings snapshot.

A successful HTTP response alone does not establish source completeness. Required shapes, terminal pages, unique identities and GraphQL counts are checked. Allowance connections are bounded to the first 20 actors; any additional page or missing actor/count is explicitly incomplete. Matching refs are count-only and are never described as a full list. Unknown rule types or unsupported parameter schemas remain incomplete with their raw bytes retained.

Accepted-permission headers describe endpoint requirements. Absence analysis requires repository admin observations before/after plus GraphQL viewerPermission ADMIN, complete relevant sources and verified identities. Positive rules remain visible even with unrelated coverage gaps.

Organization/enterprise NOT_APPLICABLE requires official scope documentation and observed personal non-fork repository ownership; conflicting inherited sources invalidate it. Organizations and unverified fork ancestry retain UNKNOWN. Existing output directories with contents are refused to preserve old packets.

The tool's exit 0 means packet written. Consult `status.json`, `derived/sources.json`, identity observations and `derived/analysis.json` for completeness. No collector status is an independent review verdict.
