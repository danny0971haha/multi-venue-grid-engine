# Phase 1 Gate 1 Corrective 7

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REVIEW CANDIDATE  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Corrective base SHA:** `5a58f3aa4585137e809decd19d4dc4be83045ead`  
**Corrective base tree:** `39a9edf58146d45e2c0848cd219cc239447a526d`  
**Parent corrective:** `docs/PHASE_1_GATE_1_CORRECTIVE_6.md`

This document describes the Corrective 7 candidate. It does not declare `GATE_1=PASS`. The independent reviewer owns that verdict.

## 1. Corrective base

```text
CORRECTIVE_BASE_SHA=5a58f3aa4585137e809decd19d4dc4be83045ead
CORRECTIVE_BASE_TREE=39a9edf58146d45e2c0848cd219cc239447a526d
AUTHORIZED_WORK=PHASE_1_GATE_1_CORRECTIVE_7_ONLY
PHASE_2_AUTHORIZED=NO
```

The authoritative parent is the final Corrective 6 review HEAD. This candidate does not reset, rebase, or force-push.

## 2. Current-byte root cause

Corrective 6 made snapshot import reject counters that cannot increment losslessly:

```text
Number.isSafeInteger(sequence)
sequence >= 0
Number.isSafeInteger(sequence + 1)
```

That importer rule rejects `Number.MAX_SAFE_INTEGER` because `MAX_SAFE_INTEGER + 1` is not a safe integer. Runtime generation still treated the current counter as incrementable when `current + 1` was itself a safe integer. Therefore:

```text
current = Number.MAX_SAFE_INTEGER - 1
generate one ID
committed sequence = Number.MAX_SAFE_INTEGER
```

The resulting snapshot could be exported and could not be re-imported by the same importer. C6-13 encoded that broken boundary as expected behavior. Explicit generated-prefix execution IDs `sim-exec-<N>` could also advance `executionSeq` to `MAX_SAFE_INTEGER` without using the importer rule.

## 3. Binding invariant

```text
EVERY_SUCCESSFULLY_EXPORTED_RUNTIME_SNAPSHOT
MUST_BE_ACCEPTED_BY_CURRENT_IMPORTER
AND_RESTORE_A_DETERMINISTICALLY_EQUIVALENT_STATE
```

Stored/imported counters and committed generated sequences share one helper:

```ts
export function isImportableSequenceCounter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isSafeInteger(value + 1)
  );
}
```

Call sites:

```text
src/simulator/snapshot.ts  isImportableSequenceCounter           definition
src/simulator/snapshot.ts  assertSafeIncrementableInteger       import of orderSeq/executionSeq
src/simulator/engine.ts    assertCommittedSequenceImportable    committed generated sequence
src/simulator/engine.ts    assertSequenceIncrementable          next auto-generated order/execution seq
src/simulator/engine.ts    applyExecution explicit sim-exec-*   generated-prefix execution IDs
src/simulator/engine.ts    peekGeneratedOrderId / nextOrderId   ACK submit and owned-order discovery
```

The importer is not relaxed. `Number.MAX_SAFE_INTEGER` remains `ORDER_SEQ_UNSAFE` / `EXECUTION_SEQ_UNSAFE`. Counters are not clamped on export. Generators do not skip IDs.

## 4. Generated order boundary

```text
current = MAX_SAFE_INTEGER - 2
next successful generation
stored = MAX_SAFE_INTEGER - 1
export -> import -> export succeeds
```

```text
current = MAX_SAFE_INTEGER - 1
next generation
code = ORDER_SEQ_EXHAUSTED
orderSeq remains MAX_SAFE_INTEGER - 1
orders/levels/intents/authorityLinks unchanged
canIncreaseRisk() == false
exported blocker state remains importable
```

`peekGeneratedOrderId()` / `nextOrderId()` check the committed sequence before any trading collection mutation. ACK `submit()` peeks before `setState`.

## 5. Generated execution boundary

Auto-generated execution IDs use the same helper:

