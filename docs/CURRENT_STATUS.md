# Current status

Snapshot: 2026-10-12. This document is a navigation/status record, not independent acceptance or an instruction to begin another phase.

## Integration line

`integration/v0.1-reset-20261011` is the single integration line. It merges `origin/main` (`22665d7`) into the most advanced runtime line (`fix/multi-ci-native-log-retention-20260908` at `d85478a`), so it contains every earlier product commit. Resolve its own identity with `git rev-parse HEAD HEAD^{tree}`.

Historical identities, unchanged and retained for reference:

| Evidence identity | Branch | Commit |
| --- | --- | --- |
| Frozen Phase 2D baseline | `experiment/v0.1-phase2` | `7f196d367e39640eee9517f742b0d61424f9d4cc` |
| Phase 2E runtime Corrective 3 candidate | `experiment/v0.1-phase2e-halt-ack` | `704afa2dd858c52dad06aa22941d463aa5ce4d69` |
| Runtime line used for this integration | `fix/multi-ci-native-log-retention-20260908` | `d85478a7e1edbf85fa95f7ad3091ad1561a8d61d` |

## Implemented vs reviewed

Implemented: pinned toolchain and dry-run bootstrap (Phase 0); decimal math, domain, grid geometry and simulator (Phase 1); exact-pair durable envelopes, atomic persistence, host-local runtime leases, fail-closed risk calculations (Phase 2A-2D); halt/kill-switch behavior, durable halt ACK and process fence (Phase 2E); run manifest and append-only telemetry as a library (Phase 2F, see below); execution coordinator place path as a library (Phase 3A, see below); a fake-only offline integration harness.

[PHASE_2E_EVIDENCE.md](PHASE_2E_EVIDENCE.md) records Phase 2E independent review as `NOT_PERFORMED`. Phase 2F and Phase 3A independent review are also `NOT_PERFORMED`. Earlier review records in [IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) and [ACCEPTANCE_GATES.md](ACCEPTANCE_GATES.md) have their own dates and scopes and are not blanket acceptance.

Not implemented: runtime wiring of telemetry, Phase 3B-3E (cancel, ownership/duplicates/batch/budget, execution cursor/replay, fatal matrix, durable journal, continuation gate), any venue adapter, integrated dry-run.

## Phase 2F telemetry and manifest

`src/telemetry/` implements RISK_PERSISTENCE_CONTRACT §23-§24 and ARCHITECTURE §10; tests cover TEST_FAULT_MATRIX P2-T01..P2-T06 (`npm run test:phase2f`).

- `manifest.json` is written once (`O_EXCL`, fsync file and directory, read back) before any event. It records spec version, experiment/run IDs, commit SHA, mode, scope, venue, market and the frozen envelope. A load rebuilds it and requires byte equality; an envelope other than the frozen one fails.
- `events.jsonl` is append-only and hash-chained: each line carries a sequence, the manifest SHA-256, the run ID, the previous line's SHA-256 and its own SHA-256. Opening verifies the whole chain.
- Any write or fsync failure poisons the writer. A torn tail, a broken chain or an external append fails closed and is never repaired.
- `INFERRED` provenance cannot record `FILL`/`PARTIAL_FILL`; `SIMULATED` is accepted only in a `DRY_RUN` manifest.
- Payloads with secret-shaped keys or values are rejected, not redacted.
- `gateRiskIncreaseOnEvidence` can only turn an allow into a deny. A telemetry failure never clears a halt, lease or risk denial.

Known limitations:

1. Not wired into `src/index.ts` or any coordinator. Phase 3 must call `gateRiskIncreaseOnEvidence` before every risk-increasing step.
2. Secret detection is pattern-based. A bare hex signing key under an innocuous key name is not detected; adapters must never pass signing material to telemetry.
3. The hash chain has no external anchor. A consistent rewrite of the last line, truncation at a line boundary, or a manifest field changed to another valid value before any event cannot be detected from the files alone.
4. A line whose fsync failed, or whose process died before fsync, may persist. A line records an attempted step, not its completion.
5. A torn tail permanently blocks that run directory. Recovery is an operator decision to start a new run ID and directory.
6. The commit SHA is supplied by the caller. Runtime wiring must supply `git rev-parse HEAD`.
7. Files are host-local with no rotation or total size cap (each line is capped at 64 KiB).
8. One writer per run directory is assumed; production relies on the runtime lease. Telemetry takes no lease itself and detects external appends by a size check before each append.
9. P2-T01 (unwritable directory) assumes tests do not run as root.

## Phase 3A execution coordinator (place path)

`src/execution/` implements the place half of IMPLEMENTATION_CONTRACT §6.1; tests cover TEST_FAULT_MATRIX P3-E01..P3-E05 plus lease, write-ahead and import cases (`npm run test:phase3`). Planned follow-ups: 3B cancel (P3-E06..E08), 3C ownership, duplicates, batch and write budget (P3-E09..E12), 3D execution cursor and replay (P3-E13..E15), 3E fatal matrix, durable journal and continuation gate.

