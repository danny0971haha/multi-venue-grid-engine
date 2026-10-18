import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateRisk, evaluateRiskFromJsonBytes } from "../../src/risk/index.js";
import type { RiskDecision, RiskInput, RiskProposedIntent } from "../../src/risk/index.js";

const NOW = "1000000";

function baseline(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    signedPosition: overrides.signedPosition ?? "0",
    markOrMidPrice: overrides.markOrMidPrice ?? "100",
    equity: overrides.equity ?? "100",
    startingEquity: overrides.startingEquity ?? "100",
    highWaterEquity: overrides.highWaterEquity ?? "100",
    realizedTradingPnl: overrides.realizedTradingPnl ?? "0",
    fees: overrides.fees ?? "0",
    funding: overrides.funding ?? "0",
    fundingConvention: overrides.fundingConvention ?? "RECEIVED_POSITIVE",
    ownedActiveOrders: overrides.ownedActiveOrders ?? [],
    unknownReservations: overrides.unknownReservations ?? [],
    proposedBatch: overrides.proposedBatch ?? [],
    gridLower: overrides.gridLower ?? "97",
    gridUpper: overrides.gridUpper ?? "103",
    freshness: {
      evaluatedAt: NOW,
      maxStaleMs: "1000",
      positionObservedAt: NOW,
      equityObservedAt: NOW,
      markObservedAt: NOW,
      pnlObservedAt: NOW,
    },
    reconciliation: { unresolved: false },
    lease: { proven: true, expired: false, lost: false },
    latchBlocked: false,
    durableInspection: { pairAuthorityProven: true },
    haltAuthorityClear: false,
    boundedReduction: { possible: true, ambiguous: false, cancelOnly: false, snapshotFresh: true },
  };
}

function buy(quantity: string, price: string): RiskProposedIntent {
  return { side: "BUY", price, quantity, reduceOnly: false, purpose: "GRID_ENTRY" };
}

// Evaluates the object and its JSON bytes and requires both entry points to agree.
function evaluateBoth(input: RiskInput): RiskDecision {
  const decision = evaluateRisk(input);
  assert.deepEqual(evaluateRiskFromJsonBytes(JSON.stringify(input)), decision);
  return decision;
}

function assertHas(decision: RiskDecision, code: string): void {
  assert.ok(decision.reasonCodes.includes(code), `${code} missing: ${decision.reasonCodes}`);
}

function assertLacks(decision: RiskDecision, code: string): void {
  assert.ok(!decision.reasonCodes.includes(code), `${code} present: ${decision.reasonCodes}`);
}

