# PR #12 new-source list (this round)

Scope: obtain native `artifacts/offline-candidate/test/01.log` from CI run `33967073453` / job `101308992804` / attempt `1`, claimed SHA-256 `93ed10bd4541a22d16a7c44b5761dcf76b4e9afde8c9f64a7373ca8353c1ef07`.

This round did **not** re-download artifact `9969805255` (digest unchanged) and did **not** re-run suites.

## User-provided / specified this round

| Item | Status | New original child log? |
| --- | --- | --- |
| Anchors in the operator prompt (PR/HEAD/tree/CI/artifact/target hash) | Same as the already-reviewed pin. No attached file. | No |
| Known local same-named `01.log` SHA-256 `d3b340fa4c75b7f8fb671f91ef48ca776c5afff864273bc0e793f0eddbe34a94` (old recorded length 2416) | Instructed **not** to treat as a new candidate. File **not found** under bounded name search this round. | No |

## Project-referenced external / evidence locations checked for *new* availability

| Location | What this round did | Result |
| --- | --- | --- |
| GitHub Actions run `33967073453` artifact list | Metadata only | `total_count=1`, still artifact id `9969805255`, digest `sha256:f3642d425b6c1aa41b485be45f0f3f60c7b8567969924444e89cc951da73f6ff`, `expired=false`. **Not a new archive.** Bytes not re-downloaded. |
| Artifact upload path in PR12 HEAD `.github/workflows/ci.yml` | Read workflow | Upload is `artifacts/phase2d-corrective4/` only. Native `artifacts/offline-candidate/test/01.log` is **not** in the retained artifact path. |
| `docs/evidence/current-candidate/*` on PR12 HEAD | Negative hash check only (packets already in prior scope) | TARGET SHA-256 **absent**. Embedded `integration-tap.txt` is SHA-256 `7b0acec7…` / 2415 UTF-8 bytes; `09.txt` cites another `01.log` hash `45b73513…`. Neither is the claimed CI original. Provenance is runtime candidate `704afa2…` with a dirty worktree, not run `33967073453`. |
| Path cited in `results.json`: `/workspace/scratch/dc6fcc8945ba/.retrieval/evidence/multi-venue-grid-engine/` | Existence check | **ABSENT** on this host. |
| PR #12 issue comments, review comments, reviews | Read | Empty. No new backup path. |
| Bounded filename search for prior reports (`multi-pr12-integration-log-delta.md`, `multi-pr12-closure.md`, `multi-pr12-evidence-review.md`, `multi-handoff.md`) | maxdepth 4 under home, tmp, Cursor projects, Codex, Downloads, PR11 work dir, this repo, classic-grid | **Not found.** Do not fabricate same-named files. |
| Bounded filename search for `01.log`, artifact id, artifact digest, phase2d-c4 zip name | same bases + Downloads | **No original file.** |

## Explicitly not treated as original child log

- Whole job-log excerpts
- Wrapper / committed TAP summaries
- Local re-run output
- JSON-embedded `integration-tap.txt` extracted from `raw-logs.json`
- Trusted-gate run `33967581058` / job `101310303078` (PR #11 / stacked-base classification failure)

## Conclusion

**No new source** supplied the native CI child-log bytes. Status: `NOT_OBTAINED_FROM_AVAILABLE_SOURCES`.

This is **not** a proof that the file does not exist anywhere. Owner retention is `UNKNOWN` (the operator did not state that it was never saved).
