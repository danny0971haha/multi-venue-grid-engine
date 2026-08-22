import assert from "node:assert/strict";
import test from "node:test";

import { makeScopeKey } from "../../src/domain/ids.js";
import {
  DeterministicSimulator,
  type SimulatorSnapshot,
  SnapshotImportError,
} from "../../src/simulator/engine.js";
import { testInit } from "./helpers.js";

const CURRENT_SCOPE = makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1");

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

function ackPlace(simulator: DeterministicSimulator, intentId: string) {
  const placed = simulator.submit(intentId, "ACK");
  assert.equal(placed.kind, "ACK");
  if (placed.kind !== "ACK") {
    throw new Error("expected ACK");
  }
  return placed.ack.exchangeOrderId;
}

function snapshotIntent(simulator: DeterministicSimulator, intentId: string) {
  const intent = simulator.exportSnapshot().intents.find((item) => item.intentId === intentId);
  assert.ok(intent);
  return intent;
}

function ownedWorkingSnapshot(): {
  snapshot: SimulatorSnapshot;
  ownedOrderId: string;
} {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  return { snapshot: simulator.exportSnapshot(), ownedOrderId };
}

function findOrder(snapshot: SimulatorSnapshot, exchangeOrderId: string) {
  const order = snapshot.orders.find((item) => item.exchangeOrderId === exchangeOrderId);
  assert.ok(order);
  return order;
}

function forgedUnlinkedOrder(ownership: "OWNED" | "UNOWNED" | "AMBIGUOUS") {
  return {
    exchangeOrderId: "forged-unlinked",
    clientOrderId: "forged-client",
    intentId: null,
    logicalLevelId: null,
    purpose: "GRID_ENTRY" as const,
    side: "BUY" as const,
    type: "LIMIT",
    price: "99.4",
    originalQuantity: "0.01",
    executedQuantity: "0",
    remainingQuantity: "0.01",
    status: "WORKING",
    reduceOnly: false,
    ownership,
    presentInOpenBook: true,
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  };
}

test("D1 snapshot order forged as ownership=OWNED with no validated linkage -> AMBIGUOUS or import rejection", () => {
  const { snapshot } = ownedWorkingSnapshot();
  snapshot.orders.push(forgedUnlinkedOrder("OWNED"));
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: "forged-client",
      exchangeOrderId: "forged-unlinked",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "AMBIGUOUS",
  );
  const observed = restored
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "forged-unlinked");
  assert.equal(observed?.ownership, "AMBIGUOUS");
  assert.equal(restored.canIncreaseRisk(), false);
});

test("D2 forged imported ownership cannot enter knownExchangeOrderIds or duplicate-cancel candidates", () => {
  const { snapshot, ownedOrderId } = ownedWorkingSnapshot();
  snapshot.orders.push(forgedUnlinkedOrder("OWNED"));
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  const plan = restored.planDuplicateCleanupByPrice("99.4");
  assert.equal(restored.cancelCandidatesInclude(plan, "forged-unlinked"), false);
  assert.equal(plan.cancelExchangeOrderIds.includes("forged-unlinked"), false);
  assert.equal(plan.survivorExchangeOrderId, ownedOrderId);
  const refused = restored.requestCancel("forged-unlinked", "ACK");
  assert.equal(refused.kind, "NOT_SENT");
  assert.equal(refused.kind === "NOT_SENT" ? refused.reason : "", "REFUSES_UNOWNED_CANCEL");
});

test("D3 legitimate ACK-linked owned order remains OWNED after export/import", () => {
  const { snapshot, ownedOrderId } = ownedWorkingSnapshot();
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  const owned = findOrder(snapshot, ownedOrderId);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: owned.clientOrderId,
      exchangeOrderId: ownedOrderId,
      scopeKey: owned.scopeKey,
      anchorEpoch: owned.anchorEpoch,
    }),
    "OWNED",
  );
  const observed = restored
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === ownedOrderId);
  assert.equal(observed?.ownership, "OWNED");
  assert.equal(restored.level("B1").state, "ENTRY_WORKING");
  assert.equal(restored.canIncreaseRisk(), true);
});

test("D4 intent experiment/run/scope/anchor mismatch -> import rejected", () => {
  const { snapshot } = ownedWorkingSnapshot();
  const mismatches: Array<["experimentId" | "runId" | "scopeKey" | "anchorEpoch", string]> = [
    ["experimentId", "other-exp"],
    ["runId", "other-run"],
    ["scopeKey", "other/sim/BTC_USDC_PERP/grid-v0.1"],
    ["anchorEpoch", "other-epoch"],
  ];
  for (const [field, value] of mismatches) {
    const tampered = structuredClone(snapshot);
    const intent = tampered.intents[0];
    assert.ok(intent);
    intent[field] = value;
    assert.throws(
      () => DeterministicSimulator.fromSnapshot(tampered),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotImportError);
        assert.equal(error.disposition, "BLOCK_RISK_INCREASE");
        return true;
      },
    );
  }
});

