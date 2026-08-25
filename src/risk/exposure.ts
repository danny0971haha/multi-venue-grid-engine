import type { DecimalString } from "../math/decimal.js";
import {
  decimalAbs,
  decimalAdd,
  decimalCmp,
  decimalMul,
  isCanonicalDecimalString,
} from "../math/decimal.js";
import type { RiskProposedIntent, RiskUnknownReservation, RiskWorkingOrder } from "./risk-types.js";
import {
  isRiskSide,
  validateProposedIntent,
  validateUnknownReservation,
  validateWorkingOrder,
} from "./risk-input-validation.js";

export type ExposureComputation = {
  plannedGrossNotional: DecimalString | null;
  actualGrossNotional: DecimalString | null;
  worstLongNotional: DecimalString | null;
  worstShortNotional: DecimalString | null;
  unbounded: boolean;
  reasonCodes: string[];
};

export const exposureIterationStats = {
  calls: 0,
  iterationsStarted: 0,
};

export function resetExposureIterationStats(): void {
  exposureIterationStats.calls = 0;
  exposureIterationStats.iterationsStarted = 0;
}

export function computeExposure(args: {
  signedPosition: DecimalString | null;
  markOrMidPrice: DecimalString | null;
  ownedActiveOrders: readonly RiskWorkingOrder[];
  unknownReservations: readonly RiskUnknownReservation[];
  proposedBatch: readonly RiskProposedIntent[];
}): ExposureComputation {
  exposureIterationStats.calls += 1;
  const reasons: string[] = [];
  if (args.signedPosition !== null && !isCanonicalDecimalString(args.signedPosition)) {
    reasons.push("INVALID_DECIMAL", "STALE_OR_MISSING_INPUT");
  }
  if (args.markOrMidPrice !== null && !isCanonicalDecimalString(args.markOrMidPrice)) {
    reasons.push("INVALID_DECIMAL", "STALE_OR_MISSING_INPUT");
  }
  if (args.signedPosition === null || args.markOrMidPrice === null) {
    reasons.push("STALE_OR_MISSING_INPUT");
  }
  if (reasons.length > 0) {
    return emptyExposure(reasons);
  }

  const position = args.signedPosition as DecimalString;
  const mark = args.markOrMidPrice as DecimalString;
  if (decimalCmp(mark, "0") <= 0) {
    return emptyExposure(["INVALID_DECIMAL", "STALE_OR_MISSING_INPUT"]);
  }
  const actualGrossNotional = decimalMul(decimalAbs(position), mark);

  let worstLongNotional = longPositionNotional(position, mark);
  let worstShortNotional = shortPositionNotional(position, mark);
  let unbounded = false;

  exposureIterationStats.iterationsStarted += 1;
  for (const order of args.ownedActiveOrders) {
    const invalid = validateWorkingOrder(order);
    if (invalid.length > 0) {
      reasons.push(...invalid);
      continue;
    }
    if (order.owned !== true || order.reduceOnly === true) {
      continue;
    }
    const notional = parseNotional(order.remainingQuantity, order.price);
    if (notional === null) {
      unbounded = true;
      reasons.push("UNBOUNDED_EXPOSURE", "INVALID_DECIMAL");
      continue;
    }
    if (!isRiskSide(order.side)) {
      reasons.push("INVALID_RISK_INPUT");
      continue;
    }
    if (order.side === "BUY") {
      worstLongNotional = decimalAdd(worstLongNotional, notional);
    } else {
      worstShortNotional = decimalAdd(worstShortNotional, notional);
    }
  }

  for (const reservation of args.unknownReservations) {
    const invalid = validateUnknownReservation(reservation);
    if (invalid.length > 0) {
      reasons.push(...invalid);
      continue;
    }
    if (reservation.price === null || reservation.quantity === null) {
      unbounded = true;
      reasons.push("UNBOUNDED_EXPOSURE", "STALE_OR_MISSING_INPUT");
      continue;
    }
    const notional = parseNotional(reservation.quantity, reservation.price);
    if (notional === null) {
      unbounded = true;
      reasons.push("UNBOUNDED_EXPOSURE", "INVALID_DECIMAL");
      continue;
    }
    if (!isRiskSide(reservation.side)) {
      reasons.push("INVALID_RISK_INPUT");
      continue;
    }
    if (reservation.side === "BUY") {
      worstLongNotional = decimalAdd(worstLongNotional, notional);
    } else {
      worstShortNotional = decimalAdd(worstShortNotional, notional);
    }
  }

  for (const intent of args.proposedBatch) {
    const invalid = validateProposedIntent(intent);
    if (invalid.length > 0) {
      reasons.push(...invalid);
      continue;
    }
    if (intent.reduceOnly === true) {
      continue;
    }
    if (intent.purpose === "CANCEL") {
      reasons.push("INVALID_RISK_INPUT");
      continue;
    }
    if (intent.price === null) {
      unbounded = true;
      reasons.push("UNBOUNDED_EXPOSURE", "STALE_OR_MISSING_INPUT");
      continue;
    }
    const notional = parseNotional(intent.quantity, intent.price);
    if (notional === null) {
      unbounded = true;
      reasons.push("UNBOUNDED_EXPOSURE", "INVALID_DECIMAL");
      continue;
    }
    if (!isRiskSide(intent.side)) {
      reasons.push("INVALID_RISK_INPUT");
      continue;
    }
    if (intent.side === "BUY") {
      worstLongNotional = decimalAdd(worstLongNotional, notional);
    } else {
      worstShortNotional = decimalAdd(worstShortNotional, notional);
    }
  }

  if (unbounded) {
    return {
      plannedGrossNotional: null,
      actualGrossNotional,
      worstLongNotional: null,
      worstShortNotional: null,
      unbounded: true,
      reasonCodes: [...new Set(reasons)],
    };
  }

  const plannedGrossNotional =
    decimalCmp(worstLongNotional, worstShortNotional) >= 0 ? worstLongNotional : worstShortNotional;

  return {
    plannedGrossNotional,
    actualGrossNotional,
    worstLongNotional,
    worstShortNotional,
    unbounded: false,
    reasonCodes: [],
  };
}

function emptyExposure(reasonCodes: string[]): ExposureComputation {
  return {
    plannedGrossNotional: null,
    actualGrossNotional: null,
    worstLongNotional: null,
    worstShortNotional: null,
    unbounded: false,
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function parseNotional(quantity: string, price: string): DecimalString | null {
  if (!isCanonicalDecimalString(quantity) || !isCanonicalDecimalString(price)) {
    return null;
  }
  if (decimalCmp(quantity, "0") < 0 || decimalCmp(price, "0") <= 0) {
    return null;
  }
  return decimalMul(quantity, price);
}

function longPositionNotional(signed: DecimalString, mark: DecimalString): DecimalString {
  return decimalCmp(signed, "0") > 0 ? decimalMul(signed, mark) : "0";
}

function shortPositionNotional(signed: DecimalString, mark: DecimalString): DecimalString {
  return decimalCmp(signed, "0") < 0 ? decimalMul(decimalAbs(signed), mark) : "0";
}
