import { Decimal } from "decimal.js";

import type { DecimalString } from "./decimal.js";
import { InvalidDecimalError, parseDecimalString, toCanonicalString } from "./decimal.js";

// Upper bound on result significant digits. Each operation derives, from its operands' digit
// positions, how many digits its exact result can need and fails closed above this bound
// before any arithmetic runs, so no result is ever rounded.
export const EXACT_DECIMAL_MAX_DIGITS = 1024;

const ExactDecimal = Decimal.clone({
  precision: EXACT_DECIMAL_MAX_DIGITS,
  rounding: Decimal.ROUND_HALF_UP,
});

function asExact(value: DecimalString): Decimal {
  return new ExactDecimal(parseDecimalString(value));
}

function requireDigits(digits: number): void {
  if (digits > EXACT_DECIMAL_MAX_DIGITS) {
    throw new InvalidDecimalError("EXACT_PRECISION_EXCEEDED");
  }
}

// Power of ten of the least significant non-zero digit.
function lowestDigitExponent(value: Decimal): number {
  return value.e - value.sd() + 1;
}

// Digits a sum or difference of two non-zero values can need, including one carry digit.
function sumDigits(a: Decimal, b: Decimal): number {
  const highest = Math.max(a.e, b.e) + 1;
  const lowest = Math.min(lowestDigitExponent(a), lowestDigitExponent(b));
  return highest - lowest + 1;
}

export function exactAdd(left: DecimalString, right: DecimalString): DecimalString {
  const a = asExact(left);
  const b = asExact(right);
  if (b.isZero()) {
    return toCanonicalString(a);
  }
  if (a.isZero()) {
    return toCanonicalString(b);
  }
  requireDigits(sumDigits(a, b));
  return toCanonicalString(a.plus(b));
}

export function exactSub(left: DecimalString, right: DecimalString): DecimalString {
  const a = asExact(left);
  const b = asExact(right);
  if (b.isZero()) {
    return toCanonicalString(a);
  }
  if (a.isZero()) {
    return toCanonicalString(b.negated());
  }
  requireDigits(sumDigits(a, b));
  return toCanonicalString(a.minus(b));
}

export function exactMul(left: DecimalString, right: DecimalString): DecimalString {
  const a = asExact(left);
  const b = asExact(right);
  if (a.isZero() || b.isZero()) {
    return "0";
  }
  requireDigits(a.sd() + b.sd());
  return toCanonicalString(a.times(b));
}
