import {
  decimalAdd,
  decimalDiv,
  decimalMul,
  decimalSub,
  parseDecimalString,
  toTenthString,
} from "../math/decimal.js";
import type { DecimalString } from "../math/decimal.js";
import { ALL_LEVELS, assertGridLogicalLevelId, type GridLogicalLevelId } from "../domain/ids.js";
import type { DecimalRounding } from "../math/decimal.js";
import {
  assessEnvelopeFeasibility,
  assessLevelFeasibility,
  normalizePrice,
  type Feasibility,
  type MarketRules,
} from "./marketRules.js";

export type ExitTarget = GridLogicalLevelId | "ANCHOR";

export type TheoreticalLevel = {
  logicalLevelId: GridLogicalLevelId;
  side: "BUY" | "SELL";
  theoreticalPrice: DecimalString;
};

export type NormalizedLevel = TheoreticalLevel & {
  normalizedPrice: DecimalString;
};

export type GridGeometry =
  | {
      status: "FEASIBLE";
      anchor: DecimalString;
      theoretical: TheoreticalLevel[];
      normalized: NormalizedLevel[];
    }
  | {
      status: "INFEASIBLE";
      reason: string;
      theoretical: TheoreticalLevel[];
    };

const HALF_BAND = "0.03";
const BAND_STEPS = "5";

const EXIT_TARGET: Record<GridLogicalLevelId, ExitTarget> = {
  B1: "ANCHOR",
  B2: "B1",
  B3: "B2",
  B4: "B3",
  B5: "B4",
  S1: "ANCHOR",
  S2: "S1",
  S3: "S2",
  S4: "S3",
  S5: "S4",
};

export function levelIndex(level: GridLogicalLevelId): "1" | "2" | "3" | "4" | "5" {
  const index = level.slice(1);
  if (index !== "1" && index !== "2" && index !== "3" && index !== "4" && index !== "5") {
    throw new Error(`INVALID_LEVEL_INDEX:${level}`);
  }
  return index;
}

export function theoreticalEntryPrice(
  anchor: DecimalString,
  level: GridLogicalLevelId,
): DecimalString {
  const parsedAnchor = parseDecimalString(anchor);
  const offset = decimalMul(HALF_BAND, decimalDiv(levelIndex(level), BAND_STEPS));
  if (level.startsWith("B")) {
    return formatGeometryPrice(decimalMul(parsedAnchor, decimalSub("1", offset)));
  }
  return formatGeometryPrice(decimalMul(parsedAnchor, decimalAdd("1", offset)));
}

export function exitTarget(level: GridLogicalLevelId): ExitTarget {
  return EXIT_TARGET[level];
}

export function theoreticalExitPrice(
  anchor: DecimalString,
  entryLevel: GridLogicalLevelId,
): DecimalString {
  const target = exitTarget(entryLevel);
  if (target === "ANCHOR") {
    return parseDecimalString(anchor);
  }
  return theoreticalEntryPrice(anchor, target);
}

export function theoreticalGrid(anchor: DecimalString): TheoreticalLevel[] {
  return ALL_LEVELS.map((logicalLevelId) => ({
    logicalLevelId,
    side: logicalLevelId.startsWith("B") ? "BUY" : "SELL",
    theoreticalPrice: theoreticalEntryPrice(anchor, logicalLevelId),
  }));
}

export function normalizeTheoreticalGrid(
  theoretical: TheoreticalLevel[],
  rules: MarketRules,
  priceRounding: DecimalRounding,
): NormalizedLevel[] {
  return theoretical.map((level) => ({
    ...level,
    normalizedPrice: normalizePrice(level.theoreticalPrice, rules, priceRounding),
  }));
}

export function buildGridGeometry(
  anchor: DecimalString,
  rules: MarketRules,
  priceRounding: DecimalRounding,
): GridGeometry {
  const theoretical = theoreticalGrid(anchor);
  const envelope = assessEnvelopeFeasibility(rules);
  const normalized = normalizeTheoreticalGrid(theoretical, rules, priceRounding);
  if (envelope.status === "INFEASIBLE") {
    return { status: "INFEASIBLE", reason: envelope.reason, theoretical };
  }
  return {
    status: "FEASIBLE",
    anchor: parseDecimalString(anchor),
    theoretical,
    normalized,
  };
}

export function evaluateGridQuantity(
  geometry: Extract<GridGeometry, { status: "FEASIBLE" }>,
  normalizedQuantity: DecimalString,
  rules: MarketRules,
): Feasibility {
  for (const level of geometry.normalized) {
    const feasibility = assessLevelFeasibility(level.normalizedPrice, normalizedQuantity, rules);
    if (feasibility.status === "INFEASIBLE") {
      return feasibility;
    }
  }
  return { status: "FEASIBLE" };
}

export function oppositeSide(level: GridLogicalLevelId): "BUY" | "SELL" {
  return level.startsWith("S") ? "BUY" : "SELL";
}

export function requireLevel(value: string): GridLogicalLevelId {
  return assertGridLogicalLevelId(value);
}

function formatGeometryPrice(value: DecimalString): DecimalString {
  return toTenthString(value);
}
