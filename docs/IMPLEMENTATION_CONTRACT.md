# Implementation Contract

Version: `0.2.0`

This contract defines the implementation sequence for the independent multi-venue perpetual grid engine.

**Current authorization: Phase 0 only.** Later phases are defined so architecture is stable, but each later phase requires the preceding independent gate to PASS and should receive a fresh bounded phase prompt tied to the actual accepted baseline SHA.

No phase in this initial contract authorizes live exchange writes.

**Independent-review status (narrowly additive, 2026-08-25 cumulative baseline refresh):**

```text
GATE_0=PASS
GATE_1=PASS
PHASE_2A=PASS
PHASE_2B=PASS
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
ACCEPTED_PHASE_2A_HEAD=51400c0f5a43c96f691115383e565743f543c9ee
ACCEPTED_PHASE_2B_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
AUTHORIZED_CHECKPOINT=PHASE_2D_CORRECTIVE_2
CUMULATIVE_PHASE_2_BASELINE=PASS
INTEGRATION_MERGE_HEAD=5b0fd685586ec57b110159ccc36e5b21ba23ac28
INTEGRATION_MERGE_TREE=420c4184209a0c919829e5fc1b66b653d37b8460
PHASE1_IS_ANCESTOR_OF_INTEGRATION=YES
PHASE_2C=REJECT
PHASE_2C_CORRECTIVE_1=REJECT
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D=REJECT
PHASE_2D_CORRECTIVE_1=REJECT
PHASE_2D_CORRECTIVE_2=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_AUTHORIZED=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
ALLOW_RISK_INCREASE=false
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
```

Authoritative Phase 2A rules are in `docs/PHASE_2A_CONTRACT.md`. This file is not otherwise revised.

## 1. Binding inputs

Implementation must follow:

- `AGENTS.md`
- `docs/EXPERIMENT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/DOMAIN_CONTRACTS.md`
- `docs/VENUE_ADAPTER_CONTRACT.md`
- `docs/RISK_PERSISTENCE_CONTRACT.md`
- `docs/TEST_FAULT_MATRIX.md`
- `docs/REVIEW_CHANGE_PROTOCOL.md`

The exact first task is `docs/PHASE_0_CONTRACT.md`.

## 2. Global non-negotiable rules

- independent implementation; no copied RitMEX/third-party bot source;
- TypeScript/Node baseline selected and pinned by Phase 0;
- dry-run is default;
- no production/testnet exchange mutation in initial phases;
- no withdrawal-enabled credential use;
- no floating dependency versions after Gate 0;
- no `number` as authoritative financial arithmetic after Phase 1;
- no state advance on ambiguous exchange mutation;
- order disappearance is not fill evidence;
- every risk-increasing write is lease-fenced and risk-gated before a future live mode exists;
- persistent safety uncertainty blocks risk increase;
- hard halt cannot auto-clear;
- each phase stops at its gate.

## 3. Phase 0 — deterministic repository/tooling baseline

Authoritative detailed contract:

```text
docs/PHASE_0_CONTRACT.md
```

Deliver:

- pinned Node/npm/TypeScript project;
- exact lockfile;
- strict TypeScript baseline;
- lint/format/test/build scripts;
- secret-scan baseline;
- CI workflow;
- dry-run default shell;
- explicit Phase 0 rejection of live mode.

Must not deliver:

- real exchange adapter;
- signing/authentication;
- order/cancel/reduce transport;
- trading strategy;
- safety-store implementation.

Gate:

```text
GATE_0
```

## 4. Phase 1 — domain model, grid strategy, and deterministic simulator

Start only after Gate 0 `PASS`.

### 4.1 Deliverables

Implement project-owned domain types from `DOMAIN_CONTRACTS.md`:

- canonical decimal-string boundary;
- pinned arbitrary-precision decimal abstraction;
- identifiers and scope/epoch semantics;
- normalized order intents;
- `ACK / REJECTED / UNKNOWN / NOT_SENT` result type;
- exchange-order observation;
- authoritative execution observation;
- position/account snapshots;
- explicit grid-level state machine.

Implement deterministic v0.1 grid geometry:

- 100U/5x/30U/150U metadata preserved;
- anchor ±3%;
- 10 entry levels, five below/five above;
- 0.6% nominal increments before venue rounding;
- adjacent one-step-toward-anchor exit target;
- no adaptive re-anchoring.

