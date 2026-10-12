import assert from "node:assert/strict";
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
  MAX_RISK_STRING_CHARS,
  sortPhase2DReasonCodes,
} from "../../src/risk/index.js";
import { RISK_CANONICAL_SERIALIZE_LIMITS } from "../../src/risk/risk-input-admission.js";
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

const NOW = "1000000";
const SECRET_LIKE = "c4-local-fixture-not-a-credential";
const LONG_DECIMAL = `0.${"1".repeat(MAX_RISK_DECIMAL_CHARS - 2)}`;
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
    price: LONG_DECIMAL,
    remainingQuantity: LONG_DECIMAL,
    reduceOnly: false,
    owned: true,
  };
}

function reservation(): RiskUnknownReservation {
  return { side: "BUY", price: LONG_DECIMAL, quantity: LONG_DECIMAL };
}

function intent(): RiskProposedIntent {
  return {
    side: "BUY",
    price: LONG_DECIMAL,
    quantity: LONG_DECIMAL,
    reduceOnly: false,
    purpose: "GRID_ENTRY",
  };
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

function maxDepth(value: unknown, depth = 1): number {
  if (value === null || typeof value !== "object") {
    return depth;
  }
  const childDepths = Object.values(value).map((child) => maxDepth(child, depth + 1));
  return childDepths.length === 0 ? depth : Math.max(...childDepths);
}

function maxCollection(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    return Math.max(value.length, ...value.map((child) => maxCollection(child)));
  }
  return Math.max(
    Object.keys(value).length,
    ...Object.values(value).map((child) => maxCollection(child)),
  );
}

