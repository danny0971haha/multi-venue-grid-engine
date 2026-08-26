# Phase 1 Implementation Contract — Domain Model, Grid Strategy, and Deterministic Simulator

**Status:** AUTHORIZED AFTER INDEPENDENT GATE 0 PASS  
**Date:** 2026-08-22  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Accepted Gate 0 candidate:** `ee0c25664f14ea8ef7e68d070d46e544c3c93ee4`  
**Gate 0 CI:** `32576193857` — success, 7/7 tests  
**Parent contracts:** `docs/IMPLEMENTATION_CONTRACT.md`, `docs/DOMAIN_CONTRACTS.md`, `docs/TEST_FAULT_MATRIX.md`

## 1. Authorization

Implement **Phase 1 only**: project-owned domain model, deterministic v0.1 grid geometry/state machine, and an in-memory deterministic simulator.

```text
GATE_0=PASS
PHASE_1_AUTHORIZED=YES
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
```

Stop after Phase 1 evidence is produced. Do not begin Phase 2.

## 2. Start procedure

Run from a clean checkout:

```bash
git fetch --all --prune
git checkout experiment/v0.1-phase1
git pull --ff-only
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
node --version
npm --version
```

Read completely before editing, in this order:

```text
AGENTS.md
docs/EXPERIMENT_SPEC.md
docs/ARCHITECTURE.md
docs/DOMAIN_CONTRACTS.md
docs/VENUE_ADAPTER_CONTRACT.md
docs/RISK_PERSISTENCE_CONTRACT.md
docs/IMPLEMENTATION_CONTRACT.md
docs/TEST_FAULT_MATRIX.md
docs/ACCEPTANCE_GATES.md
docs/EVIDENCE_TEMPLATE.md
docs/REVIEW_CHANGE_PROTOCOL.md
docs/THIRD_PARTY_BOUNDARY.md
docs/PHASE_1_CONTRACT.md
```

If these documents materially conflict, do not guess. Stop with `BLOCKED_CONTRACT_CHANGE_REQUIRED` and identify the exact conflict.

The actual pulled HEAD is the Phase 1 checkpoint base and must be recorded in evidence. Do not rely on chat summaries as authority.

## 3. Global Phase 1 invariants

### 3.1 No IEEE-754 `number` as authoritative financial arithmetic

Price, quantity, notional, equity, margin, fee, funding, PnL, tick/step sizes, and percentage thresholds used for trading/risk decisions must not use JavaScript `number` as the authoritative representation.

Implement a small project-owned decimal abstraction using one exact pinned arbitrary-precision dependency. The architectural default is `decimal.js`; if another library is proposed, stop for contract review first.

Requirements:

- add the dependency at an exact version, no `^`, `~`, `*`, `latest`, floating git refs;
- serialize authoritative decimal values as canonical decimal strings;
- reject NaN, Infinity, exponential notation where canonical serialization forbids it, empty values, and locale-formatted values;
- never persist/serialize Decimal class instances directly;
- explicit rounding mode for price/quantity normalization;
- conservative risk-related rounding must never authorize more exposure.

### 3.2 Canonical identities

Implement stable project-owned identities from `DOMAIN_CONTRACTS.md`, including:

```text
ExperimentId
RunId
ScopeKey
VenueId
MarketId
AnchorEpoch
LogicalLevelId
IntentId
ClientOrderId
ExchangeOrderId
ExecutionId
HaltId
RuntimeOwnerId
LeaseGeneration
```

Canonical v0.1 scope string:

```text
<account-scope>/<venue>/<market>/<strategy>
```

Logical levels:

```text
B1 B2 B3 B4 B5
S1 S2 S3 S4 S5
```

A new `anchorEpoch` must not silently adopt prior-epoch orders.

## 4. Required domain types

Implement normalized types/semantics for at least:

```text
Side = BUY | SELL
OrderType = LIMIT | MARKET
TimeInForce = GTC | IOC | FOK | POST_ONLY
IntentPurpose = GRID_ENTRY | GRID_EXIT | RISK_REDUCTION | EMERGENCY_FLATTEN | CANCEL
Ownership = OWNED | UNOWNED | AMBIGUOUS
WriteOutcomeKind = ACK | REJECTED | UNKNOWN | NOT_SENT
```