Implement an in-memory deterministic simulator that can model:

- ACK;
- REJECTED;
- UNKNOWN;
- working orders;
- partial fills;
- multiple execution IDs;
- cancellation;
- cancel/fill race;
- order disappearance without fill;
- duplicate orders;
- foreign/unowned order;
- stale snapshot;
- restart from exported simulator snapshot.

### 4.2 Simulator rules

Simulator behavior must not be simpler than the core semantics it is intended to test.

It must permit explicit scripts such as:

```text
PLACE -> UNKNOWN -> later discover order
PLACE -> ACK -> PARTIAL_FILL -> CANCEL_RACE -> FILL
OPEN_ORDER_DISAPPEARS -> NO EXECUTION
DUPLICATE OWNED + UNOWNED AT SAME PRICE
```

Every execution has a stable unique execution ID.

### 4.3 Phase 1 forbidden scope

Do not implement:

- filesystem durable safety store;
- runtime lease;
- real exchange network adapter;
- authentication/signing;
- live-mode writes;
- dashboard controls.

In-memory serialization/export fixtures for restart simulation are allowed.

### 4.4 Phase 1 test gate

Implement all applicable `P1-*` cases from `TEST_FAULT_MATRIX.md`.

Gate:

```text
GATE_1
```

## 5. Phase 2 — durable safety core

Start only after Gate 1 `PASS`.

This is a safety-critical phase and should be split into bounded checkpoints during implementation/review.

### 5.1 Deliverables

Implement:

- checksummed canonical durable envelope;
- primary/backup exact-pair authority;
- backup-first atomic commit;
- persistence disposition + runtime persistence latch;
- runtime lease/fencing generation;
- persistent risk state;
- unique halt ID and durable-authoritative acknowledgement;
- experiment manifest;
- append-only telemetry;
- stale/missing-input guard;
- planned gross-notional guard;
- actual notional guard;
- daily-loss guard;
- starting-equity drawdown guard;
- boundary guard;
- `CONTINUE / REDUCE / HALT` action gate;
- kill-switch state machine;
- active reduction abstraction distinct from full flatten;
- fatal-runtime write fence/termination path.

### 5.2 Kill-switch order

Normative sequence:

```text
create/evaluate hard halt
-> persist HALTING intent if durable authority is still provable
-> process/risk fence new risk
-> cancel proven-owned risk-increasing orders
-> reconcile cancel ambiguity
-> bounded reduce or full flatten as policy requires
-> fresh authoritative snapshot
-> persist HALTED_FLAT / HALTED_UNFLAT / HALT_FAILED
-> remain non-running until current halt acknowledgement is durably committed
```

### 5.3 Persistence checkpoints

The implementation agent should not attempt Phase 2 as one uncontrolled patch. Recommended review checkpoints:

```text
2A canonical envelope + exact-pair inspection
2B backup-first atomic persistence + real process crash matrix
2C runtime lease/fencing
2D risk calculations + continuation gate
2E halt/kill-switch + durable ACK
2F telemetry/manifest + integrated restart tests
```

Reviewer may collapse checkpoints only if current-byte evidence remains independently auditable.

### 5.4 Required tests

All applicable `P2-*`, `F-*`, and real process-crash storage matrix cases are mandatory.

Gate:

```text
GATE_2
```

## 6. Phase 3 — execution coordinator and reconciliation

Start only after Gate 2 `PASS`.

### 6.1 Deliverables

Implement:

- intent registry;
- deterministic client/order identity mapping;
- write budget per cycle;
- serialize conflicting intents;
- whole-batch conservative exposure reservation;
- durable unresolved `UNKNOWN` intent state;
- owned/unowned/ambiguous classification;
- deterministic owned duplicate cleanup;
- execution cursor/checkpoint;
- overlap-safe execution replay;
- restart reconciliation;
- cancellation reconciliation;
- cancel/fill race handling;
- lease-generation check immediately before every simulated mutation;
- production-shaped continuation gate that yields `CONTINUE`, `REDUCE`, or `HALT`.

### 6.2 Mandatory property

All Phase 3 behavior remains fully testable through the simulator. A real exchange adapter is not required to prove core execution safety.

### 6.3 Required tests

All applicable `P3-*` cases are mandatory.

Gate:

```text
GATE_3
```

## 7. Phase 4 — first venue capability audit and read-only adapter