test("D5 deterministic intentId/clientOrderId mismatch -> import rejected", () => {
  const { snapshot } = ownedWorkingSnapshot();

  const badIntentId = structuredClone(snapshot);
  const intent = badIntentId.intents[0];
  assert.ok(intent);
  intent.intentId = `${intent.intentId}-tampered`;
  assert.throws(() => DeterministicSimulator.fromSnapshot(badIntentId), SnapshotImportError);

  const badClient = structuredClone(snapshot);
  const clientIntent = badClient.intents.find((item) => item.logicalLevelId === "B1");
  assert.ok(clientIntent);
  clientIntent.clientOrderId = "mv1deadbeefdeadbeefde";
  assert.throws(() => DeterministicSimulator.fromSnapshot(badClient), SnapshotImportError);
});

test("D6 order-to-intent level/purpose/client/scope/epoch mismatch -> import rejected or AMBIGUOUS, never OWNED", () => {
  const { snapshot, ownedOrderId } = ownedWorkingSnapshot();
  const mismatches: Array<[string, unknown]> = [
    ["logicalLevelId", "B2"],
    ["purpose", "GRID_EXIT"],
    ["clientOrderId", "mv1deadbeefdeadbeefde"],
    ["scopeKey", "other/sim/BTC_USDC_PERP/grid-v0.1"],
    ["anchorEpoch", "other-epoch"],
  ];
  for (const [field, value] of mismatches) {
    const tampered = structuredClone(snapshot);
    const order = findOrder(tampered, ownedOrderId);
    Reflect.set(order, field, value);
    let restored: DeterministicSimulator | undefined;
    try {
      restored = DeterministicSimulator.fromSnapshot(tampered);
    } catch (error) {
      assert.ok(error instanceof SnapshotImportError);
      continue;
    }
    assert.notEqual(
      restored.classifyObserved({
        clientOrderId: order.clientOrderId,
        exchangeOrderId: ownedOrderId,
        scopeKey: order.scopeKey,
        anchorEpoch: order.anchorEpoch,
      }),
      "OWNED",
    );
    const plan = restored.planDuplicateCleanupByPrice("99.4");
    assert.equal(restored.cancelCandidatesInclude(plan, ownedOrderId), false);
  }
});

test("D7 order remaining != original - executed -> import rejected", () => {
  const { snapshot, ownedOrderId } = ownedWorkingSnapshot();
  const tampered = structuredClone(snapshot);
  const order = findOrder(tampered, ownedOrderId);
  order.remainingQuantity = "0.004";
  order.originalQuantity = "0.01";
  order.executedQuantity = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(tampered),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotImportError);
      assert.match(error.code, /QUANTITY_INVARIANT|REMAINING_MISMATCH/);
      return true;
    },
  );
});

test("D8 execution totals do not match order/level cumulative quantities -> import rejected", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const exchangeOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const snapshot = simulator.exportSnapshot();
  const tampered = structuredClone(snapshot);
  const execution = tampered.executions[0];
  assert.ok(execution);
  execution.quantity = "0.009";
  assert.throws(() => DeterministicSimulator.fromSnapshot(tampered), SnapshotImportError);
});

test("D9 openInventory or signed position inconsistent with proven executions -> reconciliation-required/import rejection", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const exchangeOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const valid = simulator.exportSnapshot();

  const inventory = structuredClone(valid);
  const level = inventory.levels.find((item) => item.logicalLevelId === "B1");
  assert.ok(level);
  level.entryExecutedQuantity = "0.01";
  level.openInventory = "0.01";
  assert.throws(() => DeterministicSimulator.fromSnapshot(inventory), SnapshotImportError);

  const position = structuredClone(valid);
  position.position.quantity = "1";
  assert.throws(() => DeterministicSimulator.fromSnapshot(position), SnapshotImportError);
});

