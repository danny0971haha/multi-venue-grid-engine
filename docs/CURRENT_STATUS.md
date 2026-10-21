# Current status

Snapshot: 2026-10-21. This document is a navigation/status record, not independent acceptance or an instruction to begin another phase.

## Integration line

`main` is the integration line. The former integration branch `integration/v0.1-reset-20261011` merged `origin/main` (`22665d7`) into the most advanced runtime line (`fix/multi-ci-native-log-retention-20260908` at `d85478a`), so it contained every earlier product commit. The owner merged it into `main` through PR #16 on 2026-10-12 (`240cb37`). Later work reaches `main` only through pull requests that the owner merges. Resolve the current identity with `git rev-parse HEAD HEAD^{tree}`.

Historical identities, unchanged and retained for reference:

| Evidence identity | Branch | Commit |
| --- | --- | --- |
| Frozen Phase 2D baseline | `experiment/v0.1-phase2` | `7f196d367e39640eee9517f742b0d61424f9d4cc` |
| Phase 2E runtime Corrective 3 candidate | `experiment/v0.1-phase2e-halt-ack` | `704afa2dd858c52dad06aa22941d463aa5ce4d69` |
| Runtime line used for the PR #16 integration | `fix/multi-ci-native-log-retention-20260908` | `d85478a7e1edbf85fa95f7ad3091ad1561a8d61d` |

## Implemented vs reviewed

Implemented: pinned toolchain and dry-run bootstrap (Phase 0); decimal math, domain, grid geometry and simulator (Phase 1); exact-pair durable envelopes, atomic persistence, host-local runtime leases, fail-closed risk calculations (Phase 2A-2D); halt/kill-switch behavior, durable halt ACK and process fence (Phase 2E); run manifest and append-only telemetry as a library (Phase 2F, see below); execution coordinator place path as a library (Phase 3A, see below); execution coordinator cancel path as a library (Phase 3B, see below); open-order ownership scan, owned-duplicate cleanup, whole-batch exposure gate and per-cycle write budget as a library (Phase 3C, see below); execution cursor, checkpoint and overlap-safe replay as a library (Phase 3D, see below); fatal process guard, durable intent journal and execution checkpoint, restart recovery and restart gate as a library (Phase 3E, see below); continuation gate (CONTINUE/REDUCE/HALT) and single-use risk-increase grant as a library (Phase 3F, see below); a fake-only offline integration harness.

No separate phase review was performed for Phase 2E ([PHASE_2E_EVIDENCE.md](PHASE_2E_EVIDENCE.md) records `NOT_PERFORMED`), Phase 2F or Phases 3A-3F. Their bytes were inside the gate reviews of 2026-10-18: Gate 2 at `8381085` (Phases 2A-2F and the process reset) and Gate 3 at `3f9cff3` (Phases 3A-3F). Both returned REJECT; see "Review correctives" below. Earlier review records in [IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) and [ACCEPTANCE_GATES.md](ACCEPTANCE_GATES.md) have their own dates and scopes and are not blanket acceptance.

Not implemented: runtime wiring of telemetry and of the Phase 3 execution library (including the continuation gate), execution of the REDUCE and HALT actions by a supervisor, any venue adapter, integrated dry-run.

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
2. Secret detection is pattern-based. A bare hex signing key under an innocuous key name is not detected; adapters must never pass signing material to telemetry. Since corrective G2-C5, the value patterns apply to the whole serialized event line and to every manifest string, not only the payload.
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

1. The journal is a port only; no durable on-disk journal exists yet (3E). Restart safety is proven only with an in-memory JSON round trip. Since 3E, `openDurableExecutionState` provides an on-disk journal (see below).
2. There is no proof of non-arrival. A `PREPARED` or `UNKNOWN` intent with no venue evidence stays blocked until an operator or later evidence resolves it.
3. `mv1` client IDs are 23 characters, not Hyperliquid cloids (128-bit hex). The Phase 4 adapter must map them deterministically and normalize duplicate-cloid rejections to `DUPLICATE_CLIENT_ORDER_ID`.
4. Execution evidence must carry the intent's client ID. A market order's reported price is not checked during reconciliation.
5. Not wired into the simulator level state, `src/index.ts`, telemetry or `gateRiskIncreaseOnEvidence`.
6. If the fence itself throws, the intent stays `PREPARED` and the exception propagates (3E fatal matrix). Since 3E, restart recovery turns it `UNKNOWN`.
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
2. If a queued cancel applies after the venue reported the order `OPEN`, the record is already back to `LINKED` and stays there until a later lookup. Since 3D, executions of a `LINKED` order are recorded by replay, and a full quantity ends it `FILLED`.
3. Place reconciliation (3A) still links an order regardless of its observed status; a later cancel then resolves it.
4. `PREPARED`/`UNKNOWN` intents cannot be cancelled by client order ID; only linked orders can. Cancelling another run's orders is 3C/3E.
5. A reverted cancel replaces the `LINKED` record's previous reason codes.
6. The registry schema version is unchanged (`phase3-intent-registry-1`); the status set and import checks grew. There is no durable journal yet (3E). Since corrective G3-C3, the schema is `phase3-intent-registry-2`, which adds persisted execution contradictions; a version 1 journal is refused.
7. Not wired into `src/index.ts`, telemetry, the risk gate or halt flatten paths.
8. If the fence itself throws, the record stays `CANCEL_PREPARED` and the exception propagates (3E fatal matrix). Since 3E, restart recovery turns it `CANCEL_UNVERIFIED`.

## Phase 3C execution coordinator (ownership, duplicates, batch, write budget)

`ExecutionCoordinator` gains `scanOpenOrders`, `cleanupOwnedDuplicates`, `submitBatch` and `startCycle`, and every risk-increasing submit now passes a planned-exposure gate. Tests cover TEST_FAULT_MATRIX P3-E09..P3-E12 (`test/execution/p3-ownership.test.ts`).

