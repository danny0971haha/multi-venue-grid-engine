# Phase 2D Implementation Contract — Risk Calculations and Continuation Gate

**Status:** PHASE 2D REJECTED; CORRECTIVE 1 REVIEW CANDIDATE; CUMULATIVE_PHASE_2_BASELINE=REVIEW_CANDIDATE

**Date:** 2026-08-25
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase2`

This file binds Phase 2D only. It does not authorize Phase 2E/2F, live writes, or `systemAllowRiskIncrease=true`.

```text
PHASE_2A=PASS
PHASE_2B=PASS
PHASE_2C_CORRECTIVE_1=REJECT
PHASE_2C_CORRECTIVE_2=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D=REJECT
PHASE_2D_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
CUMULATIVE_PHASE_2_BASELINE=REVIEW_CANDIDATE
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
INTEGRATION_MERGE_HEAD=5b0fd685586ec57b110159ccc36e5b21ba23ac28
PHASE1_IS_ANCESTOR_OF_INTEGRATION=YES
PHASE_2E_AUTHORIZED=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
```

## 1. Objective

Implement project-owned risk calculations and a deterministic `CONTINUE` / `REDUCE` / `HALT` decision. `CONTINUE` is metrics-only. It is not live-write authorization.

Even when every metric gate passes:

```text
systemAllowRiskIncrease=false
```

Durable halt/ACK and the integrated restart gate remain Phase 2E/2F.

## 2. Frozen v0.1 limits

These values are not upward-configurable.

```text
capital ceiling=100 USDT
leverage=5x
margin budget=30 USDT
planned gross-notional cap=150 USDT
daily net-loss halt=-5 USDT
starting-equity drawdown halt=10 USDT
boundary buffer=1% beyond ±3% grid boundary
```

Authoritative arithmetic uses `decimal.js` through the project-owned canonical decimal helpers. IEEE `number` is not a source of truth.

## 3. Decision model

```ts
type RiskAction = "CONTINUE" | "REDUCE" | "HALT";

type RiskDecision = {
  action: RiskAction;
  reasonCodes: string[];
  metrics: RiskMetrics;
  riskMetricsWithinLimits: boolean;
  systemAllowRiskIncrease: false;
  evaluatedAt: string;
};
```

`haltAuthorityClear` remains `false` / unimplemented at the system gate. Every decision includes `DURABLE_HALT_OR_ACK_UNAVAILABLE`.

## 4. Precedence

Reason codes are sorted by this catalog. `HALT` beats `REDUCE`. `REDUCE` beats `CONTINUE`.

```text
PERSISTENCE_UNPROVEN
-> LEASE_UNPROVEN
-> DURABLE_HALT_OR_ACK_UNAVAILABLE
-> RECONCILIATION_REQUIRED
-> STALE_OR_MISSING_INPUT
-> DAILY_LOSS
-> START_DRAWDOWN
-> BOUNDARY
-> ACTUAL_NOTIONAL
-> PLANNED_NOTIONAL
-> CONTINUE_METRICS_ONLY
```

Missing/stale/invalid required input never returns `CONTINUE` and never sets `systemAllowRiskIncrease=true`.

## 5. Required calculations

Planned exposure conservatively includes current signed position, owned risk-increasing working orders, unresolved UNKNOWN reservations, and the full proposed batch, under directional long and short worst cases. Planned gross `>150` is no new risk. Exact `150` is accepted only at the metric layer.

Actual position notional `>150` selects `REDUCE` only when bounded reduction is still provable. Cancel-only is not reduction. Ambiguous or unproven reduction is `HALT`.

```text
netDailyPnl = realizedTradingPnl - fees + normalizedFunding
netDailyPnl <= -5U -> HALT
```

Missing fee or funding is not zero.

```text
equity <= startingEquity - 10U -> HALT
```

High-water may be observed. It does not replace the starting-equity rule.

```text
long inventory and mid < gridLower * 0.99 -> HALT
short inventory and mid > gridUpper * 1.01 -> HALT
```

Zero inventory plus boundary movement is not a hard halt by itself. It may block seeding.

## 6. Out of scope

Do not implement halt state machines, durable halt ACK, telemetry/manifest, execution coordinator, venue adapters, network/auth/signing, live mode, or Phase 2E/2F.

## 7. Corrective 1 addendum — full-batch exposure and invalid grid domain

This addendum does not raise frozen 100U / 5x / 30U / 150U / -5U / 10U limits and does not authorize `systemAllowRiskIncrease=true`.

Purpose names are not risk authority. Every `reduceOnly=false` proposed intent that can change position is included in directional worst-case exposure, regardless of purpose. Only a semantically valid `reduceOnly=true` intent may be excluded. An inconsistent `CANCEL` with `reduceOnly=false` is `INVALID_RISK_INPUT` and HALT. A non-reduce-only null or unbounded price is `UNBOUNDED_EXPOSURE` and HALT.

Grid domain:

```text
gridLower > 0
gridUpper > 0
gridLower < gridUpper
```

Zero, negative, equal, or inverted bounds produce `INVALID_RISK_INPUT`, `action=HALT`, `riskMetricsWithinLimits=false`, and must not include `CONTINUE_METRICS_ONLY`.

Valid boundary inequalities are unchanged: long inventory and mark `< gridLower * 0.99` is HALT; equality at that floor is not a breach. Short inventory and mark `> gridUpper * 1.01` is HALT; equality at that ceiling is not a breach.

`INVALID_RISK_INPUT` is appended to `PHASE_2D_REASON_CODE_CATALOG` after `INVALID_DECIMAL`. Runtime validation of `side`, `purpose`, `fundingConvention`, `reduceOnly`, `owned`, and bounded-reduction booleans is exhaustive; TypeScript unions are not sufficient. Unknown or malformed required values do not receive a default financial interpretation.
