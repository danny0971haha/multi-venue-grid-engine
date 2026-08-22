import assert from "node:assert/strict";
import test from "node:test";

import { makeScopeKey } from "../../src/domain/ids.js";
import { DeterministicSimulator } from "../../src/simulator/engine.js";
import { testInit } from "./helpers.js";

function plannedEntry(simulator: DeterministicSimulator, levelId: string) {
  const planned = simulator.planEntries();
  assert.equal(planned.status, "PLANNED");
  if (planned.status !== "PLANNED") {
    throw new Error("expected planned entries");
  }
  const intent = planned.intents.find((item) => item.logicalLevelId === levelId);
  assert.ok(intent);
  return intent;
}

test("P1-I03 new anchor epoch does not adopt old order", () => {
  const first = DeterministicSimulator.create(testInit({ anchorEpoch: "epoch-1" }));
  const intent = plannedEntry(first, "B1");
  const placed = first.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  assert.ok(intent.clientOrderId);
  const second = DeterministicSimulator.create(testInit({ anchorEpoch: "epoch-2" }));
  assert.equal(
    second.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: placed.kind === "ACK" ? placed.ack.exchangeOrderId : "missing",
      scopeKey: makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1"),
      anchorEpoch: "epoch-1",
    }),
    "UNOWNED",
  );
});

test("P1-I04 clearly foreign order -> UNOWNED", () => {
  const simulator = DeterministicSimulator.create(testInit());
  simulator.injectForeignOrder({
    exchangeOrderId: "foreign-1",
    clientOrderId: "someone-else",
    logicalLevelId: null,
    purpose: "GRID_ENTRY",
    side: "BUY",
    type: "LIMIT",
    price: "99.4",
    originalQuantity: "0.01",
    executedQuantity: "0",
    remainingQuantity: "0.01",
    status: "WORKING",
    reduceOnly: false,
    anchorEpoch: "other-epoch",
    scopeKey: "other/sim/BTC_USDC_PERP/grid-v0.1",
  });
  const observed = simulator
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "foreign-1");
  assert.equal(observed?.ownership, "UNOWNED");
});

test("P1-I05 incomplete identity -> AMBIGUOUS", () => {
  const simulator = DeterministicSimulator.create(testInit());
  simulator.injectAmbiguousOrder("amb-1", "BUY", "99.4", "0.01");
  const observed = simulator.listOpenOrders().find((order) => order.exchangeOrderId === "amb-1");
  assert.equal(observed?.ownership, "AMBIGUOUS");
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("P1-I06 owned duplicate -> deterministic survivor/cleanup plan", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  const duplicate = simulator.injectOwnedDuplicate("B1", "99.4", "0.01");
  const plan = simulator.planDuplicateCleanup("B1");
  const expected = [placed.ack.exchangeOrderId, duplicate].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  assert.equal(plan.disposition, "CANCEL_OWNED_DUPLICATE");
  assert.equal(plan.survivorExchangeOrderId, expected[0]);
  assert.deepEqual(plan.cancelExchangeOrderIds, expected.slice(1));
  assert.equal(plan.cancelExchangeOrderIds.includes(plan.survivorExchangeOrderId), false);
});

test("P1-I07 owned + unowned duplicate price -> unowned never selected for cancel", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  simulator.injectForeignOrder({
    exchangeOrderId: "foreign-same-price",
    clientOrderId: "foreign-client",
    logicalLevelId: null,
    purpose: "GRID_ENTRY",
    side: "BUY",
    type: "LIMIT",
    price: "99.4",
    originalQuantity: "0.01",
    executedQuantity: "0",
    remainingQuantity: "0.01",
    status: "WORKING",
    reduceOnly: false,
    anchorEpoch: "foreign",
    scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
  });
  const plan = simulator.planDuplicateCleanupByPrice("99.4");
  assert.equal(simulator.cancelCandidatesInclude(plan, "foreign-same-price"), false);
  assert.equal(
    plan.cancelExchangeOrderIds.every((id) => id !== "foreign-same-price"),
    true,
  );
});
