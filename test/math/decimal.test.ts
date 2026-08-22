import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidDecimalError,
  decimalAdd,
  decimalCmp,
  decimalDiv,
  decimalMul,
  isExactMultiple,
  parseDecimalString,
  quantize,
} from "../../src/math/decimal.js";

test("canonical decimal serialization rejects invalid inputs", () => {
  assert.throws(() => parseDecimalString(""), InvalidDecimalError);
  assert.throws(() => parseDecimalString("1e2"), InvalidDecimalError);
  assert.throws(() => parseDecimalString("1,000"), InvalidDecimalError);
  assert.throws(() => parseDecimalString(" 100"), InvalidDecimalError);
  assert.throws(() => parseDecimalString("NaN"), InvalidDecimalError);
  assert.throws(() => parseDecimalString("Infinity"), InvalidDecimalError);
  assert.equal(parseDecimalString("1.10"), "1.1");
  assert.equal(parseDecimalString("100"), "100");
  assert.equal(parseDecimalString("-5.25"), "-5.25");
  assert.equal(parseDecimalString("0.001"), "0.001");
});

test("decimal arithmetic does not use IEEE drift for grid spacing", () => {
  const offset = decimalMul("0.03", decimalDiv("1", "5"));
  assert.equal(offset, "0.006");
  assert.equal(decimalMul("100", decimalAdd("1", decimalMul(offset, "-1"))), "99.4");
  assert.equal(decimalCmp("99.4", "99.400"), 0);
});

test("quantize is explicit and exact", () => {
  assert.equal(quantize("99.45", "0.1", "DOWN"), "99.4");
  assert.equal(quantize("99.45", "0.1", "UP"), "99.5");
  assert.equal(quantize("99.45", "0.1", "HALF_UP"), "99.5");
  assert.equal(isExactMultiple("99.4", "0.1"), true);
  assert.equal(isExactMultiple("99.45", "0.1"), false);
});
