# Candidate format corrective

Date: 2026-09-05. Base `a8402fd552d6e2fcf0436d8f2872b7618cb92412`,
tree `608a2f82630d258181f65ad97196bf16489832ee`.
Branch `fix/multi-format-evidence-20260905`. No runtime phase or gate requested.

The six format errors reported by job `101263252526` are corrected in a separate
checkpoint from agent instructions and trusted governance. Four historical JSON
documents are reformatted without changing their parsed values; two offline
integration helpers retain the same TypeScript semantic AST and assertions.
Changes follow the available Biome CI diff; local Biome is unavailable, so exact
formatter conformance still requires current-SHA CI.

## Evidence preservation

[originals.json](evidence/format-corrective-20260905/originals.json) preserves
each of the six original UTF-8 strings and SHA-256. Decoding `utf8` reproduces
the original bytes, including newlines. The same blobs remain at the base SHA.
[integrity.json](evidence/format-corrective-20260905/integrity.json) maps original
and formatted hashes and records structural equality checks.

The historical `docs/evidence/current-candidate/files.json` stays unchanged: its
hashes refer to **original** evidence, recoverable from the archive for these
four JSON files, not the newly formatted representations. Existing raw logs,
recorded candidate identities, command exits, failure records and test totals
are not regenerated or relabeled as new evidence. Formatting changes neither
old failures nor their interpretation.

## Validation

Actual local tools: Linux x86_64, Node v24.19.0, npm 11.9.0, reused TypeScript
5.9.3 and tsx 4.23.0. Not pinned Node 22.23.2/npm 10.9.8/TypeScript 7.0.2.
No dependency, engine setting or lockfile was modified to accommodate this.

- Original six SHA-256 values verified; four parsed JSON values and two semantic
  TypeScript ASTs compare equal. Both TypeScript files parse without diagnostics.
- `npm run typecheck`: exit 0 (non-pinned diagnostic).
- `npm run test:offline-integration`: exit 0; 13 tests, 0 failed/cancelled/skipped/
  todo under inherited Linux seccomp network isolation, including fresh-process
  halt reload. This was a dirty working-tree run, not exact-HEAD evidence.
- `npm run format:check`: exit 127, `biome: not found`; environment blocker.
- `git diff --check`: exit 0.
- First corrective CI at `97d851ae120b4678d479eb9d7202a7333cbdd689`, run
  `33964814247`: pinned install/typecheck/lint completed; formatter found two
  remaining line wraps in `scenarios.ts` (one file). These were corrected from
  the actual Biome diff. Later CI must be checked at the new result SHA.
- Pinned clean install, lint, full 474 regression, 79 halt tests, build and dry-run:
  not run in this formatting checkpoint. No historical runtime safety acceptance
  is inferred from AST equality or the integration suite.

Preserved refs observed remotely before edits: Phase 2D `7f196d367e39640eee9517f742b0d61424f9d4cc`,
runtime `704afa2dd858c52dad06aa22941d463aa5ce4d69`, governance
`52445f4c2b3eb65f13ae00dbef80f07b417a7d53`. No runtime/source/lock/workflow/governance
bytes changed. Final result/tree/patch identity is reported in the PR handoff.

No real/testnet credentials, exchange writes, third-party source import, merge,
force-push, settings changes, deployment or next phase. Self-review is not
independent acceptance. The trusted base compatibility issue is a separate
governance corrective; this branch does not carry or rebind that gate.
