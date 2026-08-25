import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";

import { decimalConstructorStats, resetDecimalConstructorStats } from "../../src/math/decimal.js";
import { canonicalSerializeToUtf8 } from "../../src/persistence/canonical-json.js";
import { exposureIterationStats, resetExposureIterationStats } from "../../src/risk/exposure.js";
import {
  diagnosticContainsSecretLike,
  evaluateRisk,
  evaluateRiskFromJsonBytes,
  formatRiskDecisionDiagnostic,
  FROZEN_DAILY_NET_LOSS_USDT,
  FROZEN_PLANNED_GROSS_NOTIONAL_USDT,
  FROZEN_START_DRAWDOWN_USDT,
  MAX_RISK_COLLECTION_LENGTH,
  MAX_RISK_DECIMAL_CHARS,
  MAX_RISK_INPUT_DEPTH,
  MAX_RISK_INPUT_NODES,
  MAX_RISK_INPUT_UTF8_BYTES,
  MAX_RISK_OBJECT_KEY_CHARS,
  MAX_RISK_OBJECT_PROPERTIES,
  MAX_RISK_STRING_CHARS,
  PHASE_2D_REASON_CODE_CATALOG,
  sortPhase2DReasonCodes,
} from "../../src/risk/index.js";
import {
  riskAdmissionStats,
  resetRiskAdmissionStats,
  UNAUTHORIZED_EVALUATED_AT,
} from "../../src/risk/risk-input-parser.js";
import type {
  RiskDecision,
  RiskInput,
  RiskProposedIntent,
  RiskUnknownReservation,
  RiskWorkingOrder,
} from "../../src/risk/index.js";
import {
  CANONICAL_ENVELOPE_HASH_INPUT_BYTES,
  CANONICAL_PAYLOAD_BYTES,
  ENVELOPE_SHA256,
  FIXTURE_PAYLOAD,
  FULL_ENVELOPE_BYTES,
  PAYLOAD_SHA256,
} from "../fixtures/phase2a-canonical-vector.js";

const NOW = "1000000";
const SECRET_LIKE = "c3-local-fixture-not-a-credential";
const FROZEN_CATALOG_PREFIX = [
  "PERSISTENCE_UNPROVEN",
  "LEASE_UNPROVEN",
  "DURABLE_HALT_OR_ACK_UNAVAILABLE",
  "RECONCILIATION_REQUIRED",
  "STALE_OR_MISSING_INPUT",
  "DAILY_LOSS",
  "START_DRAWDOWN",
  "BOUNDARY",
  "ACTUAL_NOTIONAL",
  "PLANNED_NOTIONAL",
  "CONTINUE_METRICS_ONLY",
  "LATCH_BLOCKED",
  "PAIR_UNPROVEN",
  "LEASE_LOST",
  "LEASE_EXPIRED",
  "FEE_MISSING",
  "FUNDING_MISSING",
  "FUNDING_CONVENTION_MISSING",
  "UNBOUNDED_EXPOSURE",
  "INVALID_DECIMAL",
  "INVALID_RISK_INPUT",
  "REDUCTION_NOT_PROVEN",
  "REDUCTION_AMBIGUOUS",
  "CANCEL_ONLY_REDUCTION",
  "BOUNDARY_SEED_BLOCKED",
  "HIGH_WATER_OBSERVED",
] as const;

const FROZEN_BASELINE_DECISION_JSON =
  '{"action":"CONTINUE","reasonCodes":["DURABLE_HALT_OR_ACK_UNAVAILABLE","CONTINUE_METRICS_ONLY","HIGH_WATER_OBSERVED"],"metrics":{"plannedGrossNotional":"0","actualGrossNotional":"0","worstLongNotional":"0","worstShortNotional":"0","netDailyPnl":"0","equity":"100","startingEquity":"100","highWaterEquity":"100","startDrawdown":"0","signedPosition":"0","markOrMidPrice":"100","plannedCap":"150","dailyLossLimit":"-5","startDrawdownLimit":"10"},"riskMetricsWithinLimits":true,"systemAllowRiskIncrease":false,"evaluatedAt":"1000000"}';

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