- The venue port gains `listOpenOrders`: a fresh snapshot of every open order in the market, owned or not. A snapshot is accepted only if every entry is an `OPEN` order of this venue and market with a unique exchange order ID (otherwise `OPEN_ORDER_OBSERVATION_INVALID`); a failed read is `OPEN_ORDER_SCAN_FAILED`.
- Each open order is classified `OWNED`, `UNOWNED` or `AMBIGUOUS` through the domain `classifyOwnership`. Only records whose order may still be working (`LINKED`, `CANCEL_PREPARED`, `CANCEL_UNVERIFIED`) grant authority. An owned order must still match its record (client order ID, side, limit price, quantity, reduce-only flag where reported, exchange order ID, and an executed quantity not below the recorded one), or it is `AMBIGUOUS`. An order that no record links, and whose client ID cannot be an engine ID (`mv1` + 20 hex), is `UNOWNED`. A null or engine-shaped client ID stays `AMBIGUOUS`.
- Any non-owned order and any owned duplicate block risk-increasing intents (`OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE`) until a later clean scan. A scan marks itself failed before reading, so an exception mid-scan leaves risk increase blocked. Reduce-only exits are not blocked by scan results.
- `cleanupOwnedDuplicates` rescans. In each slot it keeps the lowest exchange order ID and cancels the others through the 3B cancel path. Unowned and ambiguous orders are never candidates. A cancelled duplicate stays `CANCEL_UNVERIFIED`, and stays reserved, until reconciliation proves it closed. A cancel that ends in any other status stops the remaining cancels (`CLEANUP_STOPPED_BEFORE_SEND`, `PRIOR_CANCEL_NOT_SENT`).
- The planned-exposure gate (`plannedExposureDecision`; cap `FROZEN_PLANNED_GROSS_NOTIONAL_USDT` = 150, inclusive) reads the signed position and mark/mid price through an `ExposureInputSource` port. It counts, per side and without netting:
  - the position;
  - every owned working order's remaining quantity;
  - every `PREPARED`/`UNKNOWN` intent's full quantity;
  - all proposed intents together.

  A throwing or non-object read denies with `EXPOSURE_INPUT_UNAVAILABLE`, and a null position or price with `STALE_OR_MISSING_INPUT`. A market order is unbounded and denied. A reduce-only intent with a risk-increasing purpose still counts. Reduce-only exits skip the gate.
- `submitBatch` runs every check before the first send:
  - each intent's validity, prior record and admission;
  - identity and slot conflicts inside the batch;
  - the write budget for the whole batch;
  - the exposure of the whole batch.

  Any failure refuses the whole batch with no venue call. Sends then run in order, and each intent is re-admitted first. After a `NOT_SENT` (fence or lease loss, or a write-ahead failure), a journal latch or a failed re-admission, the remaining intents are reported `NOT_SENT` with `BATCH_STOPPED_BEFORE_SEND` and are not recorded. A plain venue rejection does not stop the batch.
- `writeBudgetPerCycle` must be a positive safe integer. It caps place and cancel attempts per cycle, and `startCycle()` resets it (refused while an operation is in flight). An attempt counts once it reaches the fence, whether sent or not.
- The Phase 0 bootstrap guard is unchanged; the new names avoid the guarded tokens. Test changes outside the new file are mechanical: the 3A/3B test port literals gained `listOpenOrders`, and the harness gained `writeBudgetPerCycle` (default 100) and `exposure` (default flat 0 at 100). As a result, existing 3A/3B tests now pass through the exposure gate. No 3A/3B assertion changed.

Known limitations:

1. Admission does not stop a second `LINKED` order in the same slot; only a scan finds duplicates. No scan is required before the first risk increase (3E continuation gate). Since 3E, a new coordinator requires one.
2. Scan blockers live in memory only. They are neither persisted nor restored on restart.
3. A `LINKED` record whose order is missing from a snapshot is neither resolved nor flagged (3E). A 3D replay ends it `FILLED` only from execution evidence.
4. `listOpenOrders` takes no market argument; the adapter must scope it to the coordinator's market.
5. The adapter must return client order IDs exactly as the engine sent them. Hyperliquid cloids are not `mv1` IDs, so until the Phase 4 mapping exists every engine order would classify `UNOWNED`. That fails closed, but it blocks risk increase.
6. After lease loss the journal is still written; only venue mutations are fenced.
7. The write budget also limits cancels, including future halt and flatten paths; 3E must decide whether emergency reduction bypasses it. A `NOT_SENT` attempt consumes budget (conservative).
8. A non-survivor already `CANCEL_UNVERIFIED` is reported with `CANCEL_UNRESOLVED` and not re-sent. One in `CANCEL_PREPARED` stops the cleanup.
9. The survivor rule compares exchange order IDs as strings (`sim-order-10` sorts before `sim-order-2`). It is deterministic, not chronological.
10. Batch identity checks put intent IDs and client order IDs in one set (conservative).
11. Not wired into `src/index.ts`, telemetry, the risk engine's actual-notional path or the halt paths.

## Phase 3D execution cursor and replay

`ExecutionCoordinator` gains `replayExecutions`, `ingestStreamExecution` and `executionStreamReconnected`. Tests cover TEST_FAULT_MATRIX P3-E13..P3-E15 (`test/execution/p3-replay.test.ts`).

- The venue port gains `listExecutionsSince(cursor)`. It returns one page of the market's execution history: `executions`, a `nextCursor` and `hasMore`. An `ExecutionCursor` holds venue, market, an adapter-only `opaque` value and the last execution ID and time. Pages may overlap.
- A new `ExecutionCheckpointStore` port persists the cursor. The coordinator takes a start cursor; null means the start of the venue's retained history. A cursor for another venue or market, or with an empty field, is refused (`INVALID_EXECUTION_CURSOR`).
- Each page is checked as a whole before anything is recorded. The first problem stops the replay, records nothing from that page and leaves the cursor where it was. Each execution must:
  - be an object of this venue and market with non-empty execution and exchange order IDs (`EXECUTION_OBSERVATION_INVALID`);
  - belong to a linked record by exchange order ID. Otherwise it is `UNATTRIBUTED_EXECUTION`, `EXECUTION_FOR_UNLINKED_INTENT` (its client ID names a record that is not linked yet) or `EXECUTION_MISMATCH` (its client ID names a record linked to another order);
  - match that record's client order ID and side, with a positive canonical quantity and price (`EXECUTION_MISMATCH`).

  Then:
  - An execution ID already recorded for another record is `EXECUTION_ID_COLLISION`. One already recorded with different facts, or repeated in the page with different facts, is `EXECUTION_CONFLICT`. An identical repeat is skipped.
  - A new execution for a record that is no longer working (`CANCELLED`, `FILLED`) is `EXECUTION_AFTER_CLOSE`. New executions that would exceed the order quantity are `EXECUTION_OVERFILL`.
