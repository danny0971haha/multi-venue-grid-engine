# Current-candidate validation and integration evidence

Date: 2026-09-05. Checkpoint: documentation, developer validation and offline integration only. Requested action: independent review; no acceptance decision is declared.

Base HEAD/tree: `704afa2dd858c52dad06aa22941d463aa5ce4d69` / `bda9793acd2fb8de033f65739b8c092cbdec7d9b`. Frozen Phase 2D HEAD/tree: `7f196d367e39640eee9517f742b0d61424f9d4cc` / `1b0afe805269972cf7af40f7fbf0e4e6b3e35894`. Governance HEAD/tree: `52445f4c2b3eb65f13ae00dbef80f07b417a7d53` / `13ed781c547cfa34a397565f6b78c9f94c31c903`.

GitHub API reads confirmed those refs. Repository contents and historical Git objects were retrieved through the connected GitHub API after shell network access was unavailable, and imported only when their Git hashes matched. All 75 runtime-history commit objects and their trees were reconstructed with exact identities; none were rewritten. The implementation is on a separate descendant feature branch. Final HEAD/tree are provided in the operator handoff; precommit test summaries intentionally retain their original HEAD and dirty working-tree observations.

## Environment and blockers

Linux x86_64; Python 3.12.13. Required Node/npm: **22.23.2 / 10.9.8**. Available: **24.19.0 / 11.9.0**. `npm ci` fails `EBADENGINE` with engine-strict intact. Available diagnostic modules were TypeScript 5.9.3, tsx 4.23.0, Node types 22.20.1 and decimal.js 10.6.0; the first three differ from repository pins. They were provisioned locally from already-installed dependencies without package/lockfile edits. No clean pinned-install proof exists.

Configured Biome 2.5.10 is unavailable: lint and format checks fail with command-not-found. New TypeScript was additionally normalized with available TypeScript formatting, which does not substitute for the configured Biome check.

## Required-command results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run validate:phase2e-candidate` | 1 | Stops at first command, `npm ci` -> `EBADENGINE`; no later command is treated as complete. |
| `npm run typecheck` | 0 | Diagnostic installed TypeScript; not pinned validation. |
| `npm run lint` | 127 | Biome missing. |
| `npm run format:check` | 127 | Biome missing. |
| `npm test` | 1 | tsx CLI cannot create its Unix IPC listener: `EPERM`; no suite totals. |
| `npm run test:phase2e` | 1 | Same tsx IPC limitation; no suite totals. |
| `npm run build` | 0 | Diagnostic installed TypeScript. |
| `npm run scan:secrets` | 0 | Existing tracked-file scanner; repeated after adding evidence. |
| `npm run dry-run` | 1 | Same tsx IPC limitation. |
| `npm run simulate:offline-integration` | 0 | 12 scenario groups completed; two matching canonical state hashes. |
| `npm run test:offline-integration` | 0 | 13 tests, 13 pass, 0 fail/cancelled/skip/todo. Wrapper additionally requires complete exact TAP totals. |
| `npm run test:validation-tooling` | 0 | 5 tests: malformed/missing/duplicate counts rejected or preserved, command exit preserved, descendant socket denied. |
| `git diff --check` | 0 | No whitespace errors. |

Separate diagnostic commands used `node --import tsx` with the exact unchanged historical test-file expansion, avoiding the CLI's extra IPC listener without changing npm scripts:

- Historical regression: 474 tests; **426 pass, 2 fail, 46 cancelled**, 0 skip/todo; exit 1. Two bootstrap tests internally invoke the blocked tsx CLI. All 46 evidence tests are cancelled by their setup hook because the handwritten fixture requires Node v22.23.2. These cancellations are not successes.
- Dedicated Phase 2E: **79 pass / 0 fail / 0 cancelled / 0 skip / 0 todo**; exit 0, including the unchanged crash matrix. This is diagnostic current-byte execution on the available toolchain, not the trusted pinned command result.
- Bootstrap: `node --import tsx src/index.ts`; exit 0, existing DRY_RUN output unchanged.

