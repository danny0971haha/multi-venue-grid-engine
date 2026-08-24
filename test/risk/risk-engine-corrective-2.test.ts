import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import {
  evaluateRisk,
  FROZEN_DAILY_NET_LOSS_USDT,
  FROZEN_PLANNED_GROSS_NOTIONAL_USDT,
  FROZEN_START_DRAWDOWN_USDT,
} from "../../src/risk/index.js";
import type { RiskDecision, RiskInput, RiskWorkingOrder } from "../../src/risk/index.js";
import { UNAUTHORIZED_EVALUATED_AT } from "../../src/risk/risk-input-parser.js";

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

function workingOrder(): RiskWorkingOrder {
  return {
    side: "BUY",
    price: "100",
    remainingQuantity: "1",
    reduceOnly: false,
    owned: true,
  };
}

function assertInvalidBoundary(
  decision: RiskDecision,
  evaluatedAt = UNAUTHORIZED_EVALUATED_AT,
): void {
  assert.equal(decision.action, "HALT");
  assert.equal(decision.systemAllowRiskIncrease, false);
  assert.equal(decision.riskMetricsWithinLimits, false);
  assert.equal(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"), false);
  assert.equal(decision.reasonCodes.includes("DURABLE_HALT_OR_ACK_UNAVAILABLE"), true);
  assert.equal(decision.reasonCodes.includes("INVALID_RISK_INPUT"), true);
  assert.equal(decision.reasonCodes.includes("STALE_OR_MISSING_INPUT"), true);
  assert.equal(decision.metrics.plannedGrossNotional, null);
  assert.equal(decision.metrics.actualGrossNotional, null);
  assert.equal(decision.metrics.worstLongNotional, null);
  assert.equal(decision.metrics.worstShortNotional, null);
  assert.equal(decision.metrics.netDailyPnl, null);
  assert.equal(decision.metrics.equity, null);
  assert.equal(decision.metrics.startingEquity, null);
  assert.equal(decision.metrics.highWaterEquity, null);
  assert.equal(decision.metrics.startDrawdown, null);
  assert.equal(decision.metrics.signedPosition, null);
  assert.equal(decision.metrics.markOrMidPrice, null);
  assert.equal(decision.metrics.plannedCap, FROZEN_PLANNED_GROSS_NOTIONAL_USDT);
  assert.equal(decision.metrics.dailyLossLimit, FROZEN_DAILY_NET_LOSS_USDT);
  assert.equal(decision.metrics.startDrawdownLimit, FROZEN_START_DRAWDOWN_USDT);
  assert.equal(decision.evaluatedAt, evaluatedAt);
}

function omitKey(input: RiskInput, key: keyof RiskInput): unknown {
  const copy: Record<string, unknown> = { ...input };
  delete copy[key];
  return copy;
}

describe("Phase 2D corrective 2", { concurrency: 1 }, () => {
  test("P2D-C2-01 input=null -> HALT without throwing", () => {
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(null as unknown);
    });
    assertInvalidBoundary(decision as RiskDecision);
  });

  test("P2D-C2-02 input=undefined -> HALT without throwing", () => {
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(undefined as unknown);
    });
    assertInvalidBoundary(decision as RiskDecision);
  });

  test("P2D-C2-03 primitive string/number/boolean -> HALT", () => {
    for (const value of ["risk", 1, true, false, 0] as const) {
      const decision = evaluateRisk(value as unknown);
      assertInvalidBoundary(decision);
    }
  });

  test("P2D-C2-04 missing ownedActiveOrders -> HALT", () => {
    const decision = evaluateRisk(omitKey(baseline(), "ownedActiveOrders"));
    assertInvalidBoundary(decision, NOW);
  });

  test("P2D-C2-05 ownedActiveOrders=null/object/string -> HALT", () => {
    for (const ownedActiveOrders of [null, { length: 0 }, "[]"] as const) {
      const decision = evaluateRisk({
        ...baseline(),
        ownedActiveOrders,
      } as unknown);
      assertInvalidBoundary(decision, NOW);
    }
  });

  test("P2D-C2-06 unknownReservations is not an array -> HALT", () => {
    const decision = evaluateRisk({
      ...baseline(),
      unknownReservations: { side: "BUY" },
    } as unknown);
    assertInvalidBoundary(decision, NOW);
  });

  test("P2D-C2-07 proposedBatch is not an array -> HALT", () => {
    const decision = evaluateRisk({
      ...baseline(),
      proposedBatch: "batch",
    } as unknown);
    assertInvalidBoundary(decision, NOW);
  });

  test("P2D-C2-08 malformed freshness/lease/reconciliation/durableInspection/boundedReduction -> HALT", () => {
    const cases: unknown[] = [
      { ...baseline(), freshness: null },
      { ...baseline(), freshness: { evaluatedAt: NOW } },
      { ...baseline(), lease: null },
      { ...baseline(), lease: { proven: true } },
      { ...baseline(), reconciliation: "no" },
      { ...baseline(), durableInspection: [] },
      { ...baseline(), boundedReduction: { possible: true } },
      new (class HostileInput {})(),
    ];
    for (const value of cases) {
      const decision = evaluateRisk(value);
      assert.equal(decision.action, "HALT");
      assert.equal(decision.systemAllowRiskIncrease, false);
      assert.equal(decision.reasonCodes.includes("INVALID_RISK_INPUT"), true);
      assert.equal(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"), false);
    }
  });

  test("P2D-C2-09 array element null/primitive/malformed -> HALT", () => {
    const cases: unknown[] = [
      { ...baseline(), ownedActiveOrders: [null] },
      { ...baseline(), ownedActiveOrders: ["order"] },
      { ...baseline(), ownedActiveOrders: [1] },
      { ...baseline(), ownedActiveOrders: [{ side: "BUY" }] },
      { ...baseline(), unknownReservations: [null] },
      { ...baseline(), proposedBatch: [false] },
    ];
    for (const value of cases) {
      const decision = evaluateRisk(value);
      assertInvalidBoundary(decision, NOW);
    }
  });

  test("P2D-C2-10 top-level getter throws -> HALT, exception does not escape", () => {
    const input = baseline();
    let getterCalls = 0;
    Object.defineProperty(input, "ownedActiveOrders", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("top-level getter");
      },
    });
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(input as unknown);
    });
    assert.equal(getterCalls, 0);
    assertInvalidBoundary(decision as RiskDecision);
  });

  test("P2D-C2-11 nested getter throws -> HALT", () => {
    const input = baseline();
    let getterCalls = 0;
    Object.defineProperty(input.freshness, "evaluatedAt", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("nested getter");
      },
    });
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(input as unknown);
    });
    assert.equal(getterCalls, 0);
    assert.equal((decision as RiskDecision).action, "HALT");
    assert.equal((decision as RiskDecision).reasonCodes.includes("INVALID_RISK_INPUT"), true);
    assert.equal((decision as RiskDecision).systemAllowRiskIncrease, false);
  });

  test("P2D-C2-12 stateful getter is rejected or observed once", () => {
    const input = baseline();
    let getterCalls = 0;
    Object.defineProperty(input, "ownedActiveOrders", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? [] : null;
      },
    });
    const decision = evaluateRisk(input as unknown);
    assert.ok(getterCalls <= 1);
    assert.equal(decision.action, "HALT");
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.equal(decision.reasonCodes.includes("INVALID_RISK_INPUT"), true);
    assert.equal(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"), false);
  });

  test("P2D-C2-13 Proxy ownKeys throws -> HALT", () => {
    const target = baseline();
    const proxied = new Proxy(target, {
      ownKeys() {
        throw new Error("ownKeys");
      },
    });
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(proxied as unknown);
    });
    assertInvalidBoundary(decision as RiskDecision);
  });

  test("P2D-C2-14 Proxy getOwnPropertyDescriptor throws -> HALT", () => {
    const target = baseline();
    const proxied = new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error("getOwnPropertyDescriptor");
      },
    });
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(proxied as unknown);
    });
    assertInvalidBoundary(decision as RiskDecision);
  });

  test("P2D-C2-15 sparse array / accessor array index -> HALT", () => {
    const sparse: unknown[] = [];
    sparse[1] = workingOrder();
    const sparseDecision = evaluateRisk({
      ...baseline(),
      ownedActiveOrders: sparse,
    } as unknown);
    assertInvalidBoundary(sparseDecision);

    const accessorOrders: unknown[] = [];
    let getterCalls = 0;
    Object.defineProperty(accessorOrders, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("array index getter");
      },
    });
    const accessorDecision = evaluateRisk({
      ...baseline(),
      ownedActiveOrders: accessorOrders,
    } as unknown);
    assert.equal(getterCalls, 0);
    assertInvalidBoundary(accessorDecision);
  });

  test("P2D-C2-16 caller object is byte-identical and not mutated", () => {
    const valid = baseline({
      ownedActiveOrders: [workingOrder()],
    });
    const validBefore = JSON.stringify(valid);
    evaluateRisk(valid);
    assert.equal(JSON.stringify(valid), validBefore);

    const malformed = {
      ...baseline(),
      extra: "nope",
    } as unknown as Record<string, unknown>;
    const malformedBefore = JSON.stringify(malformed);
    evaluateRisk(malformed as unknown);
    assert.equal(JSON.stringify(malformed), malformedBefore);
  });

  test("P2D-C2-17 repeated malformed evaluation is byte-identical", () => {
    const malformed = { ...baseline(), ownedActiveOrders: null } as unknown;
    const first = JSON.stringify(evaluateRisk(malformed));
    const second = JSON.stringify(evaluateRisk(malformed));
    assert.equal(first, second);
    const third = JSON.stringify(evaluateRisk(null as unknown));
    const fourth = JSON.stringify(evaluateRisk(null as unknown));
    assert.equal(third, fourth);
  });

  test("P2D-C2-18 valid Phase 2D inputs remain byte-identical at 150/-5/10 and boundary", () => {
    const exactCap = evaluateRisk(
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
    assert.equal(exactCap.metrics.plannedGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT);
    assert.equal(exactCap.action, "CONTINUE");
    assert.equal(exactCap.systemAllowRiskIncrease, false);
    assert.equal(
      JSON.stringify(exactCap),
      JSON.stringify(
        evaluateRisk(
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
        ),
      ),
    );

    const dailyHalt = evaluateRisk(baseline({ realizedTradingPnl: "-5" }));
    assert.equal(dailyHalt.action, "HALT");
    assert.equal(dailyHalt.reasonCodes.includes("DAILY_LOSS"), true);
    assert.equal(dailyHalt.metrics.netDailyPnl, FROZEN_DAILY_NET_LOSS_USDT);
    assert.equal(dailyHalt.systemAllowRiskIncrease, false);

    const drawdownHalt = evaluateRisk(baseline({ equity: "90", startingEquity: "100" }));
    assert.equal(drawdownHalt.action, "HALT");
    assert.equal(drawdownHalt.reasonCodes.includes("START_DRAWDOWN"), true);
    assert.equal(drawdownHalt.metrics.startDrawdown, FROZEN_START_DRAWDOWN_USDT);

    const longEqual = evaluateRisk(
      baseline({
        signedPosition: "1",
        markOrMidPrice: "96.03",
        gridLower: "97",
        gridUpper: "103",
      }),
    );
    assert.equal(longEqual.reasonCodes.includes("BOUNDARY"), false);
    assert.equal(longEqual.action, "CONTINUE");
    assert.equal(longEqual.systemAllowRiskIncrease, false);
  });

  test("P2D-C2-19 original Phase 2D and corrective 1 tests remain present", async () => {
    const original = await readFile(
      path.join(process.cwd(), "test/risk/risk-engine.test.ts"),
      "utf8",
    );
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
      assert.ok(original.includes(id), `missing ${id}`);
    }
    const corrective1 = await readFile(
      path.join(process.cwd(), "test/risk/risk-engine-corrective-1.test.ts"),
      "utf8",
    );
    for (let index = 1; index <= 18; index += 1) {
      const id = `P2D-C1-${String(index).padStart(2, "0")}`;
      assert.ok(corrective1.includes(id), `missing ${id}`);
    }
  });

  test("P2D-C2-20 systemAllowRiskIncrease is always false", () => {
    const decisions = [
      evaluateRisk(baseline()),
      evaluateRisk(null as unknown),
      evaluateRisk(baseline({ realizedTradingPnl: "-5" })),
      evaluateRisk({ ...baseline(), ownedActiveOrders: null } as unknown),
    ];
    for (const decision of decisions) {
      assert.equal(decision.systemAllowRiskIncrease, false);
    }
  });
});
