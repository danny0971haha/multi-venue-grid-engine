import type { DecimalString } from "../math/decimal.js";
import {
  decimalAbs,
  decimalAdd,
  decimalCmp,
  decimalMul,
  isCanonicalDecimalString,
} from "../math/decimal.js";
import type { RiskProposedIntent, RiskUnknownReservation, RiskWorkingOrder } from "./risk-types.js";

export type ExposureComputation = {
  plannedGrossNotional: DecimalString | null;
  actualGrossNotional: DecimalString | null;
  worstLongNotional: DecimalString | null;
  worstShortNotional: DecimalString | null;
  unbounded: boolean;
  reasonCodes: string[];
};

export function computeExposure(args: {
  signedPosition: DecimalString | null;
  markOrMidPrice: DecimalString | null;
  ownedActiveOrders: readonly RiskWorkingOrder[];
  unknownReservations: readonly RiskUnknownReservation[];
  proposedBatch: readonly RiskProposedIntent[];
}): ExposureComputation {
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

  for (const order of args.ownedActiveOrders) {
    if (!order.owned || order.reduceOnly) {
      continue;
    }
    const notional = parseNotional(order.remainingQuantity, order.price);
    if (notional === null) {
      unbounded = true;
      reasons.push("UNBOUNDED_EXPOSURE", "INVALID_DECIMAL");
      continue;
    }
    if (order.side === "BUY") {
      worstLongNotional = decimalAdd(worstLongNotional, notional);
    } else {
      worstShortNotional = decimalAdd(worstShortNotional, notional);
    }
  }

  for (const reservation of args.unknownReservations) {
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
    if (reservation.side === "BUY") {
      worstLongNotional = decimalAdd(worstLongNotional, notional);
    } else {
      worstShortNotional = decimalAdd(worstShortNotional, notional);
    }
  }

  for (const intent of args.proposedBatch) {
    if (intent.reduceOnly || intent.purpose !== "GRID_ENTRY") {
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