```text
current = MAX_SAFE_INTEGER - 2
next successful auto generation
stored = MAX_SAFE_INTEGER - 1
roundtrip succeeds
```

```text
current = MAX_SAFE_INTEGER - 1
next auto generation
code = EXECUTION_SEQ_EXHAUSTED
executionSeq unchanged
orders/levels/position/executions/intents/authorityLinks unchanged
first-wins durable fault preserved
export/import succeeds
```

## 6. Explicit generated-prefix execution IDs

Paths that parse `sim-exec-<N>` and may advance `executionSeq` use the same helper before commit:

```text
sim-exec-(MAX_SAFE_INTEGER - 1)
  -> may commit when other conditions are valid
  -> executionSeq becomes MAX_SAFE_INTEGER - 1
  -> export/import/export succeeds

sim-exec-MAX_SAFE_INTEGER
  -> rejected before any trading collection mutation
  -> code = EXECUTION_SEQ_EXHAUSTED
  -> no partial execution/order/level/position commit
  -> executionSeq does not become MAX_SAFE_INTEGER
```

## 7. Fault semantics

Exhaustion faults remain first-wins and durable. `riskIncreaseBlocked=false` cannot override them. After export/import, `canIncreaseRisk()` stays false. Trading collections other than the explicit blocker fields stay byte-identical across the failed attempt.

## 8. Changed files

```text
src/simulator/engine.ts
src/simulator/snapshot.ts
test/simulator/p1-corrective-6.test.ts
test/simulator/p1-corrective-7.test.ts
docs/PHASE_1_GATE_1_CORRECTIVE_7.md
```

`src/domain/types.ts`, Phase 2 files, runtime bootstrap, dependencies, and schema version were not modified. C6-13 was corrected in place; other Corrective 6 tests were not weakened or renamed.

## 9. Mandatory tests

```text
C7-1 orderSeq=MAX_SAFE-2 generates once to MAX_SAFE-1 and roundtrips
C7-2 orderSeq=MAX_SAFE-1 exhausts before mutation; collections identical; durable first-wins fault
C7-3 C7-2 fault snapshot still blocks risk when serialized riskIncreaseBlocked=false
C7-4 executionSeq=MAX_SAFE-2 auto-generates once to MAX_SAFE-1 and roundtrips
C7-5 executionSeq=MAX_SAFE-1 auto-generation exhausts before mutation
C7-6 explicit sim-exec-(MAX_SAFE-1) commits, advances counter, and roundtrips
C7-7 explicit sim-exec-MAX_SAFE is rejected before any trading mutation
C7-8 generated order/execution collision protection still fails closed without skipping
C7-9 success, exhaustion, and collision terminals all export/import/export equivalently
C7-10 previous P1, C1-C13, D1-D13, C3, C4, C5, and C6 cases remain present and green
```

C6-13 no longer asserts that runtime may commit a `MAX_SAFE_INTEGER` counter. Its live boundary is `MAX_SAFE-2 -> MAX_SAFE-1` success, then `MAX_SAFE-1 -> next mutation` fail-before-commit. Import of `MAX_SAFE_INTEGER` remains rejected.

## 10. Boundary matrix

```text
counter before          operation                         counter after           outcome                 trading mutation  import
MAX_SAFE-2              next generated order              MAX_SAFE-1              ACK success            yes               accepted
MAX_SAFE-1              next generated order              MAX_SAFE-1              ORDER_SEQ_EXHAUSTED    no                accepted
MAX_SAFE                import stored orderSeq            n/a                     ORDER_SEQ_UNSAFE       n/a               rejected
MAX_SAFE-2              next auto execution               MAX_SAFE-1              success                yes               accepted
MAX_SAFE-1              next auto execution               MAX_SAFE-1              EXECUTION_SEQ_EXHAUSTED no               accepted
MAX_SAFE                import stored executionSeq        n/a                     EXECUTION_SEQ_UNSAFE   n/a               rejected
```

## 11. Explicit ID matrix

