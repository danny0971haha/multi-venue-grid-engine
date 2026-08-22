# Risk and Persistence Contract

Version: `0.1.0`

This document defines the fail-closed safety semantics for risk state, durable persistence, runtime fencing, hard halts, and manual acknowledgement.

It is intentionally stricter than a normal application-state store. A persistence uncertainty that could cause a trading process to forget a halt, duplicate an order, or resume risk is treated as a safety failure.

## 1. Core principle

The durable safety state is authoritative only when its on-disk representation is **proven**.

The runtime may continue risk-increasing behavior only when all applicable authorities agree:

```text
valid current runtime lease
AND
proven durable risk state
AND
no unresolved hard halt
AND
fresh required risk inputs
AND
reconciliation gate clear
AND
planned exposure within limits
```

Any unknown/contradictory authority blocks new risk.

## 2. Risk action model

Use an explicit action rather than independent booleans:

```ts
type RiskAction =
  | "CONTINUE"
  | "REDUCE"
  | "HALT";

type RiskDecision = {
  action: RiskAction;
  reasonCodes: string[];
  allowRiskIncrease: boolean;
  evaluatedAt: string;
};
```

Required invariant:

```text
CONTINUE -> allowRiskIncrease may be true only after all continuation gates pass
REDUCE   -> allowRiskIncrease = false
HALT     -> allowRiskIncrease = false
```

Never infer continuation from `halt === false` alone.

## 3. Required risk inputs

For live-capable evaluation, the risk engine needs authoritative/fresh inputs for every metric it uses:

- account equity;
- current signed position;
- mark/mid price used for notional;
- daily realized PnL when available;
- fees/funding needed for net daily PnL;
- active owned orders;
- unresolved `UNKNOWN` write reservations;
- grid boundaries;
- runtime lease state;
- persistent halt state;
- reconciliation status.

Missing/stale data must produce `REDUCE` or `HALT` according to whether a bounded safe reduction can still be proven. It must not produce `CONTINUE`.

## 4. Frozen v0.1 hard guards

From `docs/EXPERIMENT_SPEC.md`:

```text
capital ceiling            = 100 USDT
leverage                   = 5x
margin budget              = 30 USDT
planned gross-notional cap = 150 USDT
daily net-loss halt        = -5 USDT
drawdown from start halt   = 10 USDT
boundary buffer            = 1% beyond ±3% grid boundary
```

These values are not configurable upward without a spec version change.

## 5. Planned exposure gate

Before submitting any risk-increasing batch, reserve exposure from:

1. current signed position;
2. active owned risk-increasing orders;
3. unresolved `UNKNOWN` placements that might exist;
4. all proposed risk-increasing intents in the batch.

Compute conservative directional scenarios. The maximum plausible gross exposure must be `<= 150 USDT`.

If exposure cannot be bounded because an ambiguous order has unknown quantity/price, block risk increase.

## 6. Actual exposure guard

If authoritative actual position notional exceeds `150 USDT`:

```text
stop new risk
-> cancel proven-owned risk-increasing orders
-> request bounded active reduction
-> obtain fresh authoritative position snapshot
-> verify <= safe target
```

If cancellation, reduction, or verification is failed/ambiguous:

```text
HALT
-> emergency flatten policy
-> fresh verification
-> remain HALTED if not proven safe
```

Cancel-only is not considered successful risk reduction.

## 7. Daily loss

Define v0.1 net daily PnL from authoritative components whenever the venue makes them available:

```text
netDailyPnl = realizedTradingPnl - fees + funding
```

If the venue signs funding with opposite convention, normalize it explicitly.

At:

```text
netDailyPnl <= -5 USDT
```

hard halt.

If a required component becomes unavailable/stale during a live-capable run, the engine must not silently compute it as zero.

## 8. Drawdown

Persist `startingEquityUsd` for the experiment run and track high-water equity for telemetry.

Hard v0.1 rule:

```text
equityUsd <= startingEquityUsd - 10 USDT
```

=> hard halt.

High-water drawdown is observed and persisted, but it is not a replacement for the fixed starting-equity hard rule unless the experiment spec is versioned.

## 9. Boundary guard

For adverse long inventory:

```text
mid < gridLower * 0.99
```

For adverse short inventory:

```text
mid > gridUpper * 1.01
```

=> hard halt.

No-inventory boundary movement is not itself a hard halt in v0.1, but it may block new grid seeding depending on strategy/reconciliation state.

## 10. Halt state machine

Persist a structured halt state:

```ts
type HaltStatus =
  | "RUNNING"
  | "HALTING"
  | "HALTED_UNFLAT"
  | "HALTED_FLAT"
  | "HALT_FAILED";
```

Required fields:

