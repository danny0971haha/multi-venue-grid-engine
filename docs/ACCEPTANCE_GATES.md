# Acceptance Gates

Version: `0.2.0`

The independent reviewer returns exactly one of:

```text
PASS
REJECT
BLOCKED
```

Green CI is necessary but never sufficient. No gate in this document authorizes live exchange writes.

**Independent-review status (narrowly additive, 2026-08-24):**

```text
GATE_0=PASS
GATE_1=PASS
GATE_2=NOT_REVIEWED
PHASE_2A=REVIEW_CANDIDATE
PHASE_2A_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2B_AUTHORIZED=NO
```

Phase 2A implements only read-side canonical envelope validation and exact-pair inspection. It does not complete Gate 2. See `docs/PHASE_2A_CONTRACT.md`.

## Gate 0 — deterministic baseline

PASS only if current-byte evidence proves:

- Node `22.23.2` and npm `10.9.8` are the tested runtime/toolchain;
- exact dependency versions and deterministic `package-lock.json` are committed;
- clean `npm ci` succeeds;
- strict typecheck succeeds;
- lint succeeds;
- format check succeeds;
- tests succeed;
- production build succeeds;
- secret-scan baseline succeeds;
- no tracked secret files/material are found;
- dry-run is the default;
- explicit `LIVE` request fails with stable fail-closed reason;
- Phase 0 dry-run requires no network/credentials;
- CI runs on implementation branches and pull requests;
- CI contains no deployment/trading job;
- implementation stayed within `PHASE_0_CONTRACT.md` write scope;
- no contract document was modified by the implementation agent;
- no real venue/write/signing code was introduced;
- no live exchange write occurred.

## Gate 1 — domain / simulator correctness

PASS only if all applicable `P1-*` matrix cases pass and evidence proves:

- v0.1 configuration semantics preserve exactly `100U / 5x / 30U / 150U / 10 levels / ±3%`;
- grid entry levels resolve to deterministic five-below/five-above geometry;
- authoritative price/qty/money arithmetic does not use IEEE `number` as source of truth;
- venue rounding/min-size behavior is explicit;
- canonical identities are stable and collision-tested where needed;
- `ACK / REJECTED / UNKNOWN / NOT_SENT` are distinct;
- `UNKNOWN` reserves possible exposure and requires reconciliation;
- partial fills preserve execution IDs, executed quantity, and remaining quantity;
- cancel != fill;
- disappearance != fill;
- local position delta != invented fill;
- duplicate logical orders reconcile deterministically;
- unowned/ambiguous orders are distinguished;
- restart from simulator snapshot does not blindly reseed or duplicate exposure;
- execution replay is idempotent.

No real exchange adapter is required or allowed for Gate 1.

## Gate 2 — durable risk and persistence safety

PASS only if all applicable `P2-*` and required process-crash matrix cases pass.

### Durable authority

Must prove:

- canonical checksummed envelope validates deterministically;
- primary/backup exact-pair is the normal authority;
- missing/corrupt/conflicting/ahead copy blocks risk increase;
- generation and previous-hash chain are checked;
- backup-first atomic transition uses identical next-state bytes;
- final exact-pair inspection is required before `allowRiskIncrease=true`;
- unsafe automatic repair is absent;
- runtime persistence latch cannot silently clear inside the same process.

### Real crash evidence

Must use fresh-process inspection after real child-process termination at every meaningful atomic-write boundary for at least:

- normal risk-state transition;
- hard-halt persistence transition;
- halt-acknowledgement transition.

Allowed post-crash outcomes are only:

```text
proven old exact pair
proven new exact pair
fail-closed / risk blocked
```

### Halt semantics

Must prove:

- hard breach prevents new risk;
- halt creates unique current `haltId`;
- cancel/reduce/flatten failures remain non-running;
- fresh snapshot is required to prove flat/reduced state;
- hard halt never auto-restarts;
- stale/mismatched/caller-forged halt IDs cannot resume;
- acknowledgement authority comes from current durable exact pair;
- correct acknowledgement only reaches RUNNING after safe resume gates and exact durable commit.

### Risk semantics

Must prove:

