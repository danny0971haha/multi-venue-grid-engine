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
  --frozen-ref experiment/v0.1-phase2 \
  --frozen-ref experiment/v0.1-phase2e-halt-ack \
  --frozen-ref governance/phase2e-trusted-gate \
  --out docs/evidence/owner-protection-v2-<stamp>
```

Do not paste a token into this command or into chat. If `gh auth status` is invalid, refresh it locally.

This tool does not modify repository settings, rulesets, branch protection, PR status, or required checks. It does not adopt PR #11.
