import type { DecimalString } from "../math/decimal.js";
import {
  decimalAdd,
  decimalCmp,
  decimalMul,
  decimalSub,
  isCanonicalDecimalString,
} from "../math/decimal.js";
import { computeExposure } from "./exposure.js";
import { freshnessFailures } from "./freshness.js";
import {
  canonicalEvaluatedAt,
  parseAndSnapshotRiskInput,
  parseRiskInputFromJsonBytes,
  UNAUTHORIZED_EVALUATED_AT,
} from "./risk-input-parser.js";
import {
  isFundingConvention,
  validateGridDomain,
  validateRiskInput,
} from "./risk-input-validation.js";
import type { RiskDecision, RiskInput, RiskMetrics } from "./risk-types.js";
import {
  FROZEN_DAILY_NET_LOSS_USDT,
  FROZEN_PLANNED_GROSS_NOTIONAL_USDT,
  FROZEN_START_DRAWDOWN_USDT,
  PHASE_2D_REASON_CODE_CATALOG,
} from "./risk-types.js";

const SECRET_KEY_PATTERN =
  /secret|password|token|apikey|api[_-]?key|private[_-]?key|credential|authorization|bearer/i;

/**
 * In-process object boundary. Defensive fail-closed for finite plain objects
 * that return from property observation. This is not a DoS-proof or hard-timeout
 * guarantee against non-returning Proxy traps or process OOM. External adapters,
 * fixtures, CLI, and network boundaries must use `evaluateRiskFromJsonBytes`.
 */
export function evaluateRisk(input: unknown): RiskDecision {
  try {
    const parsed = parseAndSnapshotRiskInput(input);
    if (!parsed.ok) {
      return invalidInputDecision(parsed.evaluatedAt, parsed.reasonCodes);
    }
    return evaluateTrustedRiskInput(parsed.value);
  } catch {
    return invalidInputDecision(UNAUTHORIZED_EVALUATED_AT, ["INVALID_RISK_INPUT"]);
  }
}

/**
 * Authoritative external risk admission boundary. UTF-8 byte length is enforced
 * before JSON.parse. Uint8Array uses fatal UTF-8 decode.
 */
export function evaluateRiskFromJsonBytes(raw: string | Uint8Array): RiskDecision {
  try {
    const parsed = parseRiskInputFromJsonBytes(raw);
    if (!parsed.ok) {
      return invalidInputDecision(parsed.evaluatedAt, parsed.reasonCodes);
    }
    return evaluateTrustedRiskInput(parsed.value);
  } catch {
    return invalidInputDecision(UNAUTHORIZED_EVALUATED_AT, ["INVALID_RISK_INPUT"]);
  }
}

