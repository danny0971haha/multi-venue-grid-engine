import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { evaluateRisk, FROZEN_PLANNED_GROSS_NOTIONAL_USDT } from "../../src/risk/index.js";
import type { RiskInput, RiskProposedIntent } from "../../src/risk/index.js";

const NOW = "1000000";

function baseline(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    signedPosition: overrides.signedPosition ?? "0",
    markOrMidPrice: overrides.markOrMidPrice ?? "100",
    equity: overrides.equity ?? "100",
    startingEquity: overrides.startingEquity ?? "100",
    highWaterEquity: overrides.highWaterEquity ?? "100",
    realizedTradingPnl: overrides.realizedTradingPnl ?? "0",
    fees: overrides.fees === undefined ? "0" : overrides.fees,
    funding: overrides.funding === undefined ? "0" : overrides.funding,
    fundingConvention:
      overrides.fundingConvention === undefined ? "RECEIVED_POSITIVE" : overrides.fundingConvention,
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
      ...(overrides.freshness ?? {}),
    },
    reconciliation: { unresolved: false, ...(overrides.reconciliation ?? {}) },
    lease: { proven: true, expired: false, lost: false, ...(overrides.lease ?? {}) },
    latchBlocked: overrides.latchBlocked ?? false,
    durableInspection: {
      pairAuthorityProven: true,
      ...(overrides.durableInspection ?? {}),
    },
    haltAuthorityClear: false,
    boundedReduction: {
      possible: true,
      ambiguous: false,
      cancelOnly: false,
      snapshotFresh: true,
      ...(overrides.boundedReduction ?? {}),
    },
  };
}

function intent(partial: RiskProposedIntent): RiskProposedIntent {
  return { ...partial };
}

