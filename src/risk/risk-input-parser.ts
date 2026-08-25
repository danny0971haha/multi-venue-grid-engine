import { Buffer } from "node:buffer";

import { CanonicalJsonError, canonicalSerializeToUtf8 } from "../persistence/canonical-json.js";
import {
  enforceRiskJsonBudgets,
  enforceRiskUtf8ByteLimit,
  RISK_CANONICAL_SERIALIZE_LIMITS,
  RiskInputLimitError,
  riskDecimalFieldsExceedBudget,
} from "./risk-input-admission.js";
import { hasUnpairedSurrogate, jsonTextHasDuplicateKeys } from "./risk-json-text.js";
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

const EVALUATED_AT_PATTERN = /^(0|[1-9][0-9]{0,12})$/;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type ParsedRiskInput =
  | { ok: true; value: RiskInput }
  | { ok: false; reasonCodes: string[]; evaluatedAt: string };

export const riskAdmissionStats = {
  jsonParseCalls: 0,
};

export function resetRiskAdmissionStats(): void {
  riskAdmissionStats.jsonParseCalls = 0;
}

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
 *
 * Canonical UTF-8 length is then admitted through the same byte budget as
 * `parseRiskInputFromJsonBytes`. This object API is defensive fail-closed for
 * finite inputs. It is not a DoS-proof or hard-timeout guarantee against
 * non-returning Proxy traps or process OOM. External bytes must use
 * `parseRiskInputFromJsonBytes`.
 */
export function parseAndSnapshotRiskInput(input: unknown): ParsedRiskInput {
  try {
    const utf8 = canonicalSerializeToUtf8(input, RISK_CANONICAL_SERIALIZE_LIMITS);
    return parseRiskInputFromJsonBytes(utf8);
  } catch (error) {
    return failFromObservation(error);
  }
}

/**
 * Authoritative external trust boundary: measure UTF-8 bytes before JSON.parse,
 * fatal-decode Uint8Array, reject unpaired JS surrogates and duplicate keys,
 * then apply exact-shape and resource budgets.
 */
export function parseRiskInputFromJsonBytes(raw: string | Uint8Array): ParsedRiskInput {
  try {
    const byteLength = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
    enforceRiskUtf8ByteLimit(byteLength);
    if (typeof raw === "string" && hasUnpairedSurrogate(raw)) {
      return failClosedParse(UNAUTHORIZED_EVALUATED_AT);
    }
    const text = decodeJsonBytes(raw);
    const parsed: unknown = parseJsonText(text);
    if (jsonTextHasDuplicateKeys(text)) {
      return failClosedParse(UNAUTHORIZED_EVALUATED_AT);
    }
    return admitParsedRiskJson(parsed);
  } catch (error) {
    return failFromObservation(error);
  }
}

export function canonicalEvaluatedAt(value: unknown): string {
  if (typeof value !== "string" || value.length > 13) {
    return UNAUTHORIZED_EVALUATED_AT;
  }
  return EVALUATED_AT_PATTERN.test(value) ? value : UNAUTHORIZED_EVALUATED_AT;
}

function decodeJsonBytes(raw: string | Uint8Array): string {
  if (typeof raw === "string") {
    return raw;
  }
  return FATAL_UTF8_DECODER.decode(raw);
}

function parseJsonText(text: string): unknown {
  riskAdmissionStats.jsonParseCalls += 1;
  return JSON.parse(text);
}

function admitParsedRiskJson(parsed: unknown): ParsedRiskInput {
  const evaluatedAt = canonicalEvaluatedAt(extractEvaluatedAtRaw(parsed));
  try {
    enforceRiskJsonBudgets(parsed);
  } catch (error) {
    if (error instanceof RiskInputLimitError) {
      return failClosedLimit(evaluatedAt);
    }
    throw error;
  }
  if (riskDecimalFieldsExceedBudget(parsed)) {
    return failClosedLimit(evaluatedAt);
  }
  if (!isStructurallyCompleteRiskInput(parsed)) {
    return failClosedParse(evaluatedAt);
  }
  return { ok: true, value: parsed };
}

function failFromObservation(error: unknown): ParsedRiskInput {
  if (isLimitError(error)) {
    return failClosedLimit(UNAUTHORIZED_EVALUATED_AT);
  }
  return failClosedParse(UNAUTHORIZED_EVALUATED_AT);
}

function isLimitError(error: unknown): boolean {
  return (
    error instanceof RiskInputLimitError ||
    (error instanceof CanonicalJsonError && error.reasonCode === "RESOURCE_LIMIT_EXCEEDED")
  );
}

function failClosedParse(evaluatedAt: string): ParsedRiskInput {
  return {
    ok: false,
    reasonCodes: ["INVALID_RISK_INPUT"],
    evaluatedAt,
  };
}

function failClosedLimit(evaluatedAt: string): ParsedRiskInput {
  return {
    ok: false,
    reasonCodes: ["INVALID_RISK_INPUT", "RISK_INPUT_LIMIT_EXCEEDED"],
    evaluatedAt,
  };
}

function extractEvaluatedAtRaw(parsed: unknown): unknown {
  try {
    if (!isPlainObject(parsed)) {
      return undefined;
    }
    const freshness = parsed.freshness;
    if (!isPlainObject(freshness)) {
      return undefined;
    }
    return freshness.evaluatedAt;
  } catch {
    return undefined;
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
