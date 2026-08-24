import { decimalCmp, isCanonicalDecimalString } from "../math/decimal.js";
import type { FundingConvention, RiskBoundedReduction, RiskFreshness } from "./risk-types.js";

const RISK_INPUT_KEYS = [
  "boundedReduction",
  "durableInspection",
  "equity",
  "fees",
  "freshness",
  "funding",
  "fundingConvention",
  "gridLower",
  "gridUpper",
  "haltAuthorityClear",
  "highWaterEquity",
  "latchBlocked",
  "lease",
  "markOrMidPrice",
  "ownedActiveOrders",
  "proposedBatch",
  "realizedTradingPnl",
  "reconciliation",
  "signedPosition",
  "startingEquity",
  "unknownReservations",
] as const;

const FRESHNESS_KEYS = [
  "equityObservedAt",
  "evaluatedAt",
  "markObservedAt",
  "maxStaleMs",
  "pnlObservedAt",
  "positionObservedAt",
] as const;

const LEASE_KEYS = ["expired", "lost", "proven"] as const;
const RECONCILIATION_KEYS = ["unresolved"] as const;
const DURABLE_KEYS = ["pairAuthorityProven"] as const;
const REDUCTION_KEYS = ["ambiguous", "cancelOnly", "possible", "snapshotFresh"] as const;
const WORKING_ORDER_KEYS = ["owned", "price", "reduceOnly", "remainingQuantity", "side"] as const;
const RESERVATION_KEYS = ["price", "quantity", "side"] as const;
const INTENT_KEYS = ["price", "purpose", "quantity", "reduceOnly", "side"] as const;

const SIDES = new Set(["BUY", "SELL"]);
const PURPOSES = new Set([
  "GRID_ENTRY",
  "GRID_EXIT",
  "RISK_REDUCTION",
  "EMERGENCY_FLATTEN",
  "CANCEL",
]);
const FUNDING_CONVENTIONS = new Set<FundingConvention>(["RECEIVED_POSITIVE", "PAID_POSITIVE"]);

export function validateRiskInput(input: unknown): string[] {
  if (!isPlainObject(input)) {
    return ["INVALID_RISK_INPUT"];
  }
  const record = input as Record<string, unknown>;
  if (!hasExactKeys(record, RISK_INPUT_KEYS)) {
    return ["INVALID_RISK_INPUT"];
  }
  const codes: string[] = [];
  if (record.haltAuthorityClear !== false) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (typeof record.latchBlocked !== "boolean") {
    codes.push("INVALID_RISK_INPUT");
  }
  codes.push(...validateNullableDecimal(record.signedPosition));
  codes.push(...validateNullableDecimal(record.markOrMidPrice));
  codes.push(...validateNullableDecimal(record.equity));
  codes.push(...validateNullableDecimal(record.startingEquity));
  codes.push(...validateNullableDecimal(record.highWaterEquity));
  codes.push(...validateNullableDecimal(record.realizedTradingPnl));
  codes.push(...validateNullableDecimal(record.fees));
  codes.push(...validateNullableDecimal(record.funding));
  codes.push(...validateNullableDecimal(record.gridLower));
  codes.push(...validateNullableDecimal(record.gridUpper));
  if (record.fundingConvention !== null && !isFundingConvention(record.fundingConvention)) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (!isPlainObject(record.freshness) || !hasExactKeys(record.freshness, FRESHNESS_KEYS)) {
    codes.push("INVALID_RISK_INPUT");
  } else {
    codes.push(...validateFreshnessShape(record.freshness as RiskFreshness));
  }
  if (!isPlainObject(record.lease) || !hasExactKeys(record.lease, LEASE_KEYS)) {
    codes.push("INVALID_RISK_INPUT");
  } else {
    const lease = record.lease as Record<string, unknown>;
    if (
      typeof lease.proven !== "boolean" ||
      typeof lease.expired !== "boolean" ||
      typeof lease.lost !== "boolean"
    ) {
      codes.push("INVALID_RISK_INPUT");
    }
  }
  if (
    !isPlainObject(record.reconciliation) ||
    !hasExactKeys(record.reconciliation, RECONCILIATION_KEYS) ||
    typeof (record.reconciliation as { unresolved?: unknown }).unresolved !== "boolean"
  ) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (
    !isPlainObject(record.durableInspection) ||
    !hasExactKeys(record.durableInspection, DURABLE_KEYS) ||
    typeof (record.durableInspection as { pairAuthorityProven?: unknown }).pairAuthorityProven !==
      "boolean"
  ) {
    codes.push("INVALID_RISK_INPUT");
  }
  codes.push(...validateBoundedReduction(record.boundedReduction));
  if (!Array.isArray(record.ownedActiveOrders)) {
    codes.push("INVALID_RISK_INPUT");
  } else {
    for (const order of record.ownedActiveOrders) {
      codes.push(...validateWorkingOrder(order));
    }
  }
  if (!Array.isArray(record.unknownReservations)) {
    codes.push("INVALID_RISK_INPUT");
  } else {
    for (const reservation of record.unknownReservations) {
      codes.push(...validateUnknownReservation(reservation));
    }
  }
  if (!Array.isArray(record.proposedBatch)) {
    codes.push("INVALID_RISK_INPUT");
  } else {
    for (const intent of record.proposedBatch) {
      codes.push(...validateProposedIntent(intent));
    }
  }
  codes.push(...validateGridDomain(record.gridLower, record.gridUpper));
  return [...new Set(codes)];
}

