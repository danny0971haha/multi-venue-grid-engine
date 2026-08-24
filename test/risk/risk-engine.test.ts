import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { bootDryRun } from "../../src/bootstrap/runtimeMode.js";
import {
  diagnosticContainsSecretLike,
  evaluateRisk,
  formatRiskDecisionDiagnostic,
  FROZEN_PLANNED_GROSS_NOTIONAL_USDT,
  sortPhase2DReasonCodes,
} from "../../src/risk/index.js";
import type { RiskInput } from "../../src/risk/index.js";

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

describe("Phase 2D risk calculations", { concurrency: 1 }, () => {
  test("P2-R01 / 2D-01 planned 149.99 may CONTINUE", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          {
            side: "BUY",
            price: "100",
            quantity: "1.4999",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "149.99");
    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.equal(decision.riskMetricsWithinLimits, true);
  });

  test("P2-R02 / 2D-02 planned exact 150 is accepted at the metric layer", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          {
            side: "BUY",
            price: "100",
            quantity: "1.5",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT);
    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("P2-R03 / 2D-03 planned >150 does not CONTINUE", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          {
            side: "BUY",
            price: "100",
            quantity: "1.5001",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "150.01");
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.equal(decision.riskMetricsWithinLimits, false);
  });

  test("P2-R04 / 2D-04 UNKNOWN reservation pushes >150", () => {
    const decision = evaluateRisk(
      baseline({
        ownedActiveOrders: [
          {
            side: "BUY",
            price: "100",
            remainingQuantity: "1.4",
            reduceOnly: false,
            owned: true,
          },
        ],
        unknownReservations: [{ side: "BUY", price: "100", quantity: "0.2" }],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "160");
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
  });

  test("2D-05 full batch is checked before the first intent", () => {
    const decision = evaluateRisk(
      baseline({
        proposedBatch: [
          {
            side: "BUY",
            price: "100",
            quantity: "0.8",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
          {
            side: "BUY",
            price: "100",
            quantity: "0.8",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
        ],
      }),
    );
    assert.equal(decision.metrics.plannedGrossNotional, "160");
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
  });

  test("2D-06 long/short directional worst case uses the larger scenario", () => {
    const decision = evaluateRisk(
      baseline({
        ownedActiveOrders: [
          {
            side: "BUY",
            price: "100",
            remainingQuantity: "0.8",
            reduceOnly: false,
            owned: true,
          },
          {
            side: "SELL",
            price: "100",
            remainingQuantity: "0.9",
            reduceOnly: false,
            owned: true,
          },
        ],
      }),
    );
    assert.equal(decision.metrics.worstLongNotional, "80");
    assert.equal(decision.metrics.worstShortNotional, "90");
    assert.equal(decision.metrics.plannedGrossNotional, "90");
    assert.equal(decision.action, "CONTINUE");
  });

  test("P2-R05 / 2D-07 actual >150 selects REDUCE", () => {
    const decision = evaluateRisk(
      baseline({
        signedPosition: "2",
        markOrMidPrice: "100",
      }),
    );
    assert.equal(decision.metrics.actualGrossNotional, "200");
    assert.equal(decision.action, "REDUCE");
    assert.ok(decision.reasonCodes.includes("ACTUAL_NOTIONAL"));
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("P2-R06 / P2-R07 / 2D-08 reduction impossible or ambiguous selects HALT", () => {
    const impossible = evaluateRisk(
      baseline({
        signedPosition: "2",
        boundedReduction: {
          possible: false,
          ambiguous: false,
          cancelOnly: false,
          snapshotFresh: true,
        },
      }),
    );
    assert.equal(impossible.action, "HALT");
    assert.ok(impossible.reasonCodes.includes("REDUCTION_NOT_PROVEN"));

    const cancelOnly = evaluateRisk(
      baseline({
        signedPosition: "2",
        boundedReduction: {
          possible: true,
          ambiguous: false,
          cancelOnly: true,
          snapshotFresh: true,
        },
      }),
    );
    assert.equal(cancelOnly.action, "HALT");
    assert.ok(cancelOnly.reasonCodes.includes("CANCEL_ONLY_REDUCTION"));

    const unknown = evaluateRisk(
      baseline({
        signedPosition: "2",
        boundedReduction: {
          possible: true,
          ambiguous: true,
          cancelOnly: false,
          snapshotFresh: true,
        },
      }),
    );
    assert.equal(unknown.action, "HALT");
    assert.ok(unknown.reasonCodes.includes("REDUCTION_AMBIGUOUS"));

    const staleSnapshot = evaluateRisk(
      baseline({
        signedPosition: "2",
        boundedReduction: {
          possible: true,
          ambiguous: false,
          cancelOnly: false,
          snapshotFresh: false,
        },
      }),
    );
    assert.equal(staleSnapshot.action, "HALT");
    assert.ok(staleSnapshot.reasonCodes.includes("REDUCTION_NOT_PROVEN"));
  });

  test("P2-R08 / 2D-09 daily PnL exact -5 is HALT", () => {
    const decision = evaluateRisk(
      baseline({
        realizedTradingPnl: "-5",
        fees: "0",
        funding: "0",
      }),
    );
    assert.equal(decision.metrics.netDailyPnl, "-5");
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("DAILY_LOSS"));
  });

  test("P2-R09 daily PnL below -5 is HALT", () => {
    const decision = evaluateRisk(baseline({ realizedTradingPnl: "-5.01" }));
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("DAILY_LOSS"));
  });

  test("P2-R10 / 2D-10 fee missing is not substituted with zero", () => {
    const decision = evaluateRisk(baseline({ fees: null }));
    assert.equal(decision.metrics.netDailyPnl, null);
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("FEE_MISSING"));
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("2D-11 funding sign is normalized", () => {
    const received = evaluateRisk(
      baseline({
        realizedTradingPnl: "0",
        fees: "0",
        funding: "2",
        fundingConvention: "RECEIVED_POSITIVE",
      }),
    );
    assert.equal(received.metrics.netDailyPnl, "2");
    assert.equal(received.action, "CONTINUE");

    const paidHalt = evaluateRisk(
      baseline({
        realizedTradingPnl: "0",
        fees: "0",
        funding: "5",
        fundingConvention: "PAID_POSITIVE",
      }),
    );
    assert.equal(paidHalt.metrics.netDailyPnl, "-5");
    assert.equal(paidHalt.action, "HALT");
    assert.ok(paidHalt.reasonCodes.includes("DAILY_LOSS"));
  });

  test("P2-R11 / 2D-12 drawdown exact 10 is HALT", () => {
    const decision = evaluateRisk(baseline({ equity: "90", startingEquity: "100" }));
    assert.equal(decision.metrics.startDrawdown, "10");
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("START_DRAWDOWN"));
  });

  test("P2-R12 equity below the start-drawdown threshold is HALT", () => {
    const decision = evaluateRisk(baseline({ equity: "89.99", startingEquity: "100" }));
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("START_DRAWDOWN"));
  });

  test("2D-13 high-water does not replace the starting-equity rule", () => {
    const decision = evaluateRisk(
      baseline({
        equity: "95",
        startingEquity: "100",
        highWaterEquity: "120",
      }),
    );
    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.metrics.startDrawdown, "5");
    assert.ok(decision.reasonCodes.includes("HIGH_WATER_OBSERVED"));
    assert.equal(decision.reasonCodes.includes("START_DRAWDOWN"), false);
  });

  test("P2-R13 / 2D-14 long boundary is HALT", () => {
    const decision = evaluateRisk(
      baseline({
        signedPosition: "0.1",
        markOrMidPrice: "96.02",
        gridLower: "97",
        gridUpper: "103",
      }),
    );
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("BOUNDARY"));
  });

  test("P2-R14 / 2D-15 short boundary is HALT", () => {
    const decision = evaluateRisk(
      baseline({
        signedPosition: "-0.1",
        markOrMidPrice: "104.04",
        gridLower: "97",
        gridUpper: "103",
      }),
    );
    assert.equal(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("BOUNDARY"));
  });

  test("P2-R15 / 2D-16 boundary with zero inventory is not a hard halt", () => {
    const decision = evaluateRisk(
      baseline({
        signedPosition: "0",
        markOrMidPrice: "96.02",
        gridLower: "97",
        gridUpper: "103",
      }),
    );
    assert.notEqual(decision.action, "HALT");
    assert.ok(decision.reasonCodes.includes("BOUNDARY_SEED_BLOCKED"));
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("P2-R16 / 2D-17 stale position does not CONTINUE", () => {
    const decision = evaluateRisk(
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
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("STALE_OR_MISSING_INPUT"));
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("P2-R17 / 2D-18 stale equity/PnL does not CONTINUE", () => {
    const staleEquity = evaluateRisk(
      baseline({
        freshness: {
          evaluatedAt: NOW,
          maxStaleMs: "1000",
          positionObservedAt: NOW,
          equityObservedAt: "998999",
          markObservedAt: NOW,
          pnlObservedAt: NOW,
        },
      }),
    );
    assert.notEqual(staleEquity.action, "CONTINUE");
    const stalePnl = evaluateRisk(
      baseline({
        freshness: {
          evaluatedAt: NOW,
          maxStaleMs: "1000",
          positionObservedAt: NOW,
          equityObservedAt: NOW,
          markObservedAt: NOW,
          pnlObservedAt: null,
        },
      }),
    );
    assert.notEqual(stalePnl.action, "CONTINUE");
    assert.ok(stalePnl.reasonCodes.includes("STALE_OR_MISSING_INPUT"));
  });

  test("P2-R18 / 2D-19 lease lost does not CONTINUE", () => {
    const decision = evaluateRisk(
      baseline({
        lease: { proven: false, expired: false, lost: true },
      }),
    );
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("LEASE_UNPROVEN"));
    assert.ok(decision.reasonCodes.includes("LEASE_LOST"));
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("2D-20 persistence latch blocked does not CONTINUE", () => {
    const decision = evaluateRisk(baseline({ latchBlocked: true }));
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("PERSISTENCE_UNPROVEN"));
    assert.ok(decision.reasonCodes.includes("LATCH_BLOCKED"));
  });

  test("2D-21 reconciliation unresolved does not CONTINUE", () => {
    const decision = evaluateRisk(baseline({ reconciliation: { unresolved: true } }));
    assert.notEqual(decision.action, "CONTINUE");
    assert.ok(decision.reasonCodes.includes("RECONCILIATION_REQUIRED"));
  });

  test("2D-22 decimal precision beats adversarial IEEE rounding", () => {
    const ieeeTrap = evaluateRisk(
      baseline({
        proposedBatch: [
          {
            side: "BUY",
            price: "0.1",
            quantity: "1",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
          {
            side: "BUY",
            price: "0.2",
            quantity: "1",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
        ],
      }),
    );
    assert.equal(ieeeTrap.metrics.plannedGrossNotional, "0.3");
    assert.notEqual(ieeeTrap.metrics.plannedGrossNotional, String(0.1 + 0.2));

    const justOver = evaluateRisk(
      baseline({
        proposedBatch: [
          {
            side: "BUY",
            price: "50.00000000000001",
            quantity: "3",
            reduceOnly: false,
            purpose: "GRID_ENTRY",
          },
        ],
      }),
    );
    assert.ok(justOver.metrics.plannedGrossNotional !== null);
    assert.ok(justOver.reasonCodes.includes("PLANNED_NOTIONAL"));
    assert.notEqual(justOver.action, "CONTINUE");
  });

  test("2D-23 deterministic reason ordering", () => {
    const decision = evaluateRisk(
      baseline({
        latchBlocked: true,
        lease: { proven: false, expired: true, lost: true },
        reconciliation: { unresolved: true },
        realizedTradingPnl: "-6",
      }),
    );
    assert.deepEqual(decision.reasonCodes, sortPhase2DReasonCodes(decision.reasonCodes));
    const persistence = decision.reasonCodes.indexOf("PERSISTENCE_UNPROVEN");
    const lease = decision.reasonCodes.indexOf("LEASE_UNPROVEN");
    const haltAck = decision.reasonCodes.indexOf("DURABLE_HALT_OR_ACK_UNAVAILABLE");
    const recon = decision.reasonCodes.indexOf("RECONCILIATION_REQUIRED");
    const daily = decision.reasonCodes.indexOf("DAILY_LOSS");
    assert.ok(persistence < lease);
    assert.ok(lease < haltAck);
    assert.ok(haltAck < recon);
    assert.ok(recon < daily);
  });

  test("2D-24 caller objects are not mutated", () => {
    const owned = {
      side: "BUY" as const,
      price: "100",
      remainingQuantity: "0.1",
      reduceOnly: false,
      owned: true,
    };
    const input = baseline({ ownedActiveOrders: [owned] });
    const before = JSON.stringify(input);
    const decision = evaluateRisk(input);
    assert.equal(JSON.stringify(input), before);
    owned.remainingQuantity = "9";
    input.signedPosition = "99";
    const firstOrder = input.ownedActiveOrders[0];
    if (firstOrder !== undefined) {
      firstOrder.price = "1";
    }
    assert.equal(JSON.stringify(input) !== before, true);
    const parsed = JSON.parse(before) as {
      ownedActiveOrders: Array<{ remainingQuantity: string }>;
    };
    assert.equal(parsed.ownedActiveOrders[0]?.remainingQuantity, "0.1");
    assert.equal(decision.metrics.plannedGrossNotional, "10");
    assert.equal(decision.metrics.signedPosition, "0");
  });

  test("2D-25 diagnostics do not leak secret-like values", () => {
    const decision = evaluateRisk(baseline());
    const diagnostic = formatRiskDecisionDiagnostic(decision);
    assert.equal(diagnosticContainsSecretLike(diagnostic), false);
    assert.equal(diagnostic.includes("apiKey"), false);
    assert.equal(diagnostic.includes("secret"), false);
    assert.equal(diagnostic.includes("BEGIN PRIVATE"), false);
  });

  test("2D-26 CONTINUE still has systemAllowRiskIncrease=false", () => {
    const decision = evaluateRisk(baseline());
    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.ok(decision.reasonCodes.includes("DURABLE_HALT_OR_ACK_UNAVAILABLE"));
    assert.ok(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"));
  });

  test("2D-27 all Phase 2C corrective tests remain present", async () => {
    const text = await readFile(
      path.join(process.cwd(), "test/persistence/runtime-lease-corrective-1.test.ts"),
      "utf8",
    );
    for (let index = 1; index <= 24; index += 1) {
      assert.ok(text.includes(`2C-C1-${String(index).padStart(2, "0")}`));
    }
  });

  test("2D-28 previous Phase 2A/2B/2C tests remain present", async () => {
    const phase2c = await readFile(
      path.join(process.cwd(), "test/persistence/runtime-lease.test.ts"),
      "utf8",
    );
    assert.ok(phase2c.includes("2C-L30"));
    const phase2b = await readFile(
      path.join(process.cwd(), "test/persistence/atomic-pair-store.test.ts"),
      "utf8",
    );
    assert.ok(phase2b.includes("2B-P22 all backup A..H real SIGKILL cases"));
    const dryRun = bootDryRun();
    assert.equal(dryRun.liveExchangeWrites, false);
  });
});
