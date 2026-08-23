# Phase 1 Gate 1 Corrective 5

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REVIEW CANDIDATE  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Corrective base SHA:** `bee50ec5e9b5b66b358b3a05f5124fee1988b00c`  
**Parent corrective:** `docs/PHASE_1_GATE_1_CORRECTIVE_4.md`

This document describes the Corrective 5 candidate. It does not declare `GATE_1=PASS`. The independent reviewer owns that verdict.

## 1. Corrective base

```text
CORRECTIVE_BASE_SHA=bee50ec5e9b5b66b358b3a05f5124fee1988b00c
AUTHORIZED_WORK=PHASE_1_GATE_1_CORRECTIVE_5_ONLY
PHASE_2_AUTHORIZED=NO
```

## 2. Current-byte root cause

Corrective 4 preserved duplicate owned exposure rows and rejected conflicting execution replay. Current bytes at the corrective base still mutated trading state before `applyExecution()` finished validating, and generated identity allocation could overwrite an existing map entry.

Concrete defects in `bee50ec5e9b5b66b358b3a05f5124fee1988b00c`:

1. `applyExecution()` wrote `executions` and `order.executedQuantity` before residual, positivity, inventory, and state-transition checks completed. A later `NEGATIVE_REMAINING_QUANTITY` or `NEGATIVE_OPEN_INVENTORY` throw left a half-committed execution, order, and sometimes level.
2. `quantity <= 0` and `price <= 0` were accepted as ordinary caller input. Zero quantity appended a no-op execution. Negative quantity could mutate inventory and then fail closed only after those writes.
3. Residual capacity was not checked as `originalQuantity - executedQuantity` before mutation. Cancel/fill races that serialized `remainingQuantity=0` still depended on a post-write `remainingAfter()` throw.
4. `nextOrderId()` / `nextExecutionId()` incremented a counter and returned `sim-ord-####` / `sim-exec-####` without checking the destination map. `Map.set()` then overwrote any existing order or execution with that stable ID.
5. Explicit `sim-exec-0001` did not advance `executionSeq`, so the next generated execution reused and overwrote `sim-exec-0001`.
6. Snapshot import trusted `orderSeq` / `executionSeq` without cross-checking project-generated identity sets. A stale counter was accepted and the collision was deferred to the next mutation.
7. After an invalid execution throw, `canIncreaseRisk()` could remain `true`. There was no durable, serializable execution-integrity fault.

## 3. Transactional mutation contract

`applyExecution()` now finishes every validation and next-state calculation before any map, order, level, position, intent, or authority write.

Order of work:

1. Canonical-parse quantity and price.
2. Reject `quantity <= 0` with `NON_POSITIVE_EXECUTION_QUANTITY`.
3. Reject `price <= 0` with `NON_POSITIVE_EXECUTION_PRICE`.
4. Exact canonical replay of an existing execution ID returns the stored evidence with no mutation.
5. Conflicting replay of an existing execution ID still throws `EXECUTION_ID_CONFLICT`, sets `executionConflict=true`, and does not overwrite the original evidence.
6. Resolve the new execution ID. Generated IDs are checked against the execution map before any write. Explicit IDs in the `sim-exec-` namespace advance `executionSeq` only on successful commit.
7. Compute `residual = originalQuantity - executedQuantity`. New quantity must not exceed residual. Cancelled orders with serialized `remainingQuantity=0` still accept delayed evidence up to that residual and reject anything larger as `EXECUTION_OVERFILL`.
8. Precompute next order quantities/status, next level quantities/state/execution IDs/weighted price, next position, optional new exit intent, and every state/inventory transition on clones/temporaries.
9. Commit those computed values in one step only after every check succeeds.

Any exception or transition failure leaves the original execution map, order bytes, level bytes, position bytes, intent bytes, and authority bytes unchanged. The only permitted extra change is an explicit integrity/reconciliation blocker field.

