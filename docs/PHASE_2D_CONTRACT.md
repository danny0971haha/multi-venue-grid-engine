# Phase 2D Implementation Contract — Risk Calculations and Continuation Gate

**Status:** PHASE 2D REJECTED; CORRECTIVE 1 REJECT; CORRECTIVE 2 ACCEPT; CORRECTIVE 3 REJECT; CORRECTIVE 4 IMPLEMENTATION ACCEPT; CORRECTIVE 4 EVIDENCE HEAD REJECT; EVIDENCE CORRECTIVE 1 REVIEW CANDIDATE; CUMULATIVE_PHASE_2_BASELINE=PASS

**Date:** 2026-08-25
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase2`

This file binds Phase 2D only. It does not authorize Phase 2E/2F, live writes, or `systemAllowRiskIncrease=true`.

```text
GATE_0=PASS
GATE_1=PASS
PHASE_2A=PASS
PHASE_2B=PASS
PHASE_2C_CORRECTIVE_1=REJECT
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D=REJECT
PHASE_2D_CORRECTIVE_1=REJECT
PHASE_2D_CORRECTIVE_2=ACCEPT
PHASE_2D_CORRECTIVE_3=REJECT
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION=ACCEPT
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD=76171a19f3bc2ade35f4d86cbd9b591aaf90dc8b
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD_DISPOSITION=REJECT
PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_OVERALL=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
CUMULATIVE_PHASE_2_BASELINE=PASS
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

## 8. Corrective 2 addendum — runtime input fail-closed boundary

This addendum does not raise frozen 100U / 5x / 30U / 150U / -5U / 10U limits and does not authorize `systemAllowRiskIncrease=true`.

`evaluateRisk(input: unknown)` is the public runtime boundary. Before any financial calculation, clone, `.map`, spread, freshness check, or nested property dereference of caller-owned data:

1. Observe the untrusted value through canonical own-property descriptors (no getter invocation).
2. Materialize a detached trusted `RiskInput` snapshot via canonical JSON parse.
3. Confirm exact structural shape on that snapshot only.
4. Run existing exact-shape and financial semantic validation on the trusted snapshot only.

The caller object is never read a second time. Accessors, class instances, non-plain objects, sparse arrays, extra symbol/accessor properties, throwing `ownKeys` / `getOwnPropertyDescriptor` traps, and non-array collection fields fail closed.

Any input that cannot be safely parsed or structurally completed returns a deterministic decision:

```text
action=HALT
reasonCodes include DURABLE_HALT_OR_ACK_UNAVAILABLE, INVALID_RISK_INPUT, and STALE_OR_MISSING_INPUT
reasonCodes exclude CONTINUE_METRICS_ONLY
riskMetricsWithinLimits=false
systemAllowRiskIncrease=false
unproven metrics=null
frozen limit fields retained
```

If `freshness.evaluatedAt` cannot be read from the detached snapshot, `evaluatedAt` is the unauthorized diagnostic sentinel `"0"`. That sentinel is not market time and must not be treated as a fresh observation.

The same malformed input must produce a byte-identical decision. Valid Phase 2D inputs keep prior 150U / -5U / 10U and boundary semantics. Zero-quantity policy is unchanged in this corrective.

## 9. Corrective 3 addendum — bounded risk input admission

This addendum does not raise frozen 100U / 5x / 30U / 150U / -5U / 10U limits and does not authorize `systemAllowRiskIncrease=true`. Independent reviewer disposition for Corrective 2 is ACCEPT. Corrective 3 is REJECTED for object/raw UTF-8 budget mismatch; Corrective 4 is the review candidate.

Frozen risk-admission resource budgets (risk boundary only; persistence canonical serializer default behavior is unchanged):

```text
MAX_RISK_INPUT_UTF8_BYTES = 65_536
MAX_RISK_INPUT_DEPTH = 8
MAX_RISK_INPUT_NODES = 2_048
MAX_RISK_COLLECTION_LENGTH = 128
MAX_RISK_OBJECT_PROPERTIES = 64
MAX_RISK_STRING_CHARS = 256
MAX_RISK_OBJECT_KEY_CHARS = 128
MAX_RISK_DECIMAL_CHARS = 128
```