- New executions go through `IntentRegistry.applyExecutions`. It keeps the status below full quantity and ends the record `FILLED` (`FILLED_BY_EXECUTION_EVIDENCE`) at full quantity. `LINKED -> FILLED` is now allowed, but only through this method; `resolveCancel` refuses `LINKED`.
- Durability order per page:
  1. the journal, only when something was added;
  2. the checkpoint;
  3. the in-memory cursor.

  A journal failure latches the coordinator and leaves the checkpoint alone. A checkpoint failure leaves the cursor; the next replay re-reads the page and skips what it already recorded.
- Risk increase is blocked (`EXECUTION_REPLAY_BLOCKS_RISK_INCREASE`, and `canIncreaseRisk()` is false) while any execution blocker is set:
  - A new coordinator starts with `EXECUTION_REPLAY_INCOMPLETE`.
  - Each replay first resets the blockers to that one code. Only a replay that reaches `hasMore: false` clears it.
  - A failed read (`EXECUTION_REPLAY_READ_FAILED`), an invalid page (`EXECUTION_PAGE_INVALID`) or an execution problem stops the replay, and so does reaching 100 pages (`EXECUTION_REPLAY_PAGE_LIMIT`). Each adds its code.

  Cancels and reduce-only exits are not blocked.
- Stream events are never trusted to be complete. Each needs a decimal string `meta.sequence` with no leading zeros, compared as a big integer. Each of these adds a blocker that only a later completed replay clears:
  - a missing or unusable sequence (`EXECUTION_STREAM_SEQUENCE_UNUSABLE`);
  - a jump past the next expected sequence (`EXECUTION_STREAM_GAP`);
  - an event that arrives while another operation runs or after a journal latch (`EXECUTION_STREAM_EVENT_DROPPED`). Since re-review corrective G3-RC1, an event that arrives while another operation runs is still checked before that operation ends (see "Re-review correctives" below); one that arrives after a journal latch is dropped unread;
  - any execution problem.

  Older or repeated sequences are accepted, because execution-ID checks make them harmless. Stream events never move the cursor.
- `executionStreamReconnected()` resets the sequence baseline and adds `EXECUTION_STREAM_RECONNECTED`. A blocker raised while a replay runs survives that replay.
- `SimulatedVenue` serves its existing `fill` executions as paged history: `listExecutionsSince`, `setExecutionPageSize`, `overlapExecutionReads`, `failNextExecutionReads` and `calls.executions`.
- The Phase 0 bootstrap guard is unchanged. Test changes outside the new file are mechanical:
  - `createHarness` is now async and runs one replay by default;
  - the test port literals gained `listExecutionsSince`;
  - the harness gained a `MemoryCheckpointStore`;
  - the p3-cancel `restart` helper is async, and one restart call passes `checkpoints` and `executionCursor: null`;
  - the write-budget validation test uses `assert.rejects` instead of `assert.throws`, with the same error pattern.

  No 3A-3C expected value changed.

Known limitations:

1. Unattributed or foreign executions, and executions of `REJECTED`/`NOT_SENT` records, block risk increase and pin the cursor until an operator path exists (3E+). `EXECUTION_FOR_UNLINKED_INTENT` for a `PREPARED`/`UNKNOWN` record clears after `reconcileUnresolved` links the order and a replay re-reads it; for a `REJECTED`/`NOT_SENT` record it stays.
2. An execution problem is reported, not resolved. An `EXECUTION_CONFLICT` or `EXECUTION_ID_COLLISION` raised by a stream event for an execution older than the cursor is cleared by the next completed replay without re-reading it. Since corrective G3-C3, the evidence of every execution problem is persisted and a completed replay no longer clears it. Only `UNATTRIBUTED_EXECUTION` and `EXECUTION_FOR_UNLINKED_INTENT` clear, once a record holds the same execution with the same facts; the others stay until an operator path exists (none yet).
3. Blockers live in memory only. A restart starts from `EXECUTION_REPLAY_INCOMPLETE` and forgets the reason for an earlier block (3E). Since corrective G3-C3, persisted execution problems survive a restart; the other replay and stream blockers are still in memory.
4. Stream events with a null sequence (the simulator, until an adapter provides one) always block until a replay.
5. A stream that keeps filling while replays run can keep risk increase blocked through dropped events. Since G3-RC1 each such event is still checked, and the events waiting to be checked have no bound.
6. REST lag: a replay can clear stream blockers before the REST history shows a streamed event. The event was already recorded from the stream, so nothing is lost, but the clear rests on the adapter's history being current.
7. `executionStreamReconnected()` must be called on every connection, including the first. Nothing enforces it.
8. A venue cursor that never advances, such as simulator overlap at or above the page size, ends every replay at the page limit.
9. The retained history must cover the cursor. The simulator never expires history; the Phase 4 adapter must prove a stale cursor is refused rather than silently skipped.
10. An order linked by 3A reconciliation with executions already at full quantity stays `LINKED` (remaining quantity 0; a cancel is refused with `ORDER_FULLY_EXECUTED`). Replay does not promote it, because every execution is already recorded.
11. Executions must carry the engine's client order ID. A venue that omits it on fills fails closed with `EXECUTION_MISMATCH` (Phase 4 audit).
12. A completed replay does not require a fresh open-order scan or reconciliation of unresolved records; that is the 3E continuation gate. Since 3E, `runRestartGate` runs all three at startup. Since 3F, `evaluateContinuation` runs all three before every grant.
13. Not wired into `src/index.ts`, telemetry, the risk engine's actual-notional path or the halt paths.

## Phase 3E fatal process errors, durable journal and restart gate

Phase 3E implements the durable `UNKNOWN` state and restart reconciliation of IMPLEMENTATION_CONTRACT §6.1 and TEST_FAULT_MATRIX §11 F-01..F-05. The continuation gate (CONTINUE/REDUCE/HALT) is deferred to Phase 3F. Tests: `test/execution/p3-fatal.test.ts` (child processes) and `test/execution/p3-restart.test.ts`.