function reservation(): RiskUnknownReservation {
  return { side: "BUY", price: "100", quantity: "1" };
}

function intent(): RiskProposedIntent {
  return {
    side: "BUY",
    price: "100",
    quantity: "1",
    reduceOnly: false,
    purpose: "GRID_ENTRY",
  };
}

function evaluateJson(value: unknown): RiskDecision {
  return evaluateRiskFromJsonBytes(JSON.stringify(value));
}

function padUtf8(json: string, targetBytes: number): string {
  const size = Buffer.byteLength(json, "utf8");
  assert.ok(size <= targetBytes, `json already ${String(size)} bytes`);
  return `${json}${" ".repeat(targetBytes - size)}`;
}

function nestedContainers(depth: number): unknown {
  let current: unknown = true;
  for (let index = 0; index < depth; index += 1) {
    current = { nested: current };
  }
  return current;
}

function countNodes(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 1;
  }
  if (Array.isArray(value)) {
    return 1 + value.reduce<number>((sum, element) => sum + countNodes(element), 0);
  }
  return 1 + Object.values(value).reduce<number>((sum, element) => sum + countNodes(element), 0);
}

function exactNodeCount(target: number): unknown {
  if (target === 1) {
    return null;
  }
  if (target <= 1 + MAX_RISK_COLLECTION_LENGTH) {
    return Array.from({ length: target - 1 }, () => null);
  }
  const root: unknown[] = [];
  let remaining = target - 1;
  while (remaining > 0) {
    if (remaining === 1) {
      root.push(null);
      remaining -= 1;
      continue;
    }
    const nulls = Math.min(MAX_RISK_COLLECTION_LENGTH, remaining - 1);
    root.push(Array.from({ length: nulls }, () => null));
    remaining -= 1 + nulls;
  }
  assert.ok(root.length <= MAX_RISK_COLLECTION_LENGTH);
  return root;
}

function objectWithKeys(count: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (let index = 0; index < count; index += 1) {
    record[`k${String(index)}`] = 1;
  }
  return record;
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

function assertLimitBoundary(
  decision: RiskDecision,
  evaluatedAt = UNAUTHORIZED_EVALUATED_AT,
): void {
  assertInvalidBoundary(decision, evaluatedAt);
  assert.equal(decision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), true);
  assert.deepEqual(decision.reasonCodes, sortPhase2DReasonCodes(decision.reasonCodes));
}

