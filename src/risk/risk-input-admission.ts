import type { CanonicalSerializeLimits } from "../persistence/canonical-json.js";
import {
  MAX_RISK_COLLECTION_LENGTH,
  MAX_RISK_DECIMAL_CHARS,
  MAX_RISK_INPUT_DEPTH,
  MAX_RISK_INPUT_NODES,
  MAX_RISK_OBJECT_KEY_CHARS,
  MAX_RISK_OBJECT_PROPERTIES,
  MAX_RISK_STRING_CHARS,
} from "./risk-types.js";

export class RiskInputLimitError extends Error {
  readonly reasonCode = "RISK_INPUT_LIMIT_EXCEEDED";

  constructor() {
    super("RISK_INPUT_LIMIT_EXCEEDED");
    this.name = "RiskInputLimitError";
  }
}

export const RISK_CANONICAL_SERIALIZE_LIMITS: CanonicalSerializeLimits = {
  maxDepth: MAX_RISK_INPUT_DEPTH,
  maxNodes: MAX_RISK_INPUT_NODES,
  maxCollectionLength: MAX_RISK_COLLECTION_LENGTH,
  maxObjectProperties: MAX_RISK_OBJECT_PROPERTIES,
  maxStringChars: MAX_RISK_STRING_CHARS,
  maxObjectKeyChars: MAX_RISK_OBJECT_KEY_CHARS,
};

const TOP_LEVEL_DECIMAL_KEYS = [
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

const FRESHNESS_DECIMAL_KEYS = [
  "equityObservedAt",
  "evaluatedAt",
  "markObservedAt",
  "maxStaleMs",
  "pnlObservedAt",
  "positionObservedAt",
] as const;

export function enforceRiskJsonBudgets(value: unknown): void {
  walkJson(value, 1, { nodes: 0 });
}

export function riskDecimalFieldsExceedBudget(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of TOP_LEVEL_DECIMAL_KEYS) {
    if (decimalStringExceedsBudget(value[key])) {
      return true;
    }
  }
  if (isRecord(value.freshness)) {
    for (const key of FRESHNESS_DECIMAL_KEYS) {
      if (decimalStringExceedsBudget(value.freshness[key])) {
        return true;
      }
    }
  }
  if (arrayHasOverlongDecimals(value.ownedActiveOrders, ["price", "remainingQuantity"])) {
    return true;
  }
  if (arrayHasOverlongDecimals(value.unknownReservations, ["price", "quantity"])) {
    return true;
  }
  if (arrayHasOverlongDecimals(value.proposedBatch, ["price", "quantity"])) {
    return true;
  }
  return false;
}

export function decimalStringExceedsBudget(value: unknown): boolean {
  return typeof value === "string" && value.length > MAX_RISK_DECIMAL_CHARS;
}

function arrayHasOverlongDecimals(value: unknown, keys: readonly string[]): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  for (const element of value) {
    if (!isRecord(element)) {
      continue;
    }
    for (const key of keys) {
      if (decimalStringExceedsBudget(element[key])) {
        return true;
      }
    }
  }
  return false;
}

function walkJson(value: unknown, depth: number, counter: { nodes: number }): void {
  counter.nodes += 1;
  if (counter.nodes > MAX_RISK_INPUT_NODES) {
    throw new RiskInputLimitError();
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_RISK_STRING_CHARS) {
      throw new RiskInputLimitError();
    }
    return;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_RISK_INPUT_DEPTH) {
      throw new RiskInputLimitError();
    }
    if (value.length > MAX_RISK_COLLECTION_LENGTH) {
      throw new RiskInputLimitError();
    }
    for (const element of value) {
      walkJson(element, depth + 1, counter);
    }
    return;
  }
  if (isRecord(value)) {
    if (depth > MAX_RISK_INPUT_DEPTH) {
      throw new RiskInputLimitError();
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_RISK_OBJECT_PROPERTIES) {
      throw new RiskInputLimitError();
    }
    for (const key of keys) {
      if (key.length > MAX_RISK_OBJECT_KEY_CHARS) {
        throw new RiskInputLimitError();
      }
      walkJson(value[key], depth + 1, counter);
    }
    return;
  }
  throw new RiskInputLimitError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
