# Hyperliquid venue capability audit (2026-10-16)

Phase 4.1 deliverable for IMPLEMENTATION_CONTRACT §7.1 and VENUE_ADAPTER_CONTRACT §21. This audit rests on the official documentation plus one public metadata read (E1, section 10). It is not a gate decision; the independent reviewer decides Gate 4A. It was corrected on 2026-10-20 after the independent review's `REJECT` (issue #27); see the correction note below.

```text
EVIDENCE_LEVEL=OFFICIAL_DOCUMENTATION_PLUS_ONE_PUBLIC_METADATA_READ
READ_ONLY_VENUE_EVIDENCE=PUBLIC_META_ONLY (E1, section 10); no account-scoped read
NETWORK_CALLS_TO_HYPERLIQUID_API=1 (mainnet POST /info {"type":"meta"}, unauthenticated, no account address, 2026-10-16)
NETWORK_CALLS_TO_HYPERLIQUID_API_FOR_2026_10_20_CORRECTION=0 (documentation pages only, listed in the correction note)
CREDENTIALS_CREATED_OR_USED=NONE
LIVE_EXCHANGE_WRITE=NO
GATE_DEVIATION=Phase 4 started without Gate 3 PASS, by owner authorization on 2026-10-16
INDEPENDENT_REVIEW=REJECT on 2026-10-18 (issue #27, reviewed SHA 49e6594728d9f374bb5198837485e56e31cf5c91); this corrected version is not yet reviewed
```

## Correction of 2026-10-20