```ts
type DurableRiskState = {
  schemaVersion: number;
  scopeKey: ScopeKey;
  experimentId: ExperimentId;
  leaseGeneration: string;
  status: HaltStatus;
  haltId: HaltId | null;
  haltReasons: string[];
  acknowledgedHaltId: HaltId | null;
  startingEquityUsd: DecimalString | null;
  highWaterEquityUsd: DecimalString | null;
  lastRiskEvaluationAt: string | null;
  updatedAt: string;
};
```

### 10.1 Hard halt start

Before remediation writes begin, create/persist a unique current `haltId` and `HALTING` intent if persistence is still provable.

Then:

```text
fence risk-increasing writes
-> cancel proven-owned risk-increasing orders
-> reconcile cancellation ambiguity
-> actively reduce/flatten
-> fresh account/position/order snapshot
-> persist terminal halt status
```

Terminal status:

- `HALTED_FLAT`: fresh evidence proves strategy exposure is flat and owned risk orders are gone.
- `HALTED_UNFLAT`: halt is durable but nonzero exposure remains.
- `HALT_FAILED`: remediation or persistence evidence is insufficient/failed.

All terminal halt statuses block automatic restart.

## 11. Manual halt acknowledgement

A halt acknowledgement is **not** a generic `resume=true` flag.

Required protocol:

1. load and prove the current durable state from disk;
2. prove the current exact `haltId` from that durable state;
3. compare operator-provided acknowledgement to that exact ID;
4. reject stale, missing, mismatched, or caller-invented IDs;
5. obtain fresh venue evidence required for safe resume;
6. prove no unresolved ambiguous writes/reconciliation blockers;
7. persist a new exact durable generation that records acknowledgement and `RUNNING`;
8. only after durable commit may risk increase be considered again.

The caller-provided in-memory state is **never** the authority for which halt is being acknowledged.

A previous halt ID cannot authorize a later halt.

## 12. Runtime persistence latch

A process-local latch permanently blocks risk increase for the life of the process after any persistence condition becomes unproven.

Example:

```ts
type RuntimePersistenceLatch = {
  blocked: boolean;
  reasonCodes: string[];
  blockedAt: string | null;
};
```

Once `blocked=true`:

- no risk-increasing venue write is permitted;
- a later successful disk write does not silently clear the latch;
- process restart plus fresh durable inspection is required;
- remediation may continue only through explicitly risk-reducing paths.

This prevents a transient storage failure from being forgotten by later happy-path code.

## 13. Durable envelope

Safety-critical state uses a versioned checksummed envelope.

Normative conceptual shape:

```ts
type DurableEnvelope<T> = {
  schemaVersion: number;
  kind: string;
  scopeKey: string;
  storeGeneration: string;
  previousEnvelopeSha256: string | null;
  payloadSha256: string;
  payload: T;
  envelopeSha256: string;
};
```

Hashing uses canonical deterministic serialization. Hash fields themselves are handled in a documented non-recursive way.

The exact serialization algorithm must be tested with stable fixtures.

## 14. Primary + backup exact-pair authority

Safety state is stored as:

```text
<state>.json
<state>.json.bak
```

The only normal committed state is a **valid exact pair**:

```text
primary bytes == backup bytes
AND both envelopes validate
AND kind/scope/schema match
AND generation/hash chain is valid
```

A single apparently valid copy is not automatically enough to authorize risk increase after a contradictory/partial commit.

## 15. Initial store creation

Initial creation is allowed only when all are true:

- no prior primary or backup exists;
- the runtime is in a non-live/bootstrap state;
- the expected scope is known;
- there is no unresolved historical state for that experiment scope.

Create the first exact pair with generation `1` (or project-equivalent initial generation) and `previousEnvelopeSha256 = null`.

If only one file already exists, do not treat the situation as clean initialization.

## 16. Transition precondition

Before any durable transition:

1. inspect primary and backup independently;
2. validate envelope checksums and schema;
3. require an exact authoritative predecessor pair;
4. confirm expected scope;
5. compute next generation = predecessor generation + 1;
6. set `previousEnvelopeSha256` to predecessor envelope hash;
7. build one immutable byte representation for the requested next state.

If predecessor authority is unproven, return a fail-closed result and set the runtime latch. Do not manufacture a clean lineage.

## 17. Backup-first atomic commit protocol

Write the **same precomputed next-state bytes** to backup first, then primary.

For each target copy:

```text
create temp file in same directory
-> write all bytes
-> fsync temp file
-> close temp file
-> atomic rename temp -> target
-> fsync parent directory where supported
-> reopen/read/validate target bytes
```

Full transition:

```text
inspect exact predecessor pair
-> build next envelope bytes once
-> atomically commit BACKUP
-> inspect committed BACKUP
-> atomically commit PRIMARY using identical bytes
-> final inspect PRIMARY + BACKUP
-> require exact next pair
```

Only the final exact-pair inspection can return `allowRiskIncrease=true`.

## 18. Crash/partial transition semantics

Process death can occur at any storage step.

After restart, possible states include:

```text
old exact pair
new exact pair
backup ahead of primary
primary ahead of backup
missing primary
missing backup
corrupt primary
corrupt backup
valid but conflicting pair
unexpected generation jump
broken previous-hash chain
```

Only a proven exact pair may authorize continuation.

A partial/ahead/conflicting pair is a safety event. Default behavior:

```text
preserve disk evidence
-> mark persistence authority unproven
-> block risk increase
-> require explicit recovery/review path
```

Do **not** automatically choose the higher generation and continue trading.

## 19. No unsafe automatic repair

Automatic repair is intentionally bounded.

A startup reader must not silently overwrite a contradictory pair merely because one copy looks newer or valid.

A write function must not respond to an unproven commit by repeatedly rewriting both files until they happen to match; that destroys crash evidence and may convert an uncertain transition into false authority.

Any repair capability introduced later must:

- have a distinct recovery command/path;
- be unavailable during normal live continuation;
- preserve original bytes/evidence;
- produce a reviewed audit event;
- prove the selected predecessor/lineage.

## 20. Persistence result

Persistence returns a disposition, not just success/failure:

```ts
type PersistDisposition =
  | "REQUESTED_STATE_COMMITTED"
  | "PREDECESSOR_UNPROVEN"
  | "PARTIAL_COMMIT"
  | "FINAL_PAIR_UNPROVEN"
  | "IO_FAILURE";

type PersistResult<T> = {
  disposition: PersistDisposition;
  state: T;
  allowRiskIncrease: boolean;
  reasonCodes: string[];
  committedEnvelopeSha256: string | null;
  committedGeneration: string | null;
};
```

`allowRiskIncrease=true` is permitted only for `REQUESTED_STATE_COMMITTED` plus a final exact-pair proof and an unblocked runtime latch.

## 21. Runtime lease / fencing

Exactly one runtime may own a trading scope.

Persist a lease record containing at least:

```ts
type RuntimeLease = {
  scopeKey: ScopeKey;
  ownerId: RuntimeOwnerId;
  generation: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
};
```

Required semantics:

- generation is monotonic;
- acquisition is atomic;
- a new owner must fence the old generation;
- every venue mutation asserts current owner + generation immediately before transmission;
- long-running kill-switch steps recheck lease before each mutation;
- lease loss/uncertainty sets `allowRiskIncrease=false` immediately;
- a stale process cannot regain authority simply by writing its old lease record.

The simulator must be able to test lease theft/loss deterministically.

## 22. Restart gate

After any restart, before new risk:

```text
prove durable risk exact pair
-> acquire current runtime lease
-> load anchor/epoch
-> load intent/order registry
-> query fresh open orders
-> classify ownership
-> query current position/account
-> replay authoritative executions from durable cursor
-> resolve UNKNOWN intents
-> verify leverage if live-capable
-> evaluate risk
-> persist any required reconciled state
-> only then permit CONTINUE
```

Any unresolved blocker leaves the engine in reconciliation/halt mode.

## 23. Telemetry durability

Telemetry is append-only evidence, not a substitute for authoritative risk state.

However, if the experiment contract requires a manifest/event to exist before a risk-increasing operation and that evidence cannot be written, fail closed. Do not trade first and hope telemetry succeeds later.

Telemetry failure must never clear a halt or lease failure.

Secrets are forbidden in telemetry.

## 24. Manifest

Before an experiment run begins, persist an immutable run manifest containing at least:

```text
spec version
experiment ID
run ID
commit SHA
mode
scope
venue
market
100U capital ceiling
5x leverage
30U margin budget
150U planned gross cap
10 levels
±3% half-band
5U daily-loss limit
10U start-drawdown limit
1% boundary buffer
startedAt
```

If a later run uses different contract values, it must have a new spec version/run identity and must not be mixed into the same aggregate silently.

## 25. Fatal process errors

Safety-critical runtime code must not use a global `catch` that logs an uncaught fatal error and continues placing orders.

On fatal/unhandled runtime failure:

```text
set process write fence if possible
-> emit best-effort fatal evidence
-> stop normal strategy loop
-> terminate non-zero or enter a separately proven supervisor-safe halted mode
```

A supervisor restart still goes through the full restart gate.

## 26. Testability requirement

All semantics in this document must be testable without a real exchange.

Phase 2 must provide fault hooks/test doubles for:

- atomic storage steps;
- lease acquisition/expiry/theft;
- stale snapshots;
- ambiguous cancellation/reduction;
- telemetry failures;
- process-crash child workers.

Exception injection alone is not sufficient for crash durability. `docs/TEST_FAULT_MATRIX.md` requires real child-process termination at storage boundaries.

## 27. Change boundary

Changes to any of the following require independent contract review before implementation:

- exact-pair authority rule;
- halt acknowledgement authority;
- runtime lease generation/fencing semantics;
- conditions that allow risk increase;
- backup-first commit ordering;
- exposure/loss/drawdown thresholds;
- startup handling of contradictory state.

An implementation agent may propose such a change but must not silently apply it.