Implement project-owned structures equivalent to the authoritative contracts for:

```text
ExperimentConfig
ObservationMeta
OrderIntent
VenueWriteResult<TAck>
ExchangeOrderObservation
ExecutionObservation
PositionSnapshot
AccountSnapshot
ReconciliationDisposition
```

Semantics are binding:

- `ACK` = venue/simulator unambiguously accepted according to the method contract;
- `REJECTED` = unambiguous non-acceptance;
- `UNKNOWN` = request may have reached the venue, so possible exposure remains reserved;
- `NOT_SENT` = local gate prevented transmission;
- exception/timeout is not automatically `REJECTED`;
- order disappearance is not fill evidence;
- local position delta does not invent an execution ID;
- missing authoritative account/position values remain `null`, never substituted with zero.

## 5. Frozen v0.1 experiment configuration

Normalized Phase 1 configuration semantics must preserve exactly:

```text
version=0.1.0
capitalCeilingUsd="100"
leverage="5"
marginBudgetUsd="30"
maxPlannedGrossNotionalUsd="150"
gridLevels=10
gridHalfBandFraction="0.03"
dailyLossLimitUsd="5"
drawdownFromStartLimitUsd="10"
boundaryBufferFraction="0.01"
```

This phase does not authorize risk-engine persistence or live trading. It only establishes deterministic domain/configuration semantics used by later phases.

## 6. Deterministic v0.1 grid geometry

For anchor `A` and half-band `0.03`, ten entry levels exclude the anchor and resolve before venue rounding to:

```text
B1 = A * (1 - 0.03 * 1/5)
B2 = A * (1 - 0.03 * 2/5)
B3 = A * (1 - 0.03 * 3/5)
B4 = A * (1 - 0.03 * 4/5)
B5 = A * (1 - 0.03 * 5/5)

S1 = A * (1 + 0.03 * 1/5)
S2 = A * (1 + 0.03 * 2/5)
S3 = A * (1 + 0.03 * 3/5)
S4 = A * (1 + 0.03 * 4/5)
S5 = A * (1 + 0.03 * 5/5)
```

For anchor `100`, exact theoretical values are:

```text
B1=99.4
B2=98.8
B3=98.2
B4=97.6
B5=97.0
S1=100.6
S2=101.2
S3=101.8
S4=102.4
S5=103.0
```

Store both theoretical and normalized venue-rule values where applicable.

Implement explicit market-rule normalization for:

```text
price tick
quantity step
minimum quantity/notional feasibility
```

A venue-rule fixture that cannot fit inside the frozen 100U/5x/30U/150U envelope must return an explicit infeasible/unsupported disposition. Never increase capital/leverage/budget to make a fixture pass.

No adaptive re-anchoring is allowed.

### Exit target

A fully filled entry creates an opposite-side exit one grid step toward anchor:

```text
B5 -> B4
B4 -> B3
B3 -> B2
B2 -> B1
B1 -> anchor

S5 -> S4
S4 -> S3
S3 -> S2
S2 -> S1
S1 -> anchor
```

## 7. Explicit grid-level state machine

Implement the state machine from `DOMAIN_CONTRACTS.md`:

```text
IDLE
ENTRY_SUBMITTING
ENTRY_WORKING
ENTRY_PARTIAL
POSITION_OPEN
EXIT_SUBMITTING
EXIT_WORKING
EXIT_PARTIAL
CANCEL_PENDING
RECONCILING
ERROR_REQUIRES_RECONCILIATION
HALTED
```

Mutation-dependent transitions may commit only from:

1. an unambiguous `ACK`; or
2. fresh authoritative simulator observation proving the target fact.

Forbidden assumptions:

```text
timeout -> order exists
exception -> order rejected
open-order disappearance -> fill
position delta -> invented execution
```

## 8. Partial-fill semantics

Persist/model at least:

