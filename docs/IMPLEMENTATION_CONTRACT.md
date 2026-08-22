# Implementation Contract

## Binding scope

Implement an independent multi-venue grid engine from scratch. Do not copy third-party bot source code.

The implementation agent may consult official exchange documentation and public behavioral descriptions, but source bytes from unlicensed reference repositories are out of scope.

## Phase 0 — Repository and toolchain baseline

Deliver:

- TypeScript project scaffold;
- pinned Node/Bun choice and versions;
- deterministic package lock;
- formatter/linter/typecheck/test commands;
- CI workflow;
- secret-scan baseline;
- dry-run default.

No exchange write code is required in Phase 0.

### Gate 0

Must prove clean install + typecheck + tests on CI.

## Phase 1 — Domain model and simulator

Build:

- venue-neutral market/order/execution types;
- explicit grid-level state machine;
- client/intention identity scheme;
- deterministic grid geometry from percentage band;
- simulator/in-memory venue;
- partial-fill simulation;
- cancel/timeout/ambiguous-write simulation;
- duplicate and orphan order simulation.

Do not add a real exchange adapter yet.

### Required tests

- seed 10 levels under ±3%;
- entry -> partial fill -> remaining -> full fill;
- fill -> adjacent exit intent;
- cancel is not fill;
- disappeared order becomes reconciliation-required, not authoritative FILL;
- duplicate logical level deterministically reconciles;
- restart from simulator snapshot does not duplicate exposure.

## Phase 2 — Durable safety core

Build:

- runtime lease/fencing;
- checksummed durable state with atomic writes;
- persisted halt state + unique halt acknowledgement;
- experiment manifest;
- append-only telemetry;
- stale-data guard;
- planned/actual notional guard;
- daily loss and drawdown guards;
- boundary guard;
- kill-switch state machine;
- active reduction abstraction separate from full flatten.

### Required fault injection

- process dies during state write;
- corrupt primary state;
- missing primary with backup present;
- conflicting generation/hash;
- lease loss;
- reduction returns ambiguous result;
- snapshot stale during halt;
- telemetry write failure must not authorize trading.

## Phase 3 — Execution coordinator

Build:

- idempotent intent registry;
- bounded writes per cycle;
- conservative worst-case gross notional calculation;
- deterministic duplicate-order cleanup;
- orphan/unowned-order classification;
- ambiguous API outcome reconciliation;
- execution-cursor replay.

### Gate

All safety behavior must remain testable with the simulator. Exchange adapters must not be required to exercise core risk semantics.

## Phase 4 — First real venue adapter

Select **one** venue only after a read-only capability audit.

Audit must document:

- official API docs source/date;
- authentication requirements;
- deterministic client order ID support;
- open-order query semantics;
- execution/fill history semantics;
- partial fills;
- leverage set/readback;
- isolated margin support;
- reduce-only behavior;
- partial position reduction;
- timestamp/freshness semantics;
- rate limits;
- minimum notional/quantity;
- cancel confirmation semantics.

If authoritative fill provenance cannot be established, the venue is not live-canary eligible.

Implement read-only adapter first, then dry-run write planning. No live writes in this contract.

## Phase 5 — Second venue adapter

Only after Phase 4 independent review passes.

Purpose: prove the abstraction does not accidentally encode the first venue's behavior.

## Explicitly prohibited in initial implementation

- live order submission;
- production API keys;
- withdrawal-enabled credentials;
- automatic hard-halt restart;
- adaptive grid shift;
- dashboard trading controls;
- copy/paste from RitMEX or other unlicensed bots;
- catch-and-continue after fatal uncaught exceptions;
- reducing tests or risk thresholds to get CI green.

## Change control

Changing any of these requires a spec version bump:

- capital;
- leverage;
- margin budget;
- gross-notional cap;
- grid level count;
- grid band;
- daily loss;
- hard drawdown;
- boundary buffer;
- hard-halt resume semantics.