- The intent registry maps intent ID -> deterministic client order ID -> exchange order ID -> execution IDs. Client IDs must equal the domain derivation (`mv1` + 20 hex); anything else is refused before a send.
- Each place is written ahead as `PREPARED` through an `IntentJournal` port, then sent through a `MutationFence` that proves the runtime lease immediately before the venue call (`createLeaseMutationFence` wraps `runLeaseFencedMutation`).
- Outcomes: ACK links the order; a plain rejection is `REJECTED`; a thrown, unknown or duplicate-client-ID result is `UNKNOWN`, never a rejection; a fence or write-ahead failure is `NOT_SENT` with no venue call.
- Any `PREPARED`/`UNKNOWN` intent blocks every risk-increasing intent and every new intent in the same slot. Only venue evidence for the same client ID (the order, or executions covering the full quantity) resolves it; absence of evidence never does.
- A journal write failure latches the coordinator: no further submit or reconcile.
- Registry import is strict (exact keys, sorted records, fingerprints, cross-record uniqueness) and never repairs.
- The Phase 0 bootstrap guard (`test/bootstrap/runtimeMode.test.ts`) previously forbade the token `placeOrder` anywhere in `src/`. It now allows it only in `src/execution/coordinator.ts`, `src/execution/ports.ts` and `src/simulator/venue.ts`, and additionally requires that no module statically reachable from `src/index.ts` names it. `cancelOrder` and network imports remain forbidden everywhere. This is a guard change for reviewer attention.

Known limitations:

1. The journal is a port only; no durable on-disk journal exists yet (3E). Restart safety is proven only with an in-memory JSON round trip.
2. There is no proof of non-arrival. A `PREPARED` or `UNKNOWN` intent with no venue evidence stays blocked until an operator or later evidence resolves it.
3. `mv1` client IDs are 23 characters, not Hyperliquid cloids (128-bit hex). The Phase 4 adapter must map them deterministically and normalize duplicate-cloid rejections to `DUPLICATE_CLIENT_ORDER_ID`.
4. Execution evidence must carry the intent's client ID. A market order's reported price is not checked during reconciliation.
5. Not wired into the simulator level state, `src/index.ts`, telemetry or `gateRiskIncreaseOnEvidence`.
6. If the fence itself throws, the intent stays `PREPARED` and the exception propagates (3E fatal matrix).
7. `SimulatedVenue` (`src/simulator/venue.ts`) is a test double that lives in `src/` beside the existing simulator.

## Process reset (2026-10-11)

Between 2026-09-01 and 2026-09-12 no runtime behavior changed; effort went to rebinding exact SHAs, trees, byte hashes and test counts after every change. The integration line retires that machinery (all of it remains in git history):

- trusted Phase 2D freeze gate and governance self-test workflows, `.github/trusted/`, `scripts/governance/`;
- CI native-log retention;
- the Phase 2D Corrective 4 evidence generator/verifier (it pinned the literal `npm test` script);
- the Linux-only Python offline wrapper (it pinned the frozen SHA and the 474/79 counts).

No product source, risk, persistence, halt or test assertion changed in the reset. `npm test` now runs every product suite; see [VALIDATION_GUIDE.md](VALIDATION_GUIDE.md).

On 2026-10-11 the owner removed `trusted-phase2d-freeze-gate` from the `main` branch-protection required checks (its workflow no longer exists). The CI job name `Clean install, static checks, tests, secret scan, and dry-run` is unchanged.

## Present authorization boundary

```text
PHASE_2E_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=PR16_PR17_BY_OWNER_ONLY
```

On 2026-10-11 the owner authorized Phase 2F implementation and selected Hyperliquid as the first Phase 4 venue. On 2026-10-12 the owner authorized Phase 3 implementation without a Gate 2 PASS (a recorded deviation from ACCEPTANCE_GATES), and authorized merging PR #16 and PR #17 and closing superseded PRs; those merges are performed by the owner, not by this record. Phase 4 and later phases still require an explicit owner decision. Real/testnet credentials and exchange networking remain unauthorized.

Unknown, stale, lease-uncertain or persistence-uncertain state must continue to fail closed and block risk increase. The separate risk, durable state, lease, halt, ACK and process-fence authorities are not a single boolean switch.

## Known product risk: venue minimum order size

The frozen envelope plans at most 150U gross notional over 10 levels, roughly 15U per order. `docs/EXPERIMENT_SPEC.md` section 3 requires reporting incompatibility rather than raising leverage, margin or notional. Unverified public reports suggest Binance USD-M BTCUSDT requires about 100U minimum notional (incompatible), Hyperliquid about 10U minimum notional (possibly compatible), and OKX BTC-USDT-SWAP a 0.01 BTC contract value with an unverified minimum size. The Phase 4 venue audit must read these limits from each venue's public metadata before selecting a venue; an unverifiable venue stays unsupported. Hyperliquid is the owner's first Phase 4 venue (not started); its minimum order value, size/price precision and margin rules must be verified from official metadata before an adapter is accepted, or it stays unsupported.