- `installFatalProcessGuard(latch)` (`src/execution/fatal-guard.ts`) handles `uncaughtException` and `unhandledRejection`:
  1. It blocks the runtime persistence latch (`FATAL_UNCAUGHT_EXCEPTION` / `FATAL_UNHANDLED_REJECTION`), so no fenced write can start.
  2. It writes only `{"event":"FATAL_PROCESS_ERROR","reasonCode":...}` to stderr, never the error itself.
  3. It exits with `FATAL_EXIT_CODE` (70).

  A second install throws `FATAL_GUARD_ALREADY_INSTALLED`. A test fails if any other file in `src/` registers a process-level error handler. Since corrective G2-C4, `installFatalProcessGuard(latch, processFence?)` also takes the runtime's Phase 2E halt process fence and trips it before step 1.
- `openDurableExecutionState({ directory, scopeKey, latch })` (`src/execution/journal-store.ts`) loads two Phase 2B exact pairs: the intent journal (`intent-journal`) and the execution checkpoint (`execution-checkpoint`, schema `phase3-execution-checkpoint-1`). It returns a registry, a start cursor, and an `IntentJournal` and `ExecutionCheckpointStore` backed by those pairs. It fails closed when:
  - a pair is not a proven exact pair with a `VALID` primary (`INTENT_JOURNAL_UNPROVEN` / `EXECUTION_CHECKPOINT_UNPROVEN`, plus the inspection codes);
  - a checkpoint exists without a journal (`EXECUTION_CHECKPOINT_WITHOUT_JOURNAL`);
  - the journal is not a valid registry state, or holds an intent of another scope (`INTENT_JOURNAL_INVALID`);
  - the checkpoint is not exactly `{ schemaVersion, cursor }`, or its cursor does not have exactly the five cursor keys or fails the 3D cursor check (`EXECUTION_CHECKPOINT_INVALID`).

  A fresh directory gets an empty journal before anything else, so a checkpoint never exists without its journal (`INTENT_JOURNAL_INITIALIZATION_FAILED` if that write fails).
- Each pair has one ordered writer that writes from the generation and hash it last proved. A write that does not prove the requested state committed is rejected (`INTENT_JOURNAL_WRITE_FAILED` / `EXECUTION_CHECKPOINT_WRITE_FAILED`), and the latch is blocked. Once the latch is blocked, whatever blocked it, both writers refuse every later write. The coordinator then latches through its existing `JOURNAL_LATCHED` path.
- `recoverInterruptedIntents(registry, journal)` (`src/execution/restart.ts`) runs before a coordinator uses a loaded registry. It turns every `PREPARED` record into `UNKNOWN` (`RESTART_SEND_OUTCOME_UNKNOWN`) and every `CANCEL_PREPARED` into `CANCEL_UNVERIFIED` (`RESTART_CANCEL_OUTCOME_UNKNOWN`) in one journal write. If that write fails (`RESTART_RECOVERY_WRITE_FAILED`), the caller must stop. Both statuses already block risk increase and keep their exposure reserved (3A-3C).
- A new coordinator now also starts with `OPEN_ORDER_SCAN_REQUIRED`; only a clean scan clears it. `riskIncreaseBlockers()` lists every current blocker, sorted: the scan and replay blockers, `JOURNAL_LATCHED` and `UNRESOLVED_INTENT`. `canIncreaseRisk()` is true only when that list is empty.
- `runRestartGate(coordinator, anchorEpoch)` runs `reconcileUnresolved`, `scanOpenOrders` and `replayExecutions`, each even after an earlier one reports a problem. It allows risk increase only when `riskIncreaseBlockers()` is empty afterwards.
- Fault matrix (each test prints its §14 evidence fields as test diagnostics):
  - F-01 / F-02: a worker that places one order per tick throws, or rejects a promise, while idle, and queues one more submit behind the fault. It exits 70 with the latch blocked and makes no venue call after the fault. Negative controls with a log-and-ignore handler place the queued order and exit 0.
  - F-03: SIGKILL after the `PREPARED` write and before the venue call. On restart the record becomes `UNKNOWN`; the lookup finds nothing, so it stays `UNKNOWN` and every risk increase is refused. A second restart sees the durable `UNKNOWN`.
  - F-04: SIGKILL after the venue stored the order and before the response. On restart the record becomes `UNKNOWN`, the lookup links it without a resend, and a new order is then accepted.
  - F-05: after a fatal exit, a restart before the lease expires is `BLOCKED`. After expiry, the gate records a fill that happened while nothing ran before any new order. A foreign open order keeps the gate closed (`UNOWNED_OPEN_ORDER`).
- Test changes outside the new files:
  - `createHarness` now also scans by default (`scan: false` skips it), and `buildIntent` accepts `scopeKey`.
  - In `p3-place.test.ts`, the lost-journal duplicate test now places the stale order after the restart scan, since a scan before it blocks first. A new test covers that blocking scan.
  - A write-ahead test rescans after reconciliation before asserting that risk increase is allowed.

  No other 3A-3D expected value changed. The Phase 0 bootstrap guard is unchanged; the test venue lives in `test/fixtures/`.

Known limitations:

1. Absence is never proof. An F-03 intent with no venue evidence stays `UNKNOWN`, and blocks risk increase, until an operator path exists.
2. Not wired into `src/index.ts`, telemetry, halt persistence or a supervisor. The guard only terminates; the tests play the supervisor.
3. After a SIGKILL, takeover waits for the 30 s lease expiry, and a leftover coordination claim is cleared by the Phase 2C liveness probe. The tests use a fixed lease clock past expiry and never renew the lease.
4. The restart gate's result covers coordinator blockers only. The latch and lease are enforced at send time by the fence, and by the journal writers. Since 3F, a risk-increasing submit also needs a grant from `evaluateContinuation`.
5. Opening a fresh directory writes the empty journal with the Phase 2B non-live bootstrap authorization; live bootstrap is not provided.
6. Open treats a corrupt primary as unproven even when the pair store could recover it from `.bak` (stricter; recovery is an operator decision).
7. Scan and replay blockers are still in memory. A restart recomputes them; only `UNKNOWN`/`CANCEL_UNVERIFIED` records carry a block across restarts. Since corrective G3-C3, persisted execution problems also carry a block across restarts.
8. With a lost journal, an engine-shaped order already open at the restart scan is `AMBIGUOUS_OPEN_ORDER` and blocks risk increase until an operator resolves it.
9. Every journal write stores the whole registry; there is no compaction.