describe("Phase 2D corrective 5", () => {
  test("C5-01 a proposed notional just above 150 is a planned cap breach", () => {
    const price = `150.${"0".repeat(38)}1`;
    const decision = evaluateBoth(baseline({ proposedBatch: [buy("1", price)] }));
    assert.equal(decision.metrics.plannedGrossNotional, price);
    assertHas(decision, "PLANNED_NOTIONAL");
    assert.equal(decision.action, "HALT");
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("C5-02 a tiny addend that lifts the planned sum above 150 is kept", () => {
    const tiny = `0.${"0".repeat(39)}1`;
    const proposed = evaluateBoth(baseline({ proposedBatch: [buy("1.5", "100"), buy(tiny, "1")] }));
    assert.equal(proposed.metrics.plannedGrossNotional, `150.${"0".repeat(39)}1`);
    assertHas(proposed, "PLANNED_NOTIONAL");

    const reserved = evaluateBoth(
      baseline({
        ownedActiveOrders: [
          { side: "BUY", price: "100", remainingQuantity: "1.5", reduceOnly: false, owned: true },
        ],
        unknownReservations: [{ side: "BUY", price: "1", quantity: tiny }],
      }),
    );
    assert.equal(reserved.metrics.plannedGrossNotional, `150.${"0".repeat(39)}1`);
    assertHas(reserved, "PLANNED_NOTIONAL");
  });

  test("C5-03 an actual position notional just above 150 is an actual cap breach", () => {
    const expected = `150.${"0".repeat(39)}1`;
    for (const signedPosition of [`1.5${"0".repeat(40)}1`, `-1.5${"0".repeat(40)}1`]) {
      const decision = evaluateBoth(baseline({ signedPosition, markOrMidPrice: "100" }));
      assert.equal(decision.metrics.actualGrossNotional, expected, signedPosition);
      assertHas(decision, "ACTUAL_NOTIONAL");
      assert.equal(decision.action, "REDUCE", signedPosition);
      assert.equal(decision.systemAllowRiskIncrease, false);
    }
  });

  test("C5-04 net daily PnL keeps a loss below -5 that rounding would lose", () => {
    const decision = evaluateBoth(
      baseline({
        realizedTradingPnl: `-10000000000.${"0".repeat(29)}4`,
        fees: "0",
        funding: `9999999995.${"0".repeat(29)}1`,
      }),
    );
    assert.equal(decision.metrics.netDailyPnl, `-5.${"0".repeat(29)}3`);
    assertHas(decision, "DAILY_LOSS");
    assert.equal(decision.action, "HALT");
  });

  test("C5-05 paid-positive funding is negated exactly", () => {
    const decision = evaluateBoth(
      baseline({ funding: `-1.${"0".repeat(40)}1`, fundingConvention: "PAID_POSITIVE" }),
    );
    assert.equal(decision.metrics.netDailyPnl, `1.${"0".repeat(40)}1`);
    assertLacks(decision, "DAILY_LOSS");
  });

  test("C5-06 start drawdown is exact on both sides of the limit", () => {
    const start = `100.${"0".repeat(39)}1`;
    const breach = evaluateBoth(
      baseline({ startingEquity: start, highWaterEquity: start, equity: "90" }),
    );
    assert.equal(breach.metrics.startDrawdown, `10.${"0".repeat(39)}1`);
    assertHas(breach, "START_DRAWDOWN");
    assert.equal(breach.action, "HALT");

    // The exact drawdown is below 10. Rounding to 40 digits used to turn it into 10.
    const below = evaluateBoth(baseline({ equity: `90.${"0".repeat(40)}1` }));
    assert.equal(below.metrics.startDrawdown, `9.${"9".repeat(41)}`);
    assertLacks(below, "START_DRAWDOWN");
  });

  test("C5-07 a long position just below the exact lower boundary is a breach", () => {
    const decision = evaluateBoth(
      baseline({
        gridLower: `100.${"0".repeat(41)}1`,
        gridUpper: "103",
        signedPosition: "1",
        markOrMidPrice: "99",
      }),
    );
    assertHas(decision, "BOUNDARY");
    assert.equal(decision.action, "HALT");
  });

  test("C5-08 a short position just above the exact upper boundary is a breach", () => {
    const decision = evaluateBoth(
      baseline({
        gridLower: "97",
        gridUpper: `100.${"0".repeat(37)}5`,
        signedPosition: "-1",
        markOrMidPrice: `101.${"0".repeat(37)}6`,
      }),
    );
    assertHas(decision, "BOUNDARY");
    assert.equal(decision.action, "HALT");
  });

  test("C5-09 extreme admitted decimals are computed exactly without rejection", () => {
    const huge = "9".repeat(127);
    const large = evaluateBoth(baseline({ signedPosition: huge, markOrMidPrice: huge }));
    assert.equal(large.metrics.actualGrossNotional, `${"9".repeat(126)}8${"0".repeat(126)}1`);
    assertLacks(large, "INVALID_RISK_INPUT");
    assertLacks(large, "INVALID_DECIMAL");
    assertHas(large, "ACTUAL_NOTIONAL");

    const tiny = `0.${"0".repeat(125)}1`;
    const small = evaluateBoth(baseline({ signedPosition: tiny, markOrMidPrice: tiny }));
    assert.equal(small.metrics.actualGrossNotional, `0.${"0".repeat(251)}1`);
    assertLacks(small, "INVALID_RISK_INPUT");
    assertLacks(small, "INVALID_DECIMAL");
    assertLacks(small, "ACTUAL_NOTIONAL");

    const mixed = evaluateBoth(
      baseline({
        signedPosition: huge,
        markOrMidPrice: huge,
        proposedBatch: [buy(tiny, tiny)],
      }),
    );
    assert.equal(
      mixed.metrics.plannedGrossNotional,
      `${"9".repeat(126)}8${"0".repeat(126)}1.${"0".repeat(251)}1`,
    );
    assertHas(mixed, "PLANNED_NOTIONAL");
  });

  test("C5-10 controls at and around the cap are unchanged", () => {
    const atCap = evaluateBoth(baseline({ proposedBatch: [buy("1.5", "100")] }));
    assert.equal(atCap.metrics.plannedGrossNotional, "150");
    assertLacks(atCap, "PLANNED_NOTIONAL");
    assert.equal(atCap.action, "CONTINUE");

    const below = evaluateBoth(baseline({ proposedBatch: [buy("1", "149.99")] }));
    assertLacks(below, "PLANNED_NOTIONAL");
    assert.equal(below.action, "CONTINUE");

    const above = evaluateBoth(baseline({ proposedBatch: [buy("1", "150.01")] }));
    assertHas(above, "PLANNED_NOTIONAL");
    assert.equal(above.action, "HALT");
  });
});
