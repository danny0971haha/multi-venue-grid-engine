# Phase 2D Implementation Contract — Risk Calculations and Continuation Gate

**Status:** AUTHORIZED ONLY AFTER PHASE 2C CORRECTIVE 1 HARD INTERNAL GATE  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase2`

This file binds Phase 2D only. It does not authorize Phase 2E/2F, live writes, or `systemAllowRiskIncrease=true`.

```text
PHASE_2A=PASS
PHASE_2B=PASS
PHASE_2C_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_AUTHORIZED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
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