```ts
type ExecutionIntegrityFault = {
  code:
    | "NON_POSITIVE_EXECUTION_QUANTITY"
    | "NON_POSITIVE_EXECUTION_PRICE"
    | "EXECUTION_OVERFILL"
    | "EXECUTION_ID_COLLISION"
    | "ORDER_ID_COLLISION";
  executionId: string | null;
  exchangeOrderId: string;
};
```

First recorded fault is retained. Later faults do not silently replace it. `canIncreaseRisk()` is false while a fault exists. Export/import preserves the fault. A serialized `riskIncreaseBlocked=false` cannot override it. Malformed serialized faults are rejected with `MALFORMED_EXECUTION_INTEGRITY_FAULT`.

## 4. ID / counter collision contract

Project-generated identities:

```text
sim-ord-####
sim-exec-####
```

All insertion boundaries go through collision-checked helpers:

```text
submit ACK order creation
discoverOwnedOrder
injectOwnedDuplicate
injectForeignOrder
injectAmbiguousOrder
applyExecution
snapshot import
```

Rules:

- No path may `Map.set()` over an existing stable ID.
- Exact execution replay uses the Corrective 4 replay contract.
- Same stable ID plus conflicting payload does not overwrite; it sets a reconciliation/integrity blocker and throws a stable code.
- A foreign or ambiguous observation that reuses an owned `exchangeOrderId` does not replace owned order bytes or authority linkage. It fails closed with `ORDER_ID_COLLISION`.
- Runtime generators compute the candidate ID, check the map, and fail closed on collision. They do not skip-and-hide and they do not overwrite.
- Explicit execution IDs in the reserved `sim-exec-` namespace are accepted, then the counter is advanced to that sequence on commit. The next generated ID cannot reuse the explicit ID.

Snapshot import parses every `sim-ord-<n>` and `sim-exec-<n>`. `orderSeq` and `executionSeq` must not be behind the maximum existing project-generated sequence. Behind/collision snapshots are rejected immediately with:

```text
ORDER_SEQ_BEHIND_IDENTITIES
EXECUTION_SEQ_BEHIND_IDENTITIES
```

## 5. Snapshot schema / migration decision

```text
schemaVersion: phase1-simulator-2
```

No schema bump. Corrective 3 `authorityLinks` and Corrective 4 `executionConflict` remain required and unchanged.

New exported field: `executionIntegrityFault`.

- Missing or `null` imports as `null`.
- A well-formed object with a known code, `executionId: string | null`, and non-empty `exchangeOrderId` is accepted.
- Any other value is rejected with `MALFORMED_EXECUTION_INTEGRITY_FAULT`.
- The field is always exported as `null` or the recorded fault so export -> import -> export stays deterministic.

This is the same additive-optional pattern Corrective 4 used for `executionConflict`. Existing `phase1-simulator-2` snapshots without the field remain importable.

## 6. Changed files

```text
src/simulator/engine.ts
src/simulator/snapshot.ts
test/simulator/p1-corrective-5.test.ts
docs/PHASE_1_GATE_1_CORRECTIVE_5.md
```

`src/domain/types.ts` was not required and was not modified.

## 7. Mandatory tests

```text
C5-1 negative execution quantity rejected before trading-state mutation
C5-2 zero execution quantity rejected before mutation
C5-3 zero/negative execution price rejected before mutation
C5-4 execution quantity greater than residual rejected
C5-5 overfill failure preserves order/level/position/execution/authority bytes
C5-6 invalid execution sets durable risk blocker
C5-7 blocker survives export/import even when serialized riskIncreaseBlocked=false
C5-8 explicit sim-exec-0001 followed by generated execution cannot overwrite
C5-9 stale snapshot executionSeq behind existing generated IDs is rejected
C5-10 stale snapshot orderSeq behind existing generated IDs is rejected
C5-11 generated order candidate collision cannot overwrite existing foreign/owned order
C5-12 foreign observation using an existing owned exchangeOrderId cannot replace owned bytes or authority
C5-13 exact canonical execution replay remains idempotent
C5-14 conflicting execution replay still preserves original evidence
C5-15 duplicate owned exposure rows remain exact after export/import
C5-16 cancel/fill delayed execution may not exceed original-minus-executed residual
C5-17 invalid state transition leaves all trading collections byte-identical
C5-18 all previous P1, C1, D1, C3 and C4 cases remain present and green
```

