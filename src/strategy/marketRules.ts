import {
  decimalCmp,
  decimalMul,
  isExactMultiple,
  parseDecimalString,
  quantize,
  type DecimalRounding,
  type DecimalString,
} from "../math/decimal.js";
import { V01_EXPERIMENT_CONFIG } from "../domain/config.js";
import type { ExperimentConfig } from "../domain/types.js";

export type MarketRules = {
  priceTick: DecimalString;
  quantityStep: DecimalString;
  minQuantity: DecimalString | null;
  maxQuantity: DecimalString | null;
  minNotional: DecimalString | null;
  maxNotional: DecimalString | null;
  maxClientOrderIdLength: number | null;
  clientOrderIdPattern: string | null;
};

export type Feasibility = { status: "FEASIBLE" } | { status: "INFEASIBLE"; reason: string };

export function normalizePrice(
  price: DecimalString,
  rules: MarketRules,
  rounding: DecimalRounding,
): DecimalString {
  const parsed = parseDecimalString(price);
  const tick = parseDecimalString(rules.priceTick);
  const normalized = quantize(parsed, tick, rounding);
  if (!isExactMultiple(normalized, tick)) {
    throw new Error("INVALID_TICK_NORMALIZATION");
  }
  return normalized;
}

export function normalizeQuantity(
  quantity: DecimalString,
  rules: MarketRules,
  rounding: DecimalRounding,
): DecimalString {
  const parsed = parseDecimalString(quantity);
  const step = parseDecimalString(rules.quantityStep);
  const normalized = quantize(parsed, step, rounding);
  if (!isExactMultiple(normalized, step)) {
    throw new Error("INVALID_STEP_NORMALIZATION");
  }
  if (rules.minQuantity !== null && decimalCmp(normalized, rules.minQuantity) < 0) {
    throw new Error("QUANTITY_BELOW_MINIMUM");
  }
  if (rules.maxQuantity !== null && decimalCmp(normalized, rules.maxQuantity) > 0) {
    throw new Error("QUANTITY_ABOVE_MAXIMUM");
  }
  return normalized;
}

export function plannedNotional(price: DecimalString, quantity: DecimalString): DecimalString {
  return decimalMul(parseDecimalString(price), parseDecimalString(quantity));
}

export function assessEnvelopeFeasibility(
  rules: MarketRules,
  config: ExperimentConfig = V01_EXPERIMENT_CONFIG,
): Feasibility {
  if (config !== V01_EXPERIMENT_CONFIG && !sameFrozenEnvelope(config)) {
    return { status: "INFEASIBLE", reason: "FROZEN_ENVELOPE_CHANGED" };
  }
  if (rules.minNotional !== null) {
    const minNotional = parseDecimalString(rules.minNotional);
    if (decimalCmp(minNotional, config.maxPlannedGrossNotionalUsd) > 0) {
      return { status: "INFEASIBLE", reason: "MIN_NOTIONAL_EXCEEDS_ENVELOPE" };
    }
  }
  return { status: "FEASIBLE" };
}

export function assessLevelFeasibility(
  normalizedPrice: DecimalString,
  normalizedQuantity: DecimalString,
  rules: MarketRules,
  config: ExperimentConfig = V01_EXPERIMENT_CONFIG,
): Feasibility {
  const envelope = assessEnvelopeFeasibility(rules, config);
  if (envelope.status === "INFEASIBLE") {
    return envelope;
  }
  const notional = plannedNotional(normalizedPrice, normalizedQuantity);
  if (rules.minNotional !== null && decimalCmp(notional, rules.minNotional) < 0) {
    return { status: "INFEASIBLE", reason: "LEVEL_NOTIONAL_BELOW_MINIMUM" };
  }
  if (rules.maxNotional !== null && decimalCmp(notional, rules.maxNotional) > 0) {
    return { status: "INFEASIBLE", reason: "LEVEL_NOTIONAL_ABOVE_MAXIMUM" };
  }
  if (decimalCmp(notional, config.maxPlannedGrossNotionalUsd) > 0) {
    return { status: "INFEASIBLE", reason: "LEVEL_NOTIONAL_EXCEEDS_ENVELOPE" };
  }
  return { status: "FEASIBLE" };
}

function sameFrozenEnvelope(config: ExperimentConfig): boolean {
  return (
    config.version === V01_EXPERIMENT_CONFIG.version &&
    config.capitalCeilingUsd === V01_EXPERIMENT_CONFIG.capitalCeilingUsd &&
    config.leverage === V01_EXPERIMENT_CONFIG.leverage &&
    config.marginBudgetUsd === V01_EXPERIMENT_CONFIG.marginBudgetUsd &&
    config.maxPlannedGrossNotionalUsd === V01_EXPERIMENT_CONFIG.maxPlannedGrossNotionalUsd &&
    config.gridLevels === V01_EXPERIMENT_CONFIG.gridLevels &&
    config.gridHalfBandFraction === V01_EXPERIMENT_CONFIG.gridHalfBandFraction &&
    config.dailyLossLimitUsd === V01_EXPERIMENT_CONFIG.dailyLossLimitUsd &&
    config.drawdownFromStartLimitUsd === V01_EXPERIMENT_CONFIG.drawdownFromStartLimitUsd &&
    config.boundaryBufferFraction === V01_EXPERIMENT_CONFIG.boundaryBufferFraction
  );
}
