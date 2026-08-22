import type { SimulatorInit } from "../../src/simulator/engine.js";
import type { MarketRules } from "../../src/strategy/marketRules.js";

export function testRules(overrides: Partial<MarketRules> = {}): MarketRules {
  return {
    priceTick: "0.1",
    quantityStep: "0.001",
    minQuantity: "0.001",
    maxQuantity: null,
    minNotional: null,
    maxNotional: null,
    maxClientOrderIdLength: 36,
    clientOrderIdPattern: null,
    ...overrides,
  };
}

export function testInit(overrides: Partial<SimulatorInit> = {}): SimulatorInit {
  return {
    experimentId: "exp-1",
    runId: "run-1",
    accountScope: "canary-01",
    venue: "sim",
    market: "BTC_USDC_PERP",
    strategy: "grid-v0.1",
    anchorEpoch: "epoch-1",
    anchorPrice: "100",
    marketRules: testRules(),
    priceRounding: "DOWN",
    quantityRounding: "DOWN",
    leaseGeneration: "1",
    createdAt: "2026-08-22T00:00:00.000Z",
    quantity: "0.01",
    ...overrides,
  };
}