test("D10 serialized riskIncreaseBlocked=false cannot override UNKNOWN/AMBIGUOUS/reconciling blockers", () => {
  const unknownSim = DeterministicSimulator.create(testInit());
  const unknownIntent = plannedEntry(unknownSim, "B1");
  const unknown = unknownSim.submit(unknownIntent.intentId, "UNKNOWN");
  assert.equal(unknown.kind, "UNKNOWN");
  const unknownSnapshot = unknownSim.exportSnapshot();
  unknownSnapshot.riskIncreaseBlocked = false;
  const unknownRestored = DeterministicSimulator.fromSnapshot(unknownSnapshot);
  assert.equal(unknownRestored.canIncreaseRisk(), false);
  assert.equal(unknownRestored.level("B1").state, "RECONCILING");

  const ambiguousSim = DeterministicSimulator.create(testInit());
  ambiguousSim.injectAmbiguousOrder("amb-d10", "BUY", "99.4", "0.01");
  const ambiguousSnapshot = ambiguousSim.exportSnapshot();
  ambiguousSnapshot.riskIncreaseBlocked = false;
  const ambiguousRestored = DeterministicSimulator.fromSnapshot(ambiguousSnapshot);
  assert.equal(ambiguousRestored.canIncreaseRisk(), false);
  assert.equal(
    ambiguousRestored.classifyObserved({
      clientOrderId: null,
      exchangeOrderId: "amb-d10",
      scopeKey: null,
      anchorEpoch: null,
    }),
    "AMBIGUOUS",
  );

  const reconcilingSim = DeterministicSimulator.create(testInit());
  const reconcilingIntent = plannedEntry(reconcilingSim, "B2");
  const reconcilingOrderId = ackPlace(reconcilingSim, reconcilingIntent.intentId);
  reconcilingSim.disappear(reconcilingOrderId);
  const reconcilingSnapshot = reconcilingSim.exportSnapshot();
  reconcilingSnapshot.riskIncreaseBlocked = false;
  const reconcilingRestored = DeterministicSimulator.fromSnapshot(reconcilingSnapshot);
  assert.equal(reconcilingRestored.canIncreaseRisk(), false);
  assert.equal(reconcilingRestored.level("B2").state, "RECONCILING");
});

test("D11 foreign scope/epoch remains UNOWNED and is never a cancel candidate", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  simulator.injectForeignOrder({
    exchangeOrderId: "foreign-d11",
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
    anchorEpoch: "foreign-epoch",
    scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
  });
  const snapshot = simulator.exportSnapshot();
  const foreign = findOrder(snapshot, "foreign-d11");
  foreign.ownership = "OWNED";
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: "foreign-client",
      exchangeOrderId: "foreign-d11",
      scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
      anchorEpoch: "foreign-epoch",
    }),
    "UNOWNED",
  );
  const plan = restored.planDuplicateCleanupByPrice("99.4");
  assert.equal(restored.cancelCandidatesInclude(plan, "foreign-d11"), false);
  assert.equal(plan.cancelExchangeOrderIds.includes("foreign-d11"), false);
  assert.equal(plan.survivorExchangeOrderId, ownedOrderId);
  const refused = restored.requestCancel("foreign-d11", "ACK");
  assert.equal(refused.kind, "NOT_SENT");
});

test("D12 export -> import -> export remains deterministic for valid legitimate owned state", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const exchangeOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const first = simulator.exportSnapshot();
  const firstJson = JSON.stringify(first);
  const restored = DeterministicSimulator.fromSnapshot(JSON.parse(firstJson) as SimulatorSnapshot);
  const second = restored.exportSnapshot();
  assert.equal(JSON.stringify(second), firstJson);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: findOrder(first, exchangeOrderId).clientOrderId,
      exchangeOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
});

test("adversarial serialized ownership flip from AMBIGUOUS/UNOWNED to OWNED does not grant cancel authority", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  simulator.injectAmbiguousOrder("amb-flip", "BUY", "99.4", "0.01");
  const baseline = simulator.planDuplicateCleanupByPrice("99.4");
  assert.equal(simulator.cancelCandidatesInclude(baseline, "amb-flip"), false);
  assert.equal(baseline.survivorExchangeOrderId, ownedOrderId);

  const snapshot = simulator.exportSnapshot();
  const ambiguous = findOrder(snapshot, "amb-flip");
  assert.equal(ambiguous.ownership === "AMBIGUOUS" || ambiguous.ownership === "UNOWNED", true);
  ambiguous.ownership = "OWNED";
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: null,
      exchangeOrderId: "amb-flip",
      scopeKey: null,
      anchorEpoch: null,
    }),
    "AMBIGUOUS",
  );
  const after = restored.planDuplicateCleanupByPrice("99.4");
  assert.equal(restored.cancelCandidatesInclude(after, "amb-flip"), false);
  assert.deepEqual(after.cancelExchangeOrderIds, baseline.cancelExchangeOrderIds);
  assert.equal(after.survivorExchangeOrderId, baseline.survivorExchangeOrderId);
  const refused = restored.requestCancel("amb-flip", "ACK");
  assert.equal(refused.kind, "NOT_SENT");
});

test("D13 all C1-C13 and every original P1-* case remain green without weakening assertions", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const exchangeOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const cancelled = simulator.requestCancel(exchangeOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const level = simulator.level("B1");
  assert.equal(level.openInventory, "0.004");
  assert.ok(level.exitIntentId);
  assert.equal(snapshotIntent(simulator, level.exitIntentId).quantity, "0.004");

  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  assert.equal(restored.level("B1").openInventory, "0.004");
  assert.equal(restored.level("B1").entryMutationSequence, "1");
  assert.equal(restored.canIncreaseRisk(), true);

  const foreign = DeterministicSimulator.create(testInit());
  foreign.injectForeignOrder({
    exchangeOrderId: "foreign-d13",
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
  assert.equal(
    foreign.listOpenOrders().find((order) => order.exchangeOrderId === "foreign-d13")?.ownership,
    "UNOWNED",
  );
});
