import assert from "node:assert/strict";
import test from "node:test";

import { V01_EXPERIMENT_CONFIG } from "../../src/domain/config.js";
import { ALL_LEVELS } from "../../src/domain/ids.js";
import { parseDecimalString } from "../../src/math/decimal.js";
import {
  buildGridGeometry,
  exitTarget,
  theoreticalEntryPrice,
  theoreticalExitPrice,
  theoreticalGrid,
} from "../../src/strategy/geometry.js";
import {
  assessEnvelopeFeasibility,
  normalizePrice,
  normalizeQuantity,
} from "../../src/strategy/marketRules.js";

const exactAnchor100 = {
  B1: "99.4",
  B2: "98.8",
  B3: "98.2",
  B4: "97.6",
  B5: "97.0",
  S1: "100.6",
  S2: "101.2",
  S3: "101.8",
  S4: "102.4",
  S5: "103.0",
} as const;

test("P1-G01 anchor 100 exact ten levels", () => {
  const levels = theoreticalGrid("100");
  assert.equal(levels.length, 10);
  for (const level of levels) {
    const mathematical = exactAnchor100[level.logicalLevelId];
    assert.equal(level.theoreticalPrice, parseDecimalString(mathematical));
    assert.equal(parseDecimalString(mathematical), parseDecimalString(level.theoreticalPrice));
  }
});

test("P1-G02 arbitrary decimal anchor without IEEE drift", () => {
  assert.equal(theoreticalEntryPrice("93250.5", "B1"), "92690.997");
  assert.equal(theoreticalEntryPrice("93250.5", "S5"), "96048.015");
  assert.equal(theoreticalEntryPrice("0.001", "B5"), "0.00097");
});

test("P1-G03 explicit tick rounding", () => {
  const rules = {
    priceTick: "1",
    quantityStep: "0.001",
    minQuantity: null,
    maxQuantity: null,
    minNotional: null,
    maxNotional: null,
    maxClientOrderIdLength: null,
    clientOrderIdPattern: null,
  };
  assert.equal(normalizePrice("99.4", rules, "DOWN"), "99");
  assert.equal(normalizePrice("99.4", rules, "UP"), "100");
  const geometry = buildGridGeometry("100", { ...rules, priceTick: "0.1" }, "DOWN");
  assert.equal(geometry.status, "FEASIBLE");
  if (geometry.status === "FEASIBLE") {
    assert.equal(
      geometry.normalized.find((level) => level.logicalLevelId === "B1")?.normalizedPrice,
      "99.4",
    );
  }
});

test("P1-G04 explicit quantity-step normalization", () => {
  const rules = {
    priceTick: "0.1",
    quantityStep: "0.01",
    minQuantity: "0.01",
    maxQuantity: null,
    minNotional: null,
    maxNotional: null,
    maxClientOrderIdLength: null,
    clientOrderIdPattern: null,
  };
  assert.equal(normalizeQuantity("0.019", rules, "DOWN"), "0.01");
  assert.equal(normalizeQuantity("0.011", rules, "UP"), "0.02");
});

test("P1-G05 min-notional infeasible without envelope expansion", () => {
  const rules = {
    priceTick: "0.1",
    quantityStep: "0.001",
    minQuantity: "0.001",
    maxQuantity: null,
    minNotional: "1000",
    maxNotional: null,
    maxClientOrderIdLength: null,
    clientOrderIdPattern: null,
  };
  const result = assessEnvelopeFeasibility(rules, V01_EXPERIMENT_CONFIG);
  assert.equal(result.status, "INFEASIBLE");
  if (result.status === "INFEASIBLE") {
    assert.equal(result.reason, "MIN_NOTIONAL_EXCEEDS_ENVELOPE");
  }
  assert.equal(V01_EXPERIMENT_CONFIG.leverage, "5");
  assert.equal(V01_EXPERIMENT_CONFIG.capitalCeilingUsd, "100");
  assert.equal(V01_EXPERIMENT_CONFIG.marginBudgetUsd, "30");
});

test("exit targets walk one step toward anchor", () => {
  assert.equal(exitTarget("B5"), "B4");
  assert.equal(exitTarget("B4"), "B3");
  assert.equal(exitTarget("B3"), "B2");
  assert.equal(exitTarget("B2"), "B1");
  assert.equal(exitTarget("B1"), "ANCHOR");
  assert.equal(exitTarget("S5"), "S4");
  assert.equal(exitTarget("S4"), "S3");
  assert.equal(exitTarget("S3"), "S2");
  assert.equal(exitTarget("S2"), "S1");
  assert.equal(exitTarget("S1"), "ANCHOR");
  assert.equal(theoreticalExitPrice("100", "B5"), "97.6");
  assert.equal(theoreticalExitPrice("100", "B4"), "98.2");
  assert.equal(theoreticalExitPrice("100", "B1"), "100");
  assert.equal(theoreticalExitPrice("100", "S5"), "102.4");
  assert.equal(theoreticalExitPrice("100", "S1"), "100");
  assert.equal(ALL_LEVELS.length, 10);
});
