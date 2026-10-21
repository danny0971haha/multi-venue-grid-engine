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
PHASE_2A_CORRECTIVE_1=REJECT
PHASE_2A_CORRECTIVE_2=REVIEW_CANDIDATE
PHASE_2B_AUTHORIZED=NO
```

**Status note (CR-2026-10-20-G2-C8, `APPROVE_WITH_CHANGES` in issue #26 comment 6315908120, 2026-10-21):** The block above is the 2026-08-24 record. The flags below supersede `GATE_2`, `PHASE_2A`, `PHASE_2A_CORRECTIVE_2` and `PHASE_2B_AUTHORIZED` above and add `GATE_3`, `PHASE_2B` and `PHASE_2E_AUTHORIZED`; all other flags above are unchanged.

```text
GATE_2=REJECT
GATE_3=REJECT
PHASE_2A=PASS
PHASE_2A_CORRECTIVE_2=SUPERSEDED_BY_PHASE_2A_PASS
PHASE_2B_AUTHORIZED=YES
PHASE_2B=PASS
PHASE_2E_AUTHORIZED=NO
```

- `GATE_2` and `GATE_3`: independent reviews of 2026-10-18 (Gate 2 at `8381085e91a84be36deb41e0f545840b668762a7`, issue #26; Gate 3 at `3f9cff3fcab5e4bfda8abae9d60a445717a5c073`, issue #24) and re-reviews of 2026-10-21 at `be0bafe3e7b03b15f177010aed34be68358c09b4` (issue #26 comment 6315908120; issue #24 comment 6317456345). All four returned REJECT.
- `PHASE_2A` and `PHASE_2B`: the reviewer record of 2026-08-25 in `docs/IMPLEMENTATION_CONTRACT.md` (`ACCEPTED_PHASE_2A_HEAD`, `ACCEPTED_PHASE_2B_HEAD`).
- `PHASE_2A_CORRECTIVE_2=SUPERSEDED_BY_PHASE_2A_PASS`: the Phase 2A PASS at `ACCEPTED_PHASE_2A_HEAD=51400c0f5a43c96f691115383e565743f543c9ee` supersedes the corrective candidate status above.
- `PHASE_2B_AUTHORIZED=YES` is historical: it is the dated Phase 2B authorization of 2026-08-24 in `docs/PHASE_2B_CONTRACT.md` §1. It is not new implementation permission.
- `PHASE_2E_AUTHORIZED=NO`: no Phase 2E authorization is inferred; see the status note in `docs/PHASE_2D_CONTRACT.md`.

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
