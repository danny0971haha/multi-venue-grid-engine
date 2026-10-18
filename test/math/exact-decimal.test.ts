import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InvalidDecimalError } from "../../src/math/decimal.js";
import {
  EXACT_DECIMAL_MAX_DIGITS,
  exactAdd,
  exactMul,
  exactSub,
} from "../../src/math/exact-decimal.js";

// Independent reference: canonical decimal strings as scaled BigInt values.
function toScaled(value: string): { units: bigint; scale: number } {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(`${whole}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

function fromScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction === "" ? whole : `${whole}.${fraction}`}`;
}

function referenceAdd(left: string, right: string): string {
  const a = toScaled(left);
  const b = toScaled(right);
  const scale = Math.max(a.scale, b.scale);
  const sum = a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale);
  return fromScaled(sum, scale);
}

function referenceMul(left: string, right: string): string {
  const a = toScaled(left);
  const b = toScaled(right);
  return fromScaled(a.units * b.units, a.scale + b.scale);
}

function negate(value: string): string {
  if (value === "0") {
    return value;
  }
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

// Edge values of the 128-character risk decimal domain plus near-cap values.
const SAMPLES = [
  "0",
  "1",
  "-1",
  "150",
  "-5",
  "0.99",
  "1.01",
  "150.000000000000000000000000000000000000001",
  "1.500000000000000000000000000000000000000001",
  `-10000000000.${"0".repeat(29)}4`,
  "9".repeat(127),
  `-${"9".repeat(127)}`,
  `0.${"0".repeat(125)}1`,
  `-0.${"0".repeat(124)}1`,
  `1.${"0".repeat(125)}1`,
  `${"1".repeat(63)}.${"1".repeat(64)}`,
];

describe("exact decimal arithmetic", () => {
  test("ED-01 a product above the cap keeps every digit", () => {
    assert.equal(
      exactMul("1", "150.000000000000000000000000000000000000001"),
      "150.000000000000000000000000000000000000001",
    );
    assert.equal(
      exactMul("1.500000000000000000000000000000000000000001", "100"),
      "150.0000000000000000000000000000000000000001",
    );
  });

  test("ED-02 sums and differences keep a tiny remainder next to a large term", () => {
    assert.equal(exactAdd("150", `0.${"0".repeat(42)}1`), `150.${"0".repeat(42)}1`);
    assert.equal(
      exactAdd(`-10000000000.${"0".repeat(29)}4`, `9999999995.${"0".repeat(29)}1`),
      `-5.${"0".repeat(29)}3`,
    );
    assert.equal(exactSub("10", `0.${"0".repeat(42)}1`), `9.${"9".repeat(43)}`);
  });

  test("ED-03 every sample pair matches the BigInt reference", () => {
    for (const left of SAMPLES) {
      for (const right of SAMPLES) {
        assert.equal(exactAdd(left, right), referenceAdd(left, right), `${left} + ${right}`);
        assert.equal(
          exactSub(left, right),
          referenceAdd(left, negate(right)),
          `${left} - ${right}`,
        );
        assert.equal(exactMul(left, right), referenceMul(left, right), `${left} * ${right}`);
      }
    }
  });

  test("ED-04 zero operands give exact results at any size", () => {
    const huge = `1${"0".repeat(2000)}1`;
    assert.equal(exactMul("0", huge), "0");
    assert.equal(exactMul(huge, "0"), "0");
    assert.equal(exactAdd("0", huge), huge);
    assert.equal(exactSub(huge, "0"), huge);
    assert.equal(exactSub("0", huge), `-${huge}`);
  });

  test("ED-05 a result that fits the digit bound exactly is computed exactly", () => {
    const half = `1${"0".repeat(EXACT_DECIMAL_MAX_DIGITS / 2 - 2)}1`;
    assert.equal(exactMul(half, half), referenceMul(half, half));
    const wide = `1${"0".repeat(EXACT_DECIMAL_MAX_DIGITS - 3)}1`;
    assert.equal(exactAdd(wide, "1"), referenceAdd(wide, "1"));
  });

  test("ED-06 a result that could exceed the digit bound fails closed before arithmetic", () => {
    const over = `1${"0".repeat(EXACT_DECIMAL_MAX_DIGITS / 2 - 1)}1`;
    const half = `1${"0".repeat(EXACT_DECIMAL_MAX_DIGITS / 2 - 2)}1`;
    const failsClosed = (run: () => string) =>
      assert.throws(
        run,
        (error: unknown) =>
          error instanceof InvalidDecimalError && error.message === "EXACT_PRECISION_EXCEEDED",
      );
    failsClosed(() => exactMul(over, half));
    failsClosed(() => exactAdd(`1${"0".repeat(EXACT_DECIMAL_MAX_DIGITS)}`, "0.1"));
    failsClosed(() => exactSub(`0.${"0".repeat(EXACT_DECIMAL_MAX_DIGITS)}1`, "1"));
    // The bound comes from operand digit positions, so even an exactly zero difference of
    // over-bound operands fails closed.
    const wide = `1${"0".repeat(EXACT_DECIMAL_MAX_DIGITS)}1`;
    failsClosed(() => exactSub(wide, wide));
  });

  test("ED-07 malformed inputs are rejected", () => {
    for (const value of ["", "1e3", "01", " 1", "1.", ".5", "+1", "1,0", "NaN", "Infinity"]) {
      assert.throws(() => exactAdd(value, "1"), InvalidDecimalError, JSON.stringify(value));
      assert.throws(() => exactSub("1", value), InvalidDecimalError, JSON.stringify(value));
      assert.throws(() => exactMul(value, "1"), InvalidDecimalError, JSON.stringify(value));
    }
  });
});
