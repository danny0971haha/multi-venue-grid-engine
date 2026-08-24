import { canonicalSerializeToUtf8 } from "../persistence/canonical-json.js";
import {
  DURABLE_KEYS,
  FRESHNESS_KEYS,
  INTENT_KEYS,
  LEASE_KEYS,
  RECONCILIATION_KEYS,
  REDUCTION_KEYS,
  RESERVATION_KEYS,
  RISK_INPUT_KEYS,
  WORKING_ORDER_KEYS,
  hasExactKeys,
  isPlainObject,
} from "./risk-input-validation.js";
import type { RiskInput } from "./risk-types.js";

/**
 * Unauthorized diagnostic sentinel used when `freshness.evaluatedAt` cannot be
 * read from a detached trusted snapshot. It is not market time and must not be
 * treated as a fresh observation.
 */
export const UNAUTHORIZED_EVALUATED_AT = "0";

export type ParsedRiskInput =
  | { ok: true; value: RiskInput }
  | { ok: false; reasonCodes: string[]; evaluatedAt: string };

const NULLABLE_DECIMAL_KEYS = [
  "equity",
  "fees",
  "funding",
  "gridLower",
  "gridUpper",
  "highWaterEquity",
  "markOrMidPrice",
  "realizedTradingPnl",
  "signedPosition",
  "startingEquity",
] as const;

/**
 * Observe an untrusted caller value exactly once through canonical own-property
 * descriptors, then validate and return a detached trusted snapshot.
 *
 * Accessors are rejected without invocation. Proxy `ownKeys` /
 * `getOwnPropertyDescriptor` / `getPrototypeOf` throws are caught and fail closed.
 * Subsequent risk math must read only `value`, never the original caller object.
 */
export function parseAndSnapshotRiskInput(input: unknown): ParsedRiskInput {
  try {
    return parseAndSnapshotRiskInputUnchecked(input);
  } catch {
    return failClosedParse(UNAUTHORIZED_EVALUATED_AT);
  }
}

function parseAndSnapshotRiskInputUnchecked(input: unknown): ParsedRiskInput {
  const utf8 = canonicalSerializeToUtf8(input);
  const parsed: unknown = JSON.parse(utf8);
  const evaluatedAt = extractEvaluatedAt(parsed);
  if (!isStructurallyCompleteRiskInput(parsed)) {
    return failClosedParse(evaluatedAt);
  }
  return { ok: true, value: parsed };
}

function failClosedParse(evaluatedAt: string): ParsedRiskInput {
  return {
    ok: false,
    reasonCodes: ["INVALID_RISK_INPUT"],
    evaluatedAt,
  };
}

function extractEvaluatedAt(parsed: unknown): string {
  try {
    if (!isPlainObject(parsed)) {
      return UNAUTHORIZED_EVALUATED_AT;
    }
    const freshness = parsed.freshness;
    if (!isPlainObject(freshness)) {
      return UNAUTHORIZED_EVALUATED_AT;
    }
    return typeof freshness.evaluatedAt === "string"
      ? freshness.evaluatedAt
      : UNAUTHORIZED_EVALUATED_AT;
  } catch {
    return UNAUTHORIZED_EVALUATED_AT;
  }
}

function isStructurallyCompleteRiskInput(value: unknown): value is RiskInput {
  if (!isPlainObject(value) || !hasExactKeys(value, RISK_INPUT_KEYS)) {
    return false;
  }
  if (typeof value.latchBlocked !== "boolean" || typeof value.haltAuthorityClear !== "boolean") {
    return false;
  }
  if (value.fundingConvention !== null && typeof value.fundingConvention !== "string") {
    return false;
  }
  for (const key of NULLABLE_DECIMAL_KEYS) {
    const field = value[key];
    if (field !== null && typeof field !== "string") {
      return false;
    }
  }
  if (!isFreshnessShape(value.freshness)) {
    return false;
  }
  if (!isLeaseShape(value.lease)) {
    return false;
  }
  if (
    !isPlainObject(value.reconciliation) ||
    !hasExactKeys(value.reconciliation, RECONCILIATION_KEYS) ||
    typeof value.reconciliation.unresolved !== "boolean"
  ) {
    return false;
  }
  if (
    !isPlainObject(value.durableInspection) ||
    !hasExactKeys(value.durableInspection, DURABLE_KEYS) ||
    typeof value.durableInspection.pairAuthorityProven !== "boolean"
  ) {
    return false;
  }
  if (!isReductionShape(value.boundedReduction)) {
    return false;
  }
  if (!isObjectArray(value.ownedActiveOrders, WORKING_ORDER_KEYS)) {
    return false;
  }
  if (!isObjectArray(value.unknownReservations, RESERVATION_KEYS)) {
    return false;
  }
  if (!isObjectArray(value.proposedBatch, INTENT_KEYS)) {
    return false;
  }
  return true;
}

function isFreshnessShape(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, FRESHNESS_KEYS)) {
    return false;
  }
  const fields: unknown[] = [
    value.evaluatedAt,
    value.maxStaleMs,
    value.positionObservedAt,
    value.equityObservedAt,
    value.markObservedAt,
    value.pnlObservedAt,
  ];
  return fields.every((field) => field === null || typeof field === "string");
}

function isLeaseShape(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, LEASE_KEYS)) {
    return false;
  }
  return (
    typeof value.proven === "boolean" &&
    typeof value.expired === "boolean" &&
    typeof value.lost === "boolean"
  );
}

function isReductionShape(value: unknown): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, REDUCTION_KEYS)) {
    return false;
  }
  return (
    typeof value.possible === "boolean" &&
    typeof value.ambiguous === "boolean" &&
    typeof value.cancelOnly === "boolean" &&
    typeof value.snapshotFresh === "boolean"
  );
}

function isObjectArray(value: unknown, expectedKeys: readonly string[]): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((element) => isPlainObject(element) && hasExactKeys(element, expectedKeys));
}