```text
execution ID                    prior sequence  outcome                   resulting sequence  roundtrip
sim-exec-(MAX_SAFE-1)           0               commit when otherwise valid MAX_SAFE-1         success
sim-exec-MAX_SAFE               0               EXECUTION_SEQ_EXHAUSTED   unchanged (0)       success
sim-exec-0001 then generated    0               generated becomes 0002    2                   success
```

## 12. Actual local results

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
npm run lint                                         exit 0  (33 files)
npm run format:check                                 exit 0  (33 files)
npm test                                             exit 0  146/146 pass
npm run test:phase1                                  exit 0  139/139 pass
node --import tsx --test test/simulator/p1-corrective-7.test.ts
                                                     exit 0  10/10 pass
npm run build                                        exit 0
npm run scan:secrets                                 exit 0  65 tracked files
npm run dry-run                                      exit 0
  runtimeMode=DRY_RUN liveExchangeWrites=false phase=0
npm run check                                        exit 0
git diff --check                                     exit 0
```

Focused runner used by this repository:

```text
node --import tsx --test test/simulator/p1-corrective-7.test.ts
```

`npm run build` emits only `src/**` to `dist/`. It does not emit `dist/test/simulator/p1-corrective-7.test.js`.

## 13. Final SHA / tree

```text
BASE_SHA=5a58f3aa4585137e809decd19d4dc4be83045ead
BASE_TREE=39a9edf58146d45e2c0848cd219cc239447a526d
IMPLEMENTATION_SHA=66567d9d20beb3031eee2b2069db61b288dc0d2e
IMPLEMENTATION_TREE=fa90c58567512a749d6cb2c40fcab0b4931f7f4b
TEST_SHA=924188385defc5d7770484c3f4413d2953932e9d
TEST_TREE=3b3484c69e7ac22bbd275ff6e388ad8d14117efd
DOCS_BIND_SHA=e60c935cd988629d225a4d91e9bfd7f0ffc7451f
DOCS_BIND_TREE=c53e9bca46a4f026d48fc89d332329f5a8f29656
```

The evidence commit that records these identities is the current review HEAD after this file is updated.

## 14. Exact branch-push CI evidence

Corrective 6 CI placeholders are not valid evidence for this candidate.

Branch-push CI on `e60c935cd988629d225a4d91e9bfd7f0ffc7451f`:

```text
RUN_ID=32652963043
RUN_URL=https://github.com/danny0971haha/multi-venue-grid-engine/actions/runs/32652963043
HEAD_SHA=e60c935cd988629d225a4d91e9bfd7f0ffc7451f
EVENT=push
CONCLUSION=success
```

A later evidence-only commit may move branch HEAD. Independent review must bind the exact final HEAD and the exact branch-push run whose `headSha` equals that HEAD. The PR body and handoff packet use that later run, not this bind-commit run.

## 15. Known limitations

- Phase 1 remains an in-memory deterministic simulator. There is still no durable Phase 2 risk store, runtime lease, or live venue transport.
- `ExecutionIntegrityFault` has no operator reset/acknowledgement contract yet. A recorded fault permanently blocks risk increase for that simulator instance until an explicit later reconciliation contract exists.
- `EXECUTION_ID_CONFLICT` remains the Corrective 4 blocker (`executionConflict`) and is not folded into `ExecutionIntegrityFault`.
- `fromSnapshot()` continues to OR derived blockers into `riskIncreaseBlocked`. A runtime export may serialize `riskIncreaseBlocked=false` while a fault is present; import still blocks risk increase. Deterministic equivalence for those terminals is collections + fault + `canIncreaseRisk()`, not the serialized flag bit.
- Injecting a foreign order whose id is already in the generated `sim-ord-` namespace without advancing `orderSeq` still creates a runtime state that import rejects as `ORDER_SEQ_BEHIND_IDENTITIES`. C5-11/C7-8 keep fail-closed collision behavior and do not skip IDs to make that fixture importable.
- `node --test dist/test/simulator/p1-corrective-7.test.js` is not produced by the current build graph.

## 16. Phase 2 stop line

```text
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
```

This corrective stops after a Phase 1 review candidate is produced. Independent review decides `GATE_1`.
