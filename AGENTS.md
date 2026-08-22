# AGENTS.md — Binding Implementation Instructions

This file is binding for any AI or human implementing this repository.

## Mission

Build an **independent, from-scratch multi-venue perpetual grid engine** that can eventually be tested under the frozen 100U experiment envelope in `docs/EXPERIMENT_SPEC.md`.

The immediate task is engineering and dry-run validation only. **Do not perform live exchange writes.**

## Third-party boundary

- Do not fork `discountry/ritmex-bot` or any other trading bot into this repository.
- Do not copy third-party source files, code blocks, tests, fixtures, comments, or generated artifacts unless a compatible license is explicitly verified and the user separately authorizes the import.
- The reference repository `discountry/ritmex-bot` currently has no detected repository license in GitHub metadata as of the frozen research baseline. Treat its source as **read-only behavioral research**, not importable code.
- General ideas, public API documentation, exchange specifications, state-machine concepts, and independently designed algorithms may be used.
- Keep an attribution/research note for external concepts, but implementation bytes must be independently authored.

## Working rules

1. Work only on a feature branch. Never commit implementation directly to `main`.
2. Preserve `main` as the reviewable architecture/baseline branch.
3. Before changing code, record:
   - current branch;
   - HEAD SHA;
   - working-tree status;
   - toolchain versions.
4. Use bounded checkpoints. One checkpoint should have one primary engineering objective.
5. Do not mix UI polish with safety-critical execution changes.
6. Never weaken a fail-closed guard just to make a test pass.
7. Never claim live readiness from green CI alone.
8. Never create or use API keys with withdrawal permissions.
9. Secrets must not appear in git history, tests, telemetry, screenshots, logs, fixtures, or review artifacts.
10. If a required exchange fact cannot be verified, fail closed or leave the venue unsupported.

## Mandatory architecture

Keep these responsibilities separate:

- `core/domain` — types, order/position/execution identities, grid-level state machine.
- `strategy/grid` — grid geometry and desired strategy transitions only.
- `execution` — intent coordination, idempotency, ownership, reconciliation.
- `risk` — exposure, loss, drawdown, stale-data, boundary and kill-switch decisions.
- `venues` — exchange-specific protocol/adapters.
- `storage` — durable state, checksums/generations, runtime fencing.
- `telemetry` — append-only evidence events and run manifests.
- `cli` / `ui` — operational surfaces; never own trading truth.

Do not let exchange adapters contain strategy policy. Do not let UI state control authoritative risk state.

## Required v0.1 safety semantics

- Dry-run is the default.
- Live mode must require explicit double opt-in plus a commit-bound canary acknowledgement.
- Only one runtime may own an experiment scope at a time; use a durable runtime lease/fencing generation.
- Restart must reconcile exchange state before any new risk-increasing order.
- Unknown/orphan orders are surfaced and block live reseeding until resolved.
- Authoritative `FILL` requires exchange-observed execution evidence. Open-order disappearance alone is not a fill.
- Partial fills must preserve executed quantity, remaining quantity, order identity, and execution identity where available.
- Duplicate logical orders must be deterministically reconciled.
- Hard risk breach: stop new risk -> cancel owned grid orders -> actively reduce/flatten -> fresh snapshot verify -> persist HALTED.
- Failed/ambiguous cancel or reduction remains HALTED.
- Hard halt cannot auto-restart. Resume requires a unique halt acknowledgement tied to the current halt instance.
- Missing/stale live equity, position, PnL, or execution data fails closed.
- Actual notional above cap must not degrade into cancel-only behavior; it requires bounded active reduction or a hard halt/flatten path.
- Uncaught fatal process errors must not be logged-and-ignored while trading continues. Fence writes and terminate or otherwise prove a fail-closed supervisor path.

## First implementation sequence

Follow `docs/IMPLEMENTATION_CONTRACT.md` exactly. Do not skip directly to exchange integration.

## Required handoff after every checkpoint

Return the exact packet in `docs/EVIDENCE_TEMPLATE.md` including current bytes, diff, tests, unresolved risks, and explicit statement that no live exchange write occurred.

The independent reviewer, not the implementation agent, decides PASS / REJECT / BLOCKED.
