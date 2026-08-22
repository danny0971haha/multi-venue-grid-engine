# Phase 1 Gate 1 Corrective 2

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REJECTED  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Rejected candidate:** `577527a87a1ec9d48ab46653e8e0ee4fe631314b`  
**Rejected candidate tree:** `ea7c032908e514d273fd5db2d63ec4e43424772d`  
**Parent corrective:** `docs/PHASE_1_GATE_1_CORRECTIVE_1.md`

## 1. Independent decision

```text
GATE_1=REJECT
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

Corrective 1 fixes the originally reported inventory sizing, mutation-cycle identity, ambiguous fallback, and decimal canonicalization defects. Gate 1 still cannot pass because snapshot import currently lets serialized order bytes bootstrap their own ownership authority. That can convert an unproven order into `OWNED` and make it eligible for future cancellation planning.

Implement only this corrective, then stop for independent review.

## 2. Blocking findings

### MV-P1-C2-R1 — Imported `ownership="OWNED"` is circular self-attestation

Current import validation checks order IDs and quantities, but does not validate or rederive the serialized `ownership`, scope, anchor epoch, client-order identity, or exchange-order linkage.

`fromSnapshot()` then copies each order object directly into the simulator. Later, `ownershipEvidence()` seeds `knownExchangeOrderIds` from every order whose imported field says `ownership === "OWNED"`. `classifyObserved()` can therefore classify the same order as owned because the untrusted snapshot already labeled it owned.

This is circular authority:

```text
snapshot says OWNED
-> imported order enters known-owned exchange ID set
-> classifier sees known exchange ID
-> classifier returns OWNED
-> duplicate cleanup may select it for cancellation
```

Required correction:

- imported `ownership` must never bootstrap ownership evidence;
- ownership authority must derive from project-owned mutation records and verified linkage, such as a canonical intent/client-order identity plus an exchange-order association created from an ACK or authoritative observation;
- on import, rederive classification from validated identity evidence rather than trusting the serialized classification;
- if ownership cannot be proved after import, classify as `AMBIGUOUS` and block risk increase/reseed;
- positively foreign scope/epoch remains `UNOWNED`;
- `AMBIGUOUS` and `UNOWNED` orders must never become cancellation candidates;
- consider removing `ownership` from authoritative snapshot state or treating it only as a derived/display field that must exactly match recomputation.

### MV-P1-C2-R2 — Snapshot identity relationships are under-validated

Intent validation currently requires only non-empty scope and anchor strings. It does not prove that each intent matches the snapshot's experiment, run, current scope, anchor epoch, logical level, purpose, mutation sequence, deterministic intent ID, and deterministic client-order ID.

Order validation checks that an optional `intentId` exists, but does not prove that the order's scope/epoch/client ID/logical level/purpose corresponds to that intent.

Required correction:

For every imported current-scope project intent, validate at least:

```text
experimentId == snapshot.init.experimentId
runId == snapshot.init.runId
scopeKey == canonical scope from snapshot.init
anchorEpoch == snapshot.init.anchorEpoch
logicalLevelId is valid and matches the referencing level/order
purpose is valid for the reference slot
mutation sequence matches both level state and deterministic intent ID
clientOrderId equals the deterministic derivation from validated intent inputs
leaseGeneration is a canonical non-negative integer string
```

For every order linked to an intent, validate the corresponding identity, level, purpose, side, quantity, client-order ID, scope, and anchor epoch. Mismatch must fail closed or downgrade ownership to `AMBIGUOUS`; it must never create owned cancellation authority.

### MV-P1-C2-R3 — Quantity invariants are incomplete on import

Current order validation proves `executed <= original`, but does not prove:

```text
remaining == original - executed
```

Current level validation proves:

```text
openInventory == entryExecutedQuantity - exitExecutedQuantity
```

but does not fully reconcile the level's order/execution references, legacy executed/remaining fields, open inventory, and aggregate position.

Required correction:

- enforce exact canonical `original = executed + remaining` for every order where remaining is authoritative;
- reject negative, impossible, or mismatched quantities;
- execution quantities referenced by each level/order must reconcile exactly with cumulative executed fields;
- current level inventory must reconcile with validated entry and exit executions;
- signed position must reconcile with aggregate proven open inventory across BUY/SELL levels, unless the snapshot explicitly represents a reconciliation-required external position divergence;
- inconsistent state must block import rather than be silently normalized.

### MV-P1-C2-R4 — Stored risk-block state must not override derived blockers

Snapshot bytes include `riskIncreaseBlocked`. This value may be retained for audit, but import/startup authority must be recomputed conservatively from validated state.

Required correction:

After import, effective risk increase must be blocked whenever any of the following exists, regardless of the serialized boolean:

```text
UNKNOWN mutation
AMBIGUOUS ownership
RECONCILING / ERROR_REQUIRES_RECONCILIATION level
execution gap
stale snapshot
identity or quantity inconsistency
unresolved order/intent linkage
```

Do not permit a serialized `riskIncreaseBlocked=false` to override a derived blocker.

### MV-P1-C2-R5 — Exact-head CI evidence is not yet independently bound

The workflow supports branch-push CI, but the independent review did not receive a concrete exact-head run bound to rejected candidate `577527a87a1ec9d48ab46653e8e0ee4fe631314b` through the available PR-run evidence path.

This is not a substitute for the code corrections above. The next handoff must report the exact branch-push run ID, head SHA, job conclusion, and complete test totals without inventing them.

## 3. Mandatory corrective tests

Add stable case IDs covering at least:

```text
D1 snapshot order forged as ownership=OWNED with no validated linkage -> AMBIGUOUS or import rejection
D2 forged imported ownership cannot enter knownExchangeOrderIds or duplicate-cancel candidates
D3 legitimate ACK-linked owned order remains OWNED after export/import
D4 intent experiment/run/scope/anchor mismatch -> import rejected
D5 deterministic intentId/clientOrderId mismatch -> import rejected
D6 order-to-intent level/purpose/client/scope/epoch mismatch -> import rejected or AMBIGUOUS, never OWNED
D7 order remaining != original - executed -> import rejected
D8 execution totals do not match order/level cumulative quantities -> import rejected
D9 openInventory or signed position inconsistent with proven executions -> reconciliation-required/import rejection
D10 serialized riskIncreaseBlocked=false cannot override UNKNOWN/AMBIGUOUS/reconciling blockers
D11 foreign scope/epoch remains UNOWNED and is never a cancel candidate
D12 export -> import -> export remains deterministic for valid legitimate owned state
D13 all C1-C13 and every original P1-* case remain green without weakening assertions
```

Include a direct adversarial test that changes only a serialized order's `ownership` field from `AMBIGUOUS`/`UNOWNED` to `OWNED` and proves that cancellation authority does not change.

## 4. Design rule for ownership evidence

A safe Phase 1 design should separate:

```text
serialized observation/classification
from
project-owned authority linkage
```

Acceptable authority examples include:

- intent ID and deterministic client-order ID generated by this project;
- exchange-order ID linked to that intent by a simulator ACK or validated authoritative observation;
- current scope and current anchor epoch;
- preserved mutation sequence.

An order object's own serialized `ownership` label is never authority.

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

Do not modify authoritative contracts to make implementation pass. If another path is required, stop with:

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

Report exact branch-push GitHub Actions:

```text
RUN_ID=
HEAD_SHA=
STATUS=
CONCLUSION=
TEST_TOTALS=
```

## 8. Handoff

Push bounded commits only to:

```text
experiment/v0.1-phase1
```

Then stop and return:

```text
PHASE=PHASE_1_GATE_1_CORRECTIVE_2
REQUESTED_GATE=GATE_1
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/multi-venue-grid-engine
BRANCH=experiment/v0.1-phase1
BASE_SHA=<actual pulled corrective contract head>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

COMMITS:
<exact list>

FILES_CHANGED:
<exact list>

TESTS:
<commands, exit codes, totals>

OWNERSHIP_AUTHORITY_EVIDENCE:
<how imported ownership is rederived and cannot self-attest>

SNAPSHOT_IDENTITY_EVIDENCE:
<intent/order/execution/level cross-reference validation>

QUANTITY_RECONCILIATION_EVIDENCE:
<order/level/execution/position invariants>

CI_EVIDENCE:
<exact branch-push run ID and candidate SHA>

ARTIFACTS:
<patch path/URL, bytes, LF count, SHA-256>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
PHASE_2_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Gate 1 PASS. Stop after handoff.