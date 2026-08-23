# Phase 1 Gate 1 Corrective 6

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REVIEW CANDIDATE  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Corrective base SHA:** `31cfe078c09a15d4906b56fb64731449ca1c598a`  
**Corrective base tree:** `7cbb90ebee0897132df6e0c23b27b1ae33c12e2f`  
**Parent implementation SHA:** `76e40fabe470189a2938a953178856ca0310cb3f`  
**Parent corrective:** `docs/PHASE_1_GATE_1_CORRECTIVE_5.md`

This document describes the Corrective 6 candidate. It does not declare `GATE_1=PASS`. The independent reviewer owns that verdict.

## 1. Corrective base

```text
CORRECTIVE_BASE_SHA=31cfe078c09a15d4906b56fb64731449ca1c598a
CORRECTIVE_BASE_TREE=7cbb90ebee0897132df6e0c23b27b1ae33c12e2f
AUTHORIZED_WORK=PHASE_1_GATE_1_CORRECTIVE_6_ONLY
PHASE_2_AUTHORIZED=NO
```

The authoritative parent is the final Corrective 5 docs/CI bind HEAD. This candidate does not reset to the Corrective 5 implementation commit.

## 2. Current-byte root cause

Corrective 5 made `applyExecution()` transactional and added a first-wins `executionIntegrityFault` for a closed set of integrity codes. Current bytes at the corrective base still allowed unproven orders to drive project-owned effects, imported zero-valued runtime-impossible quantities/prices, left some execution-evidence failures without a durable blocker, and accepted generator counters that cannot increment losslessly.

Concrete defects in `31cfe078c09a15d4906b56fb64731449ca1c598a`:

1. `computeExecutionEffects()` ran whenever `logicalLevelId` was non-null. An `UNOWNED` or `AMBIGUOUS` order carrying a current level id could change open inventory, terminal markers, level state, exit intents, and `workingExchangeOrderId`.
2. Snapshot import accepted `quantity="0"` / `price="0"` on executions, intents, and `originalQuantity` because it only required non-negative canonical decimals. Runtime `applyExecution()` already rejects those zeros.
3. Unknown `exchangeOrderId` threw `UNKNOWN_EXCHANGE_ORDER` without a serialized blocker, so `canIncreaseRisk()` could remain `true`. `NEGATIVE_OPEN_INVENTORY` and other effect-calculation failures preserved trading bytes but did not record a durable fault.
4. `orderSeq` / `executionSeq` were validated with `Number.isInteger` only. `Number.MAX_SAFE_INTEGER` and larger IEEE integers were importable. Runtime generators could increment into a value where `sequence + 1` is no longer a safe integer.

## 3. Proven-authority execution contract

Serialized `ownership` labels are not authoritative. Mutation of project-owned level, intent, inventory, position, or authority state requires `hasProvenAuthorityLinkage()` against the current-scope authority ledger.

```text
OWNED + proven current-scope ACK/AUTHORITATIVE_OBSERVATION linkage
  -> normal execution handling may proceed
UNOWNED
  -> no project-owned level/intent/inventory/position/authority mutation
  -> first-wins EXECUTION_AUTHORITY_UNPROVEN
AMBIGUOUS
  -> no project-owned level/intent/inventory/position/authority mutation
  -> first-wins EXECUTION_AUTHORITY_UNPROVEN
  -> risk increase remains blocked
unknown exchangeOrderId
  -> execution-history/identity reconciliation evidence
  -> first-wins EXECUTION_ORDER_MISSING
  -> canIncreaseRisk() == false
```

Effect calculation still runs on temporaries before commit so that an unowned oversized exit continues to throw `NEGATIVE_OPEN_INVENTORY` (Corrective 5 C5-17). That path now also records `EXECUTION_INVENTORY_CONFLICT` before the throw. Successful temporary calculation for an unproven order is discarded.

`EXECUTION_ID_CONFLICT` remains the Corrective 4 `executionConflict` blocker. It is not folded into `ExecutionIntegrityFault`.

## 4. Durable first-wins execution-evidence faults