function measureCanonical(value: unknown): { text: string; bytes: number } {
  const text = canonicalSerializeToUtf8(value, RISK_CANONICAL_SERIALIZE_LIMITS);
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

function structurallyValidOversizedInput(): RiskInput {
  return baseline({
    ownedActiveOrders: Array.from({ length: 100 }, () => workingOrder()),
    unknownReservations: Array.from({ length: 100 }, () => reservation()),
    proposedBatch: Array.from({ length: 100 }, () => intent()),
  });
}

function payloadWithExactCanonicalUtf8Bytes(targetBytes: number): Record<string, string[]> {
  const buckets: string[][] = [[], [], [], [], []];
  const asObject = (candidate: string[][]): Record<string, string[]> => ({
    a: candidate[0] ?? [],
    b: candidate[1] ?? [],
    c: candidate[2] ?? [],
    d: candidate[3] ?? [],
    e: candidate[4] ?? [],
  });
  const bytesOf = (candidate: string[][]): number => measureCanonical(asObject(candidate)).bytes;
  const clone = (): string[][] => buckets.map((bucket) => [...bucket]);
  const full = "a".repeat(MAX_RISK_STRING_CHARS);

  outer: for (const bucket of buckets) {
    while (bucket.length < MAX_RISK_COLLECTION_LENGTH) {
      bucket.push(full);
      const size = bytesOf(buckets);
      if (size === targetBytes) {
        return asObject(buckets);
      }
      if (size > targetBytes) {
        bucket.pop();
        break outer;
      }
    }
  }

  const tuned = clone();
  const appendChar = (): boolean => {
    for (const bucket of tuned) {
      const last = bucket[bucket.length - 1];
      if (last !== undefined && last.length < MAX_RISK_STRING_CHARS) {
        bucket[bucket.length - 1] = `${last}a`;
        return true;
      }
      if (bucket.length < MAX_RISK_COLLECTION_LENGTH) {
        bucket.push("a");
        return true;
      }
    }
    return false;
  };
  const removeChar = (): boolean => {
    for (let index = tuned.length - 1; index >= 0; index -= 1) {
      const bucket = tuned[index];
      if (bucket === undefined || bucket.length === 0) {
        continue;
      }
      const last = bucket[bucket.length - 1] ?? "";
      if (last.length <= 1) {
        bucket.pop();
        return true;
      }
      bucket[bucket.length - 1] = last.slice(0, -1);
      return true;
    }
    return false;
  };

  while (bytesOf(tuned) < targetBytes) {
    assert.equal(appendChar(), true);
  }
  while (bytesOf(tuned) > targetBytes) {
    assert.equal(removeChar(), true);
  }
  assert.equal(bytesOf(tuned), targetBytes);
  return asObject(tuned);
}

function lastFilledBucket(value: Record<string, string[]>): string[] {
  for (const key of ["e", "d", "c", "b", "a"]) {
    const bucket = value[key];
    if (bucket !== undefined && bucket.length > 0) {
      return bucket;
    }
  }
  throw new Error("expected a non-empty padding bucket");
}

function padUtf8(json: string, targetBytes: number): string {
  const size = Buffer.byteLength(json, "utf8");
  assert.ok(size <= targetBytes, `json already ${String(size)} bytes`);
  return `${json}${" ".repeat(targetBytes - size)}`;
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
  assert.equal(decision.metrics.equity, null);
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

function assertNoMath(): void {
  assert.equal(decimalConstructorStats.calls, 0);
  assert.equal(exposureIterationStats.calls, 0);
  assert.equal(exposureIterationStats.iterationsStarted, 0);
}

function assertObjectRawParity(value: unknown): {
  canonicalBytes: number;
  objectDecision: RiskDecision;
  rawDecision: RiskDecision;
} {
  const { text, bytes } = measureCanonical(value);
  const objectDecision = evaluateRisk(value);
  const rawDecision = evaluateRiskFromJsonBytes(text);
  assert.equal(JSON.stringify(objectDecision), JSON.stringify(rawDecision));
  return { canonicalBytes: bytes, objectDecision, rawDecision };
}

describe("Phase 2D corrective 4", { concurrency: 1 }, () => {
  beforeEach(() => {
    resetDecimalConstructorStats();
    resetExposureIterationStats();
    resetRiskAdmissionStats();
  });

  test("C4-01 structurally valid oversized object matches raw-byte rejection", () => {
    const oversized = structurallyValidOversizedInput();
    assert.ok(maxDepth(oversized) <= MAX_RISK_INPUT_DEPTH);
    assert.ok(countNodes(oversized) <= MAX_RISK_INPUT_NODES);
    assert.ok(maxCollection(oversized) <= MAX_RISK_COLLECTION_LENGTH);
    const { canonicalBytes, objectDecision, rawDecision } = assertObjectRawParity(oversized);
    assert.ok(canonicalBytes > MAX_RISK_INPUT_UTF8_BYTES);
    assertLimitBoundary(objectDecision);
    assertLimitBoundary(rawDecision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
    const rendered = `${JSON.stringify(objectDecision)}\n${formatRiskDecisionDiagnostic(objectDecision)}`;
    assert.equal(rendered.includes(LONG_DECIMAL), false);
  });

  test("C4-02 exact 65,535 canonical bytes object/raw parity", () => {
    const value = payloadWithExactCanonicalUtf8Bytes(MAX_RISK_INPUT_UTF8_BYTES - 1);
    const { canonicalBytes, objectDecision, rawDecision } = assertObjectRawParity(value);
    assert.equal(canonicalBytes, MAX_RISK_INPUT_UTF8_BYTES - 1);
    assertInvalidBoundary(objectDecision);
    assert.equal(objectDecision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
    assert.equal(JSON.stringify(rawDecision), JSON.stringify(objectDecision));
    assert.ok(riskAdmissionStats.jsonParseCalls >= 1);
    assertNoMath();
  });

  test("C4-03 exact 65,536 canonical bytes object/raw parity", () => {
    const value = payloadWithExactCanonicalUtf8Bytes(MAX_RISK_INPUT_UTF8_BYTES);
    const { canonicalBytes, objectDecision } = assertObjectRawParity(value);
    assert.equal(canonicalBytes, MAX_RISK_INPUT_UTF8_BYTES);
    assertInvalidBoundary(objectDecision);
    assert.equal(objectDecision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
    assert.ok(riskAdmissionStats.jsonParseCalls >= 1);
    assertNoMath();
  });

  test("C4-04 exact 65,537 canonical bytes object/raw parity", () => {
    const value = payloadWithExactCanonicalUtf8Bytes(MAX_RISK_INPUT_UTF8_BYTES + 1);
    const { canonicalBytes, objectDecision, rawDecision } = assertObjectRawParity(value);
    assert.equal(canonicalBytes, MAX_RISK_INPUT_UTF8_BYTES + 1);
    assertLimitBoundary(objectDecision);
    assertLimitBoundary(rawDecision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
  });

  test("C4-05 raw ASCII padding 65,535 / 65,536 / 65,537", () => {
    const json = JSON.stringify(baseline());
    const under = evaluateRiskFromJsonBytes(padUtf8(json, MAX_RISK_INPUT_UTF8_BYTES - 1));
    assert.equal(JSON.stringify(under), FROZEN_BASELINE_DECISION_JSON);
    resetDecimalConstructorStats();
    resetExposureIterationStats();
    resetRiskAdmissionStats();
    const exact = evaluateRiskFromJsonBytes(padUtf8(json, MAX_RISK_INPUT_UTF8_BYTES));
    assert.equal(JSON.stringify(exact), FROZEN_BASELINE_DECISION_JSON);
    resetDecimalConstructorStats();
    resetExposureIterationStats();
    resetRiskAdmissionStats();
    const over = evaluateRiskFromJsonBytes(padUtf8(json, MAX_RISK_INPUT_UTF8_BYTES + 1));
    assertLimitBoundary(over);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
  });

  test("C4-06 oversized multibyte UTF-8 within structural caps", () => {
    const euro = "€";
    assert.equal(Buffer.byteLength(euro, "utf8"), 3);
    const value = {
      items: Array.from({ length: MAX_RISK_COLLECTION_LENGTH }, () =>
        euro.repeat(MAX_RISK_STRING_CHARS),
      ),
    };
    assert.ok(maxDepth(value) <= MAX_RISK_INPUT_DEPTH);
    assert.ok(countNodes(value) <= MAX_RISK_INPUT_NODES);
    assert.ok(maxCollection(value) <= MAX_RISK_COLLECTION_LENGTH);
    const { canonicalBytes, objectDecision } = assertObjectRawParity(value);
    assert.ok(canonicalBytes > MAX_RISK_INPUT_UTF8_BYTES);
    assertLimitBoundary(objectDecision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
    const rendered = `${JSON.stringify(objectDecision)}\n${formatRiskDecisionDiagnostic(objectDecision)}`;
    assert.equal(rendered.includes(euro), false);
  });

  test("C4-07 exact 65,537 multibyte object/raw parity", () => {
    const value = payloadWithExactCanonicalUtf8Bytes(MAX_RISK_INPUT_UTF8_BYTES - 1);
    const lastBucket = lastFilledBucket(value);
    const last = lastBucket[lastBucket.length - 1];
    assert.ok(last !== undefined && last.length > 0);
    lastBucket[lastBucket.length - 1] = `${last.slice(0, -1)}€`;
    const { canonicalBytes, objectDecision } = assertObjectRawParity(value);
    assert.equal(canonicalBytes, MAX_RISK_INPUT_UTF8_BYTES + 1);
    assertLimitBoundary(objectDecision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
  });

  test("C4-08 structurally invalid and oversized input", () => {
    const malformed = `${"[".repeat(10)}${"1,".repeat(40_000)}0${"]".repeat(10)}`;
    assert.ok(Buffer.byteLength(malformed, "utf8") > MAX_RISK_INPUT_UTF8_BYTES);
    const decision = evaluateRiskFromJsonBytes(malformed);
    assertLimitBoundary(decision);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
  });

  test("C4-09 oversized rejection is deterministic", () => {
    const oversized = structurallyValidOversizedInput();
    const first = JSON.stringify(evaluateRisk(oversized));
    const second = JSON.stringify(evaluateRisk(oversized));
    const third = JSON.stringify(evaluateRiskFromJsonBytes(measureCanonical(oversized).text));
    assert.equal(first, second);
    assert.equal(second, third);
  });

  test("C4-10 no payload echo on limit failure", () => {
    const oversized = structurallyValidOversizedInput();
    const decision = evaluateRisk(oversized);
    assertLimitBoundary(decision);
    const diagnostic = formatRiskDecisionDiagnostic(decision);
    assert.equal(JSON.stringify(decision).includes(LONG_DECIMAL), false);
    assert.equal(diagnostic.includes(LONG_DECIMAL), false);
    assert.equal(diagnostic.includes(SECRET_LIKE), false);
    assert.equal(diagnosticContainsSecretLike(diagnostic), false);
  });

  test("C4-11 duplicate equity keys fail closed before risk math", () => {
    const json = JSON.stringify(baseline()).replace(
      '"equity":"100"',
      '"equity":"100","equity":"99"',
    );
    const decision = evaluateRiskFromJsonBytes(json);
    assertInvalidBoundary(decision);
    assert.equal(decision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
    assert.equal(decision.reasonCodes.includes("CONTINUE_METRICS_ONLY"), false);
    assert.equal(decision.metrics.equity, null);
    assert.equal(riskAdmissionStats.jsonParseCalls, 1);
    assertNoMath();
    const diagnostic = formatRiskDecisionDiagnostic(decision);
    assert.equal(diagnostic.includes("99"), false);
    assert.equal(JSON.stringify(decision).includes(json), false);
  });

  test("C4-12 escaped duplicate keys and nested duplicates fail closed", () => {
    const escaped = JSON.stringify(baseline()).replace(
      '"equity":"100"',
      '"equity":"100","\\u0065quity":"99"',
    );
    const nested = JSON.stringify(baseline()).replace(
      '"proven":true',
      '"proven":false,"proven":true',
    );
    for (const raw of [escaped, nested]) {
      resetDecimalConstructorStats();
      resetExposureIterationStats();
      resetRiskAdmissionStats();
      const decision = evaluateRiskFromJsonBytes(raw);
      assertInvalidBoundary(decision);
      assert.equal(decision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
      assertNoMath();
    }
  });

  test("C4-13 same key in sibling objects is not a duplicate", () => {
    const json = JSON.stringify(
      baseline({
        ownedActiveOrders: [
          {
            side: "BUY",
            price: "100",
            remainingQuantity: "0",
            reduceOnly: true,
            owned: true,
          },
          {
            side: "SELL",
            price: "101",
            remainingQuantity: "0",
            reduceOnly: true,
            owned: true,
          },
        ],
      }),
    );
    const decision = evaluateRiskFromJsonBytes(json);
    assert.equal(decision.reasonCodes.includes("INVALID_RISK_INPUT"), false);
    assert.equal(decision.systemAllowRiskIncrease, false);
  });

  test("C4-14 unpaired surrogate JS string fails closed before parse", () => {
    const json = JSON.stringify(baseline());
    const poisoned = json.replace('"signedPosition":"0"', `"signedPosition":"0${"\uD800"}"`);
    const decision = evaluateRiskFromJsonBytes(poisoned);
    assertInvalidBoundary(decision);
    assert.equal(decision.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
    assert.equal(riskAdmissionStats.jsonParseCalls, 0);
    assertNoMath();
    const invalidUtf8 = evaluateRiskFromJsonBytes(new Uint8Array([0x7b, 0xff, 0x7d]));
    assertInvalidBoundary(invalidUtf8);
    assert.equal(invalidUtf8.reasonCodes.includes("RISK_INPUT_LIMIT_EXCEEDED"), false);
  });

  test("C4-15 in-budget valid object remains byte-identical to prior decision", () => {
    const objectDecision = evaluateRisk(baseline());
    const bytesDecision = evaluateRiskFromJsonBytes(JSON.stringify(baseline()));
    assert.equal(JSON.stringify(objectDecision), FROZEN_BASELINE_DECISION_JSON);
    assert.equal(JSON.stringify(bytesDecision), FROZEN_BASELINE_DECISION_JSON);
    assert.equal(objectDecision.systemAllowRiskIncrease, false);
  });
});