The independent content review of 2026-10-18 (issue #27) returned `REJECT` with seven findings. This revision corrects the audit for those findings and the related rulings. Where a statement changed, the new text supersedes the 2026-10-16 text; the reviewed original stays available at `49e6594728d9f374bb5198837485e56e31cf5c91`.

| Finding | Correction | Where |
| --- | --- | --- |
| 1 `expiresAfter` | An action deadline, not an order lifetime. It never resolves an accepted order or releases a reservation. `scheduleCancel` is a separate account-wide operation. | H-10, H-12 |
| 2 bare `tid` | S7 defines `tid` as a 50-bit hash of the two order IDs and gives `(block_time, coin, tid)` for global uniqueness. `stableExecutionId` changes to `UNPROVEN`; bare-`tid` deduplication and the last-`tid` anchor are withdrawn. | §2, §3, V-06, H-02, H-03, B6 |
| 3 account mode | A supported-mode precondition through `userAbstraction`; unified account and portfolio margin are refused, the other values stay unproven, and spot support is not added. | V-02, §5, H-04, H-15, B7 |
| 4 currency | Owner preference received; formal amendment outstanding (`docs/change-requests/CR-2026-10-20-USDC-ENVELOPE.md`, not approved). | B5, §6, Q1 |
| 5 minimum value | S10 lists `MinTradeNtl`, "Order must have minimum value of $10.", as a documented rejection condition. Reduce-only exceptions and actual eligibility stay unproven. | §2, §3, V-01, §5, B1, B4, §6 |
| 6 server time | S7 documents `WebData3.userState.serverTime`. Its unit, freshness and suitability for risk are unproven, so `serverTimestamp` stays `UNPROVEN` with a corrected reason. | §2, §3, V-12, §5, B3, H-08 |
| 7 fund movements | External withdrawals and transfers are separated from same-address collateral movement. The withdrawal prohibition stands; no waiver. | B2, H-15, Q3 |

The rulings are applied as follows: ruling 2 (E1) in section 10; ruling 3 (capability values) in section 3; ruling 4 (fill provenance) in V-06 and B6; ruling 5 (blocker list) in section 5; ruling 6 (currency) in B5 and Q1; ruling 7 (Q3/Q4) in section 8; ruling 8 (rounding) in section 6; ruling 9 (price band) in H-14.

**How the correction was checked.** On 2026-10-20 the official GitBook pages below were downloaded as Markdown (page URL plus `.md`) and searched as plain text. Every statement this correction adds or changes rests on that text, not on the 2026-10-16 web reader. No request went to `api.hyperliquid.xyz`, to the testnet API or for any account address. The pages change without notice; the hashes record what was read.

| Page | Bytes | SHA-256 |
| --- | ---: | --- |
| S2 | 1561 | `1114a12bc134c7d0e004002e67a3103bb7835f13ec34329d5409c1f895830a10` |
| S3 | 119366 | `6df658a502e587db9cd5ae4bbe30c4e7cfde8e8a96cd5b11d6ca1ea39928c687` |
| S4 | 55013 | `f4228fc7734af5dbf420e5bdf2b25c248a5b5287035ab2d8a645dc14ce64f0bd` |
| S5 | 32182 | `1b9d14665c030b68d257a29f365489be3074bb3a0e57a83069966174cbe790ae` |
| S7 | 18671 | `a2d5cc74efc59d0df2e65c77a769bdc06696fd73cb9ad0e6446913e682c0e136` |
| S9 | 4342 | `e63b1672b6d05dddc9b61e327c16e769024140e32482d5627f037c1eafe9b6c2` |
| S10 | 4080 | `f094b0d8eb40cee3c0ef8d22fbb60032e82382bd7d641bd2d144186af6d92595` |
| S13 | 4926 | `9153f790a0d45f6de7334bad6c98f880241577c4168b66d661d6204dafae3512` |
| S15 | 5192 | `59ef08be4b7e3d7cc0f4245abd4f133d743a983820df5b2ef0ce1ceb6af50ea3` |

S1, S6, S8, S11, S12, S14 and S16 were not re-read. Statements that cite only those pages are unchanged and keep the 2026-10-16 reading method.

## 0. Scope and boundary

- **Venue and market.** Hyperliquid perpetuals on the default, validator-operated USDC perp DEX, BTC perpetual (EXPERIMENT_SPEC §2). Builder-deployed (HIP-3) perps, spot, vaults, TWAP and trigger orders are out of scope.
- **Gate deviation.** IMPLEMENTATION_CONTRACT §7 says Phase 4 starts only after Gate 3 `PASS`. On 2026-10-16 the owner asked for both the Gate 3 review brief (issue #24) and Phase 4 ("都做"). Gate 3 review is pending. This audit is therefore a recorded deviation, and it does not change any Phase 3 code. Issue #27 ruling 10 accepts the disclosure, not retroactive gate acceptance.
- **Authorization boundary.** The first version of this audit sent no request to `api.hyperliquid.xyz` or `api.hyperliquid-testnet.xyz`, because exchange networking was unauthorized. On 2026-10-16 the owner approved read-only networking for evidence (Q2, section 8) without choosing among the offered scopes, so the narrowest one was applied: a single public mainnet `meta` read (E1). Testnet reads, account-address reads, credentials and every write remain unauthorized. The 2026-10-20 correction sent no request to either API, and issue #27 authorizes no additional exchange networking. Facts observed in E1 are marked `LIVE-META`; every other fact that needs live evidence stays `LIVE-PENDING`.
- **Sources.** Only the official Hyperliquid documentation (section 1) and the public metadata response E1 (section 10) were used. RitMEX and other bots were not consulted (THIRD_PARTY_BOUNDARY.md, IMPLEMENTATION_CONTRACT §12). No SDK was installed or read.
- **Reading method.** The pages were fetched on 2026-10-16 through a web reader that returns summaries and short quotes. The exchange endpoint page (about 119k characters) was read in two windows. On 2026-10-18 the reviewer read S1-S16 directly as Markdown, and its findings supersede the summarizer-derived statements where they disagree (issue #27 ruling 1). On 2026-10-20 nine pages were re-read as Markdown for this correction (correction note). Quotes in this audit are short excerpts.

Evidence labels used below:

| Label | Meaning |
| --- | --- |
| `DOC` | Stated in the text of an official page. |
| `DOC-EXAMPLE` | Appears only in an official example (a request, a response or an error string), not as a stated rule. |
| `NOT-STATED` | The pages read do not say it. |
| `LIVE-META` | Observed in the recorded public `meta` response E1 (section 10). One historical snapshot whose bytes were not retained (issue #27 ruling 2); the adapter must still read it at startup. |
| `LIVE-PENDING` | Needs authorized read-only evidence (public metadata or a dedicated account's info reads). |

## 1. Official sources

No page shows an API version string or a revision date. All were fetched 2026-10-16. S2, S3, S4, S5, S7, S9, S10, S13 and S15 were fetched again on 2026-10-20 (correction note).

| ID | URL | Used for |
| --- | --- | --- |
| S1 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api | Mainnet and testnet base URLs |
| S2 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size | Price and size precision |
| S3 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint | Order, cancel, cancelByCloid, scheduleCancel, modify, updateLeverage, updateIsolatedMargin, expiresAfter, vaultAddress, approveAgent, fund-moving actions (withdraw3, usdSend, spotSend, sendAsset, agentSendAsset, usdClassTransfer and others), account-abstraction actions, noop |
| S4 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint | openOrders, frontendOpenOrders, userFills, userFillsByTime, orderStatus, historicalOrders, userRateLimit, userRole, userAbstraction, l2Book, pagination |
| S5 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals | meta, clearinghouseState (including its unified-account note), activeAssetData, userFunding |
| S6 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits | IP, address and WebSocket limits |
| S7 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions | orderUpdates, userFills, WsOrder, WsFill, WsTrade, WebData3 |
| S8 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats | 60 s idle timeout, ping/pong |
| S9 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets | Nonce rules, API wallet lifecycle |
| S10 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses | Batch error vectors, pre-validation errors, MinTradeNtl |
| S11 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids | Asset index mapping |
| S12 | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing | Two signing schemes |
| S13 | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types | GTC, ALO, IOC, reduce-only |
| S14 | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining | Cross/isolated margin, leverage rules |
| S15 | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications | Instrument type, settlement, collateral and price currency |
| S16 | https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet | Testnet funding |

## 2. Required audit fields (VENUE_ADAPTER_CONTRACT §21)

```text
VENUE=HYPERLIQUID (default USDC perp DEX; BTC perpetual; HIP-3, spot and vaults out of scope)
AUDIT_DATE=2026-10-16 (corrected 2026-10-20)
OFFICIAL_DOC_URLS=S1..S16 in section 1
API_VERSION=NOT-STATED (no version identifier or revision date on any page read; recorded as fetched 2026-10-16, partly re-fetched 2026-10-20)
AUTH_METHOD=Info reads: unauthenticated POST /info keyed by a public account address (S4). Writes: POST /exchange with action, nonce and an ECDSA signature under one of two schemes, L1 action or user-signed (S3, S12), signed by the account key or an approved API ("agent") wallet; sub-accounts and vaults are signed by the master with vaultAddress (S3). No per-key permission model is documented.
MARKET_SYMBOL_RULES=Perp asset = integer index of the coin in meta.universe (S11; DOC-EXAMPLE "BTC = 0" on mainnet); coin name from meta (S5). Linear perpetual, USDC margined, no expiry (S15). The oracle price is denominated in USDT, the collateral is USDC, and "no conversions with the USDC/USDT exchange rate are applied" (S15). LIVE-META: mainnet universe index 0 is "BTC", the only entry with that name, not delisted (E1). Still read and checked by name at startup, never hard-coded (H-13).
CLIENT_ORDER_ID_SUPPORT=Optional order field c (cloid), a 128-bit hex string (S3). cancelByCloid (S3) and orderStatus by cloid (S4). WsOrder carries cloid (S7). Fills do not (S4, S7). Engine mv1 IDs are not valid cloids; a deterministic mapping is required (H-01).
ORDER_LOOKUP_SEMANTICS=orderStatus by oid (u64) or cloid returns {order, status, statusTimestamp} or {"status":"unknownOid"} (S4). unknownOid is not proof that an order never existed.
OPEN_ORDER_SEMANTICS=openOrders and frontendOpenOrders for an account address (S4); frontendOpenOrders adds origSz, reduceOnly, orderType, trigger fields. The documented examples show no cloid (LIVE-PENDING). Default cap 1000 open orders (S6).
EXECUTION_HISTORY_SEMANTICS=userFills (2000 most recent); userFillsByTime with inclusive startTime/endTime, at most 2000 per response, and "only the 10000 most recent fills are available" (S4); time-range responses "will only return 500 elements or distinct blocks of data", paged by using "the last returned timestamp as the next startTime" (S4 Pagination); WebSocket userFills with an isSnapshot first message (S7). Fill fields include oid, tid, px, sz, side, time, startPosition, dir, closedPnl, fee, feeToken, hash; no cloid.
EXECUTION_ID_STABILITY=UNPROVEN. WsFill and userFills carry tid, labeled "unique trade id" (S7). The WsTrade definition on the same page qualifies it: "tid is 50-bit hash of (buyer_oid, seller_oid)" and "For a globally unique trade id, use (block_time, coin, tid)" (S7). So bare tid is not documented as unique: both sides of a trade derive it from the same order pair, and a 50-bit hash is not documented as collision-free. Fills expose time, but the pages do not say it is the block time, and they do not say that a REST fill and a WebSocket fill for the same execution carry identical values. No account- and market-scoped execution identity is documented. hash is the L1 transaction hash and is not a fill identity. Candidate key for later evidence in H-02.
PARTIAL_FILL_SEMANTICS=Each fill row carries the order's oid, its tid and the fill sz (S4, S7); tid alone is not a fill identity (EXECUTION_ID_STABILITY). Order objects carry sz and origSz, but the docs do not define them (S4). aggregateByTime merges fills and must not be used.
LEVERAGE_SET=updateLeverage {asset, isCross, leverage (integer)} (S3); any integer from 1 to the asset's maxLeverage (S14). LIVE-META: BTC maxLeverage 40, margin table 56 "tiered 40x" (40x from notional 0, 20x from 150000000) (E1), so 5x is in range. An open position's leverage can be increased (S14); decreasing it or switching margin mode with an open position is NOT-STATED.
LEVERAGE_READBACK=activeAssetData(user, coin).leverage {type, value} (S5); clearinghouseState assetPositions[].position.leverage {type, value, rawUsd} while a position exists (S5). Neither response carries a timestamp of its own except clearinghouseState.time (undefined, see SERVER_TIMESTAMP).
ISOLATED_MARGIN=Supported (S14): updateLeverage with isCross=false. meta.universe carries onlyIsolated and marginMode ("strictIsolated", "noCross") per asset (S5). LIVE-META: the BTC entry carries neither field, so the metadata does not restrict BTC's margin mode; 8 of 234 entries carry onlyIsolated=true with marginMode "strictIsolated" (E1). Whether isolated 5x is accepted for BTC is proven only by the H-07 readback.
REDUCE_ONLY=Order flag r (S3). "An order that reduces a current position as opposed to opening a new position in the opposite direction" (S13). Statuses reduceOnlyRejected and reduceOnlyCanceled exist (S4). Oversize reduce-only behavior and whether the MinTradeNtl minimum applies to reduce-only orders are NOT-STATED.
PARTIAL_REDUCTION=A reduce-only order (IOC or GTC) smaller than the position (S3, S13). No dedicated close endpoint. Proof of reduction only by a fresh clearinghouseState (VENUE_ADAPTER_CONTRACT §17).
CANCEL_VERIFICATION=cancel and cancelByCloid return a per-request vector of "success" or the error "Order was never placed, already canceled, or filled" (S3, S10). Verification by orderStatus terminal status with statusTimestamp, open orders and fills by oid (S4).
SERVER_TIMESTAMP=UNPROVEN. No server-time endpoint is documented on the pages read. S7 documents WebData3.userState.serverTime (a number) in an aggregate described as "used primarily for the frontend"; its unit, its relation to the state it accompanies and any freshness guarantee are NOT-STATED. clearinghouseState.time and l2Book.time exist but are not defined (S4, S5). Fills, orders and order statuses carry per-record times. A documented timestamp field is not proven freshness, and a local receipt time alone does not prove that the underlying state is fresh.
RATE_LIMITS=IP 1200 weight/min; exchange weight 1 + floor(batch_length / 40); info weight 2 (l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState, exchangeStatus), 60 (userRole), 20 (other), plus per-item extras for fill and order history. Address actions: 1 per 1 USDC of cumulative volume plus an initial 10000 buffer, then 1 per 10 s; cancels allowed up to min(limit + 100000, 2 * limit). WebSocket: 10 connections, 30 new connections/min, 1000 subscriptions, 10 unique users, 2000 messages/min, 100 inflight posts (S6). The response on hitting a limit is NOT-STATED.
MIN_QTY=No fixed minimum quantity documented. Quantity step = 10^-szDecimals from meta (S2). LIVE-META: BTC szDecimals 5, so the quantity step is 0.00001 BTC and perp prices allow at most 6 - 5 = 1 decimal (S2 rule applied to E1).
MIN_NOTIONAL=$10 order value, DOC: S10 lists the order error type MinTradeNtl, "Order must have minimum value of $10."; S4 lists the order status minTradeNtlRejected, "Rejected due to order notional below minimum"; S3 shows the same string in a response example. The pages do not say at which price the value is computed, whether reduce-only orders are exempt, or whether the threshold differs by asset. The meta response has no minimum-value field (E1). Whether a given order is accepted is LIVE-PENDING.
TESTNET_OR_SANDBOX=Testnet at https://api.hyperliquid-testnet.xyz (S1). The faucet gives 1000 mock USDC only to an address that has deposited on mainnet (S16). Behavioral differences from mainnet NOT-STATED; asset indices differ by network (S11 examples).
UNPROVEN_CAPABILITIES=stableExecutionId (finding 2, B6); serverTimestamp (B3); fullFlatten (residual below the minimum order value, B4); executionCursor is UNSUPPORTED natively (adapter-owned checkpoint with bounded overlap, H-03); supported account abstraction mode (B7); plus the LIVE-PENDING facts and blockers in sections 5 and 8.
CANARY_ELIGIBLE=BLOCKED
```

`CANARY_ELIGIBLE=BLOCKED` rather than `NO`: no documented or observed fact disqualifies the venue, but blockers B1-B7 (section 5) cannot be cleared from documentation and public metadata alone. B5's formal amendment is outstanding. This is the audit's recommendation; the reviewer decides.

## 3. Capability object (VENUE_ADAPTER_CONTRACT §4)

Proposed values for the Phase 4.2 adapter's `capabilities()`. `PROVEN` here means an official documentation section describes the mechanism, as §4 allows for `evidenceRef`. It is mechanism-level only: it does not mean completed adapter behavior, safe retries, observed BTC configuration or canary qualification (issue #27 ruling 3). Where the required account-scoped evidence stays unavailable, Phase 4.2 must still mark the dependent capability `UNPROVEN` under IMPLEMENTATION_CONTRACT §7.2. The only read-only evidence is the public metadata snapshot E1, which supports the `leverageSet` range and the `isolatedMargin` metadata check and nothing else in this table.

| Capability | Proposed | evidenceRef / reason |
| --- | --- | --- |
| `deterministicClientOrderId` | PROVEN | S3 order field `c`: client-chosen 128-bit hex cloid. Requires mapping H-01. Venue handling of a reused cloid is NOT-STATED, so a retry with the same cloid is not proven safe. |
| `orderLookupByClientId` | PROVEN | S4 orderStatus accepts a cloid. `unknownOid` is not absence proof (H-05). |
| `executionHistory` | PROVEN | S4 userFills, userFillsByTime. Retention limit: only the 10000 most recent fills. |
| `executionCursor` | UNSUPPORTED | No native stable cursor. Time-range queries with inclusive bounds, paged by the last returned timestamp (S4). Substitute: an adapter-owned checkpoint with bounded overlap replay (H-03), which depends on the unproven execution identity (`stableExecutionId`). |
| `stableExecutionId` | UNPROVEN | S7 WsFill and S4 userFills carry `tid`, but S7 WsTrade defines it as a 50-bit hash of (buyer_oid, seller_oid) and gives (block_time, coin, tid) for global uniqueness. Fill `time` versus block time and REST/WebSocket equivalence are NOT-STATED. Collision detection fails closed but does not prove uniqueness (H-02, B6). |
| `partialFillIdentity` | PROVEN | S4, S7: each fill row has oid, tid and sz. Mechanism only: these fields do not make `tid` a fill identity (`stableExecutionId`). Remaining quantity comes from the engine's own sum of fills, because order `sz`/`origSz` are undefined (S4). |
| `leverageSet` | PROVEN | S3 updateLeverage; S14 integer 1..maxLeverage. BTC maxLeverage 40 (E1, LIVE-META), so 5 is in range. |
| `leverageReadback` | PROVEN | S5 activeAssetData leverage {type, value}; clearinghouseState position leverage. |
| `isolatedMargin` | PROVEN | S14 isolated margin supported; S3 isCross=false. E1: BTC has no onlyIsolated/marginMode restriction. Mode switch with an open position NOT-STATED: set while flat (H-07). |
| `reduceOnly` | PROVEN | S3 flag `r`; S13 definition; S4 reduceOnlyRejected/reduceOnlyCanceled. |
| `partialPositionReduction` | PROVEN | Mechanism: reduce-only IOC/GTC order smaller than the position (S3, S13). Only a fresh position snapshot proves the result (§17). |
| `fullFlatten` | UNPROVEN | Mechanism exists (reduce-only IOC for the full size), but IOC can fill partly or not at all (S4 iocCancelRejected), and S10 does not say whether its MinTradeNtl rejection at $10 also applies to a reduce-only order that closes a smaller residual (B4). |
| `cancelSingle` | PROVEN | S3 cancel by oid, cancelByCloid. |
| `cancelAllOwned` | PROVEN | S3 cancel takes a batch of {asset, oid}; owned orders only. Owned scope depends on proven ownership (H-01): until the mapping exists, no order counts as owned. The account-wide scheduleCancel is not owned-scoped and is excluded (H-12). |
| `cancelVerification` | PROVEN | S4 orderStatus terminal statuses (canceled and others) with statusTimestamp. The cancel response alone is not verification (H-06). |
| `serverTimestamp` | UNPROVEN | No server-time endpoint on the pages read. S7 WebData3.userState.serverTime is documented, but its unit and freshness are NOT-STATED and the aggregate is frontend-oriented. clearinghouseState.time and l2Book.time are undefined (S4, S5). |
| `websocketOrders` | PROVEN | S7 orderUpdates (WsOrder with cloid, status, statusTimestamp). No sequence numbers or ordering guarantee documented. |
| `websocketExecutions` | PROVEN | S7 userFills subscription with tid and isSnapshot. No sequence numbers or ordering guarantee documented. |

## 4. Phase 4 audit matrix (TEST_FAULT_MATRIX §12)

| ID | Capability | Documented evidence | Open item |
| --- | --- | --- | --- |
| V-01 | market rules | Prices: at most 5 significant figures and at most `6 - szDecimals` decimals for perps; integer prices always allowed. Sizes rounded to szDecimals (S2). Minimum order value $10: S10 MinTradeNtl rejection condition (DOC), with S4 status minTradeNtlRejected and an S3 response example. E1: BTC index 0, szDecimals 5, maxLeverage 40, no marginMode restriction. | Reduce-only exception, the price used for the value and the acceptance of a given order: LIVE-PENDING (not in meta). The price rule is not a fixed tick (H-14). |
| V-02 | account snapshot | clearinghouseState: marginSummary and crossMarginSummary {accountValue, totalMarginUsed, totalNtlPos, totalRawUsd}, withdrawable, top-level `time` (S5). S5: "Under unified account or portfolio margin, use spot balances endpoint instead for trading account balance across spot and perps." S4 userAbstraction returns "unifiedAccount", "portfolioMargin", "disabled", "default" or "dexAbstraction". | clearinghouseState equity is not sufficient in every account mode; a supported-mode precondition is required and unhandled modes fail closed (H-04, B7). `time` semantics undefined; queries must use the account address, not an agent address (H-04). |
| V-03 | position | assetPositions[].position: coin, szi (signed size), entryPx, positionValue, unrealizedPnl, leverage, liquidationPx, marginUsed, cumFunding (S5). | Sign convention of szi (positive long) is not stated in words (LIVE-PENDING). |
| V-04 | open orders | openOrders {coin, limitPx, oid, side, sz, timestamp}; frontendOpenOrders adds origSz, reduceOnly, orderType, trigger fields (S4). | cloid absent from the documented examples (LIVE-PENDING); ownership falls back to oid links (H-01). |
| V-05 | order lookup | orderStatus by oid or cloid; 29 documented statuses; `unknownOid` (S4). historicalOrders (2000 most recent) includes cloid (S4). | `unknownOid` right after a send is not absence proof (H-05). |
| V-06 | executions | userFills, userFillsByTime, WebSocket userFills, each with oid and tid (S4, S7); S7 WsTrade defines tid as a hash of the two order IDs. | Fills carry oid but not cloid (H-02); 10000-fill retention (H-03). Oid-to-owned-intent attribution plus overlap replay is a viable design path, not proof of complete, stable, authoritative accounting. Execution identity (`stableExecutionId=UNPROVEN`), attribution and replay completeness remain unresolved for Gate 4A and canary purposes, so the documented endpoints do not by themselves clear the VENUE_ADAPTER_CONTRACT §22 automatic blocker (B6). |
| V-07 | partial fills | Fill rows per partial execution with oid, tid, sz, startPosition (S4, S7). | Order `sz`/`origSz` undefined; the engine sums fills. Fill identity unproven (V-06). |
| V-08 | leverage | updateLeverage set (S3); activeAssetData and clearinghouseState readback (S5); integer 1..maxLeverage (S14). | Set while flat; exact readback comparison `{type: "isolated", value: 5}` (H-07). |
| V-09 | reduce-only | Flag `r` and definition (S3, S13); reduce-only statuses (S4). | Oversize and below-minimum behavior NOT-STATED. |
| V-10 | reduction | Reduce-only IOC with a bounded limit price; IOC may cancel unfilled remainder (S13, S4 iocCancelRejected). | Residual below $10 may be unclosable (B4). Bounded retries and fresh snapshot required. |
| V-11 | cancellation | Response vector "success" or the ambiguous error (S3, S10); terminal status via orderStatus (S4). | "success" treated as ACK, not confirmation (H-06). |
| V-12 | freshness | Per-record times on fills/orders; WebData3.userState.serverTime (S7; unit and freshness NOT-STATED); 60 s WebSocket idle timeout with ping/pong (S8); first subscription message isSnapshot (S7). | No proven server time; no WebSocket sequence numbers. Every reconnect needs a REST replay (H-08). |
| V-13 | rate limits | See RATE_LIMITS above (S6); userRateLimit info query {cumVlm, nRequestsUsed, nRequestsCap, nRequestsSurplus} (S4). | Limit-hit response NOT-STATED; the adapter must treat it as RATE_LIMIT or UNKNOWN_WRITE_OUTCOME (H-09). |
| V-14 | sandbox/testnet | Testnet URL (S1); faucet requires a mainnet deposit from the same address (S16). | Behavioral differences NOT-STATED; testnet indices differ. Testnet evidence is not mainnet evidence. |

## 5. Canary capability minimum (VENUE_ADAPTER_CONTRACT §22) and blockers

| §22 item | Documentation | Status |
| --- | --- | --- |
| Authoritative account/position snapshots | clearinghouseState (S5); userAbstraction (S4) | Mechanism documented for supported account modes only (B7); freshness unproven (B3) |
| Deterministic or otherwise safe order identity | cloid (S3) | Documented; mapping H-01 not built |
| Authoritative execution/fill provenance | userFills, WsFill (S4, S7) | Candidate path only; identity, attribution and replay completeness unresolved (B6) |
| Partial-fill handling | Per-fill rows (S4, S7) | Documented; fill identity unproven (B6) |
| Cancellation and verification | cancel, orderStatus (S3, S4) | Documented; owned scope depends on ownership (H-01) |
| Bounded reduction/flatten | Reduce-only IOC (S3, S13) | Residual below minimum unproven (B4) |
| Leverage configuration/readback | updateLeverage, activeAssetData (S3, S5) | Documented; BTC maxLeverage 40 observed (E1); readback not observed (B1) |
| Market rules/precision/min-size | S2, S10, E1 | Index and szDecimals observed (E1); $10 minimum is a documented rejection condition (S10); reduce-only exception and acceptance of a given order unproven (B1, B4) |
| Freshness/timestamp semantics | Per-record times; WebData3 serverTime with unit and freshness NOT-STATED | Unproven (B3) |
| Safe restart reconciliation | orderStatus, open orders, fills by time | Depends on H-01..H-04 being built, tested and reviewed (B6, B7) |

Blockers behind `CANARY_ELIGIBLE=BLOCKED`:

- **B1 — Account-scoped evidence missing.** Public documentation facts need no further authorization and are recorded in sections 2-4, for example the $10 MinTradeNtl rejection (S10), the fill and order schemas (S4, S7) and the abstraction query (S4). Public metadata observed once in E1: BTC's asset index, szDecimals, maxLeverage and margin-mode metadata. Observations that need a separate authorization: (a) info reads for a dedicated account address, for the presence of cloid in open-order responses, the `time` fields, the account's leverage readback and its abstraction mode (B7), a wider scope than the owner's 2026-10-16 approval as applied (Q2); (b) real orders, so testnet or live writes, for the acceptance of orders near $10 including reduce-only, the meaning of order `sz`/`origSz`, fill `time` versus block time and REST/WebSocket fill equivalence (B6). Neither is authorized.
- **B2 — Withdrawal restriction of an API wallet is not provable from the documentation.** S9 says API wallets "are only used to sign", but no page read says which actions an API wallet cannot sign, and no per-key permission flag is documented. S3 documents two different groups of fund-moving actions:
  - External withdrawals and transfers that can leave the account: `withdraw3` (bridge withdrawal), `usdSend` ("Send usd to another address"), `spotSend` ("Send spot assets to another address"), `sendAsset` (between perp DEXs, spot, users and sub-accounts), and the EVM, vault, staking and HIP-3 liquidator transfers.
  - Same-address collateral movement: `agentSendAsset`, "Similar to send asset, but can be signed by an agent. Destination must match the source address."; and `usdClassTransfer`, which moves USDC between the user's spot and perp wallets.

  The mandatory prohibition (AGENTS.md rule 8; EXPERIMENT_SPEC §2 "Withdrawal permission: disabled, mandatory") concerns the first group. Same-address movement does not take funds off the account, so requiring every fund-moving action to be rejected would be a stronger and possibly unsatisfiable condition (issue #27 finding 7); the engine still never constructs either group (H-15). Showing that an API wallet cannot sign an external withdrawal or transfer needs official confirmation, recorded evidence or an explicit ruling (Q3). Static application guards and a finite set of testnet rejections do not establish a universal mainnet permission restriction. No waiver is granted. Open: the owner did not decide on 2026-10-16; the auditor's recommendation is in section 8. B2 blocks a live canary only, not read-only work.
- **B3 — Server time and freshness unproven.** S7 documents `WebData3.userState.serverTime` in a frontend-oriented aggregate, but its unit, its relation to the accompanying state and any freshness guarantee are NOT-STATED; `clearinghouseState.time` and `l2Book.time` are undefined. A documented timestamp field is not proven freshness, and a local receipt time alone does not prove that the underlying state is fresh. Until a reviewed freshness rule exists (H-08), the risk inputs that depend on freshness stay unproven.
- **B4 — Residual reduction below the minimum order value.** S10 documents the MinTradeNtl rejection at $10 but does not say whether reduce-only orders are exempt. A grid partial fill can leave a residual of a few USDC. If such a residual cannot be closed, the hard-halt flatten path cannot always reach flat. Needs testnet or documentation evidence. Open: the owner did not decide on 2026-10-16; `fullFlatten` stays `UNPROVEN` (section 8).
- **B5 — Envelope currency. Owner preference received; formal amendment outstanding.** EXPERIMENT_SPEC `0.1.0` §2 freezes 100/30/150 USDT. Hyperliquid's collateral is USDC and the BTC oracle price is USDT-denominated, with no USDC/USDT conversion: "these contracts are technically quanto contracts where USDT pnl is denominated in USDC" (S15). On 2026-10-16 the owner preferred USDC with the numbers unchanged (Q1). Unchanged numeric strings do not make USDT and USDC the same frozen unit (issue #27 ruling 6). The change needs a REVIEW_CHANGE_PROTOCOL §4 request and a §5 experiment-spec version bump before any implementation or run uses it. The request is drafted separately as `docs/change-requests/CR-2026-10-20-USDC-ENVELOPE.md` and is not approved. Until it is approved and applied, nothing in Phase 4 may treat the envelope as USDC.
- **B6 — Execution identity and replay completeness unproven.** `tid` is a 50-bit hash of the two order IDs, documented global uniqueness needs `(block_time, coin, tid)`, and fill `time` is not documented as the block time (S7). Oid attribution plus overlap replay (H-02, H-03) is a viable design path, not proof of complete, stable, authoritative accounting (issue #27 ruling 4). Clearing B6 needs a documented or evidenced account- and market-scoped execution identity, REST/WebSocket equivalence, and replay bounds and completion criteria that a reviewer accepts.
- **B7 — Account abstraction mode unhandled.** S5 directs unified-account and portfolio-margin users to the spot balances endpoint for the trading-account balance, so `clearinghouseState.marginSummary.accountValue` is not sufficient equity in every mode. S4 `userAbstraction` reports one of five strings. S3 names three of them as settable values (`disabled`, `unifiedAccount`, `portfolioMargin`) but defines none in words, and the pages do not define `default` or `dexAbstraction`. S3 also says that under the deprecated HIP-3 DEX abstraction, actions on HIP-3 perps automatically transfer collateral from the validator-operated USDC perps balance (for HIP-3 DEXs whose collateral is USDC) or from spot otherwise, so the default perp DEX balance can change without an engine order. The mode can be set by a user-signed action (`userSetAbstraction`) and by an agent-signed one (`agentSetAbstraction`). Which modes are supported needs account evidence and a reviewer decision (H-04).

Gate 4A also needs the read-only adapter and its conformance tests (IMPLEMENTATION_CONTRACT §7.2), and Gate 3 is not PASS. Neither exists yet, independently of B1-B7.

## 6. Envelope feasibility (EXPERIMENT_SPEC §3)

- Per-level target: 150 gross over 10 levels, about 15 per level, in the envelope's unit. Margin at 5x isolated: 150 / 5 = 30, equal to the margin budget.
- Units: EXPERIMENT_SPEC `0.1.0` states USDT. Hyperliquid's collateral is USDC and its BTC prices are USDT-denominated with no conversion (S15). The owner prefers USDC with the numbers unchanged, but that reading is not in force until the formal amendment is approved and applied (B5). The arithmetic below uses the numbers only and does not settle the unit.
- Documented minimum: S10 MinTradeNtl rejects an order below $10. 15 per level is above it, so the entry size is compatible **if** quantity rounding allows it.
- Quantity per level must be `floor(15 / price, szDecimals)`, and each order must still satisfy `qty * price >= minNotional` while the sum stays at or below 150. With one quantity step worth `price * 10^-szDecimals`, the envelope fails if no multiple of the step lies between the minimum and 15. If it fails, the program must report the incompatibility and must not raise leverage, margin or notional (EXPERIMENT_SPEC §3).
- With BTC szDecimals 5 (E1), take each order's own normalized price `P`, not only the anchor: every grid level is sized at its own price. With `q = floor(15 / P, 5)`, `15 >= q * P > 15 - P * 10^-5`, and `15 - P * 10^-5 >= 10` for every `0 < P <= 500000`. Rounding alone therefore cannot put a 15-per-level BTC order below $10 at any price up to 500000. An exit or reduction whose quantity comes from a fill is not sized by this formula; it must be checked as `q * P >= 10` at its own price, and a partial-fill exit can fail that check (B4).
- This is a conditional entry-size result only (issue #27 ruling 8). It does not show overall envelope feasibility, margin sufficiency at mark price under the S14 margin formula, or that residuals can be closed.
- maxLeverage 40 (E1) is above the frozen 5x, and nothing in E1 forbids isolated margin for BTC.
- Partial fills can create exit orders below the minimum (B4). That is a strategy/risk design question for a later phase, not something this audit resolves.

## 7. Requirements for later phases

These follow from the documentation. They are requirements on later checkpoints, not implemented here.

- **H-01 cloid mapping.** The engine's `mv1` + 20 hex IDs (23 characters) are not valid cloids (`0x` + 32 hex). The adapter needs a deterministic, domain-separated mapping to 128 bits, stored with the intent, with collision checks that fail closed. Ownership classification must recognize mapped cloids; until then every engine order classifies `UNOWNED` (CURRENT_STATUS, Phase 3C limitation 5). If open-order responses carry no cloid (V-04), ownership must come from the registry's oid link, and an unlinked oid needs an orderStatus lookup; an order that stays unlinked is `AMBIGUOUS` and blocks.
- **H-02 Fill attribution and execution identity.** Fills carry oid and tid but not cloid. The adapter must attach the engine client ID through the registry's oid link (from the place ACK's `resting.oid`/`filled.oid` or an orderStatus by cloid) before handing executions to the core; a fill whose oid is not linked to an owned intent is unattributed and stays a blocker (CURRENT_STATUS, Phase 3D limitations 1 and 11). Bare `tid` is not an execution identity (S7 WsTrade), so the adapter must not deduplicate, anchor or detect collisions on `tid` alone. No normalized execution identity is proven here. A candidate for later evidence is the tuple (account address, coin, fill `time`, `tid`, `oid`). It may be adopted only after documentation or recorded evidence shows that fill `time` is the trade's block time and that the REST and WebSocket rows for one execution carry identical values, and after reviewer acceptance. Until then `stableExecutionId=UNPROVEN`, fills cannot be treated as complete authoritative accounting, and any identity conflict fails closed. Fail-closed collision detection does not prove uniqueness.
- **H-03 Execution replay without a native cursor.** This is a replay design for review, not a completeness proof, because no execution identity is proven (H-02).
  - Checkpoint: the adapter stores, per account and coin, the last processed fill time `T` and the full recorded facts (oid, tid, px, sz, side, time, startPosition, fee) of every fill processed at `T`.
  - Query: userFillsByTime from `startTime = T` (inclusive, so the rows at `T` overlap) to an `endTime` fixed when the replay starts; keep only the configured coin; never set `aggregateByTime`. Page with the last returned time as the next startTime (S4).
  - Overlap and retention gap: the first page must contain every recorded fill at `T` with identical facts. If any is missing, the window may lie outside the 10000 most recent fills (S4) or the venue data changed, so the replay fails closed and the cursor is refused (Phase 3D limitation 9). Without a prior checkpoint, replay starts at the run's start time.
  - Bounds: S4 states both "500 elements or distinct blocks of data" per time-range response and "at most 2000 fills per response". A page with 500 or more rows is treated as possibly truncated, whatever the 2000 limit says. A replay stops and fails closed once the rows returned since `T` reach 10000, counting overlap repeats (which only makes the stop earlier), or once a finite page limit set in Phase 4.2 is reached. Every request follows the H-17 timeout.
  - No progress: a possibly truncated page whose last time equals its start time cannot advance and fails closed.
  - Completion: a page with fewer than 500 rows is below every documented limit and is treated as reaching `endTime`. The replay is complete only when such a page is reached and the overlap check passed. This relies on the S4 limits being the only truncation, which a reviewer must accept.
  - Overlapping rows are deduplicated only under a reviewed execution identity (H-02). Until then the replay cannot clear fill-provenance uncertainty (B6).
- **H-04 Account address and account mode.** Info queries must use the master or sub-account address; an agent address returns empty results (S4). Before trusting an empty position or order list, the adapter must confirm the configured address with `userRole` (`user` or `subAccount`, never `agent` or `missing`). `userRole` does not establish the abstraction mode. Before any account snapshot is used as a risk input, the adapter must read `userAbstraction` (S4) and continue only in a supported mode:
  - `unifiedAccount` and `portfolioMargin` are refused: S5 says their trading-account balance comes from the spot balances endpoint, and spot support is out of scope and is not added implicitly.
  - `disabled`, `default` and `dexAbstraction` are not defined in words on the pages read. Each stays unsupported until account evidence and a reviewer decision show that clearinghouseState for the default perp DEX is the account's complete trading equity in that mode.
  - Any other or missing value fails closed.

  The mode can change through `userSetAbstraction` (user-signed) or `agentSetAbstraction` (agent-signed) (S3). The adapter must read it at startup, at every reconciliation and at a bounded interval set in Phase 4.2; a change, a failed read or a stale reading blocks risk increase and is surfaced.
- **H-05 Write outcomes.** Order and cancel responses are vectors matching the batch; a pre-validation error is one error for the whole payload (S10). `filled {totalSz, avgPx, oid}` in a place response is an ACK, not fill evidence (no tid). `unknownOid` right after an ambiguous send is not proof of non-arrival.
- **H-06 Cancel.** "success" is an ACK. Confirmation needs a terminal orderStatus or fresh open orders plus fills by oid. The error "never placed, already canceled, or filled" is a reconciliation case. Do not resend a cancel whose result already returned (S6).
- **H-07 Leverage and margin mode.** Set `isCross=false, leverage=5` while flat, read back through activeAssetData and compare `{type, value}` exactly. A mismatch or a missing readback blocks live-capable continuation (§18).
- **H-08 Freshness and WebSocket.** No proven server clock and no WebSocket sequence numbers. S7 documents `WebData3.userState.serverTime`, but its unit and freshness meaning are NOT-STATED and WebData3 is described as "used primarily for the frontend"; it must not serve as a freshness proof without evidence and review. A local receipt time shows when the adapter received a message, not that the underlying state is fresh. Every connection, including the first, calls `executionStreamReconnected()` and is followed by a REST replay (Phase 3D limitation 7). Every streamed execution has a null sequence and blocks risk increase until a replay (Phase 3D limitation 4). Send `{"method":"ping"}` within the 60 s idle timeout (S8). Record `clearinghouseState.time` as venue-reported, not as a proven server clock. The freshness rule for risk inputs remains open (B3).
- **H-09 Rate limits.** Track IP weight locally and read `userRateLimit` as a risk input; low address headroom should block risk increase so that cancels and reductions keep headroom (cancels have the larger limit). Hitting a limit on a mutation is `UNKNOWN_WRITE_OUTCOME` unless the response proves no commit.
- **H-10 `expiresAfter`.** An optional action field: a millisecond timestamp "after which the action will be rejected" (S3). It bounds when an action can still be accepted, not how long an accepted order lives. A GTC order "rests on the order book until it is filled or canceled" (S13), so an order accepted before the deadline can keep resting after it. Expiry therefore never resolves an ambiguous order outcome and never releases an exposure reservation; only reconciliation evidence does (H-05). An action canceled for a stale `expiresAfter` consumes 5x the usual address-based rate limit, and user-signed actions do not support the field (S3). Whether to use it is a later design decision.
- **H-11 Nonces and API wallets.** Nonces must be unique per signer: one of the 100 highest stored, larger than the smallest, inside (T - 2 days, T + 1 day) (S9). Use a separate API wallet per process and never reuse an API wallet address, because pruned nonce state allows replay of old signed actions (S9). An account holds 1 unnamed and up to 3 named API wallets; expiry at most 180 days (S3).
- **H-12 Account-wide cancel.** `scheduleCancel` cancels all open orders of the account at a set time at least 5 seconds ahead, at most 10 triggers per day, reset at 00:00 UTC (S3). It is a separate account-wide operation, not owned-scoped, and not a lifetime bound for individual orders (H-10). It needs an explicit live-canary contract before use (§16). The same applies to the `noop` nonce-invalidation action that S3 suggests for cancelling in-flight orders.
- **H-13 Asset IDs.** Read the BTC index from `meta` at startup and verify it by name. Testnet and mainnet indices differ. Reject delisted assets (`isDelisted`). E1 lists 56 delisted entries among 234, so the universe is not a list of live markets.
- **H-14 Price rule versus `MarketRules.priceTick`.** The 5-significant-figure rule is not a fixed tick: the allowed increment depends on the price's magnitude, and integer prices are always allowed (S2). `MarketRules.priceTick: DecimalString` (VENUE_ADAPTER_CONTRACT §6) cannot express it as a global rule. Strip trailing zeros in signed payloads (S2). For BTC with szDecimals 5 (E1) the S2 rule gives: at or above 10000 every integer price is valid and no fractional price is, so the increment there is exactly 1; from 1000 to below 10000 it is 0.1. This is a derivation from S2 and E1, not an observed order result. Phase 4.2 may use one uniform tick only for an explicitly scoped price band (for BTC, prices at or above 10000 with increment 1). Every price must be validated against that band, including exits and reductions, and any price outside it is refused. The band must not be exposed as a globally accurate rule, and choosing it must not put grid policy in the adapter. If `MarketRules` cannot express such a restriction, a generic extension goes through REVIEW_CHANGE_PROTOCOL §12 before implementation.
- **H-15 Never-sent actions.** The engine must never construct fund-moving, account-mode or agent-management actions:
  - external withdrawals and transfers: `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `sendToEvmWithData`, `vaultTransfer`, `cDeposit`, `cWithdraw`, `tokenDelegate`, `hip3LiquidatorTransfer`;
  - same-address collateral movement: `agentSendAsset`, `usdClassTransfer`;
  - account abstraction: `userSetAbstraction`, `agentSetAbstraction`, `userDexAbstraction`, `agentEnableDexAbstraction`;
  - agent management: `approveAgent`.

  Once signing exists, a static allowlist of the action types the adapter may sign should enforce this. The guard is a compensating control; it does not show that the venue would refuse these actions (B2).
- **H-16 SDK decision (IMPLEMENTATION_CONTRACT §11).** No SDK for Phase 4.2. Read-only info queries need no signing and are plain HTTPS JSON. The docs reference a Python SDK for the two signing schemes (S12); any SDK or signing library is a later, separately reviewed decision including its license.
- **H-17 Transport policy (§20).** Timeouts, retryable reads, backoff and maximum retries are defined in Phase 4.2. Mutations are never retried automatically.

## 8. Questions for the owner or reviewer, and answers

The questions as first asked, with the owner's answers of 2026-10-16 and the status after the issue #27 review:

- **Q1 (B5).** Does the frozen envelope's "USDT" mean USDC on Hyperliquid, or does EXPERIMENT_SPEC need a contract change?
  - Answer: 「可以換」 ("it can be switched"). Recorded owner preference: on Hyperliquid the envelope's "U" is USDC, with the numbers unchanged (capital 100, margin 30, gross notional 150, daily PnL halt -5, drawdown halt 10). No USDT/USDC conversion is modeled.
  - Status after review (issue #27 finding 4, ruling 6): owner preference received; formal amendment outstanding. The 2026-10-16 version of this answer said the `FROZEN_*_USDT` code constants could keep their names because their values are unit-free decimal strings; that reasoning is withdrawn, because unchanged numeric strings do not make USDT and USDC the same frozen unit. EXPERIMENT_SPEC `0.1.0` still freezes USDT and is not edited here. The REVIEW_CHANGE_PROTOCOL §4 request, with a §5 version bump, is `docs/change-requests/CR-2026-10-20-USDC-ENVELOPE.md`; it is not approved.
- **Q2 (B1).** Is read-only networking authorized for evidence? Options, narrowest first: public `meta` only; testnet info reads; info reads for one dedicated mainnet address. None needs a credential, because info reads take a public address.
  - Answer: 「好」 ("OK"), without choosing a scope. Applied: the narrowest scope, one public mainnet `meta` read (E1). Testnet info reads and address-scoped info reads need the owner to choose that scope, and the address-scoped option also needs the address. Credentials and writes remain unauthorized.
- **Q3 (B2).** What evidence of "withdrawal disabled" will the live-canary contract accept, given that Hyperliquid API wallets have no documented permission flag?
  - Answer: the owner did not understand the question and made no decision. The auditor recommends that the later live-canary contract require all three of the following (corrected for issue #27 finding 7):
    1. Direct evidence that an API wallet cannot sign an external withdrawal or a transfer that can leave the account (`withdraw3`, `usdSend`, `spotSend`, `sendAsset` to another destination, and the other external transfers in H-15): an archived official Hyperliquid statement, recorded evidence a reviewer accepts, or an explicit ruling. Same-address collateral movement, such as `agentSendAsset`, which S3 says an agent can sign, is not part of this requirement; the engine still never sends it (H-15). A finite set of testnet rejections can support but cannot by itself establish a universal mainnet restriction. Any test needs a separate authorization: a testnet credential, testnet writes, and a mainnet deposit for the faucet (S16).
    2. Compensating controls in any case: a dedicated master account that holds only the experiment's funds, the master key never on the trading host, and an engine that never constructs the actions in H-15 (static allowlist). These are compensating controls, not proof of a venue restriction.
    3. Without part 1, Hyperliquid stays not live-eligible. This audit does not waive AGENTS.md rule 8, and issue #27 ruling 7 grants no withdrawal waiver.
- **Q4 (B4).** Should testnet evidence be collected for reduce-only orders below the minimum order value, or does the strategy need a rule that avoids such residuals?
  - Answer: the owner did not know and made no decision. The auditor recommends failing closed now. `fullFlatten` stays `UNPROVEN`. A nonzero residual after a reduction attempt is not flat, so under AGENTS.md the halt stays `HALTED`. Resolve this later with testnet evidence under the same separate authorization as Q3. A strategy rule can only make such residuals rarer, because the venue decides partial fills, and it must never add exposure to lift a residual above the minimum. Issue #27 ruling 7 found this fail-closed recommendation sound.

## 9. Non-claims

- This audit does not pass Gate 4A and does not authorize a read-only adapter to connect anywhere.
- `PROVEN` in section 3 is documentation-level and mechanism-level only, and is the auditor's proposal.
- E1 is one public snapshot. It shows nothing about account, order, fill, leverage-readback or time behavior, and the metadata can change after 2026-10-16.
- The 2026-10-20 documentation re-read is documentation evidence only, not venue evidence.
- The owner's answers in section 8 are recorded decisions or preferences, not reviewer acceptance.
- This corrected version has not been reviewed. It does not claim that the issue #27 findings are cleared.
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

The raw response is not committed. It is exchange data that changes over time, and the fields used are quoted above. Its bytes were not retained, so the hash, the response's completeness and the extracted values cannot be independently reproduced. Issue #27 ruling 2 treats E1 as a disclosed historical observation, not a verified current snapshot and not permission to use other endpoints. E1 was not repeated for the 2026-10-20 correction. Repeating it needs its own authorization, and a different hash is expected once the universe changes.