export function validateProposedIntent(intent: unknown): string[] {
  if (!isPlainObject(intent) || !hasExactKeys(intent, INTENT_KEYS)) {
    return ["INVALID_RISK_INPUT"];
  }
  const record = intent as Record<string, unknown>;
  const codes: string[] = [];
  if (typeof record.side !== "string" || !SIDES.has(record.side)) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (typeof record.purpose !== "string" || !PURPOSES.has(record.purpose)) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (typeof record.reduceOnly !== "boolean") {
    codes.push("INVALID_RISK_INPUT");
  }
  if (typeof record.quantity !== "string" || !isCanonicalDecimalString(record.quantity)) {
    codes.push("INVALID_RISK_INPUT", "INVALID_DECIMAL");
  } else if (decimalCmp(record.quantity, "0") < 0) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (record.price !== null) {
    if (typeof record.price !== "string" || !isCanonicalDecimalString(record.price)) {
      codes.push("INVALID_RISK_INPUT", "INVALID_DECIMAL");
    } else if (decimalCmp(record.price, "0") <= 0) {
      codes.push("INVALID_RISK_INPUT");
    }
  }
  if (record.purpose === "CANCEL" && record.reduceOnly === false) {
    codes.push("INVALID_RISK_INPUT");
  }
  return [...new Set(codes)];
}

export function validateWorkingOrder(order: unknown): string[] {
  if (!isPlainObject(order) || !hasExactKeys(order, WORKING_ORDER_KEYS)) {
    return ["INVALID_RISK_INPUT"];
  }
  const record = order as Record<string, unknown>;
  const codes: string[] = [];
  if (typeof record.side !== "string" || !SIDES.has(record.side)) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (typeof record.reduceOnly !== "boolean" || typeof record.owned !== "boolean") {
    codes.push("INVALID_RISK_INPUT");
  }
  if (typeof record.price !== "string" || !isCanonicalDecimalString(record.price)) {
    codes.push("INVALID_RISK_INPUT", "INVALID_DECIMAL");
  } else if (decimalCmp(record.price, "0") <= 0) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (
    typeof record.remainingQuantity !== "string" ||
    !isCanonicalDecimalString(record.remainingQuantity)
  ) {
    codes.push("INVALID_RISK_INPUT", "INVALID_DECIMAL");
  } else if (decimalCmp(record.remainingQuantity, "0") < 0) {
    codes.push("INVALID_RISK_INPUT");
  }
  return [...new Set(codes)];
}

export function validateUnknownReservation(reservation: unknown): string[] {
  if (!isPlainObject(reservation) || !hasExactKeys(reservation, RESERVATION_KEYS)) {
    return ["INVALID_RISK_INPUT"];
  }
  const record = reservation as Record<string, unknown>;
  const codes: string[] = [];
  if (typeof record.side !== "string" || !SIDES.has(record.side)) {
    codes.push("INVALID_RISK_INPUT");
  }
  if (record.price !== null) {
    if (typeof record.price !== "string" || !isCanonicalDecimalString(record.price)) {
      codes.push("INVALID_RISK_INPUT", "INVALID_DECIMAL");
    }
  }
  if (record.quantity !== null) {
    if (typeof record.quantity !== "string" || !isCanonicalDecimalString(record.quantity)) {
      codes.push("INVALID_RISK_INPUT", "INVALID_DECIMAL");
    }
  }
  return [...new Set(codes)];
}

export function validateGridDomain(gridLower: unknown, gridUpper: unknown): string[] {
  if (gridLower === null || gridUpper === null) {
    return [];
  }
  if (
    typeof gridLower !== "string" ||
    typeof gridUpper !== "string" ||
    !isCanonicalDecimalString(gridLower) ||
    !isCanonicalDecimalString(gridUpper)
  ) {
    return [];
  }
  if (
    decimalCmp(gridLower, "0") <= 0 ||
    decimalCmp(gridUpper, "0") <= 0 ||
    decimalCmp(gridLower, gridUpper) >= 0
  ) {
    return ["INVALID_RISK_INPUT"];
  }
  return [];
}

export function isRiskSide(value: unknown): value is "BUY" | "SELL" {
  return typeof value === "string" && SIDES.has(value);
}

export function isFundingConvention(value: unknown): value is FundingConvention {
  return typeof value === "string" && FUNDING_CONVENTIONS.has(value as FundingConvention);
}

function validateBoundedReduction(value: unknown): string[] {
  if (!isPlainObject(value) || !hasExactKeys(value, REDUCTION_KEYS)) {
    return ["INVALID_RISK_INPUT"];
  }
  const record = value as RiskBoundedReduction;
  if (
    typeof record.possible !== "boolean" ||
    typeof record.ambiguous !== "boolean" ||
    typeof record.cancelOnly !== "boolean" ||
    typeof record.snapshotFresh !== "boolean"
  ) {
    return ["INVALID_RISK_INPUT"];
  }
  return [];
}

function validateFreshnessShape(freshness: RiskFreshness): string[] {
  const fields: Array<unknown> = [
    freshness.evaluatedAt,
    freshness.maxStaleMs,
    freshness.positionObservedAt,
    freshness.equityObservedAt,
    freshness.markObservedAt,
    freshness.pnlObservedAt,
  ];
  for (const field of fields) {
    if (field !== null && typeof field !== "string") {
      return ["INVALID_RISK_INPUT"];
    }
  }
  return [];
}

function validateNullableDecimal(value: unknown): string[] {
  if (value === null) {
    return [];
  }
  if (typeof value !== "string") {
    return ["INVALID_RISK_INPUT"];
  }
  if (!isCanonicalDecimalString(value)) {
    return ["INVALID_DECIMAL"];
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
