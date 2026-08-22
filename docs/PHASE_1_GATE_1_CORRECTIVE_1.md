# Phase 1 Gate 1 Corrective 1

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REJECTED  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Rejected candidate:** `dea7a0e7bf450614cad72c208290c4408fe901b9`  
**Rejected candidate tree:** `1f24b594b458273aa951c9bb5805af55990d8f6e`  
**Accepted Phase 0 baseline:** `ee0c25664f14ea8ef7e68d070d46e544c3c93ee4`

## 1. Independent decision

```text
GATE_1=REJECT
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

The candidate implements most Phase 1 structures and the mandatory P1 matrix, but current bytes still contain quantity/identity semantics that can create incorrect future mutations or misclassify unresolved ownership.

Implement only this corrective, then stop for independent review.

## 2. Blocking findings

### MV-P1-R1 — Partial entry fill followed by cancel creates an oversized exit intent

Current behavior:

```text
entry original quantity = 0.01
execution quantity = 0.004
cancel remaining = ACK
level -> POSITION_OPEN
ensureExitIntent(level)
exit quantity = level.originalQuantity = 0.01
```

The actual open inventory attributable to the level is `0.004`, but the generated exit intent requests `0.01`.

This violates the partial-fill contract and can over-close/reverse inventory in a future adapter path.

Required correction:

- model level inventory explicitly as cumulative entry execution minus cumulative exit execution;
- after partial entry fill plus confirmed cancellation of remaining entry quantity, create an exit only for the proven open inventory;
- never use original entry order quantity as a substitute for currently open inventory;
- preserve canonical decimal arithmetic;
- apply symmetrically to BUY and SELL entries;
- add tests that inspect the exact generated exit intent quantity, not merely that an exit intent exists.

### MV-P1-R2 — Partial exit cancellation does not create a correctly sized next exit mutation

After an exit partially fills and the remainder is cancelled, the level returns to `POSITION_OPEN`, but the existing `exitIntentId` and original exit quantity remain. A later submission can reuse the old mutation identity/quantity instead of representing only the remaining open inventory.

Required correction:

- after partial exit execution, track exact remaining level inventory;
- confirmed cancellation of the unfilled exit remainder must leave `POSITION_OPEN` with that exact residual inventory;
- a later exit attempt must use a **new deterministic intent identity** and quantity equal to the residual inventory;
- an ambiguous retry of the same unresolved mutation must preserve the same identity;
- a new mutation after the prior mutation is definitively terminal must not reuse the old `intentId`.

### MV-P1-R3 — New grid cycles reuse a previous mutation identity

`planEntries()` currently returns historical entry intents once `entriesPlanned=true`. After a completed entry/exit cycle returns a level to `IDLE`, a new cycle can reuse the original entry `intentId` and client identity.

An `intentId` identifies one intended exchange mutation. A later cycle is a different mutation.

Required correction:

- distinguish retry/reconciliation of one unresolved intent from a new terminally-separated mutation;
- maintain a deterministic per-level/per-purpose mutation sequence or equivalent cycle identity;
- same durable inputs plus same mutation sequence produce the same identity;
- a later cycle increments/changes the sequence and produces a different identity;
- export/import must preserve the sequence so restart does not create either duplicate or reused identities;
- deterministic client-order IDs must derive from the corrected intent identity.

### MV-P1-R4 — Unprovable identity can be classified `UNOWNED` instead of `AMBIGUOUS`

Current classification falls through to `UNOWNED` when an observed order has:

```text
current/matching scope
current/matching anchor epoch
unknown non-null clientOrderId
unknown exchangeOrderId
```

That order is not clearly foreign, and ownership is not proven. The authoritative contract requires `AMBIGUOUS`.

Required correction:

- `UNOWNED` only when foreign identity is positively established;
- incomplete or unprovable identity with no positive foreign proof -> `AMBIGUOUS`;
- `AMBIGUOUS` must block blind reseeding;
- duplicate cleanup must never select `AMBIGUOUS` or `UNOWNED` orders for cancellation.

### MV-P1-R5 — Authoritative decimal serialization is not single-canonical

`parseDecimalString("97.0")` normalizes to `"97"`, while `toTenthString()` can produce `"97.0"` as an authoritative grid price. The same decimal value can therefore have more than one serialized form in snapshots/identities.

Required correction:

- choose one canonical authoritative decimal-string representation;
- keep presentation formatting separate from authoritative serialized values;
- grid theoretical/normalized prices, intents, orders, executions, and snapshots must use canonical values;
- JSON export -> import -> export must preserve canonical financial bytes;
- no live `Decimal` instances may appear in exported state.

The contract examples `97.0` / `103.0` describe exact mathematical values; they do not authorize two different canonical serialized forms for the same value.

## 3. Mandatory corrective tests

Add stable case IDs covering at least:

```text
C1  partial BUY entry 0.004/0.01 + cancel remainder -> exit quantity exactly 0.004
C2  partial SELL entry 0.004/0.01 + cancel remainder -> exit quantity exactly 0.004
C3  multiple partial entry executions + cancel -> exit quantity equals exact cumulative executed quantity
C4  partial exit execution + cancel remainder -> residual level inventory is exact
C5  next exit after C4 has a new intentId and quantity equal to residual inventory
C6  UNKNOWN/retry of one unresolved mutation preserves the same intentId
C7  completed entry/exit cycle -> next entry uses a new deterministic intentId/clientOrderId
C8  restart/export-import preserves mutation sequence and does not reuse/duplicate identity
C9  matching scope/epoch + unknown client/exchange identity -> AMBIGUOUS
C10 AMBIGUOUS order blocks risk increase/reseed and is never a cancel candidate
C11 authoritative decimal export has one canonical representation
C12 export -> import -> export preserves canonical financial bytes and schema version
C13 malformed/non-canonical snapshot decimal is rejected or returns explicit reconciliation-required disposition
```

Retain and rerun every existing `P1-*` case. Do not weaken or delete tests.

## 4. Snapshot/import rule

Phase 1 snapshot import is not permitted to trust arbitrary object bytes silently.

At minimum validate before accepting restart state:

```text
schemaVersion
frozen experiment configuration
scope / anchor epoch identity
canonical decimal strings
non-negative executed/remaining quantities
executed <= original where applicable
stable intent/order/execution references
unique execution IDs
mutation sequence/cycle identity
```

Invalid or internally inconsistent state must fail closed with an explicit error/disposition. It must not be normalized into a seemingly valid risk-increasing state.

## 5. Scope

Allowed production paths remain bounded to Phase 1:

```text
src/domain/**
src/math/**
src/strategy/**
src/simulator/**
```

Allowed supporting paths:

```text
package.json                 # test registration only if needed
package-lock.json            # only if package.json legitimately changes
test/domain/**
test/math/**
test/strategy/**
test/simulator/**
```

Do not modify authoritative contracts to make implementation pass. This reviewer corrective document may remain unchanged.

If another production path is required, stop with:

```text
BLOCKED_SCOPE_CHANGE_REQUIRED
```

## 6. Prohibited actions

```text
PHASE_2_STARTED=NO
REAL_VENUE_ADAPTER=NO
HTTP_OR_WEBSOCKET_EXCHANGE_CALL=NO
EXCHANGE_AUTH_OR_SIGNING=NO
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USE=NO
FILESYSTEM_DURABLE_RISK_STORE=NO
RUNTIME_LEASE_IMPLEMENTATION=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
FORCE_PUSH=NO
FROZEN_ENVELOPE_CHANGE=NO
TEST_WEAKENING=NO
THIRD_PARTY_BOT_SOURCE_COPY=NO
```

## 7. Validation

Use:

```text
Node 22.23.2
npm 10.9.8
```

Run and report exact exit codes/totals:

```bash
node --version
npm --version
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:phase1
npm run build
npm run scan:secrets
npm run dry-run
npm run check
git diff --check
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

The Phase 0 dry-run must remain network-independent and report:

```text
runtimeMode=DRY_RUN
liveExchangeWrites=false
```

Provide the exact branch-push GitHub Actions run ID and candidate SHA. PR #2 is a stacked PR against `experiment/v0.1-phase0`; the current workflow may not create a pull-request-triggered run for that base, so branch-push CI evidence must be identified explicitly rather than invented.

## 8. Handoff

Push bounded commits only to:

```text
experiment/v0.1-phase1
```

Then stop and return:

```text
PHASE=PHASE_1_CORRECTIVE_1
REQUESTED_GATE=GATE_1
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/multi-venue-grid-engine
BRANCH=experiment/v0.1-phase1
BASE_SHA=<actual pulled reviewer-contract head>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

COMMITS:
<exact list>

FILES_CHANGED:
<exact list>

DIFF_STAT:
<exact output>

TESTS:
<commands, exit codes, totals>

CORRECTIVE_MATRIX:
<C1-C13 | test | result>

QUANTITY_EVIDENCE:
<entry executed qty, open level inventory, exit qty, residual qty>

IDENTITY_EVIDENCE:
<retry identity vs new mutation identity, cycle sequence, restart preservation>

OWNERSHIP_EVIDENCE:
<OWNED/UNOWNED/AMBIGUOUS adversarial cases and cleanup candidates>

CANONICAL_SERIALIZATION_EVIDENCE:
<single representation and export/import validation>

CI_EVIDENCE:
<RUN_ID | HEAD_SHA | status | conclusion>

ARTIFACTS:
<patch URL/path, bytes, LF count, SHA-256>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
THIRD_PARTY_BOT_SOURCE_COPIED=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
PHASE_2_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Gate 1 PASS. Stop after handoff.