- worst-case planned exposure includes current position, owned working orders, unresolved UNKNOWN writes, and full proposed batch;
- `>150U` planned exposure blocks risk increase;
- actual `>150U` selects active reduction or hard halt, not cancel-only;
- daily net PnL `<= -5U` hard-halts;
- drawdown from start `>=10U` hard-halts;
- adverse boundary breach hard-halts;
- stale/missing required live-capable inputs fail closed;
- telemetry/manifest failure cannot authorize risk;
- fatal uncaught runtime errors do not continue normal trading.

### Lease semantics

Must prove:

- one owner per scope;
- monotonic fencing generation;
- stale owner cannot mutate after fencing;
- generation is checked immediately before mutation;
- lease uncertainty blocks new risk.

## Gate 3 — execution coordinator / reconciliation

PASS only if all applicable `P3-*` matrix cases pass and evidence proves:

- intent registry is idempotent;
- conflicting actions are serialized;
- whole-batch exposure is gated before sends;
- UNKNOWN placement cannot be blindly retried with a new identity;
- discovered ambiguous order/execution reconciles to the original intent when provable;
- owned/unowned/ambiguous classification is deterministic;
- duplicate cleanup never cancels an unowned order;
- all possibly-live duplicate orders remain exposure-reserved until cancellation is proven;
- cancel/fill races reconcile from execution evidence;
- execution cursor overlap cannot double-count fills;
- execution gaps/reconnects block risk until reconciled;
- restart does not reseed before reconciliation;
- lease generation is rechecked immediately before every simulated venue write;
- all core semantics remain simulator-testable without a real exchange.

## Gate 4A — first venue capability audit / read-only adapter

PASS only if one selected venue has a dated current audit primarily backed by official documentation and the read-only adapter passes conformance tests.

Must establish or explicitly mark:

- market symbol/instrument mapping;
- tick/step/minimum-size rules;
- account/position snapshot semantics;
- open-order semantics;
- order lookup semantics;
- authoritative execution/fill path;
- stable execution identity or safe deduplication equivalent;
- partial-fill semantics;
- client order identity/idempotency capabilities;
- cancellation accepted-vs-confirmed semantics;
- leverage set/readback semantics;
- isolated margin support;
- reduce-only semantics;
- partial reduction/full flatten semantics;
- server timestamp/freshness semantics;
- rate limits/backoff requirements;
- sandbox/testnet differences where relevant.

Automatic blocker:

```text
no authoritative fill provenance
```

A PASS does not authorize mutations. Adapter remains read-only / dry-run planning only.

## Gate 4B — second venue abstraction proof

PASS only if:

- second venue has equivalent current official audit;
- second read-only adapter passes shared conformance tests;
- both venues use the same core domain/execution/risk contracts;
- capability differences are represented explicitly rather than hidden behind venue-name branches;
- no core safety contract was weakened to fit the second venue;
- no real exchange write occurred.

This gate proves abstraction portability, not live readiness.

## Gate 5 — integrated dry-run / fault campaign

PASS only if the integrated engine completes the mandatory campaign in `TEST_FAULT_MATRIX.md` and evidence proves:

- no live exchange write occurred;
- simulator and any read-only venue observations remain separated from mutation transport;
- all required fault scenarios terminate fail-closed;
- restart/reconciliation after faults is deterministic;
- real process-crash storage tests remain green in the integrated codebase;
- runtime lease/fencing remains effective;
- telemetry and manifest reconstruct all safety-critical transitions;
- manifest records exact tested commit SHA and frozen experiment envelope;
- append-only events distinguish authoritative from inferred observations;
- no duplicate logical exposure survives unnoticed;
- no unresolved `UNKNOWN` write is forgotten;
- all mandatory tests report zero failures and zero unjustified skips.

PASS means only:

```text
DRY_RUN_FAULT_CANDIDATE_ACCEPTED
```

It does not mean live trading may start.

## Live gate — not defined/authorized here

A future live canary requires a separate commit-bound contract and explicit human authorization.

Until that separate contract exists and passes its own review:

```text
LIVE_TRADING_AUTHORIZED=NO
PRODUCTION_CUTOVER_AUTHORIZED=NO
```