Byte-preservation comparisons include:

```text
orders
levels
position
executions
authorityLinks
intents
unknownWrites
orderSeq
executionSeq
```

Existing `P1-*`, `C1-C13`, `D1-D13`, `C3-*`, and `C4-*` cases remain required and were not weakened.

## 8. Actual local results

Local toolchain at implementation time:

```text
NODE_VERSION=v26.5.0
NPM_VERSION=11.17.0
REQUIRED_NODE=22.23.2
REQUIRED_NPM=10.9.8
```

`npm ci` required `--engine-strict=false` locally because the workstation Node/npm pair does not match the frozen Phase 0 engines. GitHub Actions CI remains the exact-engine authority.

Commands and results:

```text
npm ci --engine-strict=false                         exit 0
npm run typecheck                                    exit 0
npm run lint                                         exit 0  (31 files)
npm run format:check                                 exit 0  (31 files)
npm test                                             exit 0  120/120 pass
npm run test:phase1                                  exit 0  113/113 pass
node --import tsx --test test/simulator/p1-corrective-5.test.ts
                                                     exit 0  18/18 pass
node --test dist/test/simulator/p1-corrective-5.test.js
                                                     exit 1  file not emitted
npm run build                                        exit 0
npm run scan:secrets                                 exit 0  61 tracked files
npm run dry-run                                      exit 0
  runtimeMode=DRY_RUN liveExchangeWrites=false phase=0
git diff --check                                     exit 0
```

Focused runner used by this repository:

```text
node --import tsx --test test/simulator/p1-corrective-5.test.ts
```

`npm run build` emits only `src/**` to `dist/`. It does not emit `dist/test/simulator/p1-corrective-5.test.js`. The contract command `node --test dist/test/simulator/p1-corrective-5.test.js` is therefore not a valid Phase 1 test path. The accurate focused command is the `tsx` loader command above, matching `package.json` `"test"`.

## 9. Final SHA / tree

```text
BASE_SHA=bee50ec5e9b5b66b358b3a05f5124fee1988b00c
IMPLEMENTATION_SHA=76e40fabe470189a2938a953178856ca0310cb3f
IMPLEMENTATION_TREE_SHA=abe63b7e2d2dfb6a65f7070cc70da586037b3902
HEAD_SHA=<filled after docs commit>
TREE_SHA=<filled after docs commit>
```

## 10. Exact branch-push CI evidence

```text
RUN_ID=<filled after branch-push>
RUN_URL=<filled after branch-push>
HEAD_SHA=<must equal final HEAD>
CONCLUSION=<success|failure>
```

## 11. Known limitations

- Phase 1 remains an in-memory deterministic simulator. There is still no durable Phase 2 risk store, runtime lease, or live venue transport.
- `ExecutionIntegrityFault` has no operator reset/acknowledgement contract yet. A recorded fault permanently blocks risk increase for that simulator instance until an explicit later reconciliation contract exists.
- `EXECUTION_ID_CONFLICT` remains the Corrective 4 blocker (`executionConflict`) and is not folded into `ExecutionIntegrityFault`.
- Invalid inventory/state transitions such as `NEGATIVE_OPEN_INVENTORY` fail closed without a partial write. They are not given a new fault code outside the closed Corrective 5 set.
- Explicit order IDs in the `sim-ord-` namespace are not auto-advanced on `injectForeignOrder` / `injectAmbiguousOrder`. The generator fails closed on collision instead of skip-and-hiding. Snapshot import still rejects a counter that is behind those identities.
- `node --test dist/test/simulator/p1-corrective-5.test.js` is not produced by the current build graph.

## 12. Phase 2 stop line

```text
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

This corrective stops after a Phase 1 review candidate is produced. Independent review decides `GATE_1`.