Start only after Gate 3 `PASS`.

Select exactly **one** candidate venue.

### 7.1 Capability audit first

Before implementation, create:

```text
docs/venue-audits/<venue>-<YYYY-MM-DD>.md
```

Use the template/requirements in `VENUE_ADAPTER_CONTRACT.md`.

Primary evidence must be current official venue/API documentation. Record source date and API version.

Do not rely on RitMEX or another bot as the protocol authority.

### 7.2 Read-only adapter

Implement only read/normalization paths first:

- market rules;
- market/timestamp observation;
- account snapshot if a dedicated read-only credential is explicitly available;
- position snapshot if permitted;
- open orders read;
- order lookup read;
- execution history/stream read;
- leverage readback;
- capability object.

No real mutation transmission is authorized.

If private read-only evidence is unavailable, mark the relevant capability `UNPROVEN` and allow Gate 4 to return `BLOCKED` rather than inventing evidence.

### 7.3 Write planning

The adapter may define types and dry-run request planning for future methods, but must not sign/send them to a venue.

### 7.4 Gate

```text
GATE_4A_FIRST_VENUE
```

Missing authoritative fill provenance is a blocker.

## 8. Phase 5 — second venue read-only adapter / abstraction proof

Start only after first venue Gate 4A `PASS`.

Purpose: prove core abstractions do not encode the first venue's quirks.

Deliver:

- second current official capability audit;
- second read-only adapter;
- same normalized domain contracts;
- adapter-level conformance test suite shared across both adapters;
- explicit matrix of capability differences;
- no weakening of core semantics to make both venues appear identical.

If a capability differs, represent it in `VenueCapabilities`; do not branch strategy behavior on ad hoc venue names.

Gate:

```text
GATE_4B_SECOND_VENUE
```

## 9. Phase 6 — integrated dry-run and fault campaign

Start only after Gate 4B `PASS` or after reviewer explicitly scopes Phase 6 to the first accepted venue abstraction.

Still **no live exchange mutations**.

Integrate:

```text
grid strategy
+ execution coordinator
+ risk engine
+ durable state
+ runtime lease
+ telemetry
+ simulator
+ venue read normalization
```

Run the complete integrated campaign in `TEST_FAULT_MATRIX.md`.

Required artifacts:

```text
manifest.json
events.jsonl
machine-readable test matrix result
exact commit SHA
dry-run configuration snapshot
```

Gate:

```text
GATE_5_DRY_RUN_FAULT
```

A PASS means the code is a candidate for a **separate live-canary design/review**, not that it may trade.

## 10. Future live-canary phase — explicitly outside this contract

No code path may infer live authorization from:

```text
all tests green
CI green
all implementation gates PASS
venue adapter exists
API keys configured
operator starts process with LIVE mode
```

A separate commit-bound live-canary contract is mandatory.

Until then:

```text
LIVE_TRADING_AUTHORIZED=NO
PRODUCTION_CUTOVER_AUTHORIZED=NO
```

## 11. Dependency discipline

Phase 0 freezes baseline dev dependencies.

Later dependency additions must be minimal and reviewed. For production arithmetic, Phase 1 should use a pinned project-approved arbitrary-precision decimal library; the current architectural choice is `decimal.js` unless independently changed through the contract protocol.

Do not add exchange SDKs automatically. A Phase 4 venue audit should first decide whether an official/current SDK is safer than a small project-owned HTTP/WebSocket adapter.

## 12. Source boundary

External projects may inform architecture only within `THIRD_PARTY_BOUNDARY.md`.

Never:

- copy source/test/fixture bytes from an unlicensed repository;
- translate foreign source line-for-line and call it original;
- use another bot's observed implementation as proof of official exchange semantics.

Prefer official exchange documentation and independently designed tests.

## 13. Required handoff after every phase/checkpoint

Use `EVIDENCE_TEMPLATE.md` exactly.

At minimum report:

```text
PHASE/CHECKPOINT
REQUESTED_GATE
BASE_SHA
RESULT_SHA
FILES_CHANGED
DIFF_STAT
CONTRACT_CHANGES
COMMANDS + EXIT CODES
TEST TOTAL/PASS/FAIL/SKIP
FAULT MATRIX COVERAGE
KNOWN LIMITATIONS
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
NEXT_PHASE_STARTED=NO
```

The independent reviewer owns the gate decision.
