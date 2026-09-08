# Adoption-prerequisite coverage table — PR #11 (2026-09-08)

Live GitHub protection was **not** collected this round. Rows that need ruleset/protection API bodies are **INCOMPLETE**, not “no rule”.

Adoption targets in scope: **`main`** (also the actual PR base), plus the previously identified non-main stacked base **`fix/multi-format-evidence-20260905`**, and wildcard/effective-rule effects on other existing branches. This is not an account-wide security audit.

Machine policy **intent** (`SOLO_OWNER_BOOTSTRAP` in `.github/trusted/repository-governance-policy.json` on the reviewed tree) is **not** a live ruleset read-back.

| 分支／目標 | 規則來源 | 有效要求 | 證據檔案 | 是否完整 | 缺口 |
| --- | --- | --- | --- | --- | --- |
| `main` (PR #11 base / default branch) | Repository rulesets (list + each body + pagination) | enforcement; include/exclude; required checks + app binding; strict/up-to-date; bypass actors/mode; admin/include-admins; reviews; force-push; deletion | **NONE this round** (collector not run). Historical **citation only**: committed note `docs/TRUSTED_BASE_SCOPE_CORRECTIVE_20260905.md` at `de2f5c0` names ruleset **21580900**, include `refs/heads/main`, contexts `trusted-phase2d-freeze-gate` and `Clean install, static checks, tests, secret scan, and dry-run`, “read through GitHub on 2026-09-05”. Prior packet `c448e2a1` INDEX/REVIEW. | **NO** — INCOMPLETE | No 2026-09-08 paginated list/bodies; no integration_id/app binding export; no bypass list; citation is not a complete live proof. 2026-09-05 CI green on the PR is **not** proof that required checks are enforced. |
| `main` | Legacy branch protection (exact `main`) | same class of merge/push/delete/review/status fields | **NONE this round** | **NO** — INCOMPLETE | 404 must not be inferred. Protection APIs not called. |
| `main` | Effective rules (rulesets + legacy + inherited acting together) | composed effective required checks, reviews, bypass, force-push, deletion | **NONE this round** | **NO** — INCOMPLETE / UNKNOWN | Cannot certify SOLO_OWNER_BOOTSTRAP read-back. |
| PR base (same as `main` @ `22665d7`) | same as `main` | same | same | **NO** — INCOMPLETE | Base SHA confirmed; protection not exported. |
| `fix/multi-format-evidence-20260905` @ `9c0f63b1` | Repo rulesets + legacy + effective | whether any required context (including `trusted-phase2d-freeze-gate`) applies off `main`; wildcard overlap | Git identity only: `ls-remote` this round. Prior `originals/logs/remote-branches.txt` in `c448e2a1`. | **NO** — INCOMPLETE | Adoption note itself says inaccessible legacy protection is not certified absent; non-main extra requirements must be confirmed before adopting the main-only workflow filter. |
| Other existing heads (incl. PR branch `fix/multi-trusted-base-scope-20260905`, frozen `experiment/v0.1-phase2`, `governance/phase2e-trusted-gate`) | Wildcard/nested legacy + ruleset include/exclude | future/non-main applicability | Git refs only | **NO** — INCOMPLETE | No per-branch effective export. |
| Organization inherited rulesets | Org rulesets product | n/a if truly not an org | This round `GET /repos/danny0971haha/multi-venue-grid-engine`: `owner.type=User`, `owner.login=danny0971haha`. Same class as prior `originals/logs/repo-owner-identity.json`. | **NOT_APPLICABLE as org product class** for GitHub Organization inherited rulesets | Does **not** prove repository rulesets, legacy protection, or **enterprise** overlays are absent. |
| Enterprise / inherited enterprise rulesets | Enterprise overlays | unknown | **NONE** | **UNKNOWN** | Not read; owner type User does not prove enterprise absence. |
| Required checks app binding (`integration_id` historically 15368 in an older prompt snapshot) | Ruleset/status-check details | exact context names + app ids for both global contexts | **NONE this round** | **NO** — INCOMPLETE | Historical 15368 is a **partial snapshot to compare later**, not re-read here, not an instruction to change settings. |
| Bypass actors / bypass mode / include administrators | Ruleset + classic `enforce_admins` | who can bypass; admin enforcement | **NONE this round** | **UNKNOWN / INCOMPLETE** | If an API cannot show bypass completely, leave UNKNOWN — not “safe”. |
| Required reviews / CODEOWNERS as merge gate | Ruleset PR rules | policy intent: approvals=0, code-owner review false (bootstrap) vs live | Policy file on tree only | **NO** — INCOMPLETE | Policy bytes ≠ enforced GitHub rule. |
| Strict / up-to-date | Ruleset required-status strict | policy intent: `strictRequiredStatusChecks=false` while Phase 2 HEAD frozen at `7f196d3` | Policy file + frozen ref `ls-remote` this round (`7f196d367e39640eee9517f742b0d61424f9d4cc`) | **NO** — INCOMPLETE | Live strict flag not exported. |
| Force-push / deletion / direct `main` push | Ruleset + classic | policy intent: block force-push, block deletions, no direct main push | Policy file only | **NO** — INCOMPLETE | Live flags not exported. |

## Interpretation limits applied

- 403 would not mean “no rules” (not observed).
- 404 would not mean “protection off” without a verified collector/API contract (not observed).
- Empty list cannot replace detail, inheritance, and pagination completeness (no list fetched).
- PR #11 CI success at `de2f5c0` (claimed in the PR body / committed note) is **not** owner-prerequisite completion.
- Static program checks are **not** owner adoption.
- `docs/TRUSTED_PHASE2D_REVIEW_BOUNDARY.md` still contains an older `SETTINGS_EVIDENCE=READ_OK` / empty-ruleset snapshot. That text **conflicts in time** with the 2026-09-05 ruleset **21580900** citation. Neither document is a 2026-09-08 live export. This round does **not** pick a winner.

## Split from collection completeness

| Field | Value |
| --- | --- |
| Collection completeness | **INCOMPLETE** (`COLLECTOR_INPUT_MISSING`) |
| Prerequisite assessment | **UNKNOWN** (insufficient live evidence) |
| `OWNER_PREREQUISITES_VERIFIED` | **false** |
