# Phase 1 Gate 1 Corrective 4

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REVIEW CANDIDATE  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Corrective base SHA:** `46f5d9b03229717afa5d565d5aaf344cbdcb966d`  
**Parent corrective:** `docs/PHASE_1_GATE_1_CORRECTIVE_3.md`

This document describes the Corrective 4 candidate. It does not declare `GATE_1=PASS`. The independent reviewer owns that verdict.

## 1. Corrective base

```text
CORRECTIVE_BASE_SHA=46f5d9b03229717afa5d565d5aaf344cbdcb966d
AUTHORIZED_WORK=PHASE_1_GATE_1_CORRECTIVE_4_ONLY
PHASE_2_AUTHORIZED=NO
```

## 2. Root cause

Corrective 3 preserved proven-authority ownership. Two remaining defects still understated exposure and accepted conflicting fill evidence:

1. `possibleExposure()` reserved owned working risk-increasing quantity from level state. One logical level can have multiple proven-owned working `GRID_ENTRY` orders. A B1 primary remaining `0.01` plus a B1 owned duplicate remaining `0.01` was represented as one B1 row of `0.01`.
2. `applyExecution()` returned the previously stored execution whenever `executionId` already existed, without comparing the incoming exchange order ID, canonical quantity, or canonical price. A conflicting replay was silently accepted.

## 3. Possible-exposure contract

`ownedWorkingRiskIncreasing` is derived from current orders, not from level remaining quantity.

Include every order that satisfies all of:

```text
presentInOpenBook === true
classifyObserved(order) === "OWNED"
purpose === "GRID_ENTRY"
reduceOnly === false
remainingQuantity > 0
status === "WORKING" | "PARTIALLY_FILLED"
```

Each included order is an independent row:

```ts
type OwnedWorkingRiskIncreasing = {
  exchangeOrderId: ExchangeOrderId;
  logicalLevelId: GridLogicalLevelId | null;
  side: "BUY" | "SELL";
  price: DecimalString | null;
  quantity: DecimalString;
};
```

`quantity` is that order's exact `remainingQuantity`. Rows are not netted or deduplicated by logical level, side, or price. Export/import recomputes the same rows from persisted orders.

Excluded:

```text
CANCELLED
FILLED with zero remaining
disappeared / not present in the open book
UNOWNED
AMBIGUOUS
proven reduce-only GRID_EXIT
```

`AMBIGUOUS` current-scope orders continue to block `canIncreaseRisk()`. They are not relabeled `UNOWNED` to omit them from owned exposure.

## 4. Execution-replay contract

Incoming price and quantity are parsed canonically before comparison.

### Exact canonical replay

Same `executionId`, `exchangeOrderId`, canonical quantity, and canonical price:

- return the existing `ExecutionObservation`;
- do not change order, level, or position quantities;
- do not append another execution ID;
- do not set a reconciliation blocker.

### Conflicting replay

Same `executionId` with any different `exchangeOrderId`, canonical quantity, or canonical price:

- throw `EXECUTION_ID_CONFLICT`;
- do not overwrite the original execution;
- do not mutate order, level, or position quantities;
- set durable `executionConflict=true`;
- `canIncreaseRisk()` becomes false;
- the blocker survives export/import even if serialized `riskIncreaseBlocked=false`.

The original stored execution remains the recorded evidence. The conflicting payload is not selected as authoritative for further risk increase. Comparison is field-wise and independent of object insertion order.

## 5. Snapshot schema / migration decision

```text
schemaVersion: phase1-simulator-2
```

No schema bump. Corrective 3 authority semantics and `authorityLinks` remain required and unchanged.

New exported boolean: `executionConflict`. A missing field imports as `false`. A non-boolean value is rejected. Serialized `riskIncreaseBlocked=false` cannot override a derived execution-conflict blocker.

## 6. Test matrix

```text
C4-1 two proven-owned working GRID_ENTRY orders on one level are two exposure rows
C4-2 reserved quantity includes both duplicate owned working orders
C4-3 partially filled owned order reserves exact remainingQuantity
C4-4 CANCELLED, fully FILLED and disappeared orders are absent
C4-5 UNOWNED and AMBIGUOUS are omitted from owned exposure; AMBIGUOUS still blocks risk
C4-6 export/import preserves every duplicate exposure row and exchangeOrderId
C4-7 same execution ID + exact same canonical payload is idempotent
C4-8 same execution ID + different quantity produces EXECUTION_ID_CONFLICT
C4-9 same execution ID + different price produces EXECUTION_ID_CONFLICT
C4-10 same execution ID + different exchangeOrderId produces EXECUTION_ID_CONFLICT
C4-11 conflict mutates only the explicit reconciliation blocker
C4-12 export/import preserves execution conflict as a risk blocker
C4-13 reduce-only GRID_EXIT is excluded from owned working risk-increasing exposure
C4-authority-ledger is not modified or weakened by corrective 4
```

Existing `P1-*`, `C1-C13`, `D1-D13`, and `C3-*` cases remain required.

## 7. Stop before Phase 2

```text
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

This corrective stops after a Phase 1 review candidate is produced. Independent review decides `GATE_1`.
