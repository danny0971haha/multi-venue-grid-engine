# Domain Contracts

Version: `0.1.0`

This document defines the canonical domain semantics for the independently implemented engine. It exists so different implementation agents do not invent incompatible identities, numeric representations, order states, or exchange-result meanings.

`docs/EXPERIMENT_SPEC.md` remains authoritative for the numerical risk envelope. This document is authoritative for domain semantics.

## 1. Numeric representation

### 1.1 Never use IEEE-754 `number` as authoritative trading value

The following values must not be represented as authoritative JavaScript `number` values in strategy, execution, risk, storage, or venue-normalization code:

- price;
- quantity;
- notional;
- equity;
- margin;
- fee;
- funding;
- realized/unrealized PnL;
- tick size;
- quantity step;
- percentage thresholds used for order/risk decisions.

Wire/API values should be normalized to canonical decimal strings. Internal arithmetic must use one pinned arbitrary-precision decimal implementation behind a small project-owned abstraction. Phase 1 should use `decimal.js` unless a contract change is approved.

Canonical serialized decimal examples:

```text
"100"
"0.001"
"93250.5"
"-5.25"
```

Do not serialize `NaN`, `Infinity`, exponential notation, locale separators, or empty strings.

### 1.2 Rounding

Rounding is never implicit.

Every order quantity and price must be normalized using venue rules before submission planning:

```text
price -> venue tick size
quantity -> venue quantity step
notional -> venue minimum/maximum checks
```

The rounding mode must be explicit in the market-rule helper and covered by tests. Risk checks must use conservative rounding: never round a risk estimate downward if doing so could authorize more exposure.

## 2. Time and freshness

All persisted timestamps are ISO-8601 UTC strings.

A normalized observation should carry, where available:

```ts
type ObservationMeta = {
  venue: VenueId;
  source: string;
  serverTime: string | null;
  receivedAt: string;
  observedAt: string;
  freshnessMs: number | null;
  sequence: string | null;
};
```

`receivedAt` is local receipt time. `serverTime` is exchange-provided time when trustworthy. `observedAt` is the timestamp selected for freshness policy and must document which source it used.

A missing timestamp is not silently treated as fresh in live-capable logic.

## 3. Canonical identifiers

All identities are strings except lease generation, which is a non-negative monotonic integer serialized losslessly.

Required identities:

```ts
type ExperimentId = string;
type RunId = string;
type ScopeKey = string;
type VenueId = string;
type MarketId = string;
type AnchorEpoch = string;
type LogicalLevelId = string;
type IntentId = string;
type ClientOrderId = string;
type ExchangeOrderId = string;
type ExecutionId = string;
type HaltId = string;
type RuntimeOwnerId = string;
type LeaseGeneration = bigint;
```

### 3.1 `scopeKey`

The canonical v0.1 scope is:

```text
<account-scope>/<venue>/<market>/<strategy>
```

Example:

```text
canary-01/backpack/BTC_USDC_PERP/grid-v0.1
```

The exact string must be persisted. Do not derive ownership solely from venue + symbol at restart.

### 3.2 `anchorEpoch`

Every intentional anchor reset creates a new `anchorEpoch`. Orders from an older epoch do not silently become orders of the current grid.

### 3.3 `logicalLevelId`

A level identity is stable within an anchor epoch and independent of the exchange order ID.

Recommended v0.1 values:

```text
B1 B2 B3 B4 B5
S1 S2 S3 S4 S5
```

where `B1/S1` are nearest to anchor and `B5/S5` are at the ±3% boundaries.

### 3.4 `intentId`

An `intentId` identifies one intended exchange mutation. Retrying an ambiguous mutation must not create a fresh intent ID unless reconciliation has proven the old intent did not reach the venue.

### 3.5 `clientOrderId`

If a venue supports caller-provided deterministic client IDs, derive it from stable domain identity and keep it within venue length/charset limits. Hashing/truncation must be deterministic and collision-tested.

A venue order without sufficient ownership identity is `UNOWNED` or `AMBIGUOUS`; it is never silently adopted.

## 4. Core enums

```ts
type Side = "BUY" | "SELL";
type OrderType = "LIMIT" | "MARKET";
type TimeInForce = "GTC" | "IOC" | "FOK" | "POST_ONLY";

type IntentPurpose =
  | "GRID_ENTRY"
  | "GRID_EXIT"
  | "RISK_REDUCTION"
  | "EMERGENCY_FLATTEN"
  | "CANCEL";

type Ownership = "OWNED" | "UNOWNED" | "AMBIGUOUS";

type WriteOutcomeKind = "ACK" | "REJECTED" | "UNKNOWN" | "NOT_SENT";
```

