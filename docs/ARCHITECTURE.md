# Target Architecture

## 1. Design objective

Create a multi-exchange perpetual-grid engine whose trading behavior can be compared across venues without allowing venue-specific API quirks to leak into strategy logic.

The design favors **state correctness, idempotency, replayability, and fail-closed recovery** over throughput.

## 2. Layers

```text
Operator / CLI / Read-only dashboard
                |
           Runtime Orchestrator
                |
   +------------+-------------+
   |                          |
Risk Engine              Grid Strategy
   |                          |
   +------------+-------------+
                |
        Execution Coordinator
                |
        Ownership / Registry
                |
         VenueAdapter contract
                |
   +------+-----+------+------+
   |      |            |      |
 Venue A Venue B     Venue C ...
```

Durable state and telemetry are cross-cutting services but must not become hidden sources of trading policy.

## 3. Core identities

Every live-capable order must have enough identity to support deterministic reconciliation:

- `experimentId`
- `runId`
- `scopeKey` (`account/venue/market/strategy`)
- `anchorEpoch`
- `logicalLevelId`
- `intentId`
- `clientOrderId`
- `exchangeOrderId` when assigned
- `executionId` for fills
- runtime lease/fencing generation

A missing identity must never silently become an owned order.

## 4. Grid level state machine

Use an independently designed explicit state machine. Suggested states:

```text
IDLE
  -> ENTRY_SUBMITTING
  -> ENTRY_WORKING
  -> POSITION_OPEN
  -> EXIT_SUBMITTING
  -> EXIT_WORKING
  -> IDLE
```

Exceptional states may include:

```text
RECONCILING
CANCEL_PENDING
REDUCE_PENDING
HALTED
ERROR_REQUIRES_RECONCILIATION
```

The exact implementation may differ, but each transition must be attributable to authoritative evidence.

### Transition rule

A local transition that depends on an exchange write is committed only after one of:

- unambiguous exchange acknowledgement; or
- fresh exchange observation proving the intended state.

An API exception, timeout, transport disconnect, or ambiguous result does not equal success.

## 5. VenueAdapter contract

A live-capable venue adapter should expose capabilities rather than pretend every exchange is identical.

Suggested contract responsibilities:

```ts
connect()
disconnect()
getMarketRules()
getSnapshot()
listOpenOrders()
listExecutionsSince(cursor)
placeOrder(intent)
cancelOrder(orderId)
cancelOwnedOrders(scope)
reducePosition(request)
flattenPosition(request)
setLeverage(target)
readLeverage()
```

Suggested capabilities:

```text
deterministicClientOrderId
executionHistory
partialFillIdentity
leverageReadback
isolatedMargin
reduceOnly
partialPositionReduction
cancelAllOwned
exchangeStopOrder
serverTimestamp
```

The runtime must refuse a canary mode that requires a capability the venue cannot prove.

## 6. Execution coordinator

Responsibilities:

- translate strategy desires into intents;
- assign deterministic identity;
- deduplicate logical orders;
- enforce write budgets;
- serialize conflicting actions;
- reconcile unknown/ambiguous outcomes;
- never infer a fill merely because an order vanished;
- keep cancel intents and risk-reducing intents distinct from risk-increasing intents.

## 7. Risk engine

Risk policy is centralized and exchange-independent where possible.

Inputs must include freshness metadata and source attribution. Required guards:

- max planned gross notional;
- max actual position notional;
- maximum margin budget;
- daily net loss including fees/funding when authoritative data exists;
- drawdown from starting equity;
- high-water-mark drawdown telemetry;
- grid-boundary adverse-inventory halt;
- stale/missing equity/position/PnL/execution data;
- runtime lease loss;
- persistent-state corruption;
- orphan/unowned order discovery;
- ambiguous execution/cancel state that could increase exposure.

## 8. Active reduction semantics

There are two separate operations:

1. `reducePosition(targetNotional / qty)` — bounded risk reduction.
2. `flattenPosition()` — close the full strategy position.

Do not overload one optional-argument method to mean both in safety-critical code unless types make the semantics impossible to confuse.

Every reduction requires a fresh position snapshot after the exchange action. A returned HTTP 200 is not sufficient proof.

## 9. Durable state

Persist at minimum:

- experiment manifest;
- runtime lease generation;
- risk halt state and unique halt ID;
- grid anchor and anchor epoch;
- logical order registry;
- reconciliation cursor/checkpoint;
- high-water equity;
- last authoritative execution cursor.

State must be written atomically. Corrupt or contradictory primary/backup state fails closed.

## 10. Telemetry

Use append-only JSONL events. Authoritative and inferred events must never share the same event type without a source/provenance distinction.

Important event classes:

- BOOT
- SNAPSHOT
- INTENT_CREATED
- ORDER_SUBMIT
- ORDER_ACK
- ORDER_REJECT
- ORDER_CANCEL_REQUEST
- ORDER_CANCEL_CONFIRMED
- EXECUTION_OBSERVED
- PARTIAL_FILL
- FILL
- RECONCILIATION
- ORPHAN_ORDER
- RISK_DECISION
- REDUCTION_REQUEST
- REDUCTION_VERIFIED
- RISK_HALT
- RESTART
- LEASE_LOST
- FATAL_ERROR

## 11. v0.1 operational surface

Dashboard is read-only in live mode. Any later control API must require authentication and must remain subordinate to persisted risk state and runtime fencing.