function assertFailClosed(decision: ReturnType<typeof evaluateRisk>): void {
  assert.equal(decision.action, "HALT");
  assert.equal(decision.systemAllowRiskIncrease, false);
  assert.equal(decision.riskMetricsWithinLimits, false);
  assert.equal(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"), false);
}

describe("Phase 2D corrective 1", { concurrency: 1 }, () => {
  test("P2D-C1-01 GRID_EXIT with reduceOnly=false is counted", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "BUY",
            price: "100",
            quantity: "1",
            reduceOnly: false,
            purpose: "GRID_EXIT",
          }),
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "100");
    assert.equal(decision.metrics.worstLongNotional, "100");
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("P2D-C1-02 RISK_REDUCTION with reduceOnly=false is counted", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "SELL",
            price: "100",
            quantity: "0.8",
            reduceOnly: false,
            purpose: "RISK_REDUCTION",
          }),
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "80");
    assert.equal(decision.metrics.worstShortNotional, "80");
  });

  test("P2D-C1-03 EMERGENCY_FLATTEN with reduceOnly=false and bounded price is counted", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "SELL",
            price: "50",
            quantity: "2",
            reduceOnly: false,
            purpose: "EMERGENCY_FLATTEN",
          }),
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "100");
    assert.equal(decision.metrics.worstShortNotional, "100");
  });

  test("P2D-C1-04 non-reduce-only null-price intent is unbounded HALT", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "BUY",
            price: null,
            quantity: "1",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          }),
        ],
      }),
    );
    assertFailClosed(decision);
    assert.ok(decision.reasonCodes.includes("UNBOUNDED_EXPOSURE"));
  });

  test("P2D-C1-05 inconsistent CANCEL with reduceOnly=false is invalid HALT", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "BUY",
            price: "100",
            quantity: "1",
            reduceOnly: false,
            purpose: "CANCEL",
          }),
        ],
      }),
    );
    assertFailClosed(decision);
    assert.ok(decision.reasonCodes.includes("INVALID_RISK_INPUT"));
  });

  test("P2D-C1-06 mixed proposed batch is aggregated in full and blocks above 150", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "BUY",
            price: "100",
            quantity: "0.8",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          }),
          intent({
            side: "BUY",
            price: "100",
            quantity: "0.8",
            reduceOnly: false,
            purpose: "GRID_EXIT",
          }),
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "160");
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.equal(decision.riskMetricsWithinLimits, false);
  });

  test("P2D-C1-07 exact 150 remains accepted at the metrics layer", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "BUY",
            price: "100",
            quantity: "0.7",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          }),
          intent({
            side: "BUY",
            price: "100",
            quantity: "0.8",
            reduceOnly: false,
            purpose: "GRID_EXIT",
          }),
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT);
    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.ok(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"));
  });

  test("P2D-C1-08 valid reduce-only intents do not increase planned exposure", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          intent({
            side: "SELL",
            price: "100",
            quantity: "5",
            reduceOnly: true,
            purpose: "GRID_EXIT",
          }),
          intent({
            side: "SELL",
            price: "100",
            quantity: "5",
            reduceOnly: true,
            purpose: "RISK_REDUCTION",
          }),
          intent({
            side: "BUY",
            price: "100",
            quantity: "5",
            reduceOnly: true,
            purpose: "CANCEL",
          }),
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "0");
    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("P2D-C1-09 gridLower <= 0 fails closed", () => {
    const zero = evaluateRisk(baseline({ gridLower: "0" }));
    assertFailClosed(zero);
    assert.ok(zero.reasonCodes.includes("INVALID_RISK_INPUT"));
    const negative = evaluateRisk(baseline({ gridLower: "-1" }));
    assertFailClosed(negative);
    assert.ok(negative.reasonCodes.includes("INVALID_RISK_INPUT"));
  });

  test("P2D-C1-10 gridUpper <= 0 fails closed", () => {
    const zero = evaluateRisk(baseline({ gridUpper: "0" }));
    assertFailClosed(zero);
    assert.ok(zero.reasonCodes.includes("INVALID_RISK_INPUT"));
    const negative = evaluateRisk(baseline({ gridUpper: "-5" }));
    assertFailClosed(negative);
    assert.ok(negative.reasonCodes.includes("INVALID_RISK_INPUT"));
  });

  test("P2D-C1-11 gridLower == gridUpper fails closed", () => {
    const decision = evaluateRisk(baseline({ gridLower: "100", gridUpper: "100" }));
    assertFailClosed(decision);
    assert.ok(decision.reasonCodes.includes("INVALID_RISK_INPUT"));
  });

  test("P2D-C1-12 gridLower > gridUpper fails closed", () => {
    const decision = evaluateRisk(baseline({ gridLower: "103", gridUpper: "97" }));
    assertFailClosed(decision);
    assert.ok(decision.reasonCodes.includes("INVALID_RISK_INPUT"));
  });

  test("P2D-C1-13 invalid side/purpose/fundingConvention injected through RiskInput fails closed", () => {
    const badSide = evaluateRisk({
      ...baseline(),
      proposedBatch: [
        {
          side: "HOLD",
          price: "100",
          quantity: "1",
          reduceOnly: false,
          purpose: "GRID_ENTRY",
        },
      ],
    } as unknown as RiskInput);
    assertFailClosed(badSide);
    assert.ok(badSide.reasonCodes.includes("INVALID_RISK_INPUT"));

    const badPurpose = evaluateRisk({
      ...baseline(),
      proposedBatch: [
        {
          side: "BUY",
          price: "100",
          quantity: "1",
          reduceOnly: false,
          purpose: "REBALANCE",
        },
      ],
    } as unknown as RiskInput);
    assertFailClosed(badPurpose);
    assert.ok(badPurpose.reasonCodes.includes("INVALID_RISK_INPUT"));

    const badFunding = evaluateRisk({
      ...baseline(),
      fundingConvention: "UNKNOWN_SIGN",
    } as unknown as RiskInput);
    assertFailClosed(badFunding);
    assert.ok(badFunding.reasonCodes.includes("INVALID_RISK_INPUT"));
  });

  test("P2D-C1-14 invalid or stale risk input sets riskMetricsWithinLimits=false", () => {
    const stale = evaluateRisk(
      baseline({
        freshness: {
          evaluatedAt: NOW,
          maxStaleMs: "1000",
          positionObservedAt: "998999",
          equityObservedAt: NOW,
          markObservedAt: NOW,
          pnlObservedAt: NOW,
        },
      }),
    );
    assert.notEqual(stale.action, "CONTINUE");
    assert.equal(stale.riskMetricsWithinLimits, false);
    assert.equal(stale.systemAllowRiskIncrease, false);

    const invalid = evaluateRisk(baseline({ gridLower: "0", gridUpper: "103" }));
    assert.equal(invalid.riskMetricsWithinLimits, false);
    assert.equal(invalid.action, "HALT");
  });

  test("P2D-C1-15 exact long and short boundary equality remains unchanged", () => {
    const longEqual = evaluateRisk(
      baseline({
        signedPosition: "0.1",
        markOrMidPrice: "96.03",
        gridLower: "97",
        gridUpper: "103",
      }),
    );
    assert.equal(longEqual.reasonCodes.includes("BOUNDARY"), false);
    assert.equal(longEqual.action, "CONTINUE");
    assert.equal(longEqual.systemAllowRiskIncrease, false);

    const shortEqual = evaluateRisk(
      baseline({
        signedPosition: "-0.1",
        markOrMidPrice: "104.03",
        gridLower: "97",
        gridUpper: "103",
      }),
    );
    assert.equal(shortEqual.reasonCodes.includes("BOUNDARY"), false);
    assert.equal(shortEqual.action, "CONTINUE");
  });

  test("P2D-C1-16 input objects and nested arrays remain unmodified", () => {
    const owned = {
      side: "BUY" as const,
      price: "100",
      remainingQuantity: "0.2",
      reduceOnly: false,
      owned: true,
    };
    const proposed = intent({
      side: "BUY",
      price: "100",
      quantity: "0.1",
      reduceOnly: false,
      purpose: "GRID_EXIT",
    });
    const input = baseline({
      ownedActiveOrders: [owned],
      proposedBatch: [proposed],
    });
    const before = JSON.stringify(input);
    evaluateRisk(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(owned.remainingQuantity, "0.2");
    assert.equal(proposed.quantity, "0.1");
  });

  test("P2D-C1-17 repeated evaluations produce byte-identical action/reason/metrics output", () => {
    const input = baseline({
      proposedBatch: [
        intent({
          side: "BUY",
          price: "100",
          quantity: "1.2",
          reduceOnly: false,
          purpose: "GRID_EXIT",
        }),
      ],
    });
    const first = evaluateRisk(input);
    const second = evaluateRisk(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test("P2D-C1-18 all original Phase 2D tests remain and are not weakened", async () => {
    const text = await readFile(path.join(process.cwd(), "test/risk/risk-engine.test.ts"), "utf8");
    for (const id of [
      "P2-R01",
      "P2-R02",
      "P2-R03",
      "P2-R04",
      "P2-R05",
      "P2-R06",
      "P2-R07",
      "P2-R08",
      "P2-R09",
      "P2-R10",
      "P2-R11",
      "P2-R12",
      "P2-R13",
      "P2-R14",
      "P2-R15",
      "P2-R16",
      "P2-R17",
      "P2-R18",
    ]) {
      assert.ok(text.includes(id), `missing ${id}`);
    }
    for (let index = 1; index <= 28; index += 1) {
      const id = `2D-${String(index).padStart(2, "0")}`;
      assert.ok(text.includes(id), `missing ${id}`);
    }
    assert.ok(text.includes("assert.equal(decision.systemAllowRiskIncrease, false)"));
    assert.ok(text.includes('assert.notEqual(decision.action, "CONTINUE")'));
  });
});