`ExecutionIntegrityFault` is extended additively. Schema remains `phase1-simulator-2`.

```ts
type ExecutionIntegrityFault = {
  code:
    | "NON_POSITIVE_EXECUTION_QUANTITY"
    | "NON_POSITIVE_EXECUTION_PRICE"
    | "EXECUTION_OVERFILL"
    | "EXECUTION_ID_COLLISION"
    | "ORDER_ID_COLLISION"
    | "EXECUTION_ORDER_MISSING"
    | "EXECUTION_AUTHORITY_UNPROVEN"
    | "EXECUTION_STATE_TRANSITION_INVALID"
    | "EXECUTION_INVENTORY_CONFLICT"
    | "EXECUTION_EFFECT_CALCULATION_FAILURE"
    | "ORDER_SEQ_EXHAUSTED"
    | "EXECUTION_SEQ_EXHAUSTED";
  executionId: string | null;
  exchangeOrderId: string;
};
```

The following failures record the first fault, then throw, without changing trading collections:

```text
unknown execution order                         EXECUTION_ORDER_MISSING
unproven execution authority                    EXECUTION_AUTHORITY_UNPROVEN
invalid grid-state transition                   EXECUTION_STATE_TRANSITION_INVALID
NEGATIVE_OPEN_INVENTORY                         EXECUTION_INVENTORY_CONFLICT
other execution-effect calculation failure      EXECUTION_EFFECT_CALCULATION_FAILURE
generated order/execution sequence exhaustion   ORDER_SEQ_EXHAUSTED / EXECUTION_SEQ_EXHAUSTED
```

Required invariant after any such failure:

```text
orders, levels, position, executions, intents,
authorityLinks, unknownWrites, orderSeq, executionSeq
are byte-identical
only the explicit durable blocker may change
canIncreaseRisk() == false
export/import preserves the blocker
serialized riskIncreaseBlocked=false cannot override it
```

Old valid `phase1-simulator-2` snapshots remain importable. Missing/null `executionIntegrityFault` still imports as `null`. Unknown fault codes remain `MALFORMED_EXECUTION_INTEGRITY_FAULT`.

## 5. Snapshot positivity and safe-integer counters

Snapshot import now rejects states that runtime mutation cannot produce:

```text
execution.quantity            > 0     NON_POSITIVE_EXECUTION_QUANTITY
execution.price               > 0     NON_POSITIVE_EXECUTION_PRICE
OrderIntent.quantity          > 0     NON_POSITIVE_INTENT_QUANTITY
InternalOrder.originalQuantity > 0    NON_POSITIVE_ORIGINAL_QUANTITY
LIMIT order/intent price      > 0     NON_POSITIVE_LIMIT_PRICE
executedQuantity / remainingQuantity may be 0
null price remains allowed only for non-LIMIT types
```

Generator counters:

```text
Number.isSafeInteger(sequence) == true
sequence >= 0
sequence + 1 must also be a safe integer
otherwise ORDER_SEQ_UNSAFE / EXECUTION_SEQ_UNSAFE
```

`Number.MAX_SAFE_INTEGER` and larger values are rejected on import. Runtime `nextOrderId` / generated execution IDs detect exhaustion before any state change and record `ORDER_SEQ_EXHAUSTED` / `EXECUTION_SEQ_EXHAUSTED`. Generators do not skip collisions or hide wrap-around.

## 6. Changed files

```text
src/simulator/engine.ts
src/simulator/snapshot.ts
test/simulator/p1-corrective-6.test.ts
docs/PHASE_1_GATE_1_CORRECTIVE_6.md
```

`src/domain/types.ts`, Phase 1 contracts, Phase 2 files, runtime bootstrap, and dependencies were not modified.

## 7. Mandatory tests