## Phase 3F continuation gate

Phase 3F implements the production-shaped continuation gate of IMPLEMENTATION_CONTRACT §6.1 ("yields `CONTINUE`, `REDUCE`, or `HALT`") on top of the 2D risk rules and the 2E halt authority. Tests: `test/execution/p3-continuation.test.ts` (P3-C01..P3-C12).

- Two new coordinator ports (`src/execution/ports.ts`):
  - `RiskInputSource.read()` returns `RiskAccountInputs`: the 2D `RiskInput` without `ownedActiveOrders`, `unknownReservations`, `proposedBatch` and `haltAuthorityClear`, which the coordinator supplies itself.
  - `HaltAuthorityPort.inspect()` returns `{ durableStatus, allowRiskIncrease, reasonCodes }`. `createHaltAuthorityPort(context)` (`src/execution/continuation.ts`) reads a 2E `HaltRuntimeContext` through `inspectHaltContinuation`, without changing it.
- `coordinator.evaluateContinuation(anchorEpoch)` is exclusive like every other coordinator operation. It runs `reconcileUnresolved`, `scanOpenOrders` and `replayExecutions`, takes the coordinator's exposure reservation, reads the risk inputs and inspects the halt authority. A rejected read counts as missing. It then calls `decideContinuation` with the blockers present after the reads, so a reconnect or a dropped stream event during the reads counts. The gate never places, cancels or reduces anything itself.
- `decideContinuation(evidence)` is pure:
  1. The risk inputs must be a non-array object without any own coordinator-owned key; otherwise, or if reading them throws, the 2D rules get `null` (`RISK_INPUT_UNAVAILABLE`, `INVALID_RISK_INPUT`, `HALT`).
  2. The coordinator's working orders and unknown reservations are added, the proposed batch is empty and `haltAuthorityClear` is `false`. Any coordinator blocker is passed to the 2D rules as unresolved reconciliation (`RECONCILIATION_REQUIRED`, `HALT`).
  3. The halt view must have exactly the expected types (`HALT_AUTHORITY_UNAVAILABLE` otherwise). Only `RUNNING` with `allowRiskIncrease: true` lets the gate continue (`HALT_AUTHORITY_DENIED` otherwise, and the action becomes `HALT`).
  4. `allowRiskIncrease` is true only for `CONTINUE` with no blocker, risk metrics within limits and no `BOUNDARY_SEED_BLOCKED` (`CONTINUATION_GRANTED`). `REDUCE` (actual notional above the cap with a bounded reduction possible) never grants.

  Reason codes are the sorted union of the risk, blocker, halt and gate codes.
- A grant allows exactly one risk-increasing `submit` or `submitBatch` (`CONTINUATION_NOT_GRANTED` otherwise). Every submit or batch that runs uses it up, even one refused by an admission check or one with exits only. Every other coordinator operation revokes it: `startCycle`, `cancel`, `reconcileUnresolved`, `scanOpenOrders`, `cleanupOwnedDuplicates`, `replayExecutions` and a later `evaluateContinuation` that denies. `ingestStreamExecution` and `executionStreamReconnected` revoke it even while another operation is in flight. Any other call refused as busy changes nothing. Reduce-only exits and cancels never need a grant, so `REDUCE` and `HALT` never block risk reduction.
- `runRestartGate` is unchanged apart from its comment: its `allowRiskIncrease` reports coordinator blockers only.
- Test changes outside the new file:
  - `createHarness` takes `riskInputs` and `haltAuthority` (defaults: a fresh flat account inside the grid band and a `RUNNING` halt view). The new helper `grant(coordinator)` evaluates the gate and throws unless it grants.
  - Tests that expect a risk-increasing submit to reach the venue, the exposure gate or a later admission check now call `grant` first. Tests that expect a refusal before that check, and reduce-only exits, do not.
  - In `p3-ownership.test.ts`, two tests that need three owned duplicates use a venue snapshot that lags behind its acknowledgements. With a current snapshot the gate's scan now refuses a third duplicate.
  - In `p3-place.test.ts`, the lost-journal duplicate test grants both coordinators before the stale order is placed, since the gate's scan would otherwise find it first.
  - The F-03..F-05 child-process tests also report the gate's decision: `HALT` for an `UNKNOWN` intent or a foreign open order, `CONTINUE` after a clean restart.

  No 3A-3E expected value changed. The Phase 0 bootstrap guard is unchanged: `continuation.ts` contains no venue write.

Known limitations:

1. The gate only decides. `REDUCE` and `HALT` do not run the 2E hard-halt sequence or a bounded reduction; a supervisor must act on them (not implemented).
2. Every coordinator blocker is reported as `RECONCILIATION_REQUIRED`, so a transient blocker, such as a reconnect, yields `HALT` rather than a softer action. A busy coordinator also yields `HALT` (`COORDINATOR_BUSY`, not evaluated).
3. A grant is bounded by use and by the next operation, not by a clock. Venue changes between the gate and the submit are seen only by the submit's own checks. Since corrective G3-C2, one of those checks runs inside the fenced callback just before the venue call: a risk-increasing place whose grant was revoked, or that meets an execution blocker, is withheld (`RISK_INCREASE_REVOKED_BEFORE_SEND`).
4. A halt recorded between the gate and the submit is not seen by the coordinator; the fence and the halt process fence must stop the send. Halt and submit must be serialized by the supervisor.
5. `haltAuthorityClear` is always `false` in the 2D input, so `DURABLE_HALT_OR_ACK_UNAVAILABLE` appears in every decision; the halt authority is checked through the port instead.
6. Denying a grant for `BOUNDARY_SEED_BLOCKED` (flat position outside the grid band) is a fail-closed reading of PHASE_2D_CONTRACT ("It may block seeding"), RISK_PERSISTENCE_CONTRACT and TEST_FAULT_MATRIX P2-R15, flagged for the reviewer.
7. The freshness and correctness of the risk inputs are the source's job (Phase 4 adapter). The 2D freshness rules apply, but the gate cannot tell a stale source that reports fresh timestamps.
8. A venue snapshot that lags behind its acknowledgements can hide duplicates from the gate's scan.
9. `runRestartGate` alone no longer allows a risk-increasing submit; callers need `evaluateContinuation`.
10. Not wired into `src/index.ts`, telemetry or a supervisor.