Development failures corrected in the new harness: projecting full intents into the strict risk-input shape; passing the fenced callback through its existing request property; using the existing `RELEASED` result enum; returning void from a Node test callback. No product source or historical tests were changed in response. A typo in a local launch path was corrected before actual simulation. Earlier new-wrapper output checked only process exit; it now also rejects incomplete or mismatched integration TAP totals.

## New-command evidence and limits

[umbrella-summary.json](evidence/current-candidate/umbrella-summary.json) and [umbrella-install.txt](evidence/current-candidate/raw-logs.json) contain the full failing umbrella output and installation log. [simulate-summary.json](evidence/current-candidate/simulate-summary.json), [simulation-output.txt](evidence/current-candidate/raw-logs.json), [integration-summary.json](evidence/current-candidate/integration-summary.json) and [integration-tap.txt](evidence/current-candidate/raw-logs.json) contain the new simulation/test outputs. [results.json](evidence/current-candidate/results.json) and [diagnostic-results.json](evidence/current-candidate/diagnostic-results.json) record every required/diagnostic command and exit; corresponding keys in `raw-logs.json` preserve raw output. [files.json](evidence/current-candidate/files.json) binds archive hashes and sizes. Paths in original summaries refer to runtime output locations, while the archive preserves their bytes as decoded strings in `raw-logs.json`.

```text
FIXTURE_SHA256=90352b23d3907159d3d0480d2cbe4d3e6b38aa3691ecbccb87c88b5062e1d9b7
FINAL_CANONICAL_STATE_HASH=839f0467f13f6acf274dd509bb2706e000032e32cc20a48d443c773dfb7c9627
REPLAY_CANONICAL_STATE_HASH=839f0467f13f6acf274dd509bb2706e000032e32cc20a48d443c773dfb7c9627
LOCKFILE_SHA256=a20cb9ac4dffb6cd9f19b594c6e9755dff5067a29bc0391a6ba99a80b5741b51
```

The canonical hash scope is the complete simulator snapshot plus observed continuation decision, not raw host-local lease nonce bytes or a production-run manifest. The fresh child reload reads durable HALT and proves missing ACK cannot resume, then exercises valid durable ACK conditions. This clean-restart evidence does not replace SIGKILL durability tests or implement Phase 2F. The simulation's small deduplication map is harness wiring only, not a new production execution coordinator. Exact scenario mapping and invocation are in [VALIDATION_GUIDE.md](VALIDATION_GUIDE.md).

Raw console logs contain trailing whitespace. Initial `git diff --check` flagged it (exit 2); logs are now JSON-encoded without changing decoded bytes, so checks can remain strict.

## Scope preservation and documentation corrections

Byte-identical to base: all `src/`, historical `test/` files, persistence model/envelope, lease, risk engine, halt/ACK authority, process fence, crash matrix, Corrective 3, original npm script values, dependency sections, package-lock.json, `.github/`, trusted governance and historical evidence/contract files. New test paths are outside the historical npm test/halt globs. No shared cross-repository runtime package or copied Classic implementation exists.

README and AI_START_HERE no longer authorize starting the obsolete bootstrap phase. CURRENT_STATUS separates Phase 2D/runtime/governance identities and explains the old runtime packet's governance-rebind note versus the newer already-rebound governance pin. The old packets remain unchanged. The new branch is not the trusted gate's exact bound runtime candidate; new paths/script keys intentionally require a future separately reviewed decision, not weaker pin/count rules.

```text
PHASE_2E_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_EXECUTED=NO
TESTNET_WRITE_EXECUTED=NO
PRODUCTION_CREDENTIAL_USED=NO
TESTNET_CREDENTIAL_USED=NO
MERGE_EXECUTED=NO
FORCE_PUSH_USED=NO
REPOSITORY_SETTINGS_CHANGED=NO
SELF_DECLARED_PASS=NO
LIVE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
NEXT_PHASE_STARTED=NO
```

Next recommended action: review this bounded branch, then rerun all configured checks using the exact pinned toolchain and an environment permitting local IPC. Keep 474/79 exact totals and trusted candidate pinning intact. No new phase, automatic governance rebind, deployment, merge, credentials or exchange access follows from this evidence.
