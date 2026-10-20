# Contract change request CR-2026-10-20-USDC-ENVELOPE: state the experiment envelope in USDC

Status: **PROPOSED, awaiting the independent reviewer's decision.** This document changes no contract and no code. REVIEW_CHANGE_PROTOCOL §4: "A request is not approval."

## 1. Request

```text
CHANGE_ID=CR-2026-10-20-USDC-ENVELOPE
REQUESTER=implementation agent, at the owner's direction of 2026-10-18 (draft the currency amendment with Phase 4.1 audit corrective 13; issue #27 finding 4)
DATE=2026-10-20
AFFECTED_CONTRACTS=docs/EXPERIMENT_SPEC.md (version, §2, new §2.1, new §9); docs/RISK_PERSISTENCE_CONTRACT.md (§4-§8 units); docs/DOMAIN_CONTRACTS.md (§5 version and field-name note, §16 unit); README.md (envelope table); dated notes on docs/PHASE_0_CONTRACT.md §10-§11, docs/PHASE_1_CONTRACT.md §5 and docs/PHASE_2D_CONTRACT.md §2
CURRENT_BEHAVIOR=EXPERIMENT_SPEC 0.1.0 freezes capital, margin, gross notional, daily loss and drawdown in USDT (section 2)
PROPOSED_BEHAVIOR=EXPERIMENT_SPEC 0.2.0 states the same numbers in USDC, defines how notional is read on a quanto contract, and makes any market outside that definition unsupported (section 4)
REASON=Hyperliquid perpetuals on the default perp DEX use USDC collateral with USDT-quoted prices and no conversion; the owner prefers USDC with the numbers unchanged (section 3)
SAFETY_IMPACT=No number changes; the unit changes; no fail-closed guard is removed; the version change makes 0.1.0 run state unloadable by design (section 6)
BACKWARD_COMPATIBILITY=Runs under 0.1.0 and 0.2.0 must not be combined; 0.2.0 code must refuse 0.1.0 run state; historical evidence documents keep their 0.1.0 records
MIGRATION_REQUIRED=YES
TEST_CHANGES_REQUIRED=Version expectations in three tests, renamed risk constants in five risk test files, and new old-state refusal tests (section 5)
EXPERIMENT_SPEC_VERSION_BUMP=YES
```

`MIGRATION_REQUIRED=YES` means a compatibility decision, not a data conversion: no live or canary run has occurred, and this request proposes that state written under `0.1.0` is refused, never converted (section 5).

## 2. Current behavior

docs/EXPERIMENT_SPEC.md, version `0.1.0`, §2:

```text
| Starting capital | 100 USDT | dedicated account/subaccount |
| Max margin budget | 30 USDT | 30% of starting capital |
| Max planned gross notional | 150 USDT | hard cap |
| Daily loss hard halt | 5 USDT | net of fees/funding where authoritative |
| Drawdown-from-start hard halt | 10 USDT | account/experiment equity basis |
```

The same units appear in docs/RISK_PERSISTENCE_CONTRACT.md §4-§8, docs/DOMAIN_CONTRACTS.md §16, docs/PHASE_2D_CONTRACT.md §2 and README.md. RISK_PERSISTENCE_CONTRACT §4 adds: "These values are not configurable upward without a spec version change."

REVIEW_CHANGE_PROTOCOL §5 requires a new experiment-spec version before implementing any change to capital, margin budget, gross notional, daily loss or drawdown, and says: "Runs from different experiment-spec versions must not be combined as though they were one homogeneous experiment."