function evaluateTrustedRiskInput(input: RiskInput): RiskDecision {
  const inputCodes = validateRiskInput(input);
  if (inputCodes.includes("RISK_INPUT_LIMIT_EXCEEDED")) {
    return invalidInputDecision(canonicalEvaluatedAt(input.freshness.evaluatedAt), [
      "RISK_INPUT_LIMIT_EXCEEDED",
    ]);
  }
  const snapshot = cloneInput(input);
  const codes: string[] = ["DURABLE_HALT_OR_ACK_UNAVAILABLE", ...inputCodes];
  if (snapshot.haltAuthorityClear !== false) {
    codes.push("DURABLE_HALT_OR_ACK_UNAVAILABLE");
  }

  if (snapshot.latchBlocked || !snapshot.durableInspection.pairAuthorityProven) {
    codes.push("PERSISTENCE_UNPROVEN");
    if (snapshot.latchBlocked) {
      codes.push("LATCH_BLOCKED");
    }
    if (!snapshot.durableInspection.pairAuthorityProven) {
      codes.push("PAIR_UNPROVEN");
    }
  }

  if (!snapshot.lease.proven || snapshot.lease.lost || snapshot.lease.expired) {
    codes.push("LEASE_UNPROVEN");
    if (snapshot.lease.lost) {
      codes.push("LEASE_LOST");
    }
    if (snapshot.lease.expired) {
      codes.push("LEASE_EXPIRED");
    }
  }

  if (snapshot.reconciliation.unresolved) {
    codes.push("RECONCILIATION_REQUIRED");
  }

  codes.push(...freshnessFailures(snapshot.freshness));

  const exposure = computeExposure({
    signedPosition: snapshot.signedPosition,
    markOrMidPrice: snapshot.markOrMidPrice,
    ownedActiveOrders: snapshot.ownedActiveOrders,
    unknownReservations: snapshot.unknownReservations,
    proposedBatch: snapshot.proposedBatch,
  });
  codes.push(...exposure.reasonCodes);

  const pnl = computeDailyPnl(snapshot);
  codes.push(...pnl.reasonCodes);

  const drawdown = computeStartDrawdown(snapshot);
  codes.push(...drawdown.reasonCodes);

  const boundary = computeBoundary(snapshot);
  codes.push(...boundary.reasonCodes);

  let actualAction: "NONE" | "REDUCE" | "HALT" = "NONE";
  if (
    exposure.actualGrossNotional !== null &&
    decimalCmp(exposure.actualGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT) > 0
  ) {
    codes.push("ACTUAL_NOTIONAL");
    if (
      snapshot.boundedReduction.cancelOnly ||
      snapshot.boundedReduction.ambiguous ||
      !snapshot.boundedReduction.possible ||
      !snapshot.boundedReduction.snapshotFresh
    ) {
      actualAction = "HALT";
      if (snapshot.boundedReduction.cancelOnly) {
        codes.push("CANCEL_ONLY_REDUCTION");
      }
      if (snapshot.boundedReduction.ambiguous) {
        codes.push("REDUCTION_AMBIGUOUS");
      }
      if (!snapshot.boundedReduction.possible || !snapshot.boundedReduction.snapshotFresh) {
        codes.push("REDUCTION_NOT_PROVEN");
      }
    } else {
      actualAction = "REDUCE";
    }
  }

  if (
    exposure.unbounded ||
    (exposure.plannedGrossNotional !== null &&
      decimalCmp(exposure.plannedGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT) > 0)
  ) {
    codes.push("PLANNED_NOTIONAL");
  }

  const uniqueCodes = sortPhase2DReasonCodes(codes);
  const metrics = buildMetrics(snapshot, exposure, pnl.netDailyPnl, drawdown.startDrawdown);
  const metricHalt =
    uniqueCodes.includes("DAILY_LOSS") ||
    uniqueCodes.includes("START_DRAWDOWN") ||
    uniqueCodes.includes("BOUNDARY");
  const systemHalt =
    uniqueCodes.includes("PERSISTENCE_UNPROVEN") ||
    uniqueCodes.includes("LEASE_UNPROVEN") ||
    uniqueCodes.includes("RECONCILIATION_REQUIRED") ||
    uniqueCodes.includes("STALE_OR_MISSING_INPUT") ||
    uniqueCodes.includes("UNBOUNDED_EXPOSURE") ||
    uniqueCodes.includes("INVALID_DECIMAL") ||
    uniqueCodes.includes("INVALID_RISK_INPUT") ||
    uniqueCodes.includes("RISK_INPUT_LIMIT_EXCEEDED");
  const plannedBlocked = uniqueCodes.includes("PLANNED_NOTIONAL");
  const riskMetricsWithinLimits =
    !metricHalt &&
    !uniqueCodes.includes("ACTUAL_NOTIONAL") &&
    !plannedBlocked &&
    !uniqueCodes.includes("UNBOUNDED_EXPOSURE") &&
    !uniqueCodes.includes("STALE_OR_MISSING_INPUT") &&
    !uniqueCodes.includes("INVALID_DECIMAL") &&
    !uniqueCodes.includes("INVALID_RISK_INPUT") &&
    !uniqueCodes.includes("RISK_INPUT_LIMIT_EXCEEDED");

  let action: RiskDecision["action"] = "CONTINUE";
  if (systemHalt || metricHalt || actualAction === "HALT") {
    action = "HALT";
  } else if (actualAction === "REDUCE") {
    action = "REDUCE";
  } else if (plannedBlocked) {
    action = "HALT";
  }

  if (action === "CONTINUE") {
    uniqueCodes.push("CONTINUE_METRICS_ONLY");
  }
  if (snapshot.highWaterEquity !== null && isCanonicalDecimalString(snapshot.highWaterEquity)) {
    uniqueCodes.push("HIGH_WATER_OBSERVED");
  }

  return {
    action,
    reasonCodes: sortPhase2DReasonCodes(uniqueCodes),
    metrics,
    riskMetricsWithinLimits,
    systemAllowRiskIncrease: false,
    evaluatedAt: canonicalEvaluatedAt(snapshot.freshness.evaluatedAt),
  };
}

