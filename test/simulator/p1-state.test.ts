import assert from "node:assert/strict";
import test from "node:test";

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

test("P1-S01 entry ACK -> ENTRY_WORKING only after evidence", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  assert.equal(simulator.level("B1").state, "IDLE");
  const result = simulator.submit(intent.intentId, "ACK");
  assert.equal(result.kind, "ACK");
  assert.equal(simulator.level("B1").state, "ENTRY_WORKING");
});

test("P1-S02 entry REJECTED -> no working order", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const result = simulator.submit(intent.intentId, "REJECTED");
  assert.equal(result.kind, "REJECTED");
  assert.equal(simulator.level("B1").state, "IDLE");
  assert.equal(simulator.listOpenOrders().length, 0);
});

test("P1-S03 entry UNKNOWN -> RECONCILING + possible exposure reserved", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const result = simulator.submit(intent.intentId, "UNKNOWN");
  assert.equal(result.kind, "UNKNOWN");
  assert.equal(simulator.level("B1").state, "RECONCILING");
  assert.equal(simulator.canIncreaseRisk(), false);
  assert.equal(simulator.possibleExposure().unknownSubmissions.length, 1);
  const discovered = simulator.discoverOwnedOrder(intent.intentId);
  assert.equal(discovered.ownership, "OWNED");
  assert.equal(simulator.level("B1").state, "ENTRY_WORKING");
});

test("P1-S04 partial fill -> executed + remaining quantities preserved", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const level = simulator.level("B1");
  assert.equal(level.state, "ENTRY_PARTIAL");
  assert.equal(level.originalQuantity, "0.01");
  assert.equal(level.executedQuantity, "0.004");
  assert.equal(level.remainingQuantity, "0.006");
});

test("P1-S05 multiple partial executions -> execution-ID dedupe + exact cumulative quantity", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    executionId: "exec-a",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  simulator.applyExecution({
    executionId: "exec-b",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.003",
    price: "99.4",
  });
  simulator.applyExecution({
    executionId: "exec-a",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const level = simulator.level("B1");
  assert.deepEqual(level.executionIds, ["exec-a", "exec-b"]);
  assert.equal(level.executedQuantity, "0.007");
  assert.equal(level.remainingQuantity, "0.003");
  assert.equal(level.weightedExecutionPrice, "99.4");
});

test("P1-S06 full entry fill -> POSITION_OPEN + adjacent exit intent", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.01",
    price: "97.0",
  });
  const level = simulator.level("B5");
  assert.equal(level.state, "POSITION_OPEN");
  assert.ok(level.exitIntentId);
  assert.equal(level.normalizedExitPrice, "97.6");
});

test("P1-S07 exit partial/full only advances from execution evidence", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.01",
    price: "97.0",
  });
  const exitIntentId = simulator.level("B5").exitIntentId;
  assert.ok(exitIntentId);
  assert.equal(simulator.level("B5").state, "POSITION_OPEN");
  const exitAck = simulator.submit(exitIntentId, "ACK");
  assert.equal(exitAck.kind, "ACK");
  if (exitAck.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  assert.equal(simulator.level("B5").state, "EXIT_WORKING");
  simulator.applyExecution({
    exchangeOrderId: exitAck.ack.exchangeOrderId,
    quantity: "0.004",
    price: "97.6",
  });
  assert.equal(simulator.level("B5").state, "EXIT_PARTIAL");
  simulator.applyExecution({
    exchangeOrderId: exitAck.ack.exchangeOrderId,
    quantity: "0.006",
    price: "97.6",
  });
  assert.equal(simulator.level("B5").state, "IDLE");
});

test("P1-S08 cancel ACK != fill", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  const cancelled = simulator.requestCancel(placed.ack.exchangeOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  assert.equal(simulator.level("B1").state, "IDLE");
  assert.equal(simulator.listExecutions().length, 0);
});

test("P1-S09 disappearance -> RECONCILING, not fill", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.disappear(placed.ack.exchangeOrderId);
  assert.equal(simulator.level("B1").state, "RECONCILING");
  assert.equal(simulator.listExecutions().length, 0);
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("P1-S10 position delta without execution -> no invented execution", () => {
  const simulator = DeterministicSimulator.create(testInit());
  simulator.applyPositionDelta("0.25");
  assert.equal(simulator.getPosition().quantity, "0.25");
  assert.equal(simulator.listExecutions().length, 0);
  assert.equal(simulator.getAccount().equityUsd, null);
});
