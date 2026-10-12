# Candidate format corrective

## Byte-identity successor (2026-09-05)

Branch `fix/multi-evidence-byte-identity-20260905` starts at reviewed commit
`9c0f63b1ab0e8c58796f63a1e4f86a9cae12d690`, tree
`75f5c4b4b5372db0cdf3eb519f910daada7bf61d`.

The four reformatted historical JSON files were restored directly from Git
objects at `a8402fd552d6e2fcf0436d8f2872b7618cb92412`. All six payloads listed
in `docs/evidence/current-candidate/files.json` now have exactly the manifest's
byte lengths and SHA-256 values at their actual listed paths. The manifest was
not changed. Immutable evidence is intentionally excluded only from Biome's
formatter using `formatter.includes: ["**", "!docs/evidence/current-candidate/**"]`.
Ordinary source, test and other generated JSON retain formatting coverage.
This uses the documented [Biome v2 tool-specific exclusion syntax](https://biomejs.dev/reference/configuration/#formatterincludes).

The TypeScript formatting corrections in `reload-worker.ts` and `scenarios.ts`
remain byte-identical to the reviewed starting commit. The escaped UTF-8 archive
`originals.json` was removed; the original Git objects remain available.
`integrity.json` is now compact versioned corrective metadata. Semantic JSON
equality is never a substitute for byte identity, and the manifest never hashes
an alternate archived representation. No historical result was regenerated or
relabeled.

`npm run verify:candidate-evidence` reads the manifest and verifies current raw
bytes. It fails closed on missing/malformed entries, absolute/noncanonical paths,
traversal, NUL, duplicates, symlinks, non-regular files, missing files and byte/hash
mismatches. Diagnostics contain entry identity and failure codes, never payload
contents or parser excerpts. Temporary-fixture tests are available through
`npm run test:candidate-evidence`; they do not modify tracked evidence.

The `pretest` lifecycle runs both checks before `npm test`. The exact historical
`scripts.test` expansion and its 474-test identity remain unchanged; the new
manifest fixture suite uses a separate spec reporter before the historical TAP
suite, so it cannot introduce duplicate TAP summaries into the independent
Phase 2D verifier.
CI also invokes the manifest verifier, offline integration and existing halt
suite explicitly, while retaining its job name and Phase 2D generation/independent
verification path. This permits exact-command validation on CI runners when a
local environment blocks the tsx CLI's UNIX socket. No trusted governance,
runtime, adapter, risk-control, lockfile or candidate-binding bytes changed.

Final exact commit/tree, command exits, test totals and evidence hashes are
reported in the corrective PR handoff. No acceptance result transfers from the
parent or historical run to the new commit.

## Historical formatting checkpoint (superseded evidence mapping)

The following records the earlier checkpoint and its then-current limitation.
The successor above corrects its archive-based interpretation; historical
command results below are retained as history only.

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

At that checkpoint, `originals.json` preserved
each of the six original UTF-8 strings and SHA-256. Decoding `utf8` reproduces
the original bytes, including newlines. The same blobs remain at the base SHA.
The then-current `integrity.json` mapped original
and formatted hashes and recorded structural equality checks.

At that checkpoint the historical `docs/evidence/current-candidate/files.json`
was unchanged, but four listed paths no longer matched its hashes. That mapping
was defective and is corrected by restoring their original bytes above. Existing raw logs,
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