`UNKNOWN` means the request may have reached the venue. It is a first-class safety state, not an error string.

## 5. Experiment configuration

The normalized v0.1 configuration must resolve to the frozen envelope:

```ts
type ExperimentConfig = {
  version: "0.1.0";
  capitalCeilingUsd: DecimalString;      // "100"
  leverage: DecimalString;               // "5"
  marginBudgetUsd: DecimalString;        // "30"
  maxPlannedGrossNotionalUsd: DecimalString; // "150"
  gridLevels: 10;
  gridHalfBandFraction: DecimalString;   // "0.03"
  dailyLossLimitUsd: DecimalString;      // "5"
  drawdownFromStartLimitUsd: DecimalString; // "10"
  boundaryBufferFraction: DecimalString; // "0.01"
};
```

No venue adapter may override these experiment values. A venue that cannot operate inside the envelope is unsupported for the canary.

## 6. v0.1 grid geometry

Geometry is deterministic and percentage-based.

Given anchor `A` and half-band `h = 0.03`:

```text
lower = A * (1 - h)
upper = A * (1 + h)
```

There are ten logical entry levels, excluding the anchor:

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

Thus the nominal spacing from anchor is 0.6%, 1.2%, 1.8%, 2.4%, and 3.0% on each side before venue tick rounding.

The strategy stores both the unrounded theoretical price and the normalized venue price. Risk uses the actual normalized planned orders.

### 6.1 Exit target

A filled entry produces an opposite-side exit one grid step toward the anchor:

```text
B5 -> exit at B4
B4 -> exit at B3
...
B1 -> exit at anchor

S5 -> exit at S4
S4 -> exit at S3
...
S1 -> exit at anchor
```

This is a v0.1 deterministic simulator/strategy rule. Adaptive re-anchoring is not permitted.

## 7. Order intent

A normalized intent must contain enough data to be replayed and reconciled:

```ts
type OrderIntent = {
  intentId: IntentId;
  experimentId: ExperimentId;
  runId: RunId;
  scopeKey: ScopeKey;
  anchorEpoch: AnchorEpoch;
  logicalLevelId: LogicalLevelId | null;
  purpose: IntentPurpose;
  side: Side;
  type: OrderType;
  timeInForce: TimeInForce | null;
  price: DecimalString | null;
  quantity: DecimalString;
  reduceOnly: boolean;
  clientOrderId: ClientOrderId | null;
  leaseGeneration: string;
  createdAt: string;
};
```

Invariant: risk-reducing intents are explicitly distinguishable from risk-increasing intents. Do not infer this from side alone.

## 8. Venue write result

All venue mutations normalize into one of four outcomes:

```ts
type VenueWriteResult<TAck> =
  | { kind: "ACK"; ack: TAck; meta: ObservationMeta }
  | { kind: "REJECTED"; code: string | null; message: string; meta: ObservationMeta | null }
  | { kind: "UNKNOWN"; reason: string; requestFingerprint: string; lastKnownMeta: ObservationMeta | null }
  | { kind: "NOT_SENT"; reason: string };
```

Semantics:

- `ACK`: the venue unambiguously accepted/committed the operation according to the method contract.
- `REJECTED`: the venue unambiguously did not accept the operation.
- `UNKNOWN`: transport/API outcome cannot prove whether the operation reached or committed at the venue.
- `NOT_SENT`: local validation/gating prevented transmission.

An exception must be converted to the correct semantic outcome; it must not automatically mean `REJECTED`.

## 9. Exchange order observation

```ts
type ExchangeOrderObservation = {
  venue: VenueId;
  market: MarketId;
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  side: Side;
  type: string;
  price: DecimalString | null;
  originalQuantity: DecimalString;
  executedQuantity: DecimalString;
  remainingQuantity: DecimalString | null;
  status: string;
  reduceOnly: boolean | null;
  ownership: Ownership;
  meta: ObservationMeta;
};
```

An order disappearing from `listOpenOrders()` is not an execution observation.

## 10. Execution observation

Authoritative fills use a distinct type:

```ts
type ExecutionObservation = {
  venue: VenueId;
  market: MarketId;
  executionId: ExecutionId;
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  side: Side;
  price: DecimalString;
  quantity: DecimalString;
  feeAmount: DecimalString | null;
  feeAsset: string | null;
  liquidity: "MAKER" | "TAKER" | "UNKNOWN";
  meta: ObservationMeta;
};
```

Execution identity must be deduplicated durably. Replaying an execution cursor must not count the same execution twice.

## 11. Position and account snapshots

```ts
type PositionSnapshot = {
  venue: VenueId;
  market: MarketId;
  quantity: DecimalString; // signed; positive long, negative short
  markPrice: DecimalString | null;
  notionalUsd: DecimalString | null;
  unrealizedPnlUsd: DecimalString | null;
  meta: ObservationMeta;
};

type AccountSnapshot = {
  equityUsd: DecimalString | null;
  availableMarginUsd: DecimalString | null;
  realizedDailyPnlUsd: DecimalString | null;
  feesDailyUsd: DecimalString | null;
  fundingDailyUsd: DecimalString | null;
  meta: ObservationMeta;
};
```

Missing authoritative values remain `null`. Never substitute zero.

## 12. Logical level state

Phase 1 uses an explicit state machine:

```ts
type GridLevelState =
  | "IDLE"
  | "ENTRY_SUBMITTING"
  | "ENTRY_WORKING"
  | "ENTRY_PARTIAL"
  | "POSITION_OPEN"
  | "EXIT_SUBMITTING"
  | "EXIT_WORKING"
  | "EXIT_PARTIAL"
  | "CANCEL_PENDING"
  | "RECONCILING"
  | "ERROR_REQUIRES_RECONCILIATION"
  | "HALTED";
```

### 12.1 Transition evidence

A transition depending on an exchange mutation is committed only from:

1. an unambiguous `ACK`; or
2. a fresh authoritative observation proving the target fact.

Forbidden examples:

```text
timeout -> assume order exists
exception -> assume order rejected
open-order disappearance -> assume fill
local position delta -> invent execution identity
```

## 13. Partial fills

Partial fills are cumulative and execution-backed.

Persist at least:

```text
original quantity
cumulative executed quantity
remaining quantity
individual execution IDs
weighted execution price if reported/derived
exchange order identity
logical level identity
```

A partial fill does not erase the remaining working quantity.

## 14. Ownership classification

An exchange order may be `OWNED` only when ownership is proven by stable project identity, such as a deterministic client order ID plus matching scope/epoch rules.

If identity is incomplete:

- classify `UNOWNED` when it clearly belongs elsewhere;
- classify `AMBIGUOUS` when ownership cannot be proved either way.

The engine must never cancel `UNOWNED` orders as duplicate cleanup. `AMBIGUOUS` orders block live-capable reseeding until reconciled.

## 15. Reconciliation disposition

Every restart/ambiguous outcome produces an explicit disposition:

```ts
type ReconciliationDisposition =
  | "PROVEN_CONSISTENT"
  | "REPAIR_LOCAL_FROM_VENUE"
  | "CANCEL_OWNED_DUPLICATE"
  | "WAIT_FOR_FRESH_EVIDENCE"
  | "BLOCK_RISK_INCREASE"
  | "HARD_HALT";
```

No generic `continue=true` flag is authoritative enough for safety-critical control flow.

## 16. Conservative gross-notional reservation

Before authorizing a risk-increasing batch, compute both worst-case long and worst-case short exposure using:

- current authoritative signed position;
- every owned working risk-increasing order;
- every `UNKNOWN` submission that could still exist at the venue;
- every proposed risk-increasing intent in the batch.

Do not net mutually exclusive assumptions unless exclusion is proven.

The maximum of the directional scenarios must remain at or below `150 USDT` for the v0.1 experiment.

## 17. Serialization invariants

Persisted domain records must be:

- schema-versioned;
- deterministic/canonical before hashing;
- explicit about `null` versus missing;
- free of secret values;
- backward migration only through reviewed migration code.

Do not serialize live class instances such as `Decimal` directly. Convert them to canonical decimal strings first.

## 18. Phase ownership

- Phase 0 creates only scaffolding and contract-oriented smoke types; it does not implement these trading semantics.
- Phase 1 implements and tests the domain types, grid geometry, identities, simulator, and state transitions in this document.
- Later phases may extend types, but any semantic breaking change requires the protocol in `docs/REVIEW_CHANGE_PROTOCOL.md`.
