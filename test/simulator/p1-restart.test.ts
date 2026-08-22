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

test("P1-R01 restart with working entries -> no blind reseed/duplicate intent", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  const again = restored.planEntries();
  assert.equal(again.status, "PLANNED");
  if (again.status === "PLANNED") {
    assert.equal(again.intents.length, 10);
    assert.equal(again.intents.filter((item) => item.logicalLevelId === "B1").length, 1);
  }
  assert.equal(restored.level("B1").state, "ENTRY_WORKING");
});

test("P1-R02 restart with partial fill -> exact partial state survives", () => {
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
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  const level = restored.level("B1");
  assert.equal(level.state, "ENTRY_PARTIAL");
  assert.equal(level.executedQuantity, "0.004");
  assert.equal(level.remainingQuantity, "0.006");
  assert.equal(level.originalQuantity, "0.01");
});

test("P1-R03 restart with UNKNOWN write -> risk increase remains blocked/reconciling", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  simulator.submit(intent.intentId, "UNKNOWN");
  const snapshot = simulator.exportSnapshot();
  assert.equal(JSON.stringify(snapshot).includes("Decimal"), false);
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(restored.level("B1").state, "RECONCILING");
  assert.equal(restored.canIncreaseRisk(), false);
  assert.equal(restored.possibleExposure().unknownSubmissions.length, 1);
});

test("P1-R04 execution overlap -> same execution not double-counted", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const placed = simulator.submit(intent.intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  simulator.applyExecution({
    executionId: "overlap-1",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  restored.applyExecution({
    executionId: "overlap-1",
    exchangeOrderId: placed.ack.exchangeOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  assert.equal(restored.level("B1").executedQuantity, "0.005");
  assert.equal(restored.listExecutions().length, 1);
});

test("P1-R05 execution history gap -> reconciliation required", () => {
  const simulator = DeterministicSimulator.create(testInit());
  simulator.planEntries();
  simulator.markExecutionGap();
  assert.equal(simulator.canIncreaseRisk(), false);
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  assert.equal(restored.canIncreaseRisk(), false);
});

test("snapshot export/import is deterministic JSON without live class instances", () => {
  const simulator = DeterministicSimulator.create(testInit());
  plannedEntry(simulator, "S1");
  const first = JSON.stringify(simulator.exportSnapshot());
  const second = JSON.stringify(
    DeterministicSimulator.fromSnapshot(JSON.parse(first)).exportSnapshot(),
  );
  assert.equal(first, second);
  assert.equal(first.includes('"schemaVersion":"phase1-simulator-1"'), true);
});
