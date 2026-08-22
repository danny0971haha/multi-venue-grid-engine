# Venue Adapter Contract

Version: `0.1.0`

This document defines the boundary between the venue-neutral engine and exchange-specific code. A venue adapter normalizes protocol behavior; it does not contain grid strategy or risk policy.

No live exchange writes are authorized by this document.

## 1. Design rule

A venue adapter must expose **capabilities and uncertainty**, not pretend every exchange behaves identically.

The engine must be able to answer:

```text
Can this venue prove order ownership?
Can this venue prove fills authoritatively?
Can this venue distinguish rejected from unknown writes?
Can leverage be set and read back?
Can a position be reduced without increasing risk?
Can cancellation be verified?
Are timestamps fresh enough for risk decisions?
```

If the answer required for a canary is not proven, that venue is not canary eligible.

## 2. Layering

Recommended boundary:

```text
strategy/grid
    |
execution coordinator
    |
risk gate
    |
VenueAdapter interface
    |
venue-specific mapper/auth/transport
    |
official venue API
```

Forbidden dependencies:

```text
venue adapter -> strategy policy
venue adapter -> hard-coded v0.1 capital/risk thresholds
UI -> venue signing client
strategy -> raw REST/WebSocket payload
```

## 3. Split read and write capabilities

A venue implementation should separate read and mutation surfaces so Phase 4 can integrate real read-only data without accidentally enabling writes.

```ts
interface VenueReadAdapter {
  readonly id: VenueId;
  capabilities(): VenueCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getMarketRules(market: MarketId): Promise<Observed<MarketRules>>;
  getMarketData(market: MarketId): Promise<Observed<MarketData>>;
  getAccountSnapshot(): Promise<Observed<AccountSnapshot>>;
  getPosition(market: MarketId): Promise<Observed<PositionSnapshot>>;
  listOpenOrders(market: MarketId): Promise<Observed<ExchangeOrderObservation[]>>;
  getOrder(query: OrderQuery): Promise<Observed<ExchangeOrderObservation | null>>;
  listExecutionsSince(market: MarketId, cursor: ExecutionCursor | null): Promise<ExecutionPage>;
  readLeverage(market: MarketId): Promise<Observed<DecimalString | null>>;
}
```

Mutation interface is introduced only when a later reviewed phase explicitly authorizes dry-run planning and test doubles:

```ts
interface VenueWriteAdapter {
  placeOrder(intent: OrderIntent): Promise<VenueWriteResult<OrderAck>>;
  cancelOrder(request: CancelRequest): Promise<VenueWriteResult<CancelAck>>;
  cancelOwnedOrders(request: CancelOwnedRequest): Promise<VenueWriteResult<CancelBatchAck>>;
  reducePosition(request: ReducePositionRequest): Promise<VenueWriteResult<ReductionAck>>;
  flattenPosition(request: FlattenPositionRequest): Promise<VenueWriteResult<ReductionAck>>;
  setLeverage(request: SetLeverageRequest): Promise<VenueWriteResult<LeverageAck>>;
}
```

Real production signing/transmission must not be implemented in Phase 0 or Phase 1.

## 4. Capability object

Capabilities are data, not comments.

```ts
type VenueCapabilities = {
  deterministicClientOrderId: CapabilityStatus;
  orderLookupByClientId: CapabilityStatus;
  executionHistory: CapabilityStatus;
  executionCursor: CapabilityStatus;
  stableExecutionId: CapabilityStatus;
  partialFillIdentity: CapabilityStatus;
  leverageSet: CapabilityStatus;
  leverageReadback: CapabilityStatus;
  isolatedMargin: CapabilityStatus;
  reduceOnly: CapabilityStatus;
  partialPositionReduction: CapabilityStatus;
  fullFlatten: CapabilityStatus;
  cancelSingle: CapabilityStatus;
  cancelAllOwned: CapabilityStatus;
  cancelVerification: CapabilityStatus;
  serverTimestamp: CapabilityStatus;
  websocketOrders: CapabilityStatus;
  websocketExecutions: CapabilityStatus;
};

type CapabilityStatus =
  | { status: "PROVEN"; evidenceRef: string }
  | { status: "UNPROVEN"; reason: string }
  | { status: "UNSUPPORTED"; reason: string };
```

`evidenceRef` points to the venue capability audit, official documentation section, or recorded read-only evidence. Do not set `PROVEN` based on assumption or another bot's implementation.

## 5. Market identity and symbol mapping

Core code uses a canonical market identity. The adapter owns venue-specific symbols.

Example mapping record:

```ts
type VenueMarketMapping = {
  market: MarketId;
  venueSymbol: string;
  instrumentId: string | null;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string | null;
  contractType: "LINEAR_PERP" | "INVERSE_PERP" | "OTHER";
};
```

Never globally rewrite user/venue symbols with string heuristics such as removing `-PERP` or appending `USDT`. Mapping must come from explicit venue metadata/configuration.

## 6. Market rules

Normalize at least:

```ts
type MarketRules = {
  priceTick: DecimalString;
  quantityStep: DecimalString;
  minQuantity: DecimalString | null;
  maxQuantity: DecimalString | null;
  minNotional: DecimalString | null;
  maxNotional: DecimalString | null;
  maxClientOrderIdLength: number | null;
  clientOrderIdPattern: string | null;
};
```

A missing required rule blocks order planning. Do not guess precision from displayed prices.

## 7. Observation wrapper

Read methods return data plus provenance/freshness:

```ts
type Observed<T> = {
  value: T;
  meta: ObservationMeta;
};
```

If the venue returns inconsistent timestamps or partial data, preserve that fact in metadata or return an explicit normalized error. Do not fabricate freshness.

## 8. Error taxonomy

Adapters normalize transport/protocol failures into a project-owned taxonomy:

```ts
type VenueErrorKind =
  | "AUTH"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK"
  | "PROTOCOL"
  | "MALFORMED_RESPONSE"
  | "UNSUPPORTED"
  | "STALE_DATA"
  | "VENUE_REJECTED"
  | "UNKNOWN_WRITE_OUTCOME";
```

Raw response bodies must be redacted before logging. Authentication headers, private keys, signatures, cookies, bearer tokens, and complete signed requests must never appear in telemetry.

## 9. Write-outcome semantics

Every mutation returns one of:

```text
ACK
REJECTED
UNKNOWN
NOT_SENT
```

### 9.1 ACK

`ACK` is operation-specific.

For placement, `ACK` proves the venue accepted the order and returns a stable identity or sufficient lookup key. It does **not** prove fill.

For cancellation, `ACK` proves the cancel request was accepted only if the venue contract says so. If the API merely queues cancellation, final cancellation still requires observation.

For reduction, HTTP success does not prove risk is reduced. Final risk reduction requires a fresh position snapshot.

### 9.2 REJECTED

`REJECTED` is used only when the venue unambiguously proves the requested mutation was not accepted.

Examples:

- deterministic validation rejection;
- authenticated exchange error specifying the order was rejected and no order was created;
- local preflight may instead be `NOT_SENT`.

### 9.3 UNKNOWN

Use `UNKNOWN` when the mutation may have reached the venue but the result cannot be proven.

Examples:

- timeout after request bytes may have been transmitted;
- connection reset after send;
- malformed success response without usable identity;
- rate-limit/proxy behavior where commit status is ambiguous.

Required behavior after `UNKNOWN`:

1. persist the unresolved intent;
2. reserve its possible exposure;
3. do not create a conflicting fresh intent;
4. query by client ID/order ID where supported;
5. reconcile open orders and executions using fresh data;
6. only retry with the same idempotent identity if venue semantics prove that is safe;
7. otherwise block risk increase until resolved.

Blind retry with a new client order ID is forbidden.

### 9.4 NOT_SENT

Use when a local gate prevented transmission:

- stale data;
- lease mismatch;
- risk cap;
- invalid precision;
- unsupported capability;
- dry-run planner only.

## 10. Request fingerprint

Every write attempt generates a non-secret deterministic request fingerprint from normalized semantic fields:

```text
venue
market
intentId
clientOrderId if any
side
type
normalized price
normalized quantity
reduceOnly
purpose
lease generation
```

The fingerprint helps reconcile `UNKNOWN` outcomes. It must not contain credentials or signatures.

## 11. Idempotency

Idempotency is explicit and venue-specific.

If deterministic client order IDs are supported:

- same unresolved intent keeps the same client ID;
- different intents must not collide;
- restart reconstructs the same identity from durable records;
- truncation/hash behavior is deterministic and tested.

If the venue cannot provide a safe idempotent order identity, the capability audit must explain how duplicate creation is prevented. If it cannot, live canary is blocked.

## 12. Fill provenance

Authoritative execution evidence may come from:

1. authenticated execution/trade stream with stable execution IDs;
2. authenticated fill history with stable execution IDs;
3. order-detail endpoint that reports executed quantity with stable order identity, only if the audit proves cancellation ambiguity can be ruled out and delta accounting is safe.

Not authoritative by itself:

```text
open order disappeared
position changed
local timer expired
REST timeout
WebSocket reconnect
order status guessed from local state
```

An adapter may emit `ORDER_DISAPPEARED`, but core reconciliation decides what to do with it.

## 13. Execution cursor

Where the venue supports paginated or cursor-based execution history, normalize a durable cursor:

```ts
type ExecutionCursor = {
  venue: VenueId;
  market: MarketId;
  opaque: string;
  lastExecutionId: ExecutionId | null;
  lastExecutionTime: string | null;
};
```

Replay must be overlap-safe. Core execution deduplication by stable execution ID remains required even when a cursor is used.

If the venue has no stable cursor, the audit must define a bounded overlap query and deduplication method.

## 14. Snapshot consistency

A `getSnapshot()` convenience method may aggregate multiple venue endpoints, but it must not imply atomicity that the venue does not provide.

Normalized snapshot metadata must state:

```text
component timestamps
oldest component timestamp
newest component timestamp
snapshot skew
fresh/stale decision
```