## Phase 4.1 Hyperliquid capability audit (documentation and public metadata)

[venue-audits/hyperliquid-2026-10-16.md](venue-audits/hyperliquid-2026-10-16.md) is the IMPLEMENTATION_CONTRACT §7.1 capability audit for Hyperliquid BTC perpetuals. It was written from the official documentation plus one public, unauthenticated mainnet `meta` read (E1, audit section 10), which carried no account address. No credential was created or used and no SDK was installed. It proposes values for the 18 capabilities, maps TEST_FAULT_MATRIX V-01..V-14 and lists adapter requirements H-01..H-17. On 2026-10-20 it was corrected for the issue #27 review from a Markdown re-read of nine official pages; the correction sent no API request.

Main findings:

- Fills carry the venue order ID and a trade ID, but not the client order ID. The engine's `mv1` IDs are not valid cloids (`0x` + 32 hex), so a deterministic mapping and oid-based fill attribution are required. The trade ID (`tid`) is a 50-bit hash of the two order IDs, so it is not a proven execution identity on its own; `stableExecutionId` is `UNPROVEN`.
- There is no execution cursor and no WebSocket sequence number. Replay must use overlapping time-range queries; only the 10000 most recent fills are retained. The audit states replay bounds and completion criteria for review; replay completeness is unproven.
- No server-time endpoint is documented. The frontend-oriented WebSocket aggregate `WebData3` has a `serverTime` field, but its unit and freshness are not stated, so server time stays unproven.
- The account snapshot (`clearinghouseState`) is not the complete trading equity under unified-account or portfolio-margin modes. The adapter must read the account's abstraction mode (`userAbstraction`) and fail closed for any mode not shown to be supported.
- The $10 minimum order value is a documented rejection condition (error `MinTradeNtl`). Whether reduce-only orders are exempt is not stated.
- The price rule (5 significant figures) is not a fixed tick, which `MarketRules.priceTick` cannot express.
- Public metadata on 2026-10-16 (E1): BTC is mainnet asset index 0 with szDecimals 5 and maxLeverage 40, and has no isolated-only or margin-mode restriction. The minimum order value is not in the metadata.