Exact caps are accepted. Cap + 1 is `RISK_INPUT_LIMIT_EXCEEDED` and HALT. Parse errors, accessors, symbols, and other non-capacity failures keep `INVALID_RISK_INPUT` without the limit code. Limit failures also include `INVALID_RISK_INPUT`, `STALE_OR_MISSING_INPUT`, and `DURABLE_HALT_OR_ACK_UNAVAILABLE`. `RISK_INPUT_LIMIT_EXCEEDED` is appended after `HIGH_WATER_OBSERVED` and does not reorder other catalog entries.

`evaluateRiskFromJsonBytes(raw: string | Uint8Array)` is the external trust boundary. It measures UTF-8 byte length before `JSON.parse`, fatal-decodes `Uint8Array`, fail-closes invalid UTF-8 and malformed JSON, then applies exact-shape plus every structural and decimal-length budget. Diagnostics must not echo raw input or secret-like values. Repeated evaluation of the same invalid bytes is deterministic.

`evaluateRisk(input: unknown)` remains for in-process tests and already-bounded finite objects. It applies defensive fail-closed observation and the same resource budgets to inputs that return from property inspection. It is not a DoS-proof guarantee and has no hard completion-time timeout. Non-returning Proxy traps and process OOM can prevent a return. `Promise.race` cannot abort synchronous observation. Worker/process isolation is the way to obtain a hard timeout; this checkpoint does not implement worker/process isolation. External adapters, fixtures, CLI, and network boundaries must call `evaluateRiskFromJsonBytes`.

`evaluatedAt` on a `RiskDecision` is only a canonical non-negative integer millisecond string of at most 13 digits. Malformed, overlong, accessor, symbol, object, or other non-canonical values become `"0"`. Invalid decisions must not echo attacker-provided giant `evaluatedAt` strings.

Decimal-like fields are length-checked before decimal regex and `decimal.js` construction. Structure budgets are enforced before `cloneInput`, `freshnessFailures`, `computeExposure`, and exposure iteration. Traversal does not mutate caller input, does not invoke accessors, and stops at the first exceeded budget.

## 10. Corrective 4 addendum — object/raw UTF-8 budget parity

This addendum does not raise frozen 100U / 5x / 30U / 150U / -5U / 10U limits and does not authorize `systemAllowRiskIncrease=true`. Independent reviewer disposition for Corrective 3 is REJECT: `evaluateRisk(object)` admitted structurally in-budget objects whose canonical UTF-8 exceeded 65,536 bytes while `evaluateRiskFromJsonBytes` rejected the same canonical bytes.

`evaluateRisk(input)` canonically serializes with the Corrective 3 structural limits, measures the UTF-8 byte length of that canonical result, and applies `MAX_RISK_INPUT_UTF8_BYTES` through the same admission function as `evaluateRiskFromJsonBytes` before `JSON.parse` of the snapshot and before any Decimal or exposure work. Exact 65,536 is accepted. 65,537 is `RISK_INPUT_LIMIT_EXCEEDED` and HALT. Persistence canonical serializer defaults remain unchanged.

Duplicate JSON keys at the raw-byte boundary are ambiguous (`JSON.parse` last-key-wins is not an authoritative risk meaning). They fail closed with `INVALID_RISK_INPUT` and without `RISK_INPUT_LIMIT_EXCEEDED`, before Decimal or exposure math. Keys and values must not appear in diagnostics.

JavaScript string input containing unpaired surrogates is rejected before `JSON.parse` with `INVALID_RISK_INPUT`, matching fatal UTF-8 rejection of `Uint8Array`. Valid `\uD800` JSON escapes remain ordinary string content and are still subject to decimal/shape validation.

## 11. Corrective 4 evidence-closure addendum

This addendum does not change risk calculations, frozen 100U / 5x / 30U / 150U / -5U / 10U limits, admission budgets, or the Corrective 4 implementation bytes at `c64fa291af0d53139c6c526cd25ede434c08c17b`.

Independent review of Corrective 4 requires CI-generated, SHA-bound machine evidence. Schema `multi-venue-phase2d-corrective4/1` is the historical meaning of rejected evidence HEAD `76171a19f3bc2ade35f4d86cbd9b591aaf90dc8b`. Schema `multi-venue-phase2d-corrective4/2` is the evidence-corrective-1 contract. Generation and independent verification are separate npm entries and separate semantic libraries. Artifacts are produced on the CI runner and are not committed. The generator must not write ACCEPT / PASS. The verifier must not trust a generator verdict and must not emit a gate decision.

```text
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION=ACCEPT
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD_DISPOSITION=REJECT
PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_OVERALL=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
```