Risk logic may reject a snapshot with excessive component skew.

## 15. WebSocket semantics

WebSocket is a low-latency observation path, not an unquestioned source of truth.

Required handling:

- sequence/gap detection where supported;
- reconnect counter;
- resubscribe confirmation;
- REST reconciliation after detected gap or reconnect when needed;
- duplicate event handling;
- out-of-order event handling;
- timestamp provenance.

A reconnect must not automatically authorize new orders.

## 16. Cancellation

`cancelOwnedOrders(scope)` must never become `cancelAllAccountOrders()` unless the selected venue cannot target owned orders and an explicit live-canary contract approves that broader blast radius.

Default rule:

```text
only cancel orders whose ownership is PROVEN OWNED
```

Duplicate cleanup must not cancel `UNOWNED` or `AMBIGUOUS` orders.

Cancellation is considered verified only after fresh venue evidence shows the owned order is no longer active or the venue provides an equally authoritative terminal status.

Disappearance plus no execution evidence becomes a reconciliation case, not a fill.

## 17. Position reduction

`reducePosition()` and `flattenPosition()` are separate semantic operations.

### `reducePosition`

Goal: move absolute exposure toward a bounded target without crossing through zero into opposite exposure.

Required fields should include:

```text
current authoritative position reference
target maximum absolute quantity/notional
max allowed slippage policy identifier
reduce-only requirement if supported
lease generation
reason/halt ID when risk driven
```

### `flattenPosition`

Goal: close strategy exposure completely, not reverse it.

After either operation, the engine requires a fresh authoritative position snapshot. The mutation response alone is not final proof.

If reduce-only behavior cannot be proven, venue canary eligibility requires a separate review.

## 18. Leverage

For live-canary eligibility:

1. request configured leverage `5x` if venue allows programmatic setting;
2. read back leverage from an authoritative venue endpoint when supported;
3. compare exact normalized value;
4. block live-capable continuation on mismatch or unproven state.

If leverage must be set manually, the audit must specify a read-only way to verify it. If no verification exists, this is a live-canary blocker unless explicitly waived by a new contract.

## 19. Authentication boundary

Credentials belong only in venue-specific infrastructure/configuration.

Required rules:

- environment/secret store only;
- never committed;
- withdrawal permission disabled;
- minimum required trading/read permission;
- no credential value in errors, telemetry, manifests, snapshots, fixtures, or screenshots;
- signing functions accept structured semantic input and return only the transport request; core strategy never handles secrets.

Phase 0/1 test fixtures must use fake values that cannot be mistaken for real credentials.

## 20. Transport policy

Each real adapter must define:

```text
connect timeout
read timeout
overall request timeout
retryable read conditions
rate-limit/backoff behavior
maximum retry count
```

Mutation requests are **not automatically retried** after transport ambiguity. Reconciliation comes first.

Retries must be bounded and jittered where appropriate. Infinite retry loops are forbidden.

## 21. Read-only capability audit before implementation

Before Phase 4 writes any real adapter code beyond read-only integration, create a venue audit document using official documentation and read-only evidence.

Required audit fields:

```text
VENUE=
AUDIT_DATE=
OFFICIAL_DOC_URLS=
API_VERSION=
AUTH_METHOD=
MARKET_SYMBOL_RULES=
CLIENT_ORDER_ID_SUPPORT=
ORDER_LOOKUP_SEMANTICS=
OPEN_ORDER_SEMANTICS=
EXECUTION_HISTORY_SEMANTICS=
EXECUTION_ID_STABILITY=
PARTIAL_FILL_SEMANTICS=
LEVERAGE_SET=
LEVERAGE_READBACK=
ISOLATED_MARGIN=
REDUCE_ONLY=
PARTIAL_REDUCTION=
CANCEL_VERIFICATION=
SERVER_TIMESTAMP=
RATE_LIMITS=
MIN_QTY=
MIN_NOTIONAL=
TESTNET_OR_SANDBOX=
UNPROVEN_CAPABILITIES=
CANARY_ELIGIBLE=YES|NO|BLOCKED
```

Use official venue documentation as the primary source. Third-party bot code is not evidence for protocol semantics.

## 22. Canary capability minimum

A venue cannot be recommended for the first live canary unless the independent review can prove, at minimum:

- authoritative account/position snapshots;
- deterministic or otherwise safe order identity;
- authoritative execution/fill provenance;
- partial-fill handling;
- cancellation and cancellation verification;
- bounded reduction/flatten behavior;
- leverage configuration/readback or an explicitly reviewed equivalent;
- market rules/precision/min-size;
- freshness/timestamp semantics;
- safe restart reconciliation.

Missing authoritative fill provenance is an automatic blocker.

## 23. Phase boundary

- Phase 0: no real venue code.
- Phase 1: simulator implements the same semantic interface without network access.
- Phase 2–3: safety/execution core remains simulator-testable.
- Phase 4: one real venue, read-only first; write planning remains dry-run unless separately authorized.
- Phase 5: second venue only after independent Gate 4 review.
- Live writes require a separate authorization contract not present in this repository baseline.