function invalidInputDecision(evaluatedAt: string, extraCodes: readonly string[]): RiskDecision {
  const codes = sortPhase2DReasonCodes([
    "DURABLE_HALT_OR_ACK_UNAVAILABLE",
    "STALE_OR_MISSING_INPUT",
    "INVALID_RISK_INPUT",
    ...extraCodes,
  ]).filter((code) => code !== "CONTINUE_METRICS_ONLY");
  return {
    action: "HALT",
    reasonCodes: codes,
    metrics: {
      plannedGrossNotional: null,
      actualGrossNotional: null,
      worstLongNotional: null,
      worstShortNotional: null,
      netDailyPnl: null,
      equity: null,
      startingEquity: null,
      highWaterEquity: null,
      startDrawdown: null,
      signedPosition: null,
      markOrMidPrice: null,
      plannedCap: FROZEN_PLANNED_GROSS_NOTIONAL_USDT,
      dailyLossLimit: FROZEN_DAILY_NET_LOSS_USDT,
      startDrawdownLimit: FROZEN_START_DRAWDOWN_USDT,
    },
    riskMetricsWithinLimits: false,
    systemAllowRiskIncrease: false,
    evaluatedAt,
  };
}

export function sortPhase2DReasonCodes(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map<string, number>(
    PHASE_2D_REASON_CODE_CATALOG.map((code, index) => [code, index]),
  );
  return unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
}

export function formatRiskDecisionDiagnostic(decision: RiskDecision): string {
  return JSON.stringify({
    action: decision.action,
    reasonCodes: decision.reasonCodes,
    riskMetricsWithinLimits: decision.riskMetricsWithinLimits,
    systemAllowRiskIncrease: decision.systemAllowRiskIncrease,
    evaluatedAt: decision.evaluatedAt,
    metrics: decision.metrics,
  });
}

export function diagnosticContainsSecretLike(diagnostic: string): boolean {
  return SECRET_KEY_PATTERN.test(diagnostic);
}

function computeDailyPnl(input: RiskInput): {
  netDailyPnl: DecimalString | null;
  reasonCodes: string[];
} {
  const reasons: string[] = [];
  if (input.realizedTradingPnl === null || !isCanonicalDecimalString(input.realizedTradingPnl)) {
    reasons.push("STALE_OR_MISSING_INPUT");
  }
  if (input.fees === null) {
    reasons.push("FEE_MISSING", "STALE_OR_MISSING_INPUT");
  } else if (!isCanonicalDecimalString(input.fees)) {
    reasons.push("INVALID_DECIMAL", "STALE_OR_MISSING_INPUT");
  }
  if (input.funding === null) {
    reasons.push("FUNDING_MISSING", "STALE_OR_MISSING_INPUT");
  } else if (!isCanonicalDecimalString(input.funding)) {
    reasons.push("INVALID_DECIMAL", "STALE_OR_MISSING_INPUT");
  }
  if (input.fundingConvention === null) {
    reasons.push("FUNDING_CONVENTION_MISSING", "STALE_OR_MISSING_INPUT");
  } else if (!isFundingConvention(input.fundingConvention)) {
    reasons.push("INVALID_RISK_INPUT");
  }
  if (reasons.length > 0) {
    return { netDailyPnl: null, reasonCodes: reasons };
  }
  const realized = input.realizedTradingPnl as DecimalString;
  const fees = input.fees as DecimalString;
  const funding = normalizeFunding(input.funding as DecimalString, input.fundingConvention);
  const netDailyPnl = decimalAdd(decimalSub(realized, fees), funding);
  if (decimalCmp(netDailyPnl, FROZEN_DAILY_NET_LOSS_USDT) <= 0) {
    return { netDailyPnl, reasonCodes: ["DAILY_LOSS"] };
  }
  return { netDailyPnl, reasonCodes: [] };
}

function normalizeFunding(
  funding: DecimalString,
  convention: RiskInput["fundingConvention"],
): DecimalString {
  if (convention === "PAID_POSITIVE") {
    return decimalMul(funding, "-1");
  }
  return funding;
}

