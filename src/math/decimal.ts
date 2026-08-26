import { Decimal } from "decimal.js";

export type DecimalString = string;

export type DecimalRounding = "DOWN" | "UP" | "HALF_UP";

const CanonicalDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -81,
  toExpPos: 81,
});

const CANONICAL_INPUT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const ROUNDING_MODE: Record<DecimalRounding, Decimal.Rounding> = {
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  HALF_UP: Decimal.ROUND_HALF_UP,
};

export class InvalidDecimalError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidDecimalError";
  }
}

function asDecimal(value: DecimalString): Decimal {
  return new CanonicalDecimal(parseDecimalString(value));
}

export function toCanonicalString(value: Decimal): DecimalString {
  if (!value.isFinite()) {
    throw new InvalidDecimalError("NON_FINITE_DECIMAL");
  }

  const [whole = "0", fraction = ""] = value.toFixed().split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const sign = value.isNegative() && (whole !== "0" || trimmedFraction !== "") ? "-" : "";
  const absWhole = whole.replace(/^-/, "");
  return trimmedFraction.length === 0
    ? `${sign}${absWhole}`
    : `${sign}${absWhole}.${trimmedFraction}`;
}

export function parseDecimalString(value: string): DecimalString {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidDecimalError("EMPTY_DECIMAL");
  }
  if (value.includes("e") || value.includes("E") || value.includes(",") || /\s/.test(value)) {
    throw new InvalidDecimalError("NON_CANONICAL_DECIMAL");
  }
  if (!CANONICAL_INPUT.test(value)) {
    throw new InvalidDecimalError("NON_CANONICAL_DECIMAL");
  }

  const parsed = new CanonicalDecimal(value);
  if (!parsed.isFinite()) {
    throw new InvalidDecimalError("NON_FINITE_DECIMAL");
  }
  return toCanonicalString(parsed);
}

export function isCanonicalDecimalString(value: string): boolean {
  try {
    return parseDecimalString(value) === value;
  } catch {
    return false;
  }
}

export function decimalAdd(left: DecimalString, right: DecimalString): DecimalString {
  return toCanonicalString(asDecimal(left).plus(asDecimal(right)));
}

export function decimalSub(left: DecimalString, right: DecimalString): DecimalString {
  return toCanonicalString(asDecimal(left).minus(asDecimal(right)));
}

export function decimalMul(left: DecimalString, right: DecimalString): DecimalString {
  return toCanonicalString(asDecimal(left).times(asDecimal(right)));
}

export function decimalDiv(
  left: DecimalString,
  right: DecimalString,
  rounding: DecimalRounding = "HALF_UP",
): DecimalString {
  const divisor = asDecimal(right);
  if (divisor.isZero()) {
    throw new InvalidDecimalError("DIVISION_BY_ZERO");
  }
  return toCanonicalString(
    asDecimal(left).div(divisor).toDecimalPlaces(20, ROUNDING_MODE[rounding]),
  );
}

export function decimalCmp(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const compared = asDecimal(left).cmp(asDecimal(right));
  if (compared === undefined) {
    throw new InvalidDecimalError("DECIMAL_COMPARE_FAILED");
  }
  return compared === 0 ? 0 : compared > 0 ? 1 : -1;
}

export function decimalAbs(value: DecimalString): DecimalString {
  return toCanonicalString(asDecimal(value).abs());
}

export function decimalIsZero(value: DecimalString): boolean {
  return asDecimal(value).isZero();
}

export function decimalNegate(value: DecimalString): DecimalString {
  return toCanonicalString(asDecimal(value).negated());
}

export function quantize(
  value: DecimalString,
  step: DecimalString,
  rounding: DecimalRounding,
): DecimalString {
  const increment = asDecimal(step);
  if (!increment.isFinite() || increment.lte(0)) {
    throw new InvalidDecimalError("INVALID_STEP");
  }
  const ratio = asDecimal(value).div(increment);
  const rounded = ratio.toDecimalPlaces(0, ROUNDING_MODE[rounding]);
  return toCanonicalString(rounded.times(increment));
}

export function toTenthString(value: DecimalString): DecimalString {
  const canonical = parseDecimalString(value);
  if (!isExactMultiple(canonical, "0.1")) {
    return canonical;
  }
  const quantized = quantize(canonical, "0.1", "DOWN");
  const negative = decimalCmp(quantized, "0") < 0;
  const absolute = decimalAbs(quantized);
  const [whole = "0", fraction = ""] = absolute.split(".");
  return `${negative ? "-" : ""}${whole}.${`${fraction}0`.slice(0, 1)}`;
}

export function isExactMultiple(value: DecimalString, step: DecimalString): boolean {
  const increment = asDecimal(step);
  if (!increment.isFinite() || increment.lte(0)) {
    return false;
  }
  return asDecimal(value).mod(increment).isZero();
}