The audit recommends `CANARY_ELIGIBLE=BLOCKED`. Open blockers (B1-B7): account-scoped and order evidence are missing; it is not provable from the documentation that an API wallet cannot sign an external withdrawal or transfer; server time and freshness are unproven; it is unknown whether a reduce-only order below the minimum order value can close a residual; the envelope currency needs a formal amendment (owner preference received, see the authorization boundary below); execution identity and replay completeness are unproven; and the account abstraction mode is unhandled. Gate 4A also needs a read-only adapter and its conformance tests. Independent review: `REJECT` on 2026-10-18 (issue #27, `49e6594`). The corrected audit (PR #40) received `PASS` on 2026-10-21 at `be0bafe`, limited to the audit content (issue #27 comment 6317625205). B1-B7 remain open, `GATE_4A_FIRST_VENUE=NOT_REQUESTED` and `CANARY_ELIGIBLE=BLOCKED`.

## Review correctives (2026-10-18)

On 2026-10-18 the independent reviews of Gate 2 (issue #26), Gate 3 (issue #24) and the Phase 4.1 audit (issue #27) returned REJECT. Each finding is corrected in its own PR, and the reviewer re-reviews afterwards. Corrective IDs below are the reviewer's: G2 is Gate 2, G3 is Gate 3. The re-reviews of 2026-10-21, all at `be0bafe`: Gate 2 `REJECT` (issue #26 comment 6315908120; F1, F6 and F8 open, new RR2), Gate 3 `REJECT` (issue #24 comment 6317456345; F3 open, new RR2 and RR3), Phase 4.1 audit content `PASS` (issue #27 comment 6317625205). The new Gate 2 and Gate 3 correctives follow in separate PRs.

- Lease final clock check (Gate 2 F2, Gate 3 F5). `runLeaseFencedMutation` applied the PHASE_2C_CONTRACT §8 clock rules only at its first boundary. A final clock read 2000 ms behind the lease heartbeat therefore still invoked the callback. The final synchronous check now applies the same rules (regression beyond 1000 ms, forward jump beyond 24 h) before its expiry check. A failure blocks the latch, fences the token and returns `NOT_SENT` with no callback. A forward jump at the final read used to be reported as `LEASE_EXPIRED` without blocking the latch; it is now `CLOCK_FORWARD_JUMP` and blocks the latch. Tests: `test/persistence/runtime-lease-corrective-3.test.ts`, including the Phase 3 `createLeaseMutationFence` bridge. PR #28.
- Exact risk arithmetic (G2-F3/C3, G3-F4). Risk and exposure sums used the 40-significant-digit rounding helpers, so a value just above a frozen limit could round onto it and pass. `src/math/exact-decimal.ts` adds `exactAdd`, `exactSub` and `exactMul`; each fails closed (`EXACT_PRECISION_EXCEEDED`) before any result above 1024 digits instead of rounding. They are used for planned and actual notional, net daily PnL, funding, drawdown, the grid boundary products and the halt acknowledgement snapshot check. `src/math/decimal.ts` is unchanged. Tests: `test/math/exact-decimal.test.ts`, `test/risk/risk-engine-corrective-5.test.ts`, `test/halt/p2e-corrective-4.test.ts`, `test/execution/p3-exposure-precision.test.ts`. PR #29.
- Actual-exposure reduction (G2-F1/C1). A `REDUCE` decision now durably reserves the possible exposure before any mutation, cancels proven-owned risk-increasing orders, classifies every cancel and reduce outcome, and proves the result with a fresh snapshot at or below 150 gross notional. A failed, unknown or unproven step escalates to the hard halt and its flatten policy. Tests: `test/halt/p2e-corrective-5.test.ts`. PR #30.
- Phase 2 fatal path (G2-F4/C4). See the Phase 3E note above: the guard now trips the halt process fence. Real child-process F-01/F-02 (with a lease-fenced mutation spy and log-and-ignore negative controls) and F-05 fresh restarts for the Phase 2 loop. Tests: `test/halt/p2-fatal.test.ts`, `test/fixtures/phase2-fatal-worker.ts`. PR #31.
- Telemetry secret policy (G2-F5/C5). See Phase 2F limitation 2. A secret-shaped run identity or scope key fails with `MANIFEST_SECRET_PROHIBITED`. Remaining: event-line parsing on open is structural and does not re-run the secret patterns. Tests: `test/telemetry/telemetry-corrective-1.test.ts` (synthetic values only). PR #32.
- Immutable manifest (G2-F6/C6). `TelemetryLog` builds every line from a frozen private copy of the validated manifest; the public `manifest` getter returns a fresh copy. Remaining: the exported constructor does not validate its arguments. Tests: `test/telemetry/telemetry-corrective-2.test.ts`. PR #33.
- Lease witness retry (G2-F7/C7). An exact retry of the last witness line is rebuilt on that line's predecessor and accepted without new bytes; conflicting duplicates are still rejected. Tests: `test/persistence/runtime-lease-corrective-4.test.ts`. PR #34.
- Crash classifier (G2-F9/C9), test-only. The normal-transition SIGKILL tests now require `pairAuthorityProven === false` for an unproven pair and an exact old or new byte match for an authoritative one. Assertions in `test/persistence/atomic-pair-store.test.ts` were strengthened (disclosed under REVIEW_CHANGE_PROTOCOL §14). Tests: `test/persistence/atomic-pair-store-corrective-1.test.ts`. PR #35.
- Detached intent snapshot (G3-F1/C1). `submit` and `submitBatch` copy, validate and freeze each intent before any await; checks, journal and transport use that one snapshot. Tests: `test/execution/p3-coordinator-corrective-1.test.ts`. PR #36.
- Send-time revalidation (G3-F2/C2). See Phase 3F limitation 3. A withheld place is recorded `NOT_SENT`; in a batch the later items stop. Reduce-only exits are still sent. Tests: `test/execution/p3-coordinator-corrective-2.test.ts`. PR #37.
- Persisted execution contradictions (G3-F3/C3). See Phase 3B limitation 6 and Phase 3D limitations 2-3. Two `p3-replay` expectations were strengthened: a later agreeing read no longer clears a reported conflict. Remaining: an `EXECUTION_STREAM_EVENT_DROPPED` event is not inspected, so its evidence cannot be persisted, and no operator resolution path exists. Tests: `test/execution/p3-coordinator-corrective-3.test.ts`. PR #38.
- Evidence machinery (G2-F8/C8). [change-requests/CR-2026-10-20-G2-C8.md](change-requests/CR-2026-10-20-G2-C8.md) asks the reviewer to retire the PHASE_2D_CONTRACT §11 evidence requirement through a contract amendment and to record truthful status flags in the contracts. Status: `APPROVE_WITH_CHANGES` (issue #26 comment 6315908120, 2026-10-21). It is applied as PHASE_2D_CONTRACT §12 and status notes in PHASE_2D_CONTRACT, IMPLEMENTATION_CONTRACT and ACCEPTANCE_GATES. F8 stays open until the reviewer rebinds it to the applied text.
- Phase 4.1 audit (issue #27, findings 1-7). The audit is corrected in place: `expiresAfter` is an action deadline, not an order lifetime; bare `tid` is not an execution identity and `stableExecutionId` is `UNPROVEN`; the replay design has explicit bounds and completion criteria; an account-mode precondition is added; the $10 minimum cites the `MinTradeNtl` error; `WebData3.serverTime` is recorded as documented but unproven; and external withdrawals are separated from same-address collateral movement. The currency amendment is proposed separately in [change-requests/CR-2026-10-20-USDC-ENVELOPE.md](change-requests/CR-2026-10-20-USDC-ENVELOPE.md) (with an experiment-spec version bump; `APPROVE_WITH_CHANGES` on 2026-10-21 in issue #27 comment 6317625205, not yet applied). No code or contract changed and no exchange request was sent. PR #40.

## Re-review correctives (2026-10-21)

The re-reviews of 2026-10-21 at `be0bafe` (Gate 2: issue #26; Gate 3: issue #24 comment 6317456345) raised new findings. Each is corrected in its own PR, and the reviewer re-reviews afterwards. None of these PRs is reviewed yet.

- Busy-dropped execution evidence (G3-RC1). A stream execution that arrived while another operation ran was dropped unread. A conflicting fill then left only the in-memory `EXECUTION_STREAM_EVENT_DROPPED` blocker, and the next completed replay cleared it. Now the coordinator copies such an execution on arrival and checks it, in arrival order, before the running operation releases the coordinator:
  - a problem it shows is persisted as an execution contradiction, as for a direct ingest, so it survives replay and restart;
  - each checked event revokes any continuation grant;
  - while an event waits, `EXECUTION_STREAM_EVENT_DROPPED` blocks risk increase and a replay does not clear it;
  - if the journal fails during the check, the remaining events stay queued and blocking;
  - an event that arrives after a journal latch is still dropped unread.

  This replaces the "Remaining" note on PR #38 above for events that arrive while another operation runs. The persisted schema is unchanged. `test/execution/p3-coordinator-corrective-2.test.ts` expectations were strengthened (disclosed under REVIEW_CHANGE_PROTOCOL §14): its dropped stream execution has no owning intent, so it now also leaves `UNATTRIBUTED_EXECUTION` and one journal entry. Remaining: waiting events live in memory only, so a crash before the check loses them, as a crash before a direct ingest's write does; there is no bound on waiting events; an unexpected error during the check replaces the operation's result and leaves the event queued and blocking; no operator resolution path exists. Tests: `test/execution/p3-coordinator-corrective-4.test.ts`. PR #43.

## Process reset (2026-10-11)

Between 2026-09-01 and 2026-09-12 no runtime behavior changed; effort went to rebinding exact SHAs, trees, byte hashes and test counts after every change. The integration line retires that machinery (all of it remains in git history):

- trusted Phase 2D freeze gate and governance self-test workflows, `.github/trusted/`, `scripts/governance/`;
- CI native-log retention;
- the Phase 2D Corrective 4 evidence generator/verifier (it pinned the literal `npm test` script);
- the Linux-only Python offline wrapper (it pinned the frozen SHA and the 474/79 counts).

No product source, risk, persistence, halt or test assertion changed in the reset. `npm test` now runs every product suite; see [VALIDATION_GUIDE.md](VALIDATION_GUIDE.md).

This section does not amend PHASE_2D_CONTRACT §11 (Gate 2 F8). The retirement of the Phase 2D Corrective 4 evidence machinery was approved with changes in [change-requests/CR-2026-10-20-G2-C8.md](change-requests/CR-2026-10-20-G2-C8.md) and is applied as PHASE_2D_CONTRACT §12.

On 2026-10-11 the owner removed `trusted-phase2d-freeze-gate` from the `main` branch-protection required checks (its workflow no longer exists). The CI job name `Clean install, static checks, tests, secret scan, and dry-run` is unchanged.

## Present authorization boundary

```text
PHASE_2E_AUTHORIZED=NO
PHASE_2E_STARTED=YES
GATE_2=REJECT
GATE_3=REJECT
PHASE_4_1_AUDIT=PASS
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=PER_PR_BY_OWNER
```

- `PHASE_2E_AUTHORIZED=NO`: no Phase 2E authorization record exists, and none is granted retrospectively. Phase 2E implementation began on 2026-08-27 on `experiment/v0.1-phase2e-halt-ack` and reached `main` when the owner merged PR #16 on 2026-10-12. A merge is not an authorization or a gate ruling.
- `GATE_2`, `GATE_3`, `PHASE_4_1_AUDIT`: independent reviews of 2026-10-18 at `8381085` (issue #26), `3f9cff3` (issue #24) and `49e6594` (issue #27), all REJECT, and re-reviews of 2026-10-21 at `be0bafe`: Gate 2 REJECT, Gate 3 REJECT, Phase 4.1 audit content PASS (see "Review correctives" above).
- `MERGE_AUTHORIZED=PER_PR_BY_OWNER`: the owner performs each merge; no merge authority is delegated. This replaces the earlier `PR16_PR17_BY_OWNER_ONLY`, which later merges (PR #18 to PR #38) had outgrown.
- The contract headers in PHASE_2D_CONTRACT, IMPLEMENTATION_CONTRACT and ACCEPTANCE_GATES keep their August 2026 flags as dated history. The CR-2026-10-20-G2-C8 status note under each supersedes the flags it names. The contracts outrank this record.

On 2026-10-11 the owner authorized Phase 2F implementation and selected Hyperliquid as the first Phase 4 venue. On 2026-10-12 the owner authorized Phase 3 implementation without a Gate 2 PASS (a recorded deviation from ACCEPTANCE_GATES), and authorized merging PR #16 and PR #17 and closing superseded PRs; those merges are performed by the owner, not by this record. On 2026-10-16 the owner authorized the Gate 3 review request (issue #24) and Phase 4 together; Phase 4.1 therefore started without a Gate 3 PASS (a recorded deviation). Later Phase 4 steps and later phases still require an explicit owner decision. On 2026-10-18 the owner directed the correctives above, including the change requests. Phase 4.2 has not started.

Owner answers of 2026-10-16 to the Phase 4.1 audit questions (audit section 8):

- Q1: the owner prefers that on Hyperliquid the envelope's "U" is USDC, with the numbers unchanged (capital 100, margin 30, gross notional 150, daily PnL halt -5, drawdown halt 10). Owner preference received; formal amendment outstanding (issue #27 finding 4). `docs/EXPERIMENT_SPEC.md` `0.1.0` still freezes USDT and was not edited. The change request is [change-requests/CR-2026-10-20-USDC-ENVELOPE.md](change-requests/CR-2026-10-20-USDC-ENVELOPE.md). It was approved with changes on 2026-10-21 (issue #27 comment 6317625205) but is not applied; until its contract amendment is applied, nothing treats the envelope as USDC.
- Q2: read-only networking for evidence is approved, without a chosen scope. The narrowest offered scope was applied: one public mainnet `meta` read with no account address (E1). Testnet reads and account-address reads need the owner to choose that scope.
- Q3 and Q4: no decision; the auditor's recommendations are recorded in the audit. Q3 was corrected for issue #27 finding 7: the required evidence concerns external withdrawals and transfers, not same-address collateral movement, and no withdrawal waiver exists. Both block a live canary, not read-only work.

Real/testnet credentials and every exchange write remain unauthorized. Exchange networking beyond public, unauthenticated, address-free Hyperliquid `info` reads remains unauthorized.

Unknown, stale, lease-uncertain or persistence-uncertain state must continue to fail closed and block risk increase. The separate risk, durable state, lease, halt, ACK and process-fence authorities are not a single boolean switch.

## Known product risk: venue minimum order size

The frozen envelope plans at most 150U gross notional over 10 levels, roughly 15U per order. `docs/EXPERIMENT_SPEC.md` section 3 requires reporting incompatibility rather than raising leverage, margin or notional. Unverified public reports suggest Binance USD-M BTCUSDT requires about 100U minimum notional (incompatible), Hyperliquid about 10U minimum notional (possibly compatible), and OKX BTC-USDT-SWAP a 0.01 BTC contract value with an unverified minimum size. The Phase 4 venue audit must read these limits from each venue's public metadata before selecting a venue; an unverifiable venue stays unsupported. Hyperliquid is the owner's first Phase 4 venue. Its error reference documents a $10 minimum order value (`MinTradeNtl`) but not whether reduce-only orders are exempt, and size precision and margin mode come from per-asset metadata ([venue-audits/hyperliquid-2026-10-16.md](venue-audits/hyperliquid-2026-10-16.md), section 6). Public metadata read on 2026-10-16 gives BTC szDecimals 5 and maxLeverage 40, so quantity rounding cannot put a 15-per-level BTC entry order below 10 at any order price up to 500000, with each order checked at its own price. Exits sized by fills are not covered. Whether a given order, including a reduce-only residual, is accepted is still unverified, and the adapter must read the metadata again at startup; until both hold, the venue stays unsupported.