function computeStartDrawdown(input: RiskInput): {
  startDrawdown: DecimalString | null;
  reasonCodes: string[];
} {
  if (
    input.equity === null ||
    input.startingEquity === null ||
    !isCanonicalDecimalString(input.equity) ||
    !isCanonicalDecimalString(input.startingEquity)
  ) {
    return { startDrawdown: null, reasonCodes: ["STALE_OR_MISSING_INPUT"] };
  }
  const startDrawdown = decimalSub(input.startingEquity, input.equity);
  if (decimalCmp(startDrawdown, FROZEN_START_DRAWDOWN_USDT) >= 0) {
    return { startDrawdown, reasonCodes: ["START_DRAWDOWN"] };
  }
  return { startDrawdown, reasonCodes: [] };
}

function computeBoundary(input: RiskInput): { reasonCodes: string[] } {
  const domain = validateGridDomain(input.gridLower, input.gridUpper);
  if (domain.length > 0) {
    return { reasonCodes: domain };
  }
  if (
    input.signedPosition === null ||
    input.markOrMidPrice === null ||
    input.gridLower === null ||
    input.gridUpper === null
  ) {
    return { reasonCodes: ["STALE_OR_MISSING_INPUT"] };
  }
  if (
    !isCanonicalDecimalString(input.signedPosition) ||
    !isCanonicalDecimalString(input.markOrMidPrice) ||
    !isCanonicalDecimalString(input.gridLower) ||
    !isCanonicalDecimalString(input.gridUpper)
  ) {
    return { reasonCodes: ["INVALID_DECIMAL", "STALE_OR_MISSING_INPUT"] };
  }
  const longFloor = decimalMul(input.gridLower, "0.99");
  const shortCeiling = decimalMul(input.gridUpper, "1.01");
  if (
    decimalCmp(input.signedPosition, "0") > 0 &&
    decimalCmp(input.markOrMidPrice, longFloor) < 0
  ) {
    return { reasonCodes: ["BOUNDARY"] };
  }
  if (
    decimalCmp(input.signedPosition, "0") < 0 &&
    decimalCmp(input.markOrMidPrice, shortCeiling) > 0
  ) {
    return { reasonCodes: ["BOUNDARY"] };
  }
  if (decimalCmp(input.signedPosition, "0") === 0) {
    if (
      decimalCmp(input.markOrMidPrice, longFloor) < 0 ||
      decimalCmp(input.markOrMidPrice, shortCeiling) > 0
    ) {
      return { reasonCodes: ["BOUNDARY_SEED_BLOCKED"] };
    }
  }
  return { reasonCodes: [] };
}

function buildMetrics(
  input: RiskInput,
  exposure: ReturnType<typeof computeExposure>,
  netDailyPnl: DecimalString | null,
  startDrawdown: DecimalString | null,
): RiskMetrics {
  return {
    plannedGrossNotional: exposure.plannedGrossNotional,
    actualGrossNotional: exposure.actualGrossNotional,
    worstLongNotional: exposure.worstLongNotional,
    worstShortNotional: exposure.worstShortNotional,
    netDailyPnl,
    equity: input.equity,
    startingEquity: input.startingEquity,
    highWaterEquity: input.highWaterEquity,
    startDrawdown,
    signedPosition: input.signedPosition,
    markOrMidPrice: input.markOrMidPrice,
    plannedCap: FROZEN_PLANNED_GROSS_NOTIONAL_USDT,
    dailyLossLimit: FROZEN_DAILY_NET_LOSS_USDT,
    startDrawdownLimit: FROZEN_START_DRAWDOWN_USDT,
  };
}

function cloneInput(input: RiskInput): RiskInput {
  return {
    signedPosition: input.signedPosition,
    markOrMidPrice: input.markOrMidPrice,
    equity: input.equity,
    startingEquity: input.startingEquity,
    highWaterEquity: input.highWaterEquity,
    realizedTradingPnl: input.realizedTradingPnl,
    fees: input.fees,
    funding: input.funding,
    fundingConvention: input.fundingConvention,
    ownedActiveOrders: input.ownedActiveOrders.map((order) => ({ ...order })),
    unknownReservations: input.unknownReservations.map((item) => ({ ...item })),
    proposedBatch: input.proposedBatch.map((item) => ({ ...item })),
    gridLower: input.gridLower,
    gridUpper: input.gridUpper,
    freshness: { ...input.freshness },
    reconciliation: { ...input.reconciliation },
    lease: { ...input.lease },
    latchBlocked: input.latchBlocked,
    durableInspection: { ...input.durableInspection },
    haltAuthorityClear: false,
    boundedReduction: { ...input.boundedReduction },
  };
}