```text
original quantity
cumulative executed quantity
remaining quantity
stable individual execution IDs
weighted execution price where derived/reported
exchange order ID
client order ID
logical level ID
```

Partial fills do not erase remaining working quantity.

Duplicate/replayed execution IDs must not double-count executed quantity.

## 9. Deterministic in-memory simulator

Build a network-free simulator capable of scripted scenarios for:

```text
PLACE -> ACK
PLACE -> REJECTED
PLACE -> UNKNOWN -> later discover owned order
working order
partial fill
multiple partial execution IDs
full fill
cancel request / ACK
cancel/fill race
order disappearance without execution
duplicate owned orders
foreign/unowned order
ambiguous ownership
stale snapshot
execution overlap replay
execution history gap
restart from exported simulator snapshot
```

The simulator must preserve stable identities and produce explicit observations/results matching the project-owned domain types.

Required simulator properties:

- every execution has a stable unique execution ID;
- `UNKNOWN` possible exposure remains represented after restart/export-import;
- an order disappearing without an execution never emits/creates `ExecutionObservation`;
- cancel/fill race is resolved from execution evidence;
- snapshot export/import is deterministic and contains no live class instances or secrets;
- restart does not blindly reseed working/partial/UNKNOWN logical levels;
- execution overlap is idempotent;
- execution gap marks reconciliation required.

## 10. Ownership and duplicate reconciliation

Implement deterministic classification/planning sufficient for Phase 1 tests:

```text
OWNED
UNOWNED
AMBIGUOUS
```

Rules:

- ownership must be proven from stable identity;
- clearly foreign order = `UNOWNED`;
- incomplete/unprovable identity = `AMBIGUOUS`;
- new anchor epoch cannot claim old-epoch orders;
- duplicate OWNED logical orders choose a deterministic survivor/cleanup plan;
- `UNOWNED` order is never selected for cancellation;
- `AMBIGUOUS` state blocks blind reseeding in simulator semantics.

No real cancel transport is implemented in Phase 1; this is only a deterministic reconciliation plan/type.

## 11. Conservative possible-exposure representation

Phase 1 does not implement the durable Phase 2 risk engine, but domain/simulator state must retain enough information for later conservative gross-notional calculation.

At minimum, simulator snapshots must distinguish:

```text
current signed position
owned working risk-increasing orders
UNKNOWN submissions that could exist
proposed risk-increasing intents
```

Do not net away possible exposure merely because two uncertain outcomes appear opposite.

## 12. Mandatory P1 test matrix

Implement every applicable Phase 1 case in `docs/TEST_FAULT_MATRIX.md` with stable case IDs.

### Geometry

```text
P1-G01 anchor 100 exact ten levels
P1-G02 arbitrary decimal anchor without IEEE drift
P1-G03 explicit tick rounding
P1-G04 explicit quantity-step normalization
P1-G05 min-notional infeasible without envelope expansion
```

### Level state machine

```text
P1-S01 entry ACK -> ENTRY_WORKING only after evidence
P1-S02 entry REJECTED -> no working order
P1-S03 entry UNKNOWN -> RECONCILING + possible exposure reserved
P1-S04 partial fill -> executed + remaining quantities preserved
P1-S05 multiple partial executions -> execution-ID dedupe + exact cumulative quantity
P1-S06 full entry fill -> POSITION_OPEN + adjacent exit intent
P1-S07 exit partial/full only advances from execution evidence
P1-S08 cancel ACK != fill
P1-S09 disappearance -> RECONCILING, not fill
P1-S10 position delta without execution -> no invented execution
```

### Identity / ownership

```text
P1-I01 deterministic intent identity from same durable inputs
P1-I02 distinct logical levels do not collide
P1-I03 new anchor epoch does not adopt old order
P1-I04 clearly foreign order -> UNOWNED
P1-I05 incomplete identity -> AMBIGUOUS
P1-I06 owned duplicate -> deterministic survivor/cleanup plan
P1-I07 owned + unowned duplicate price -> unowned never selected for cancel
```

### Restart / replay