function assertNoLimit(decision: RiskDecision): void {
  assert.equal(decision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
}

describe("Phase 2D corrective 3", { concurrency: 1 }, () => {
  beforeEach(() => {
    resetDecimalConstructorStats();
    resetExposureIterationStats();
    resetRiskAdmissionStats();
  });

  test("C3-01 raw JSON exact 65,536 bytes", () => {
    const json = JSON.stringify(baseline());
    const padded = padUtf8(json, MAX_RISK_INPUT_UTF8_BYTES);
    assert.equal(Buffer.byteLength(padded, "utf8"), MAX_RISK_INPUT_UTF8_BYTES);
    const fromString = evaluateRiskFromJsonBytes(padded);
    const fromBytes = evaluateRiskFromJsonBytes(new Uint8Array(Buffer.from(padded, "utf8")));
    const expected = evaluateRisk(baseline());
    assert.equal(JSON.stringify(fromString), JSON.stringify(expected));
    assert.equal(JSON.stringify(fromBytes), JSON.stringify(expected));
    assertNoLimit(fromString);
    assert.ok(riskAdmissionStats.jsonParseCalls >= 1);
  });

  test("C3-02 raw JSON 65,537 bytes", () => {
    const padded = padUtf8(JSON.stringify(baseline()), MAX_RISK_INPUT_UTF8_BYTES + 1);
    assert.equal(Buffer.byteLength(padded, "utf8"), MAX_RISK_INPUT_UTF8_BYTES + 1);
    const decision = evaluateRiskFromJsonBytes(padded);
    assertLimitBoundary(decision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assert.equal(decimalConstructorStats.calls, 0);
    assert.equal(exposureIterationStats.calls, 0);
  });

  test("C3-03 invalid UTF-8", () => {
    const decision = evaluateRiskFromJsonBytes(new Uint8Array([0x7b, 0xff, 0x7d]));
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
  });

  test("C3-04 malformed JSON", () => {
    const decision = evaluateRiskFromJsonBytes('{"signedPosition":');
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 1);
    assert.equal(decimalConstructorStats.calls, 0);
  });

  test("C3-05 depth exactly 8", () => {
    const value = nestedContainers(MAX_RISK_INPUT_DEPTH);
    const decision = evaluateJson(value);
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
  });

  test("C3-06 depth 9", () => {
    const decision = evaluateJson(nestedContainers(MAX_RISK_INPUT_DEPTH + 1));
    assertLimitBoundary(decision);
    assert.equal(decimalConstructorStats.calls, 0);
    assert.equal(exposureIterationStats.calls, 0);
  });

  test("C3-07 node count exactly 2,048", () => {
    const value = exactNodeCount(MAX_RISK_INPUT_NODES);
    assert.equal(countNodes(value), MAX_RISK_INPUT_NODES);
    const decision = evaluateJson(value);
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
  });

  test("C3-08 node count 2,049", () => {
    const value = exactNodeCount(MAX_RISK_INPUT_NODES + 1);
    assert.equal(countNodes(value), MAX_RISK_INPUT_NODES + 1);
    const decision = evaluateJson(value);
    assertLimitBoundary(decision);
    assert.equal(exposureIterationStats.iterationsStarted, 0);
  });

  test("C3-09 collection length exactly 128", () => {
    const decision = evaluateJson(Array.from({ length: MAX_RISK_COLLECTION_LENGTH }, () => 1));
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
  });

  test("C3-10 collection length 129", () => {
    const decision = evaluateJson(Array.from({ length: MAX_RISK_COLLECTION_LENGTH + 1 }, () => 1));
    assertLimitBoundary(decision);
    assert.equal(exposureIterationStats.calls, 0);
  });

  test("C3-11 object properties exactly 64", () => {
    const decision = evaluateJson(objectWithKeys(MAX_RISK_OBJECT_PROPERTIES));
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
  });

  test("C3-12 object properties 65", () => {
    const decision = evaluateJson(objectWithKeys(MAX_RISK_OBJECT_PROPERTIES + 1));
    assertLimitBoundary(decision);
  });

  test("C3-13 string exactly 256 chars", () => {
    const decision = evaluateJson({ s: "x".repeat(MAX_RISK_STRING_CHARS) });
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
  });

  test("C3-14 string 257 chars", () => {
    const decision = evaluateJson({ s: "x".repeat(MAX_RISK_STRING_CHARS + 1) });
    assertLimitBoundary(decision);
  });

  test("C3-15 key exactly 128 chars", () => {
    const decision = evaluateJson({ ["k".repeat(MAX_RISK_OBJECT_KEY_CHARS)]: 1 });
    assertInvalidBoundary(decision);
    assertNoLimit(decision);
  });

  test("C3-16 key 129 chars", () => {
    const decision = evaluateJson({ ["k".repeat(MAX_RISK_OBJECT_KEY_CHARS + 1)]: 1 });
    assertLimitBoundary(decision);
  });

  test("C3-17 decimal exactly 128 chars, valid/invalid cases", () => {
    const valid = `0.${"1".repeat(MAX_RISK_DECIMAL_CHARS - 2)}`;
    assert.equal(valid.length, MAX_RISK_DECIMAL_CHARS);
    const validDecision = evaluateJson(baseline({ fees: valid }));
    assertNoLimit(validDecision);
    assert.ok(decimalConstructorStats.calls > 0);

    resetDecimalConstructorStats();
    const invalid = `${"1".repeat(MAX_RISK_DECIMAL_CHARS - 1)}a`;
    assert.equal(invalid.length, MAX_RISK_DECIMAL_CHARS);
    const invalidDecision = evaluateJson(baseline({ signedPosition: invalid }));
    assert.equal(invalidDecision.action, "HALT");
    assert.equal(invalidDecision.systemAllowRiskIncrease, false);
    assertNoLimit(invalidDecision);
    assert.equal(invalidDecision.reasonCodes.includes("INVALID_DECIMAL"), true);
  });

  test("C3-18 decimal 129 chars", () => {
    const overlong = "1".repeat(MAX_RISK_DECIMAL_CHARS + 1);
    const decision = evaluateJson(baseline({ signedPosition: overlong }));
    assertLimitBoundary(decision, NOW);
    assert.equal(decimalConstructorStats.calls, 0);
    assert.equal(exposureIterationStats.calls, 0);
  });

  test("C3-19 giant evaluatedAt does not echo input", () => {
    const giant = "9".repeat(10_000);
    const input = baseline({ freshness: { ...baseline().freshness, evaluatedAt: giant } });
    const decision = evaluateJson(input);
    assertLimitBoundary(decision);
    assert.equal(decision.evaluatedAt, UNAUTHORIZED_EVALUATED_AT);
    const rendered = `${JSON.stringify(decision)}\n${formatRiskDecisionDiagnostic(decision)}`;
    assert.equal(rendered.includes(giant), false);
    assert.equal(rendered.includes("9".repeat(20)), false);
  });

  test('C3-20 malformed evaluatedAt returns "0"', () => {
    for (const evaluatedAt of ["abc", "01", "1.0", "10000000000000", "", "-1"] as const) {
      const decision = evaluateJson(
        baseline({ freshness: { ...baseline().freshness, evaluatedAt } }),
      );
      assert.equal(decision.evaluatedAt, UNAUTHORIZED_EVALUATED_AT);
      assert.equal(decision.action, "HALT");
      assert.equal(decision.systemAllowRiskIncrease, false);
    }
    const objectDecision = evaluateJson({
      ...baseline(),
      freshness: { ...baseline().freshness, evaluatedAt: { ms: 1 } },
    });
    assert.equal(objectDecision.evaluatedAt, UNAUTHORIZED_EVALUATED_AT);
    assertInvalidBoundary(objectDecision);
  });

  test("C3-21 large ownedActiveOrders", () => {
    const orders = Array.from({ length: MAX_RISK_COLLECTION_LENGTH }, () => workingOrder());
    const decision = evaluateJson(baseline({ ownedActiveOrders: orders }));
    assertNoLimit(decision);
    assert.equal(decision.systemAllowRiskIncrease, false);
    assert.ok(exposureIterationStats.iterationsStarted > 0);
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
  });

  test("C3-22 large unknownReservations", () => {
    const items = Array.from({ length: MAX_RISK_COLLECTION_LENGTH }, () => reservation());
    const decision = evaluateJson(baseline({ unknownReservations: items }));
    assertNoLimit(decision);
    assert.equal(decision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
  });

  test("C3-23 large proposedBatch", () => {
    const items = Array.from({ length: MAX_RISK_COLLECTION_LENGTH }, () => intent());
    const decision = evaluateJson(baseline({ proposedBatch: items }));
    assertNoLimit(decision);
    assert.ok(decision.reasonCodes.includes("PLANNED_NOTIONAL"));
  });

  test("C3-24 deeply nested unknown property", () => {
    const inBudget = {
      ...baseline(),
      extra: nestedContainers(MAX_RISK_INPUT_DEPTH - 1),
    };
    const inBudgetDecision = evaluateJson(inBudget);
    assertInvalidBoundary(inBudgetDecision, NOW);
    assertNoLimit(inBudgetDecision);

    const overBudget = {
      ...baseline(),
      extra: nestedContainers(MAX_RISK_INPUT_DEPTH),
    };
    const overBudgetDecision = evaluateJson(overBudget);
    assertLimitBoundary(overBudgetDecision, NOW);
  });

  test("C3-25 limit failure deterministic on repeated evaluation", () => {
    const raw = JSON.stringify(Array.from({ length: MAX_RISK_COLLECTION_LENGTH + 1 }, () => 1));
    const first = JSON.stringify(evaluateRiskFromJsonBytes(raw));
    const second = JSON.stringify(evaluateRiskFromJsonBytes(raw));
    const third = JSON.stringify(evaluateRiskFromJsonBytes(raw));
    assert.equal(first, second);
    assert.equal(second, third);
  });

  test("C3-26 no caller mutation", () => {
    const valid = baseline({ ownedActiveOrders: [workingOrder()] });
    const validBefore = JSON.stringify(valid);
    evaluateRisk(valid);
    assert.equal(JSON.stringify(valid), validBefore);

    const json = JSON.stringify(baseline());
    const bytes = new Uint8Array(Buffer.from(json, "utf8"));
    const bytesBefore = Uint8Array.from(bytes);
    evaluateRiskFromJsonBytes(bytes);
    assert.deepEqual(bytes, bytesBefore);
  });

  test("C3-27 no secret-like diagnostic leakage", () => {
    const payload = {
      apiKey: SECRET_LIKE,
      password: SECRET_LIKE,
      items: Array.from({ length: MAX_RISK_COLLECTION_LENGTH + 1 }, () => SECRET_LIKE),
    };
    const decision = evaluateJson(payload);
    assertLimitBoundary(decision);
    const diagnostic = formatRiskDecisionDiagnostic(decision);
    assert.equal(diagnostic.includes(SECRET_LIKE), false);
    assert.equal(JSON.stringify(decision).includes(SECRET_LIKE), false);
    assert.equal(diagnosticContainsSecretLike(diagnostic), false);
  });

  test("C3-28 valid in-budget input equals previous RiskDecision", () => {
    const objectDecision = evaluateRisk(baseline());
    const bytesDecision = evaluateRiskFromJsonBytes(JSON.stringify(baseline()));
    assert.equal(JSON.stringify(objectDecision), FROZEN_BASELINE_DECISION_JSON);
    assert.equal(JSON.stringify(bytesDecision), FROZEN_BASELINE_DECISION_JSON);
    assert.equal(objectDecision.metrics.plannedCap, FROZEN_PLANNED_GROSS_NOTIONAL_USDT);
    assert.equal(objectDecision.metrics.dailyLossLimit, FROZEN_DAILY_NET_LOSS_USDT);
    assert.equal(objectDecision.metrics.startDrawdownLimit, FROZEN_START_DRAWDOWN_USDT);

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
    assert.equal(
      JSON.stringify(exactCap),
      JSON.stringify(
        evaluateRiskFromJsonBytes(
          JSON.stringify(
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
      ),
    );
  });

  test("C3-29 persistence canonical vectors byte-for-byte unchanged", () => {
    const payload = {
      marker: FIXTURE_PAYLOAD.marker,
      notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
      levels: FIXTURE_PAYLOAD.levels,
    };
    const bytes = canonicalSerializeToUtf8(payload);
    assert.equal(bytes, CANONICAL_PAYLOAD_BYTES);
    assert.equal(createHash("sha256").update(bytes, "utf8").digest("hex"), PAYLOAD_SHA256);
    assert.equal(CANONICAL_ENVELOPE_HASH_INPUT_BYTES.includes("\n"), false);
    assert.equal(FULL_ENVELOPE_BYTES.startsWith("{"), true);
    assert.equal(
      createHash("sha256").update(CANONICAL_ENVELOPE_HASH_INPUT_BYTES, "utf8").digest("hex"),
      ENVELOPE_SHA256,
    );
    assert.equal(canonicalSerializeToUtf8(payload, { maxNodes: 1_000_000 }), bytes);
  });

  test("C3-30 thrown getter still HALT", () => {
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
    assertNoLimit(decision as RiskDecision);
  });

  test("C3-31 finite throwing Proxy still HALT", () => {
    const proxied = new Proxy(baseline(), {
      getOwnPropertyDescriptor() {
        throw new Error("getOwnPropertyDescriptor");
      },
    });
    let decision: RiskDecision | undefined;
    assert.doesNotThrow(() => {
      decision = evaluateRisk(proxied as unknown);
    });
    assertInvalidBoundary(decision as RiskDecision);
    assertNoLimit(decision as RiskDecision);
  });

  test("C3-32 object API limitation documented without false hard-timeout claim", async () => {
    const contract = await readFile(path.join(process.cwd(), "docs/PHASE_2D_CONTRACT.md"), "utf8");
    const engine = await readFile(path.join(process.cwd(), "src/risk/risk-engine.ts"), "utf8");
    assert.equal(contract.includes("evaluateRiskFromJsonBytes"), true);
    assert.equal(contract.includes("not a DoS-proof guarantee"), true);
    assert.equal(contract.includes("hard completion-time"), true);
    assert.equal(contract.includes("worker/process isolation"), true);
    assert.equal(contract.includes("evaluateRisk(unknown) is DoS-proof"), false);
    assert.equal(contract.includes("Promise.race enforces a hard timeout"), false);
    assert.equal(engine.includes("This is not a DoS-proof or hard-timeout"), true);
  });

  test("C3-33 raw-byte API rejects before Decimal work", () => {
    const overlong = "1".repeat(MAX_RISK_DECIMAL_CHARS + 1);
    const decision = evaluateRiskFromJsonBytes(
      JSON.stringify(baseline({ markOrMidPrice: overlong })),
    );
    assertLimitBoundary(decision, NOW);
    assert.equal(decimalConstructorStats.calls, 0);
    assert.equal(exposureIterationStats.calls, 0);
  });

  test("C3-34 raw-byte API rejects before exposure iteration", () => {
    const orders = Array.from({ length: MAX_RISK_COLLECTION_LENGTH + 1 }, () => workingOrder());
    const decision = evaluateRiskFromJsonBytes(
      JSON.stringify(baseline({ ownedActiveOrders: orders })),
    );
    assertLimitBoundary(decision, NOW);
    assert.equal(exposureIterationStats.calls, 0);
    assert.equal(exposureIterationStats.iterationsStarted, 0);
    assert.equal(decimalConstructorStats.calls, 0);
  });

  test("C3-35 reason-code ordering remains deterministic", () => {
    assert.deepEqual(
      [...PHASE_2D_REASON_CODE_CATALOG.slice(0, FROZEN_CATALOG_PREFIX.length)],
      [...FROZEN_CATALOG_PREFIX],
    );
    assert.equal(
      PHASE_2D_REASON_CODE_CATALOG[FROZEN_CATALOG_PREFIX.length],
      "RISK_INPUT_LIMIT_EXCEEDED",
    );
    assert.equal(PHASE_2D_REASON_CODE_CATALOG.length, FROZEN_CATALOG_PREFIX.length + 1);
    const shuffled = [...PHASE_2D_REASON_CODE_CATALOG].reverse();
    assert.deepEqual(sortPhase2DReasonCodes(shuffled), [...PHASE_2D_REASON_CODE_CATALOG]);
    const limitDecision = evaluateJson(
      Array.from({ length: MAX_RISK_COLLECTION_LENGTH + 1 }, () => 1),
    );
    assert.deepEqual(limitDecision.reasonCodes, sortPhase2DReasonCodes(limitDecision.reasonCodes));
    const haltAck = limitDecision.reasonCodes.indexOf("DURABLE_HALT_OR_ACK_UNAVAILABLE");
    const stale = limitDecision.reasonCodes.indexOf("STALE_OR_MISSING_INPUT");
    const invalid = limitDecision.reasonCodes.indexOf("INVALID_RISK_INPUT");
    const limit = limitDecision.reasonCodes.indexOf("RISK_INPUT_LIMIT_EXCEEDED");
    assert.ok(haltAck < stale);
    assert.ok(stale < invalid);
    assert.ok(invalid < limit);
  });
});
