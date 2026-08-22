# Acceptance Gates

The independent reviewer returns exactly one of: `PASS`, `REJECT`, `BLOCKED`.

Green CI is necessary but never sufficient for live authorization.

## Gate 0 — Baseline

PASS only if:

- clean install succeeds from lockfile;
- typecheck succeeds;
- lint/format check succeeds;
- tests succeed;
- no tracked secret files;
- dry-run is default;
- CI runs on branch and pull request.

## Gate 1 — Domain / simulator correctness

PASS only if tests prove:

- 100U/5x/30U/150U/10-level/±3% configuration resolves exactly;
- partial fills are explicit;
- cancel != fill;
- disappearance != fill;
- duplicate logical orders reconcile deterministically;
- order identity survives restart;
- no local state advances on ambiguous exchange result.

## Gate 2 — Durable safety

PASS only if:

- persistent risk state fails closed when missing/corrupt/contradictory;
- unique halt ID is required to resume;
- runtime lease prevents concurrent owners;
- stale live inputs halt;
- planned notional cannot exceed 150U through a single planning batch;
- actual notional excess invokes active reduction or hard halt;
- kill-switch failures stay halted;
- fresh snapshot verifies final state.

## Gate 3 — Reconciliation

PASS only if:

- owned/unowned/orphan orders are distinguished;
- restart does not blindly reseed;
- execution cursor can replay without double-counting;
- ambiguous order writes require reconciliation;
- duplicate cleanup cannot cancel an unowned order;
- lease generation is checked before trading writes.

## Gate 4 — Venue capability audit

PASS only if official documentation and read-only evidence establish all capabilities needed for the selected canary venue.

A missing authoritative fill path is a blocker.

## Gate 5 — Dry-run / fault injection

PASS only if:

- no live exchange write occurred;
- all fault scenarios complete fail-closed;
- telemetry and manifest reconstruct the run;
- restart/reconciliation tests pass;
- exact tested commit SHA is recorded.

## Live gate

Not part of the initial implementation. It requires a separate explicit authorization after independent review.
