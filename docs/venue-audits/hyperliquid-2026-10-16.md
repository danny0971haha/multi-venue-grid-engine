# Hyperliquid venue capability audit (2026-10-16)

Phase 4.1 deliverable for IMPLEMENTATION_CONTRACT §7.1 and VENUE_ADAPTER_CONTRACT §21. This audit rests on the official documentation plus one public metadata read (E1, section 10). It is not a gate decision; the independent reviewer decides Gate 4A.

```text
EVIDENCE_LEVEL=OFFICIAL_DOCUMENTATION_PLUS_ONE_PUBLIC_METADATA_READ
READ_ONLY_VENUE_EVIDENCE=PUBLIC_META_ONLY (E1, section 10); no account-scoped read
NETWORK_CALLS_TO_HYPERLIQUID_API=1 (mainnet POST /info {"type":"meta"}, unauthenticated, no account address)
CREDENTIALS_CREATED_OR_USED=NONE
LIVE_EXCHANGE_WRITE=NO
GATE_DEVIATION=Phase 4 started without Gate 3 PASS, by owner authorization on 2026-10-16
```

## 0. Scope and boundary

- **Venue and market.** Hyperliquid perpetuals on the default, validator-operated USDC perp DEX, BTC perpetual (EXPERIMENT_SPEC §2). Builder-deployed (HIP-3) perps, spot, vaults, TWAP and trigger orders are out of scope.
- **Gate deviation.** IMPLEMENTATION_CONTRACT §7 says Phase 4 starts only after Gate 3 `PASS`. On 2026-10-16 the owner asked for both the Gate 3 review brief (issue #24) and Phase 4 ("都做"). Gate 3 review is pending. This audit is therefore a recorded deviation, and it does not change any Phase 3 code.
- **Authorization boundary.** The first version of this audit sent no request to `api.hyperliquid.xyz` or `api.hyperliquid-testnet.xyz`, because exchange networking was unauthorized. On 2026-10-16 the owner approved read-only networking for evidence (Q2, section 8) without choosing among the offered scopes, so the narrowest one was applied: a single public mainnet `meta` read (E1). Testnet reads, account-address reads, credentials and every write remain unauthorized. Facts observed in E1 are marked `LIVE-META`; every other fact that needs live evidence stays `LIVE-PENDING`.
- **Sources.** Only the official Hyperliquid documentation (section 1) and the public metadata response E1 (section 10) were used. RitMEX and other bots were not consulted (THIRD_PARTY_BOUNDARY.md, IMPLEMENTATION_CONTRACT §12). No SDK was installed or read.
- **Reading method.** The pages were fetched on 2026-10-16 through a web reader that returns summaries and short quotes. The exchange endpoint page (about 119k characters) was read in two windows. Quotes in this audit are short excerpts. A reviewer should re-read the cited sections directly; pages can change without notice.

Evidence labels used below:

| Label | Meaning |
| --- | --- |
| `DOC` | Stated in the text of an official page. |
| `DOC-EXAMPLE` | Appears only in an official example (a request, a response or an error string), not as a stated rule. |
| `NOT-STATED` | The pages read do not say it. |
| `LIVE-META` | Observed in the recorded public `meta` response E1 (section 10). One snapshot; the adapter must still read it at startup. |
| `LIVE-PENDING` | Needs authorized read-only evidence (public metadata or a dedicated account's info reads). |

## 1. Official sources

No page shows an API version string or a revision date. All were fetched 2026-10-16.

| ID | URL | Used for |
| --- | --- | --- |
| S1 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api | Mainnet and testnet base URLs |
| S2 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size | Price and size precision |
| S3 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint | Order, cancel, cancelByCloid, scheduleCancel, modify, updateLeverage, updateIsolatedMargin, expiresAfter, vaultAddress, approveAgent, agentSendAsset, noop |
| S4 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint | openOrders, frontendOpenOrders, userFills, userFillsByTime, orderStatus, historicalOrders, userRateLimit, userRole, l2Book, pagination |
| S5 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals | meta, clearinghouseState, activeAssetData, userFunding |
| S6 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits | IP, address and WebSocket limits |
| S7 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions | orderUpdates, userFills, WsOrder, WsFill |
| S8 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats | 60 s idle timeout, ping/pong |
| S9 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets | Nonce rules, API wallet lifecycle |
| S10 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses | Batch error vectors, pre-validation errors |
| S11 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids | Asset index mapping |
| S12 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing | Two signing schemes |
| S13 | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types | GTC, ALO, IOC, reduce-only |
| S14 | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining | Cross/isolated margin, leverage rules |
| S15 | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications | Instrument type, settlement |
| S16 | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet | Testnet funding |

## 2. Required audit fields (VENUE_ADAPTER_CONTRACT §21)

```text
VENUE=HYPERLIQUID (default USDC perp DEX; BTC perpetual; HIP-3, spot and vaults out of scope)
AUDIT_DATE=2026-10-16
OFFICIAL_DOC_URLS=S1..S16 in section 1
API_VERSION=NOT-STATED (no version identifier or revision date on any page read; recorded as fetched 2026-10-16)
AUTH_METHOD=Info reads: unauthenticated POST /info keyed by a public account address (S4). Writes: POST /exchange with action, nonce and an ECDSA signature under one of two schemes, L1 action or user-signed (S3, S12), signed by the account key or an approved API ("agent") wallet; sub-accounts and vaults are signed by the master with vaultAddress (S3). No per-key permission model is documented.
MARKET_SYMBOL_RULES=Perp asset = integer index of the coin in meta.universe (S11; DOC-EXAMPLE "BTC = 0" on mainnet); coin name from meta (S5). Linear perpetual, USDC margined, no expiry (S15). LIVE-META: mainnet universe index 0 is "BTC", the only entry with that name, not delisted (E1). Still read and checked by name at startup, never hard-coded (H-13).
CLIENT_ORDER_ID_SUPPORT=Optional order field c (cloid), a 128-bit hex string (S3). cancelByCloid (S3) and orderStatus by cloid (S4). WsOrder carries cloid (S7). Fills do not (S4, S7). Engine mv1 IDs are not valid cloids; a deterministic mapping is required (H-01).
ORDER_LOOKUP_SEMANTICS=orderStatus by oid (u64) or cloid returns {order, status, statusTimestamp} or {"status":"unknownOid"} (S4). unknownOid is not proof that an order never existed.
OPEN_ORDER_SEMANTICS=openOrders and frontendOpenOrders for an account address (S4); frontendOpenOrders adds origSz, reduceOnly, orderType, trigger fields. The documented examples show no cloid (LIVE-PENDING). Default cap 1000 open orders (S6).
EXECUTION_HISTORY_SEMANTICS=userFills (2000 most recent); userFillsByTime with inclusive startTime/endTime, at most 2000 per response, and "only the 10000 most recent fills are available" (S4); WebSocket userFills with an isSnapshot first message (S7). Fill fields include oid, tid, px, sz, side, time, startPosition, dir, closedPnl, fee, feeToken, hash; no cloid.
EXECUTION_ID_STABILITY=tid is documented as "unique trade id" (S7). Whether a tid is unique per account fill or shared by both counterparties of one trade is NOT-STATED. hash is the L1 transaction hash and is not a fill identity.
PARTIAL_FILL_SEMANTICS=Each fill row carries its own tid, the order's oid and the fill sz (S4, S7). Order objects carry sz and origSz, but the docs do not define them (S4). aggregateByTime merges fills and must not be used.
LEVERAGE_SET=updateLeverage {asset, isCross, leverage (integer)} (S3); any integer from 1 to the asset's maxLeverage (S14). LIVE-META: BTC maxLeverage 40, margin table 56 "tiered 40x" (40x from notional 0, 20x from 150000000) (E1), so 5x is in range. An open position's leverage can be increased (S14); decreasing it or switching margin mode with an open position is NOT-STATED.
LEVERAGE_READBACK=activeAssetData(user, coin).leverage {type, value} (S5); clearinghouseState assetPositions[].position.leverage {type, value, rawUsd} while a position exists (S5). Neither response carries a timestamp of its own except clearinghouseState.time (undefined, see SERVER_TIMESTAMP).
ISOLATED_MARGIN=Supported (S14): updateLeverage with isCross=false. meta.universe carries onlyIsolated and marginMode ("strictIsolated", "noCross") per asset (S5). LIVE-META: the BTC entry carries neither field, so the metadata does not restrict BTC's margin mode; 8 of 234 entries carry onlyIsolated=true with marginMode "strictIsolated" (E1). Whether isolated 5x is accepted for BTC is proven only by the H-07 readback.
REDUCE_ONLY=Order flag r (S3). "An order that reduces a current position as opposed to opening a new position in the opposite direction" (S13). Statuses reduceOnlyRejected and reduceOnlyCanceled exist (S4). Oversize reduce-only behavior and the minimum order value for reduce-only orders are NOT-STATED.
PARTIAL_REDUCTION=A reduce-only order (IOC or GTC) smaller than the position (S3, S13). No dedicated close endpoint. Proof of reduction only by a fresh clearinghouseState (VENUE_ADAPTER_CONTRACT §17).
CANCEL_VERIFICATION=cancel and cancelByCloid return a per-request vector of "success" or the error "Order was never placed, already canceled, or filled" (S3, S10). Verification by orderStatus terminal status with statusTimestamp, open orders and fills by oid (S4).
SERVER_TIMESTAMP=UNPROVEN. No server-time endpoint is documented. clearinghouseState.time and l2Book.time exist but are not defined (S4, S5). Fills, orders and order statuses carry per-record times.
RATE_LIMITS=IP 1200 weight/min; exchange weight 1 + floor(batch_length / 40); info weight 2 (l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus), 60 (userRole), 20 (other), plus per-item extras for fill and order history. Address actions: 1 per 1 USDC of cumulative volume plus an initial 10000 buffer, then 1 per 10 s; cancels allowed up to min(limit + 100000, 2 * limit). WebSocket: 10 connections, 30 new connections/min, 1000 subscriptions, 10 unique users, 2000 messages/min, 100 inflight posts (S6). The response on hitting a limit is NOT-STATED.
MIN_QTY=No fixed minimum quantity documented. Quantity step = 10^-szDecimals from meta (S2). LIVE-META: BTC szDecimals 5, so the quantity step is 0.00001 BTC and perp prices allow at most 6 - 5 = 1 decimal (S2 rule applied to E1).
MIN_NOTIONAL=10 USDC by DOC-EXAMPLE only: the error "Order must have minimum value of $10." (S3) and status minTradeNtlRejected "order notional below minimum" (S4). Not stated as a rule on S2 or S15. The meta response has no minimum-value field (E1). LIVE-PENDING.
TESTNET_OR_SANDBOX=Testnet at https://api.hyperliquid-testnet.xyz (S1). The faucet gives 1000 mock USDC only to an address that has deposited on mainnet (S16). Behavioral differences from mainnet NOT-STATED; asset indices differ by network (S11 examples).
UNPROVEN_CAPABILITIES=serverTimestamp; fullFlatten (residual below the minimum order value, B4); executionCursor is UNSUPPORTED natively (substitute in H-03, section 7); plus the LIVE-PENDING facts and blockers in sections 5 and 8.
CANARY_ELIGIBLE=BLOCKED
```

`CANARY_ELIGIBLE=BLOCKED` rather than `NO`: no documented or observed fact disqualifies the venue, but blockers B1-B4 (section 5) cannot be cleared from documentation and public metadata alone. B5 was resolved by an owner decision. This is the audit's recommendation; the reviewer decides.

## 3. Capability object (VENUE_ADAPTER_CONTRACT §4)

Proposed values for the Phase 4.2 adapter's `capabilities()`. `PROVEN` here means an official documentation section states it, as §4 allows for `evidenceRef`. The only read-only evidence is the public metadata snapshot E1, which supports the `leverageSet` range and the `isolatedMargin` metadata check and nothing else in this table.

| Capability | Proposed | evidenceRef / reason |
| --- | --- | --- |
| `deterministicClientOrderId` | PROVEN | S3 order field `c`: client-chosen 128-bit hex cloid. Requires mapping H-01. Venue handling of a reused cloid is NOT-STATED, so a retry with the same cloid is not proven safe. |
| `orderLookupByClientId` | PROVEN | S4 orderStatus accepts a cloid. `unknownOid` is not absence proof (H-05). |
| `executionHistory` | PROVEN | S4 userFills, userFillsByTime. Retention limit: only the 10000 most recent fills. |
| `executionCursor` | UNSUPPORTED | No native cursor. Time-range queries with inclusive bounds only (S4). Substitute: bounded overlap query plus tid deduplication and an anchor check (H-03). |
| `stableExecutionId` | PROVEN | S7 WsFill `tid` "unique trade id"; S4 userFills carries tid. Scope (per account fill or per trade) NOT-STATED; H-02 adds a consistency check. |
| `partialFillIdentity` | PROVEN | S4, S7: each fill row has oid, tid and sz. Remaining quantity comes from the engine's own sum of fills, because order `sz`/`origSz` are undefined (S4). |
| `leverageSet` | PROVEN | S3 updateLeverage; S14 integer 1..maxLeverage. BTC maxLeverage 40 (E1, LIVE-META), so 5 is in range. |
| `leverageReadback` | PROVEN | S5 activeAssetData leverage {type, value}; clearinghouseState position leverage. |
| `isolatedMargin` | PROVEN | S14 isolated margin supported; S3 isCross=false. E1: BTC has no onlyIsolated/marginMode restriction. Mode switch with an open position NOT-STATED: set while flat (H-07). |
| `reduceOnly` | PROVEN | S3 flag `r`; S13 definition; S4 reduceOnlyRejected/reduceOnlyCanceled. |
| `partialPositionReduction` | PROVEN | Mechanism: reduce-only IOC/GTC order smaller than the position (S3, S13). Only a fresh position snapshot proves the result (§17). |
| `fullFlatten` | UNPROVEN | Mechanism exists (reduce-only IOC for the full size), but IOC can fill partly or not at all (S4 iocCancelRejected), and whether a residual below the minimum order value can be closed is NOT-STATED (B4). |
| `cancelSingle` | PROVEN | S3 cancel by oid, cancelByCloid. |
| `cancelAllOwned` | PROVEN | S3 cancel takes a batch of {asset, oid}; owned orders only. The account-wide scheduleCancel is not owned-scoped and is excluded (H-12). |
| `cancelVerification` | PROVEN | S4 orderStatus terminal statuses (canceled and others) with statusTimestamp. The cancel response alone is not verification (H-06). |
| `serverTimestamp` | UNPROVEN | No server-time endpoint; clearinghouseState.time and l2Book.time undefined (S4, S5). |
| `websocketOrders` | PROVEN | S7 orderUpdates (WsOrder with cloid, status, statusTimestamp). No sequence numbers or ordering guarantee documented. |
| `websocketExecutions` | PROVEN | S7 userFills subscription with tid and isSnapshot. No sequence numbers or ordering guarantee documented. |

## 4. Phase 4 audit matrix (TEST_FAULT_MATRIX §12)

| ID | Capability | Documented evidence | Open item |
| --- | --- | --- | --- |
| V-01 | market rules | Prices: at most 5 significant figures and at most `6 - szDecimals` decimals for perps; integer prices always allowed. Sizes rounded to szDecimals (S2). Min order value 10 by DOC-EXAMPLE (S3, S4). E1: BTC index 0, szDecimals 5, maxLeverage 40, no marginMode restriction. | Min order value: LIVE-PENDING (not in meta). The price rule is not a fixed tick (H-14). |
| V-02 | account snapshot | clearinghouseState: marginSummary and crossMarginSummary {accountValue, totalMarginUsed, totalNtlPos, totalRawUsd}, withdrawable, top-level `time` (S5). | `time` semantics undefined; queries must use the account address, not an agent address (H-04). |
| V-03 | position | assetPositions[].position: coin, szi (signed size), entryPx, positionValue, unrealizedPnl, leverage, liquidationPx, marginUsed, cumFunding (S5). | Sign convention of szi (positive long) is not stated in words (LIVE-PENDING). |
| V-04 | open orders | openOrders {coin, limitPx, oid, side, sz, timestamp}; frontendOpenOrders adds origSz, reduceOnly, orderType, trigger fields (S4). | cloid absent from the documented examples (LIVE-PENDING); ownership falls back to oid links (H-01). |
| V-05 | order lookup | orderStatus by oid or cloid; 29 documented statuses; `unknownOid` (S4). historicalOrders (2000 most recent) includes cloid (S4). | `unknownOid` right after a send is not absence proof (H-05). |
| V-06 | executions | userFills, userFillsByTime, WebSocket userFills; tid "unique trade id" (S4, S7). | Fills carry oid but not cloid (H-02); 10000-fill retention (H-03). Authoritative fill path exists in documentation, so the automatic blocker does not apply. |
| V-07 | partial fills | Fill rows per partial execution with oid, tid, sz, startPosition (S4, S7). | Order `sz`/`origSz` undefined; the engine sums fills. |
| V-08 | leverage | updateLeverage set (S3); activeAssetData and clearinghouseState readback (S5); integer 1..maxLeverage (S14). | Set while flat; exact readback comparison `{type: "isolated", value: 5}` (H-07). |
| V-09 | reduce-only | Flag `r` and definition (S3, S13); reduce-only statuses (S4). | Oversize and below-minimum behavior NOT-STATED. |
| V-10 | reduction | Reduce-only IOC with a bounded limit price; IOC may cancel unfilled remainder (S13, S4 iocCancelRejected). | Residual below 10 may be unclosable (B4). Bounded retries and fresh snapshot required. |
| V-11 | cancellation | Response vector "success" or the ambiguous error (S3, S10); terminal status via orderStatus (S4). | "success" treated as ACK, not confirmation (H-06). |
| V-12 | freshness | Per-record times on fills/orders; 60 s WebSocket idle timeout with ping/pong (S8); first subscription message isSnapshot (S7). | No server time; no WebSocket sequence numbers. Every reconnect needs a REST replay (H-08). |
| V-13 | rate limits | See RATE_LIMITS above (S6); userRateLimit info query {cumVlm, nRequestsUsed, nRequestsCap, nRequestsSurplus} (S4). | Limit-hit response NOT-STATED; the adapter must treat it as RATE_LIMIT or UNKNOWN_WRITE_OUTCOME (H-09). |
| V-14 | sandbox/testnet | Testnet URL (S1); faucet requires a mainnet deposit from the same address (S16). | Behavioral differences NOT-STATED; testnet indices differ. Testnet evidence is not mainnet evidence. |

## 5. Canary capability minimum (VENUE_ADAPTER_CONTRACT §22) and blockers

| §22 item | Documentation | Status |
| --- | --- | --- |
| Authoritative account/position snapshots | clearinghouseState (S5) | Mechanism documented; freshness unproven (B3) |
| Deterministic or otherwise safe order identity | cloid (S3) | Documented; mapping H-01 not built |
| Authoritative execution/fill provenance | userFills, WsFill with tid (S4, S7) | Documented; attribution by oid (H-02) |
| Partial-fill handling | Per-fill rows (S4, S7) | Documented |
| Cancellation and verification | cancel, orderStatus (S3, S4) | Documented |
| Bounded reduction/flatten | Reduce-only IOC (S3, S13) | Residual below minimum unproven (B4) |
| Leverage configuration/readback | updateLeverage, activeAssetData (S3, S5) | Documented; BTC maxLeverage 40 observed (E1); readback not observed (B1) |
| Market rules/precision/min-size | S2, S3 example, E1 | Index and szDecimals observed (E1); minimum order value DOC-EXAMPLE only (B1) |
| Freshness/timestamp semantics | Per-record times only | Unproven (B3) |
| Safe restart reconciliation | orderStatus, open orders, fills by time | Depends on H-01..H-03 being built and tested |

Blockers behind `CANARY_ELIGIBLE=BLOCKED`:

- **B1 — Account-scoped read-only evidence missing.** E1 settled BTC's asset index, szDecimals, maxLeverage and margin-mode metadata. Still LIVE-PENDING: the minimum order value, the meaning of order `sz`/`origSz`, the presence of cloid in open-order responses, tid behavior, the leverage readback and the `time` fields. The open-order fields, the `time` fields and the account's current leverage need info reads for a dedicated account address, a wider scope than the owner's 2026-10-16 approval as applied (Q2). The minimum order value, `sz`/`origSz` and tid behavior need real orders, so testnet or live writes, which are not authorized.
- **B2 — Withdrawal capability of an API wallet is not provable from the documentation.** S9 says API wallets "are only used to sign", but no page read says an API wallet cannot sign a withdrawal or a USDC transfer. S3 documents `agentSendAsset`, "Similar to send asset, but can be signed by an agent. Destination must match the source address." Hyperliquid has no per-key permission flag. AGENTS.md rule 8 and EXPERIMENT_SPEC §2 ("Withdrawal permission: disabled, mandatory") therefore cannot be shown satisfied. This needs official confirmation, recorded evidence or an explicit ruling (Q3). Open: the owner did not decide on 2026-10-16; the auditor's recommendation is in section 8. B2 blocks a live canary only, not read-only work.
- **B3 — Server time unproven.** No documented server clock. Freshness must be bounded by local receive time and per-record times (H-08), and the reviewer must accept that substitute or the risk inputs stay unproven.
- **B4 — Residual reduction below the minimum order value.** The docs do not say whether a reduce-only order below 10 is accepted. A grid partial fill can leave a residual of a few USDC. If such a residual cannot be closed, the hard-halt flatten path cannot always reach flat. Needs testnet or documentation evidence. Open: the owner did not decide on 2026-10-16; `fullFlatten` stays `UNPROVEN` (section 8).
- **B5 — Envelope currency. Resolved by owner decision on 2026-10-16.** EXPERIMENT_SPEC §2 states 100/30/150 USDT. Hyperliquid margins in USDC (S15: "USDC margining, USDT denominated linear contracts"). The owner decided that on Hyperliquid the envelope's "U" is USDC, with the numbers unchanged (Q1). This audit does not edit EXPERIMENT_SPEC; the reviewer decides whether the decision also needs a formal spec amendment.

Gate 4A also needs the read-only adapter and its conformance tests (IMPLEMENTATION_CONTRACT §7.2), and Gate 3 is not PASS. Neither exists yet, independently of B1-B4.

## 6. Envelope feasibility (EXPERIMENT_SPEC §3)

- Per-level target: 150 USDC gross over 10 levels, about 15 per level. Margin at 5x isolated: 150 / 5 = 30, equal to the margin budget.
- Units: on Hyperliquid the envelope's "U" is USDC, by owner decision (Q1, B5).
- Documented minimum (DOC-EXAMPLE): 10 per order. 15 per level is above it, so the envelope is compatible **if** quantity rounding allows it.
- Quantity per level must be `floor(15 / price, szDecimals)`, and each order must still satisfy `qty * price >= minNotional` while the sum stays at or below 150. With one quantity step worth `price * 10^-szDecimals`, the envelope fails if no multiple of the step lies between the minimum and 15. If it fails, the program must report the incompatibility and must not raise leverage, margin or notional (EXPERIMENT_SPEC §3).
- With BTC szDecimals 5 (E1), one step is worth `price * 0.00001`, so `floor(15 / price, 5) * price` is more than `15 - price * 0.00001`. That is at least 10 for any price up to 500000. Rounding alone therefore cannot push a 15-per-level BTC order below the documented minimum unless BTC trades above 500000. The minimum itself is still DOC-EXAMPLE only (B1).
- maxLeverage 40 (E1) is above the frozen 5x, and nothing in E1 forbids isolated margin for BTC.
- Partial fills can create exit orders below the minimum (B4). That is a strategy/risk design question for a later phase, not something this audit resolves.

## 7. Requirements for later phases

These follow from the documentation. They are requirements on later checkpoints, not implemented here.

- **H-01 cloid mapping.** The engine's `mv1` + 20 hex IDs (23 characters) are not valid cloids (`0x` + 32 hex). The adapter needs a deterministic, domain-separated mapping to 128 bits, stored with the intent, with collision checks that fail closed. Ownership classification must recognize mapped cloids; until then every engine order classifies `UNOWNED` (CURRENT_STATUS, Phase 3C limitation 5). If open-order responses carry no cloid (V-04), ownership must come from the registry's oid link, and an unlinked oid needs an orderStatus lookup; an order that stays unlinked is `AMBIGUOUS` and blocks.
- **H-02 Fill attribution.** Fills carry oid and tid but not cloid. The adapter must attach the engine client ID through the registry's oid link (from the place ACK's `resting.oid`/`filled.oid` or an orderStatus by cloid) before handing executions to the core; an unattributed fill stays a blocker (CURRENT_STATUS, Phase 3D limitations 1 and 11). The adapter must not drop a repeated tid: the core skips identical repeats and reports a tid with different facts as `EXECUTION_CONFLICT` or `EXECUTION_ID_COLLISION`.
- **H-03 Execution replay without a native cursor.** Query userFillsByTime from the checkpoint's last execution time (inclusive bounds give overlap) and keep only the configured coin. Overlapping rows are passed to the core, which skips identical repeats by execution ID (tid). Page by the last returned time. Never infer completeness from a page count: S4 states both 500 and 2000 as limits. A full page whose last time equals its start time cannot advance and must fail closed. Because only the 10000 most recent fills are retained, the checkpoint's last tid must reappear in the overlap page; if it does not, the cursor is stale and must be refused (Phase 3D limitation 9). Never set `aggregateByTime`.
- **H-04 Account address.** Info queries must use the master or sub-account address; an agent address returns empty results (S4). Before trusting an empty position or order list, the adapter must confirm the configured address with `userRole` (`user` or `subAccount`, never `agent` or `missing`).
- **H-05 Write outcomes.** Order and cancel responses are vectors matching the batch; a pre-validation error is one error for the whole payload (S10). `filled {totalSz, avgPx, oid}` in a place response is an ACK, not fill evidence (no tid). `unknownOid` right after an ambiguous send is not proof of non-arrival.
- **H-06 Cancel.** "success" is an ACK. Confirmation needs a terminal orderStatus or fresh open orders plus fills by oid. The error "never placed, already canceled, or filled" is a reconciliation case. Do not resend a cancel whose result already returned (S6).
- **H-07 Leverage and margin mode.** Set `isCross=false, leverage=5` while flat, read back through activeAssetData and compare `{type, value}` exactly. A mismatch or a missing readback blocks live-capable continuation (§18).
- **H-08 Freshness and WebSocket.** No server clock and no WebSocket sequence numbers. Every connection, including the first, calls `executionStreamReconnected()` and is followed by a REST replay (Phase 3D limitation 7). Every streamed execution has a null sequence and blocks risk increase until a replay (Phase 3D limitation 4). Send `{"method":"ping"}` within the 60 s idle timeout (S8). Record `clearinghouseState.time` as venue-reported, not as a proven server clock.
- **H-09 Rate limits.** Track IP weight locally and read `userRateLimit` as a risk input; low address headroom should block risk increase so that cancels and reductions keep headroom (cancels have the larger limit). Hitting a limit on a mutation is `UNKNOWN_WRITE_OUTCOME` unless the response proves no commit.
- **H-10 `expiresAfter`.** It can bound how long an ambiguous order stays live, at 5x address-limit cost when it fires (S3). Whether to use it is a later design decision.
- **H-11 Nonces and API wallets.** Nonces must be unique per signer: one of the 100 highest stored, larger than the smallest, inside (T - 2 days, T + 1 day) (S9). Use a separate API wallet per process and never reuse an API wallet address, because pruned nonce state allows replay of old signed actions (S9). An account holds 1 unnamed and up to 3 named API wallets; expiry at most 180 days (S3).
- **H-12 Account-wide cancel.** `scheduleCancel` cancels all orders of the account, at most 10 triggers per day (S3). It is not owned-scoped and needs an explicit live-canary contract before use (§16). The same applies to the `noop` nonce-invalidation action that S3 suggests for cancelling in-flight orders.
- **H-13 Asset IDs.** Read the BTC index from `meta` at startup and verify it by name. Testnet and mainnet indices differ. Reject delisted assets (`isDelisted`). E1 lists 56 delisted entries among 234, so the universe is not a list of live markets.
- **H-14 Price rule versus `MarketRules.priceTick`.** The 5-significant-figure rule is not a fixed tick: the allowed increment depends on the price's magnitude, and integer prices are always allowed (S2). `MarketRules.priceTick: DecimalString` (VENUE_ADAPTER_CONTRACT §6) cannot express it. Phase 4.2 must either compute a tick for the price band in use and refuse prices outside it, or propose a contract change. Strip trailing zeros in signed payloads (S2). For BTC with szDecimals 5 (E1) the S2 rule gives: at or above 10000 every integer price is valid and no fractional price is, so the increment there is exactly 1; from 1000 to below 10000 it is 0.1. This is a derivation from S2 and E1, not an observed order result.
- **H-15 Never-sent actions.** The engine must never construct user-signed fund movements or agent management actions: withdrawals, `usdSend`, `sendAsset`, `agentSendAsset`, `approveAgent`. A static guard should enforce this once signing exists.
- **H-16 SDK decision (IMPLEMENTATION_CONTRACT §11).** No SDK for Phase 4.2. Read-only info queries need no signing and are plain HTTPS JSON. The docs reference a Python SDK for the two signing schemes (S12); any SDK or signing library is a later, separately reviewed decision including its license.
- **H-17 Transport policy (§20).** Timeouts, retryable reads, backoff and maximum retries are defined in Phase 4.2. Mutations are never retried automatically.

## 8. Questions for the owner or reviewer, and answers

The questions as first asked, with the owner's answers of 2026-10-16:

- **Q1 (B5).** Does the frozen envelope's "USDT" mean USDC on Hyperliquid, or does EXPERIMENT_SPEC need a contract change?
  - Answer: 「可以換」 ("it can be switched"). Recorded reading: on Hyperliquid the envelope's "U" is USDC, and the numbers are unchanged (capital 100, margin 30, gross notional 150, daily PnL halt -5, drawdown halt 10). No USDT/USDC conversion is modeled. The `FROZEN_*_USDT` code constants keep their names, because their values are unit-free decimal strings. EXPERIMENT_SPEC is not edited here.
- **Q2 (B1).** Is read-only networking authorized for evidence? Options, narrowest first: public `meta` only; testnet info reads; info reads for one dedicated mainnet address. None needs a credential, because info reads take a public address.
  - Answer: 「好」 ("OK"), without choosing a scope. Applied: the narrowest scope, one public mainnet `meta` read (E1). Testnet info reads and address-scoped info reads need the owner to choose that scope, and the address-scoped option also needs the address. Credentials and writes remain unauthorized.
- **Q3 (B2).** What evidence of "withdrawal disabled" will the live-canary contract accept, given that Hyperliquid API wallets have no documented permission flag?
  - Answer: the owner did not understand the question and made no decision. The auditor recommends that the later live-canary contract require all three of the following:
    1. Direct evidence that an API wallet cannot move funds: an archived official Hyperliquid statement, or a recorded testnet test in which every fund-moving action signed by an API wallet is rejected. The test needs a separate authorization: a testnet credential, testnet writes, and a mainnet deposit for the faucet (S16).
    2. Compensating controls in any case: a dedicated master account that holds only the experiment's funds, the master key never on the trading host, and an engine that never constructs fund-moving actions (H-15, static guard).
    3. Without part 1, Hyperliquid stays not live-eligible. This audit does not waive AGENTS.md rule 8.
- **Q4 (B4).** Should testnet evidence be collected for reduce-only orders below the minimum order value, or does the strategy need a rule that avoids such residuals?
  - Answer: the owner did not know and made no decision. The auditor recommends failing closed now. `fullFlatten` stays `UNPROVEN`. A nonzero residual after a reduction attempt is not flat, so under AGENTS.md the halt stays `HALTED`. Resolve this later with testnet evidence under the same separate authorization as Q3. A strategy rule can only make such residuals rarer, because the venue decides partial fills, and it must never add exposure to lift a residual above the minimum.

## 9. Non-claims

- This audit does not pass Gate 4A and does not authorize a read-only adapter to connect anywhere.
- `PROVEN` in section 3 is documentation-level and is the auditor's proposal.
- E1 is one public snapshot. It shows nothing about account, order, fill, leverage-readback or time behavior, and the metadata can change after 2026-10-16.
- The owner's answers in section 8 are recorded decisions, not reviewer acceptance.
- Nothing here is evidence of live readiness. Live writes need a separate commit-bound live-canary contract.

## 10. Read-only evidence log

E1 is the only request this audit sent to Hyperliquid.

```text
EVIDENCE_ID=E1
REQUEST=POST https://api.hyperliquid.xyz/info, header Content-Type: application/json, body {"type":"meta"}
AUTH=none; no account address; no credential
CLIENT=curl 8.7.1, agent session on the owner's workstation
SENT_UTC=2026-10-16T14:18:42Z (local clock)
RESPONSE_STATUS=200, Content-Type application/json
RESPONSE_DATE_HEADER=Fri, 16 Oct 2026 14:18:43 GMT (served through CloudFront; not a venue clock, B3)
RESPONSE_BYTES=17628
RESPONSE_SHA256=aa725f96351e898c95ab7cbc4062208200ea4fa7346478a10f60748e928b82e5
TOP_LEVEL_KEYS=universe, marginTables, collateralToken
UNIVERSE_ENTRIES=234 (56 with isDelisted=true; 8 with onlyIsolated=true, the same 8 with marginMode "strictIsolated")
UNIVERSE_ENTRY_KEYS=isDelisted, marginMode, marginTableId, maxLeverage, name, onlyIsolated, szDecimals (union; absent keys are omitted per entry)
BTC_INDEX=0 (the only entry named "BTC")
BTC_ENTRY={"szDecimals":5,"name":"BTC","maxLeverage":40,"marginTableId":56}
BTC_MARGIN_TABLE=[56,{"description":"tiered 40x","marginTiers":[{"lowerBound":"0.0","maxLeverage":40},{"lowerBound":"150000000.0","maxLeverage":20}]}]
COLLATERAL_TOKEN=0 (a spot token index; its name needs spotMeta, which was not read)
RAW_RESPONSE_COMMITTED=NO
```

The raw response is not committed. It is exchange data that changes over time, and the fields used are quoted above. A reviewer can repeat the request; a different hash is expected once the universe changes.