```text
C6-1 proven-owned ACK-linked execution still performs the normal transition
C6-2 UNOWNED GRID_EXIT with logicalLevelId=B1 cannot mutate project-owned state
C6-3 AMBIGUOUS current-level order cannot mutate level/intent state and blocks risk
C6-4 UNKNOWN exchangeOrderId preserves collections and records a durable blocker
C6-5 NEGATIVE_OPEN_INVENTORY preserves collections and records a first-wins fault
C6-6 C6-4/C6-5 blockers survive export/import even if riskIncreaseBlocked=false
C6-7 imported execution quantity="0" is rejected
C6-8 imported execution price="0" is rejected
C6-9 imported intent quantity="0" is rejected
C6-10 imported order originalQuantity="0" is rejected
C6-11 valid terminal orders may still have executed/remaining quantity 0
C6-12 orderSeq/executionSeq greater than Number.MAX_SAFE_INTEGER are rejected
C6-13 un-incrementable sequences are rejected or exhaust before mutation
C6-14 generated IDs remain deterministic and collision-safe
C6-15 Corrective 4 replay/exposure/authority and Corrective 5 transactional semantics remain
C6-16 previous P1, C1-C13, D1-D13, C3, C4, and C5 cases remain present and green
```

C6-16 greps the prior case IDs and re-runs a proven-owned full-fill / restart / authority sample. It does not treat a name grep as sufficient evidence.

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
npm run lint                                         exit 0  (32 files)
npm run format:check                                 exit 0  (32 files)
npm test                                             exit 0  136/136 pass
npm run test:phase1                                  exit 0  129/129 pass
node --import tsx --test test/simulator/p1-corrective-6.test.ts
                                                     exit 0  16/16 pass
npm run build                                        exit 0
npm run scan:secrets                                 exit 0  63 tracked files
npm run dry-run                                      exit 0
  runtimeMode=DRY_RUN liveExchangeWrites=false phase=0
npm run check                                        exit 0
git diff --check                                     exit 0
```

Focused runner used by this repository:

```text
node --import tsx --test test/simulator/p1-corrective-6.test.ts
```

`npm run build` emits only `src/**` to `dist/`. It does not emit `dist/test/simulator/p1-corrective-6.test.js`. The accurate focused command is the `tsx` loader command above, matching `package.json` `"test"`.

## 9. Final SHA / tree

```text
CORRECTIVE_BASE_SHA=31cfe078c09a15d4906b56fb64731449ca1c598a
CORRECTIVE_BASE_TREE=7cbb90ebee0897132df6e0c23b27b1ae33c12e2f
IMPLEMENTATION_SHA=ee86a3b37225f2787cae8599d59ac2c703bae578
IMPLEMENTATION_TREE=ebbd77bb03d916dccb34ef5a95ce3b2aabcec0b9
```

The evidence commit that records these identities is the current review HEAD after this file is created.

## 10. Exact branch-push CI evidence

Independent review must bind the exact branch-push run whose `headSha` equals the final branch HEAD after this document is pushed.

```text
CI_RUN_ID=<branch-push run whose headSha equals FINAL_HEAD_SHA>
CI_HEAD_SHA=<FINAL_HEAD_SHA>
CI_CONCLUSION=<from that run>
```

## 11. Known limitations

- Phase 1 remains an in-memory deterministic simulator. There is still no durable Phase 2 risk store, runtime lease, or live venue transport.
- `ExecutionIntegrityFault` has no operator reset/acknowledgement contract yet. A recorded fault permanently blocks risk increase for that simulator instance until an explicit later reconciliation contract exists.
- `EXECUTION_ID_CONFLICT` remains the Corrective 4 blocker (`executionConflict`) and is not folded into `ExecutionIntegrityFault`.
- Unowned oversized-exit evidence still throws `NEGATIVE_OPEN_INVENTORY` so C5-17 stays unchanged. The durable serialized code for that class is `EXECUTION_INVENTORY_CONFLICT`.
- Authority is proven before commit. Temporary effect calculation may still surface inventory/transition faults for unproven evidence; those results are not committed.
- `node --test dist/test/simulator/p1-corrective-6.test.js` is not produced by the current build graph.

## 12. Phase 2 stop line

```text
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

This corrective stops after a Phase 1 review candidate is produced. Independent review decides `GATE_1`.
