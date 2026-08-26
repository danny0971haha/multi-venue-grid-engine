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

test("NOT_SENT is distinct from REJECTED and UNKNOWN", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const result = simulator.submit(intent.intentId, "NOT_SENT");
  assert.equal(result.kind, "NOT_SENT");
  assert.equal(simulator.level("B1").state, "IDLE");
  assert.equal(simulator.listOpenOrders().length, 0);
  assert.equal(simulator.possibleExposure().unknownSubmissions.length, 0);
});

test("timeout-like placement is UNKNOWN, not REJECTED", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B2");
  const result = simulator.submit(intent.intentId, "UNKNOWN");
  assert.equal(result.kind, "UNKNOWN");
  assert.notEqual(result.kind, "REJECTED");
  if (result.kind === "UNKNOWN") {
    assert.equal(result.requestFingerprint.includes(intent.intentId), true);
  }
  assert.equal(simulator.level("B2").state, "RECONCILING");
  assert.equal(simulator.listOpenOrders().length, 0);
});

test("cancel NOT_SENT is not treated as REJECTED", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  const result = simulator.requestCancel(placed.ack.exchangeOrderId, "NOT_SENT");
  assert.equal(result.kind, "NOT_SENT");
  assert.equal(simulator.level("B1").state, "ENTRY_WORKING");
  assert.equal(simulator.listOpenOrders().length, 1);
});

test("cancel/fill race: fill then cancel keeps execution evidence", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  assert.equal(simulator.level("B1").state, "POSITION_OPEN");
  const cancelled = simulator.requestCancel(placed.ack.exchangeOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  assert.equal(simulator.level("B1").state, "POSITION_OPEN");
  assert.equal(simulator.listExecutions().length, 1);
  assert.ok(simulator.level("B1").exitIntentId);
});

test("cancel/fill race: late execution after cancel ACK still counts as fill", () => {
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
  simulator.applyExecution({
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  assert.equal(simulator.level("B1").state, "POSITION_OPEN");
  assert.equal(simulator.listExecutions().length, 1);
  assert.equal(simulator.level("B1").executedQuantity, "0.01");
});

test("partial fill then cancel remaining preserves executed quantity", () => {
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
  const cancelled = simulator.requestCancel(placed.ack.exchangeOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const level = simulator.level("B1");
  assert.equal(level.state, "POSITION_OPEN");
  assert.equal(level.executedQuantity, "0.004");
  assert.equal(level.remainingQuantity, "0");
  assert.equal(simulator.listExecutions().length, 1);
  assert.ok(level.exitIntentId);
});

test("possible exposure reserves remaining qty and never invents zero", () => {
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
  const exposure = simulator.possibleExposure();
  assert.equal(exposure.ownedWorkingRiskIncreasing.length, 1);
  assert.equal(exposure.ownedWorkingRiskIncreasing[0]?.quantity, "0.006");
  assert.equal(exposure.signedPosition, "0.004");
  assert.equal(
    exposure.ownedWorkingRiskIncreasing.every((item) => item.quantity !== "0"),
    true,
  );
});

test("weighted execution price uses decimal notional, not IEEE number", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    executionId: "px-a",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  simulator.applyExecution({
    executionId: "px-b",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.006",
    price: "99.6",
  });
  assert.equal(simulator.level("B1").weightedExecutionPrice, "99.52");
});
