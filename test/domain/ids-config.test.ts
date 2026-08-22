import assert from "node:assert/strict";
import test from "node:test";

import { frozenExperimentConfig } from "../../src/domain/config.js";
import {
  makeClientOrderId,
  makeIntentId,
  makeScopeKey,
  parseScopeKey,
} from "../../src/domain/ids.js";

test("P1-I01 deterministic intent identity from same durable inputs", () => {
  const input = {
    experimentId: "exp-1",
    runId: "run-1",
    scopeKey: makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1"),
    anchorEpoch: "epoch-1",
    logicalLevelId: "B1",
    purpose: "GRID_ENTRY",
    sequence: "1",
  };
  assert.equal(makeIntentId(input), makeIntentId(input));
});

test("P1-I02 distinct logical levels do not collide", () => {
  const base = {
    experimentId: "exp-1",
    runId: "run-1",
    scopeKey: makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1"),
    anchorEpoch: "epoch-1",
    purpose: "GRID_ENTRY",
    sequence: "1",
  };
  const b1 = makeIntentId({ ...base, logicalLevelId: "B1" });
  const b2 = makeIntentId({ ...base, logicalLevelId: "B2" });
  const c1 = makeClientOrderId({
    scopeKey: base.scopeKey,
    anchorEpoch: base.anchorEpoch,
    logicalLevelId: "B1",
    purpose: base.purpose,
    intentId: b1,
  });
  const c2 = makeClientOrderId({
    scopeKey: base.scopeKey,
    anchorEpoch: base.anchorEpoch,
    logicalLevelId: "B2",
    purpose: base.purpose,
    intentId: b2,
  });
  assert.notEqual(b1, b2);
  assert.notEqual(c1, c2);
});

test("canonical v0.1 scope string is account/venue/market/strategy", () => {
  const scope = makeScopeKey("canary-01", "backpack", "BTC_USDC_PERP", "grid-v0.1");
  assert.equal(scope, "canary-01/backpack/BTC_USDC_PERP/grid-v0.1");
  assert.deepEqual(parseScopeKey(scope), {
    accountScope: "canary-01",
    venue: "backpack",
    market: "BTC_USDC_PERP",
    strategy: "grid-v0.1",
  });
});

test("frozen v0.1 experiment configuration is exact", () => {
  assert.deepEqual(frozenExperimentConfig(), {
    version: "0.1.0",
    capitalCeilingUsd: "100",
    leverage: "5",
    marginBudgetUsd: "30",
    maxPlannedGrossNotionalUsd: "150",
    gridLevels: 10,
    gridHalfBandFraction: "0.03",
    dailyLossLimitUsd: "5",
    drawdownFromStartLimitUsd: "10",
    boundaryBufferFraction: "0.01",
  });
});