```text
P1-R01 restart with working entries -> no blind reseed/duplicate intent
P1-R02 restart with partial fill -> exact partial state survives
P1-R03 restart with UNKNOWN write -> risk increase remains blocked/reconciling
P1-R04 execution overlap -> same execution not double-counted
P1-R05 execution history gap -> reconciliation required
```

Add additional tests when needed to prove canonical decimal serialization, invalid input rejection, and deterministic snapshot export/import.

## 13. Scope

Recommended/allowed Phase 1 production paths:

```text
src/domain/**
src/math/**
src/strategy/**
src/simulator/**
```

If preferred, equivalent clearly separated project-owned directories may be used and documented in evidence.

Allowed supporting changes:

```text
package.json
package-lock.json
tsconfig*.json          # only if strict Phase 1 source inclusion requires it
test/domain/**
test/math/**
test/strategy/**
test/simulator/**
```

The existing Phase 0 bootstrap shell may be imported by tests, but its `LIVE_MODE_NOT_IMPLEMENTED` behavior must not be weakened.

Do not modify contract documents to make implementation easier. If a semantic contract change is necessary, stop and request it.

## 14. Explicitly forbidden Phase 1 scope

Do not implement or introduce:

```text
src/venues/** real exchange clients
real HTTP/WebSocket exchange communication
exchange authentication/signing
production/testnet credential loading
live order/place/cancel/reduce/flatten transport
filesystem durable risk/safety store
runtime lease/fencing implementation
persistent halt acknowledgement
Phase 2 kill switch
production telemetry/manifest durability
dashboard trading controls
deployment/service files
adaptive grid re-anchoring
profitability optimization
```

Also prohibited:

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USE=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
FORCE_PUSH=NO
PHASE_2_STARTED=NO
FROZEN_ENVELOPE_CHANGE=NO
TEST_WEAKENING=NO
THIRD_PARTY_BOT_SOURCE_COPY=NO
```

## 15. Third-party boundary

Do not copy, translate line-for-line, import, cherry-pick, or adapt source/test/fixture bytes from RitMEX, Classic Grid, or another unlicensed trading bot.

Official documentation and general public behavioral descriptions may inform independently designed semantics where the contracts permit it, but no real venue protocol authority is needed for Phase 1.

## 16. Validation

Use the accepted Phase 0 toolchain:

```text
Node 22.23.2
npm 10.9.8
```

Run at minimum:

```bash
node --version
npm --version
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run scan:secrets
npm run dry-run
npm run check
git diff --check
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

Also run focused Phase 1 test files independently and report exact totals/exit codes.

The existing `npm run dry-run` must remain network-independent and continue to report Phase 0 bootstrap mode with `liveExchangeWrites=false`; Phase 1 simulator tests are separate from live/runtime authorization.

## 17. Evidence and handoff

Use bounded commits. Push only to:

```text
experiment/v0.1-phase1
```

Do not merge to `main`.

After implementation, stop and return the complete evidence packet. At minimum:

```text
PHASE=PHASE_1
REQUESTED_GATE=GATE_1
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/multi-venue-grid-engine
BRANCH=experiment/v0.1-phase1
BASE_SHA=<actual pulled Phase 1 contract/base HEAD>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

COMMITS:
<exact list>

FILES_CHANGED:
<exact list>

DIFF_STAT:
<exact output>

DEPENDENCIES:
<new exact dependency/version and reason>

TESTS:
<commands, exit codes, total/pass/fail/skip>

P1_MATRIX:
<P1 case ID | test name | result>

DOMAIN_EVIDENCE:
<decimal representation, IDs, outcome semantics, ownership, state-machine invariants>

SIMULATOR_EVIDENCE:
<UNKNOWN, partial fills, disappearance, duplicates, restart, replay/gap behavior>

ARTIFACTS:
<patch URL/path, byte size/LF/SHA-256 if produced>

SECRET_SCAN:
<result without secret values>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
THIRD_PARTY_BOT_SOURCE_COPIED=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
PHASE_2_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

UNVERIFIED_ASSUMPTIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Gate 1 PASS. Stop after handoff.