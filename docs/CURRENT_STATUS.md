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

Implemented: pinned toolchain and dry-run bootstrap (Phase 0); decimal math, domain, grid geometry and simulator (Phase 1); exact-pair durable envelopes, atomic persistence, host-local runtime leases, fail-closed risk calculations (Phase 2A-2D); halt/kill-switch behavior, durable halt ACK and process fence (Phase 2E); run manifest and append-only telemetry as a library (Phase 2F, see below); execution coordinator place path as a library (Phase 3A, see below); execution coordinator cancel path as a library (Phase 3B, see below); a fake-only offline integration harness.

[PHASE_2E_EVIDENCE.md](PHASE_2E_EVIDENCE.md) records Phase 2E independent review as `NOT_PERFORMED`. Phase 2F, Phase 3A and Phase 3B independent review are also `NOT_PERFORMED`. Earlier review records in [IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) and [ACCEPTANCE_GATES.md](ACCEPTANCE_GATES.md) have their own dates and scopes and are not blanket acceptance.

Not implemented: runtime wiring of telemetry, Phase 3C-3E (ownership/duplicates/batch/budget, execution cursor/replay, fatal matrix, durable journal, continuation gate), any venue adapter, integrated dry-run.

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
- The Phase 0 bootstrap guard (`test/bootstrap/runtimeMode.test.ts`) previously forbade the token `placeOrder` anywhere in `src/`. It now allows it only in `src/execution/coordinator.ts`, `src/execution/ports.ts` and `src/simulator/venue.ts`, and additionally requires that no module statically reachable from `src/index.ts` names it. Phase 3B extends the same allowlist and reachability check to `cancelOrder` (see below). Network imports remain forbidden everywhere. This is a guard change for reviewer attention.

Known limitations:

1. The journal is a port only; no durable on-disk journal exists yet (3E). Restart safety is proven only with an in-memory JSON round trip.
2. There is no proof of non-arrival. A `PREPARED` or `UNKNOWN` intent with no venue evidence stays blocked until an operator or later evidence resolves it.
3. `mv1` client IDs are 23 characters, not Hyperliquid cloids (128-bit hex). The Phase 4 adapter must map them deterministically and normalize duplicate-cloid rejections to `DUPLICATE_CLIENT_ORDER_ID`.
4. Execution evidence must carry the intent's client ID. A market order's reported price is not checked during reconciliation.
5. Not wired into the simulator level state, `src/index.ts`, telemetry or `gateRiskIncreaseOnEvidence`.
6. If the fence itself throws, the intent stays `PREPARED` and the exception propagates (3E fatal matrix).
7. `SimulatedVenue` (`src/simulator/venue.ts`) is a test double that lives in `src/` beside the existing simulator.

## Phase 3B execution coordinator (cancel path)

`ExecutionCoordinator.cancel` implements the cancel half of IMPLEMENTATION_CONTRACT §6.1 and VENUE_ADAPTER_CONTRACT §9.1/§16; tests cover TEST_FAULT_MATRIX P3-E06..P3-E08, including the §4.2 script `PLACE -> ACK -> PARTIAL_FILL -> CANCEL_RACE -> FILL` (`test/execution/p3-cancel.test.ts`).

- Only a `LINKED` order of this coordinator's experiment, run and scope with executed quantity below the intent quantity is cancellable. Anything else is refused with no venue call.
- Each cancel is written ahead as `CANCEL_PREPARED`, then sent through the same `MutationFence`. A fence, write-ahead or venue `NOT_SENT` restores `LINKED`.
- Every sent or possibly sent cancel becomes `CANCEL_UNVERIFIED`: an ACK, a rejection, an unknown, a thrown call and an unrecognized result alike. A cancel ACK is never treated as a cancel, and a rejection is never treated as "still open".
- `CANCEL_PREPARED`/`CANCEL_UNVERIFIED` are unresolved: they block risk increase and new intents in the same slot, exactly like `PREPARED`/`UNKNOWN`.
- Reconciliation resolves a pending cancel only from a lookup by client order ID whose order matches the intent and exchange order ID, and whose executions include every recorded execution unchanged and sum to the order's executed quantity. `CANCELLED` below full quantity -> `CANCELLED`; `FILLED` at full quantity, or executions covering the full quantity even with no order -> `FILLED`; `OPEN` below full quantity -> back to `LINKED`. Anything else, including a vanished order without full execution evidence, stays `CANCEL_UNVERIFIED`. Execution evidence wins a cancel/fill race; disappearance is never a fill.
- `CANCELLED` and `FILLED` are terminal. The registry checks status against executed quantity on every transition and on import (`IMPORT_STATUS_QUANTITY_MISMATCH`).
- `SimulatedVenue` gains scripted cancel outcomes (`ACK`, `REJECT`, `UNKNOWN_APPLIED`, `UNKNOWN_DROPPED`, `THROW_APPLIED`); a cancel of an order that is not open is rejected.
- Guard change for reviewer attention: the Phase 0 bootstrap guard now treats `cancelOrder` like `placeOrder` (allowed only in the same three files and not reachable from `src/index.ts`); previously `cancelOrder` was forbidden everywhere.

Known limitations:

1. The adapter must normalize order status to `OPEN`, `FILLED` or `CANCELLED`; any other status proves nothing. There is no freshness timestamp check; the adapter must return fresh evidence (VENUE_ADAPTER_CONTRACT §16).
2. If a queued cancel applies after the venue reported the order `OPEN`, the record is already back to `LINKED` and stays there until a later lookup; LINKED records do not track fills until 3D (execution cursor).
3. Place reconciliation (3A) still links an order regardless of its observed status; a later cancel then resolves it.
4. `PREPARED`/`UNKNOWN` intents cannot be cancelled by client order ID; only linked orders can. Cancelling another run's orders is 3C/3E.
5. A reverted cancel replaces the `LINKED` record's previous reason codes.
6. The registry schema version is unchanged (`phase3-intent-registry-1`); the status set and import checks grew. There is no durable journal yet (3E).
7. Not wired into `src/index.ts`, telemetry, the risk gate or halt flatten paths.
8. If the fence itself throws, the record stays `CANCEL_PREPARED` and the exception propagates (3E fatal matrix).

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