The Phase 4.1 review of 2026-10-18 (issue #27) found:

> 4. **P2 — B5 is not contractually resolved** (§5 B5, §6, Q1; CURRENT_STATUS). The recorded owner preference resolves the desired currency, but the reviewed EXPERIMENT_SPEC still freezes USDT. Hyperliquid documents USDC collateral with USDT-denominated BTC pricing/PnL and no exchange-rate conversion. Replacing the capital, margin, notional and loss units requires a separate REVIEW_CHANGE_PROTOCOL §4 amendment and §5 experiment-spec version bump before implementing/running that interpretation.

and ruled:

> 6. **Q1/B5:** Formal amendment and experiment-spec version bump required as finding 4. Unchanged numeric strings do not make USDT and USDC the same frozen unit.

## 3. Reason

The Phase 4.1 audit (docs/venue-audits/hyperliquid-2026-10-16.md) studies Hyperliquid perpetuals on the default perp DEX as a candidate first venue. Gate 4A has not been requested. Hyperliquid's contract specifications page (S15 in the audit, re-read as Markdown on 2026-10-20 without any API request, SHA-256 `59ef08be4b7e3d7cc0f4245abd4f133d743a983820df5b2ef0ce1ceb6af50ea3`) says:

> Hyperliquid has one main style of margining for perpetual contracts: USDC margining, USDT denominated linear contracts. That is, the oracle price is denominated in USDT, but the collateral is USDC. This allows for the best combination of liquidity and accessibility. Note that no conversions with the USDC/USDT exchange rate are applied, so these contracts are technically quanto contracts where USDT pnl is denominated in USDC.

So on that venue, equity, margin, PnL, fees and funding are USDC amounts, and BTC prices and notional are USDT-quoted numbers that the venue uses as USDC without conversion. The `0.1.0` envelope in USDT does not describe such an account. Either the specification changes or the venue cannot run this experiment.

On 2026-10-16 the owner answered audit question Q1 with 「可以換」 ("it can be switched"): on Hyperliquid the envelope's "U" is USDC, with the numbers unchanged. Issue #27 found that this preference is not a contract change. This request is that change.

The request sets one unit for the whole version (USDC) instead of "the selected venue's collateral currency". With one unit, every run under `0.2.0` uses the same unit, which keeps REVIEW_CHANGE_PROTOCOL §5's homogeneity rule simple. The cost is that a USDT-margined venue is unsupported under `0.2.0` and would need another version.

## 4. Proposed contract text

On approval, the implementation agent applies exactly the changes below in a separate pull request (REVIEW_CHANGE_PROTOCOL §17), replacing each `<APPROVAL>` with the reviewer's approval reference and date. Line numbers are at `main` `ac39c063cc7793e5b462d9efb55aff1ac48e58c7`. In the current contracts (4.1-4.4) the listed lines are replaced or the listed text is added. In the phase contracts (4.5) the existing text stays as a dated record and a note is added. No other contract text changes.

### 4.1 docs/EXPERIMENT_SPEC.md

Version line and the five §2 rows:

```diff
-Version: `0.1.0`
+Version: `0.2.0`
@@ §2 table
-| Starting capital | 100 USDT | dedicated account/subaccount |
+| Starting capital | 100 USDC | dedicated account/subaccount |
-| Max margin budget | 30 USDT | 30% of starting capital |
+| Max margin budget | 30 USDC | 30% of starting capital |
-| Max planned gross notional | 150 USDT | hard cap |
+| Max planned gross notional | 150 USDC | hard cap |
-| Daily loss hard halt | 5 USDT | net of fees/funding where authoritative |
+| Daily loss hard halt | 5 USDC | net of fees/funding where authoritative |
-| Drawdown-from-start hard halt | 10 USDT | account/experiment equity basis |
+| Drawdown-from-start hard halt | 10 USDC | account/experiment equity basis |
```

New subsection after the §2 table (after line 38), before `## 3. Sizing invariant`:

````markdown
### 2.1 Envelope unit

From version `0.2.0`, `U` and every currency amount in this specification mean USDC, the collateral currency of the experiment account. Equity, margin, realized PnL, fees and funding are the USDC amounts the venue reports.

Notional is quantity times the venue's price for the market, read as USDC. A market qualifies only if the venue documents one of these:

- its prices, margin and PnL are in USDC; or
- its prices are quoted in another currency and the venue applies no conversion to USDC (a quanto contract).

The engine does not model a USDC/USDT exchange rate or any other conversion. If the selected venue's audit cannot show one of the two cases from venue documentation, or if the venue converts, the market is unsupported under this version.
````

New section at the end of the file, after §8:

````markdown
## 9. Version history

- `0.1.0`: envelope amounts in USDT.
- `0.2.0` (CR-2026-10-20-USDC-ENVELOPE, approved by the independent reviewer: <APPROVAL>): envelope unit changed to USDC (§2.1). Every number is unchanged.

Runs from different versions must not be combined as though they were one homogeneous experiment (REVIEW_CHANGE_PROTOCOL §5).
````

### 4.2 docs/RISK_PERSISTENCE_CONTRACT.md

```diff
@@ §4, lines 82-87
-capital ceiling            = 100 USDT
+capital ceiling            = 100 USDC
 leverage                   = 5x
-margin budget              = 30 USDT
-planned gross-notional cap = 150 USDT
-daily net-loss halt        = -5 USDT
-drawdown from start halt   = 10 USDT
+margin budget              = 30 USDC
+planned gross-notional cap = 150 USDC
+daily net-loss halt        = -5 USDC
+drawdown from start halt   = 10 USDC
@@ §5, line 102
-Compute conservative directional scenarios. The maximum plausible gross exposure must be `<= 150 USDT`.
+Compute conservative directional scenarios. The maximum plausible gross exposure must be `<= 150 USDC`.
@@ §6, line 108
-If authoritative actual position notional exceeds `150 USDT`:
+If authoritative actual position notional exceeds `150 USDC`:
@@ §7, line 142
-netDailyPnl <= -5 USDT
+netDailyPnl <= -5 USDC
@@ §8, line 156
-equityUsd <= startingEquityUsd - 10 USDT
+equityUsd <= startingEquityUsd - 10 USDC
```

### 4.3 docs/DOMAIN_CONTRACTS.md

```diff
@@ §5, line 169
-  version: "0.1.0";
+  version: "0.2.0";
@@ §16, line 444
-The maximum of the directional scenarios must remain at or below `150 USDT` for the v0.1 experiment.
+The maximum of the directional scenarios must remain at or below `150 USDC` for the v0.1 experiment.
```

New paragraph in §5, after the `ExperimentConfig` block and before "No venue adapter may override these experiment values." (line 182):

````markdown
`Usd` in these field names, and in `equityUsd` and `startingEquityUsd`, means the envelope unit `U` of docs/EXPERIMENT_SPEC.md §2.1: USDC from experiment spec `0.2.0`.
````

### 4.4 README.md

```diff
@@ envelope table, lines 19-27
-| Starting capital | 100 USDT |
+| Starting capital | 100 USDC |
 | Leverage | 5x |
-| Maximum margin budget | 30 USDT |
-| Maximum planned gross notional | 150 USDT |
+| Maximum margin budget | 30 USDC |
+| Maximum planned gross notional | 150 USDC |
@@
-| Daily loss hard halt | 5 USDT |
-| Drawdown-from-start hard halt | 10 USDT |
+| Daily loss hard halt | 5 USDC |
+| Drawdown-from-start hard halt | 10 USDC |
```

### 4.5 Phase contracts: dated notes

docs/PHASE_0_CONTRACT.md, after "JSON output is preferred if a CLI output format is introduced." in §10 (line 259):

````markdown
**Note (CR-2026-10-20-USDC-ENVELOPE, <APPROVAL>):** From experiment spec `0.2.0`, the expected `experimentSpecVersion` in this section and in §11 item 6 is `0.2.0`. The text above is the Phase 0 record.
````

docs/PHASE_1_CONTRACT.md, after the §5 configuration block (after line 169):

````markdown
**Note (CR-2026-10-20-USDC-ENVELOPE, <APPROVAL>):** From experiment spec `0.2.0`, `version=0.2.0` and the unit of the `Usd` values is USDC (docs/EXPERIMENT_SPEC.md §2.1). Every other value is unchanged. The block above is the Phase 1 record.
````

docs/PHASE_2D_CONTRACT.md, after the §2 limits block (after line 67):

````markdown
**Note (CR-2026-10-20-USDC-ENVELOPE, <APPROVAL>):** From experiment spec `0.2.0`, the unit of these values is USDC (docs/EXPERIMENT_SPEC.md §2.1). The numbers are unchanged. The block above is the Phase 2D record.
````

### 4.6 Not changed

- REVIEW_CHANGE_PROTOCOL.md and AGENTS.md. The label "v0.1" there and in other contracts names the engine milestone; this request changes only the experiment spec version.
- The `Version` headers of contracts other than EXPERIMENT_SPEC. REVIEW_CHANGE_PROTOCOL §5 requires only the experiment-spec bump.
- Historical evidence documents (docs/PHASE_2*_EVIDENCE.md, docs/evidence/). Their `"experimentSpecVersion":"0.1.0"` lines record what ran.
- docs/VENUE_ADAPTER_CONTRACT.md. Whether a market meets §2.1 is a venue-audit fact. This request adds no adapter capability.

## 5. Implementation and migration after the contract change

After the contract pull request merges, a second pull request changes code and tests. It needs its own independent review. Until it merges, the code still reports `0.1.0` and must not be used for a run under `0.2.0`.

Code, at `ac39c06`:

- `src/bootstrap/runtimeMode.ts:7`: `EXPERIMENT_SPEC_VERSION` becomes `"0.2.0"`. The bootstrap report and the run manifest's `specVersion` (`src/telemetry/manifest.ts:33,212`) follow it.
- `src/domain/types.ts:18` and `src/domain/config.ts:4`: `version` becomes `"0.2.0"`. `V01_EXPERIMENT_CONFIG` keeps its name, because "v0.1" is the milestone (4.6).
- `src/risk/risk-types.ts:3-8`: the five constants ending `_USDT` (`FROZEN_CAPITAL_CEILING_USDT`, `FROZEN_MARGIN_BUDGET_USDT`, `FROZEN_PLANNED_GROSS_NOTIONAL_USDT`, `FROZEN_DAILY_NET_LOSS_USDT`, `FROZEN_START_DRAWDOWN_USDT`) are renamed to end in `_USDC`, with values unchanged. Their users are `src/risk/risk-engine.ts`, `src/risk/exposure.ts`, `src/risk/index.ts` and `src/halt/engine.ts`. This follows ruling 6: a name that says USDT must not label a USDC value.
- Field names ending in `Usd` stay. DOMAIN_CONTRACTS §5 and PHASE_1_CONTRACT §5 name them, and they are part of the manifest and halt-record bytes. 4.3 defines their unit.

Tests:

- `test/bootstrap/runtimeMode.test.ts:129-131`, `test/domain/ids-config.test.ts:69` and `test/telemetry/telemetry.test.ts:71` expect `0.2.0`.
- `test/risk/risk-engine.test.ts` and `test/risk/risk-engine-corrective-{1,2,3,4}.test.ts` use the renamed constants. No assertion is weakened.
- New: a run manifest written under `0.1.0` is refused. By reading `src/telemetry/manifest.ts:156-208` at `ac39c06`, loading rebuilds the manifest and compares its stored envelope with the current frozen envelope, so a `0.1.0` envelope should fail with `MANIFEST_ENVELOPE_MISMATCH`. No test covers this yet.
- New: durable halt state written under `0.1.0` is not resumed under `0.2.0`. `src/halt/record.ts` stores `startingEquityUsd` (line 38) with no spec version or unit. The implementation pull request must prove by test that such state cannot be resumed under `0.2.0`, and must add a fail-closed refusal if none exists.

Migration (REVIEW_CHANGE_PROTOCOL §13):

- Decision: no conversion. State written under `0.1.0` is refused, and a `0.2.0` run starts under a new run identity (RISK_PERSISTENCE_CONTRACT §24). No live or canary run has occurred, so no live `0.1.0` run exists to migrate.
- Fixtures: a `0.1.0` manifest and halt record (old state) and their `0.2.0` forms (new state), with mismatch tests as above.
- Schema version: the manifest layout does not change, so this request proposes keeping `RUN_MANIFEST_SCHEMA_VERSION = 1`. Only the `specVersion` and `envelope.version` values change.
- Rollback: `0.1.0` code refuses `0.2.0` state by the same envelope comparison. Rolling back means a new `0.1.0` run, never a resumed one.

## 6. Safety impact

- No number changes. Capital 100, leverage 5x, margin 30, gross notional 150, daily loss 5, drawdown 10, levels 10, half-band ±3% and boundary buffer 1% stay as they are. The unit of the five currency amounts changes from USDT to USDC.
- On a quanto market (§2.1), notional and PnL are USDT-quoted numbers that the venue settles one-for-one in USDC. The engine's 150 USDC cap therefore uses the same numbers as the venue's own margin and PnL accounting. If the USDC/USDT rate moves away from 1, the real-money value of that exposure differs from the nominal cap by that rate. The daily-loss and drawdown halts compare USDC equity and PnL as the venue reports them, so the rate does not enter those comparisons.
- The §2.1 qualification rule is fail-closed: a market whose conversion behavior is undocumented, or that converts, is unsupported. Under the Phase 4.1 audit, Hyperliquid's BTC perpetual on the default perp DEX is documented as a quanto contract (S15). Every other Hyperliquid blocker (B1-B4, B6, B7) is independent of this request and stays open.
- No fail-closed guard is removed. The version change makes `0.1.0` run state unloadable on purpose (section 5).
- Live authorization does not change: `LIVE_TRADING_AUTHORIZED=NO`, `CANARY_ELIGIBLE=BLOCKED`, and Gate 4A is not requested.

## 7. Decision requested

```text
CR-2026-10-20-USDC-ENVELOPE=APPROVE|REJECT|APPROVE_WITH_CHANGES
```

- APPROVE: the implementation agent applies section 4 in a separate pull request, then makes the section 5 code and test changes in another pull request for independent review.
- REJECT: EXPERIMENT_SPEC `0.1.0` stands. Audit blocker B5 stays open, and a USDC-collateral venue cannot run the experiment without another request.

Choices the reviewer may change with `APPROVE_WITH_CHANGES`:

1. the version number `0.2.0`;
2. keeping the `Usd` field names (section 5);
3. keeping manifest schema version 1 (section 5);
4. keeping the "v0.1" milestone labels (4.6).

Until the decision, EXPERIMENT_SPEC `0.1.0` stands, audit blocker B5 stays open, and nothing in the repository treats the envelope as USDC.
