# Multi-Venue Grid Experiment Specification

Version: `0.1.0`

## 1. Purpose

Validate a new independently implemented multi-venue grid engine under a bounded 100U risk envelope.

The first objective is **not short-term profitability**. Measure:

1. execution correctness;
2. restart/reconciliation correctness;
3. duplicate/orphan order handling;
4. exposure containment;
5. loss/drawdown controls;
6. authoritative fill accounting;
7. operational stability;
8. transaction-cost and funding observability.

## 2. Frozen v0.1 envelope

| Parameter | Value | Rule |
|---|---:|---|
| Starting capital | 100 USDT | dedicated account/subaccount |
| Leverage | 5x | must be set and read back if venue supports it |
| Max margin budget | 30 USDT | 30% of starting capital |
| Max planned gross notional | 150 USDT | hard cap |
| Primary underlying | BTC perpetual | fallback only if minimum-size rules make BTC infeasible |
| Grid levels | 10 | normalized experiment target |
| Grid half-band | ±3.0% from anchor | percentage based |
| Tick target | 10-15s or event-driven | venue feeds may be faster |
| Daily loss hard halt | 5 USDT | net of fees/funding where authoritative |
| Drawdown-from-start hard halt | 10 USDT | account/experiment equity basis |
| Boundary buffer | 1.0% beyond active grid boundary | adverse inventory only |
| Auto restart after hard halt | disabled | manual unique ACK required |
| Grid shift | disabled | v0.1 comparison stability |
| Margin mode | isolated where supported | otherwise dedicated subaccount + hard caps |
| Withdrawal permission | disabled | mandatory |

## 3. Sizing invariant

The configured strategy must never assume the account has a hard-coded balance.

Sizing flow:

```text
authoritative account equity
-> experiment capital ceiling (100U)
-> margin budget ceiling (30U)
-> leverage ceiling (5x)
-> planned gross-notional ceiling (150U)
-> venue min-size / precision validation
-> per-level quantity
```

If venue minimum order rules make the 100U envelope infeasible, the program must report the incompatibility. It must not silently increase leverage, margin budget, or notional.

## 4. Hard risk semantics

### 4.1 Planned notional

If proposed owned orders plus existing position can exceed 150U under a conservative worst-case fill sequence, block new risk-increasing orders.

### 4.2 Actual notional

If actual position notional exceeds 150U:

1. stop new risk;
2. cancel owned risk-increasing grid orders;
3. actively reduce to at or below the safe target if the venue supports bounded reduction;
4. verify with a fresh authoritative snapshot;
5. if reduction is unavailable, fails, or is ambiguous, hard-halt and flatten according to the kill-switch policy.

Cancel-only behavior is not accepted as complete risk reduction.

### 4.3 Daily loss

At `netDailyPnl <= -5U`, hard halt.

### 4.4 Drawdown

At `equity <= startingEquity - 10U`, hard halt.

High-water drawdown is also tracked, but the v0.1 hard threshold is defined from starting equity unless the spec is versioned.

### 4.5 Boundary

For a long adverse inventory:

```text
mid < gridLower * 0.99
```

For a short adverse inventory:

```text
mid > gridUpper * 1.01
```

A breach hard-halts.

## 5. Kill switch

Hard halt sequence:

```text
persist HALTING intent
-> fence new risk writes
-> cancel owned strategy orders
-> verify cancellation / reconcile ambiguity
-> reduce or flatten position
-> fresh snapshot
-> persist HALTED_FLAT or HALTED_UNFLAT/HALT_FAILED
-> emit telemetry
```

Any failed or ambiguous step remains fail-closed.

## 6. Fill provenance

`FILL` is authoritative only when supported by exchange execution evidence.

Allowed evidence includes:

- execution/trade stream;
- authenticated fill history;
- order detail endpoint with executed quantity plus stable order identity, if sufficient to rule out cancellation ambiguity.

Not sufficient by itself:

- an order disappearing from `openOrders`;
- a local position delta without matching execution provenance;
- timeout followed by no order in a stale snapshot.

Inferred events may be logged separately as `ORDER_DISAPPEARED` / `RECONCILIATION_REQUIRED`, but must not be counted as fills.

## 7. Restart gate

Before new risk after restart:

- runtime lease acquired;
- durable state verified;
- anchor loaded or intentionally re-created under a new epoch;
- open orders reconciled;
- owned/unowned orders classified;
- current position reconciled;
- execution cursor reconciled;
- leverage verified for live;
- no unresolved hard halt.

## 8. First live canary gate

Live authorization is outside the initial implementation task.

At minimum, later authorization requires:

- all acceptance gates PASS;
- one selected venue proves required capabilities;
- API withdrawal disabled;
- dedicated 100U account/subaccount;
- exact commit SHA pinned;
- dry-run and fault injection complete;
- independent review PASS;
- explicit human live confirmation.
