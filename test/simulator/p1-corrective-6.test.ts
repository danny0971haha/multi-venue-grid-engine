import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeScopeKey } from "../../src/domain/ids.js";
import { classifyOwnership } from "../../src/domain/ownership.js";
import {
  DeterministicSimulator,
  type SimulatorSnapshot,
  SnapshotImportError,
} from "../../src/simulator/engine.js";
import { testInit } from "./helpers.js";

const CURRENT_SCOPE = makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1");
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

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

function seedOwnedB1(simulator: DeterministicSimulator) {
  const intent = plannedEntry(simulator, "B1");
  const primaryOrderId = ackPlace(simulator, intent.intentId);
  return { intent, primaryOrderId };
}

function isErrorCode(code: string) {
  return (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }
    if (error.message === code) {
      return true;
    }
    return "code" in error && (error as { code: unknown }).code === code;
  };
}

function isSnapshotCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SnapshotImportError);
    assert.equal(error.code, code);
    return true;
  };
}

function tradingCollectionBytes(snapshot: SimulatorSnapshot) {
  return JSON.stringify({
    orders: snapshot.orders,
    levels: snapshot.levels,
    position: snapshot.position,
    executions: snapshot.executions,
    authorityLinks: snapshot.authorityLinks,
    intents: snapshot.intents,
    unknownWrites: snapshot.unknownWrites,
    orderSeq: snapshot.orderSeq,
    executionSeq: snapshot.executionSeq,
  });
}

function authorityLedgerBytes(snapshot: SimulatorSnapshot) {
  return JSON.stringify(snapshot.authorityLinks);
}

function ownedWorkingRows(simulator: DeterministicSimulator) {
  return [...simulator.possibleExposure().ownedWorkingRiskIncreasing].sort((left, right) =>
    left.exchangeOrderId < right.exchangeOrderId
      ? -1
      : left.exchangeOrderId > right.exchangeOrderId
        ? 1
        : 0,
  );
}

function injectUnownedB1Exit(simulator: DeterministicSimulator, quantity: string) {
  simulator.injectForeignOrder({
    exchangeOrderId: "unowned-b1-exit",
    clientOrderId: "foreign-exit",
    logicalLevelId: "B1",
    purpose: "GRID_EXIT",
    side: "SELL",
    type: "LIMIT",
    price: "100",
    originalQuantity: quantity,
    executedQuantity: "0",
    remainingQuantity: quantity,
    status: "WORKING",
    reduceOnly: true,
    anchorEpoch: "foreign-epoch",
    scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
  });
}

function withAmbiguousB1(simulator: DeterministicSimulator) {
  simulator.injectAmbiguousOrder("ambiguous-b1", "BUY", "99.4", "0.01");
  const snapshot = simulator.exportSnapshot();
  const ambiguous = snapshot.orders.find((order) => order.exchangeOrderId === "ambiguous-b1");
  assert.ok(ambiguous);
  ambiguous.logicalLevelId = "B1";
  return DeterministicSimulator.fromSnapshot(snapshot);
}

function assertRejectedWithoutTradingMutation(
  simulator: DeterministicSimulator,
  act: () => void,
  code: string,
) {
  const before = simulator.exportSnapshot();
  const beforeBytes = tradingCollectionBytes(before);
  const beforeAuthority = authorityLedgerBytes(before);
  assert.throws(act, isErrorCode(code));
  const after = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(after), beforeBytes);
  assert.equal(authorityLedgerBytes(after), beforeAuthority);
  return { before, after };
}

test("C6-1 proven-owned ACK-linked execution still performs the normal level/position/intent transition", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: primaryOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  const execution = simulator.applyExecution({
    executionId: "c6-1-fill",
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  assert.ok(execution);
  assert.equal(execution.executionId, "c6-1-fill");
  assert.equal(simulator.level("B1").state, "POSITION_OPEN");
  assert.equal(simulator.level("B1").openInventory, "0.01");
  assert.equal(simulator.level("B1").exitIntentTerminal, false);
  assert.ok(simulator.level("B1").exitIntentId);
  assert.equal(simulator.getPosition().quantity, "0.01");
  assert.equal(simulator.exportSnapshot().executionIntegrityFault, null);
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C6-2 UNOWNED GRID_EXIT with logicalLevelId=B1 cannot mutate project-owned state", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const beforeLevel = simulator.level("B1");
  assert.equal(beforeLevel.state, "POSITION_OPEN");
  assert.equal(beforeLevel.openInventory, "0.01");
  assert.equal(beforeLevel.exitIntentTerminal, false);
  const projectExitIntentId = beforeLevel.exitIntentId;
  assert.ok(projectExitIntentId);
  injectUnownedB1Exit(simulator, "0.001");
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: "foreign-exit",
      exchangeOrderId: "unowned-b1-exit",
      scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
      anchorEpoch: "foreign-epoch",
    }),
    "UNOWNED",
  );
  const { after } = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "c6-2-unowned",
        exchangeOrderId: "unowned-b1-exit",
        quantity: "0.001",
        price: "100",
      }),
    "EXECUTION_AUTHORITY_UNPROVEN",
  );
  assert.equal(simulator.level("B1").openInventory, "0.01");
  assert.equal(simulator.level("B1").state, "POSITION_OPEN");
  assert.equal(simulator.level("B1").exitIntentTerminal, false);
  assert.equal(simulator.level("B1").exitIntentId, projectExitIntentId);
  assert.equal(simulator.level("B1").workingExchangeOrderId, null);
  assert.equal(
    after.intents.some(
      (intent) => intent.intentId !== projectExitIntentId && intent.purpose === "GRID_EXIT",
    ),
    false,
  );
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_AUTHORITY_UNPROVEN");
  assert.equal(after.executionIntegrityFault?.executionId, "c6-2-unowned");
  assert.equal(after.executionIntegrityFault?.exchangeOrderId, "unowned-b1-exit");
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C6-3 AMBIGUOUS order with a current logicalLevelId cannot mutate project-owned level or intent state", () => {
  const seeded = DeterministicSimulator.create(testInit());
  seedOwnedB1(seeded);
  const simulator = withAmbiguousB1(seeded);
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: null,
      exchangeOrderId: "ambiguous-b1",
      scopeKey: null,
      anchorEpoch: null,
    }),
    "AMBIGUOUS",
  );
  const { after } = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "c6-3-ambiguous",
        exchangeOrderId: "ambiguous-b1",
        quantity: "0.001",
        price: "99.4",
      }),
    "EXECUTION_AUTHORITY_UNPROVEN",
  );
  assert.equal(simulator.level("B1").state, "ENTRY_WORKING");
  assert.equal(simulator.level("B1").openInventory, "0");
  assert.equal(simulator.level("B1").executedQuantity, "0");
  assert.equal(simulator.level("B1").entryIntentTerminal, false);
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_AUTHORITY_UNPROVEN");
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C6-4 UNKNOWN exchangeOrderId preserves trading collections and records a durable blocker", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  assert.equal(simulator.canIncreaseRisk(), true);
  const { after } = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "c6-4-unknown",
        exchangeOrderId: "missing-exchange-order",
        quantity: "0.001",
        price: "99.4",
      }),
    "EXECUTION_ORDER_MISSING",
  );
  assert.equal(after.orders[0]?.exchangeOrderId, primaryOrderId);
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_ORDER_MISSING");
  assert.equal(after.executionIntegrityFault?.executionId, "c6-4-unknown");
  assert.equal(after.executionIntegrityFault?.exchangeOrderId, "missing-exchange-order");
  assert.equal(after.executionConflict, false);
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C6-5 NEGATIVE_OPEN_INVENTORY preserves trading collections and records a first-wins fault", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  injectUnownedB1Exit(simulator, "0.02");
  const { after } = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "c6-5-inventory",
        exchangeOrderId: "unowned-b1-exit",
        quantity: "0.02",
        price: "100",
      }),
    "NEGATIVE_OPEN_INVENTORY",
  );
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_INVENTORY_CONFLICT");
  assert.equal(after.executionIntegrityFault?.executionId, "c6-5-inventory");
  assert.equal(after.executionIntegrityFault?.exchangeOrderId, "unowned-b1-exit");
  assert.equal(simulator.level("B1").openInventory, "0.01");
  assert.equal(simulator.getPosition().quantity, "0.01");
  assert.equal(simulator.canIncreaseRisk(), false);

  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "c6-5-second",
        exchangeOrderId: "missing-later",
        quantity: "0.001",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_ORDER_MISSING"),
  );
  assert.equal(
    simulator.exportSnapshot().executionIntegrityFault?.code,
    "EXECUTION_INVENTORY_CONFLICT",
  );
});

test("C6-6 C6-4/C6-5 blockers survive export/import even if riskIncreaseBlocked=false", () => {
  const unknownSim = DeterministicSimulator.create(testInit());
  seedOwnedB1(unknownSim);
  assert.throws(
    () =>
      unknownSim.applyExecution({
        executionId: "c6-6-unknown",
        exchangeOrderId: "missing-exchange-order",
        quantity: "0.001",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_ORDER_MISSING"),
  );
  const unknownExported = unknownSim.exportSnapshot();
  unknownExported.riskIncreaseBlocked = false;
  const unknownRestored = DeterministicSimulator.fromSnapshot(unknownExported);
  assert.equal(unknownRestored.canIncreaseRisk(), false);
  assert.equal(
    unknownRestored.exportSnapshot().executionIntegrityFault?.code,
    "EXECUTION_ORDER_MISSING",
  );

  const inventorySim = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(inventorySim);
  inventorySim.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  injectUnownedB1Exit(inventorySim, "0.02");
  assert.throws(
    () =>
      inventorySim.applyExecution({
        executionId: "c6-6-inventory",
        exchangeOrderId: "unowned-b1-exit",
        quantity: "0.02",
        price: "100",
      }),
    isErrorCode("NEGATIVE_OPEN_INVENTORY"),
  );
  const inventoryExported = inventorySim.exportSnapshot();
  inventoryExported.riskIncreaseBlocked = false;
  const inventoryRestored = DeterministicSimulator.fromSnapshot(inventoryExported);
  assert.equal(inventoryRestored.canIncreaseRisk(), false);
  assert.equal(
    inventoryRestored.exportSnapshot().executionIntegrityFault?.code,
    "EXECUTION_INVENTORY_CONFLICT",
  );
  const reexported = inventoryRestored.exportSnapshot();
  assert.deepEqual(
    DeterministicSimulator.fromSnapshot(reexported).exportSnapshot().executionIntegrityFault,
    reexported.executionIntegrityFault,
  );
});

test('C6-7 an imported execution with quantity="0" is rejected', () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "keep-qty",
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const snapshot = simulator.exportSnapshot();
  const execution = snapshot.executions[0];
  assert.ok(execution);
  execution.quantity = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(snapshot),
    isSnapshotCode("NON_POSITIVE_EXECUTION_QUANTITY"),
  );
});

test('C6-8 an imported execution with price="0" is rejected', () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "keep-px",
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const snapshot = simulator.exportSnapshot();
  const execution = snapshot.executions[0];
  assert.ok(execution);
  execution.price = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(snapshot),
    isSnapshotCode("NON_POSITIVE_EXECUTION_PRICE"),
  );
});

test('C6-9 an imported intent with quantity="0" is rejected', () => {
  const simulator = DeterministicSimulator.create(testInit());
  seedOwnedB1(simulator);
  const snapshot = simulator.exportSnapshot();
  const intent = snapshot.intents.find((item) => item.logicalLevelId === "B1");
  assert.ok(intent);
  intent.quantity = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(snapshot),
    isSnapshotCode("NON_POSITIVE_INTENT_QUANTITY"),
  );

  const priceSnapshot = DeterministicSimulator.create(testInit());
  seedOwnedB1(priceSnapshot);
  const priced = priceSnapshot.exportSnapshot();
  const pricedIntent = priced.intents.find((item) => item.logicalLevelId === "B1");
  assert.ok(pricedIntent);
  pricedIntent.price = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(priced),
    isSnapshotCode("NON_POSITIVE_LIMIT_PRICE"),
  );
});

test('C6-10 an imported order with originalQuantity="0" is rejected', () => {
  const simulator = DeterministicSimulator.create(testInit());
  seedOwnedB1(simulator);
  const snapshot = simulator.exportSnapshot();
  const order = snapshot.orders[0];
  assert.ok(order);
  order.originalQuantity = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(snapshot),
    isSnapshotCode("NON_POSITIVE_ORIGINAL_QUANTITY"),
  );

  const priced = DeterministicSimulator.create(testInit());
  seedOwnedB1(priced);
  const pricedSnapshot = priced.exportSnapshot();
  const pricedOrder = pricedSnapshot.orders[0];
  assert.ok(pricedOrder);
  pricedOrder.price = "0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(pricedSnapshot),
    isSnapshotCode("NON_POSITIVE_LIMIT_PRICE"),
  );
});

test("C6-11 valid terminal orders may still have executedQuantity or remainingQuantity equal to zero", () => {
  const filled = DeterministicSimulator.create(testInit());
  const filledOrderId = ackPlace(filled, plannedEntry(filled, "B1").intentId);
  filled.applyExecution({
    exchangeOrderId: filledOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const filledOrder = filled
    .exportSnapshot()
    .orders.find((order) => order.exchangeOrderId === filledOrderId);
  assert.ok(filledOrder);
  assert.equal(filledOrder.remainingQuantity, "0");
  assert.equal(filledOrder.executedQuantity, "0.01");
  const restoredFilled = DeterministicSimulator.fromSnapshot(filled.exportSnapshot());
  assert.equal(
    restoredFilled.exportSnapshot().orders.find((order) => order.exchangeOrderId === filledOrderId)
      ?.remainingQuantity,
    "0",
  );

  const cancelled = DeterministicSimulator.create(testInit());
  const cancelledOrderId = ackPlace(cancelled, plannedEntry(cancelled, "B1").intentId);
  assert.equal(cancelled.requestCancel(cancelledOrderId, "ACK").kind, "ACK");
  const cancelledOrder = cancelled
    .exportSnapshot()
    .orders.find((order) => order.exchangeOrderId === cancelledOrderId);
  assert.ok(cancelledOrder);
  assert.equal(cancelledOrder.executedQuantity, "0");
  assert.equal(cancelledOrder.remainingQuantity, "0");
  const restoredCancelled = DeterministicSimulator.fromSnapshot(cancelled.exportSnapshot());
  const restoredCancelledOrder = restoredCancelled
    .exportSnapshot()
    .orders.find((order) => order.exchangeOrderId === cancelledOrderId);
  assert.ok(restoredCancelledOrder);
  assert.equal(restoredCancelledOrder.executedQuantity, "0");
  assert.equal(restoredCancelledOrder.remainingQuantity, "0");
  assert.equal(restoredCancelled.level("B1").state, "IDLE");
});

test("C6-12 orderSeq/executionSeq greater than Number.MAX_SAFE_INTEGER are rejected", () => {
  const simulator = DeterministicSimulator.create(testInit());
  seedOwnedB1(simulator);
  const orderSnapshot = simulator.exportSnapshot();
  orderSnapshot.orderSeq = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(orderSnapshot),
    isSnapshotCode("ORDER_SEQ_UNSAFE"),
  );

  const executionSnapshot = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(executionSnapshot);
  executionSnapshot.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  const exported = executionSnapshot.exportSnapshot();
  exported.executionSeq = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(exported),
    isSnapshotCode("EXECUTION_SEQ_UNSAFE"),
  );

  const huge = simulator.exportSnapshot();
  huge.orderSeq = 1e20;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(huge),
    isSnapshotCode("ORDER_SEQ_UNSAFE"),
  );
});

test("C6-13 sequences that cannot be incremented safely are rejected or exhaust before mutation", () => {
  const simulator = DeterministicSimulator.create(testInit());
  seedOwnedB1(simulator);
  const maxOrder = simulator.exportSnapshot();
  maxOrder.orderSeq = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(maxOrder),
    isSnapshotCode("ORDER_SEQ_UNSAFE"),
  );

  const maxExecution = simulator.exportSnapshot();
  maxExecution.executionSeq = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(maxExecution),
    isSnapshotCode("EXECUTION_SEQ_UNSAFE"),
  );

  const orderRuntime = DeterministicSimulator.create(testInit());
  seedOwnedB1(orderRuntime);
  const nearMaxOrder = orderRuntime.exportSnapshot();
  nearMaxOrder.orderSeq = Number.MAX_SAFE_INTEGER - 1;
  const orderNear = DeterministicSimulator.fromSnapshot(nearMaxOrder);
  const b2 = plannedEntry(orderNear, "B2");
  const b2OrderId = ackPlace(orderNear, b2.intentId);
  assert.equal(orderNear.exportSnapshot().orderSeq, Number.MAX_SAFE_INTEGER);
  assert.ok(b2OrderId.startsWith("sim-ord-"));
  const b3 = plannedEntry(orderNear, "B3");
  const { after } = assertRejectedWithoutTradingMutation(
    orderNear,
    () => orderNear.submit(b3.intentId, "ACK"),
    "ORDER_SEQ_EXHAUSTED",
  );
  assert.equal(after.orderSeq, Number.MAX_SAFE_INTEGER);
  assert.equal(orderNear.level("B3").state, "IDLE");
  assert.equal(after.executionIntegrityFault?.code, "ORDER_SEQ_EXHAUSTED");
  assert.equal(orderNear.canIncreaseRisk(), false);

  const executionRuntime = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(executionRuntime);
  const nearMaxExecution = executionRuntime.exportSnapshot();
  nearMaxExecution.executionSeq = Number.MAX_SAFE_INTEGER - 1;
  const executionNear = DeterministicSimulator.fromSnapshot(nearMaxExecution);
  const first = executionNear.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  assert.ok(first);
  assert.equal(executionNear.exportSnapshot().executionSeq, Number.MAX_SAFE_INTEGER);
  assertRejectedWithoutTradingMutation(
    executionNear,
    () =>
      executionNear.applyExecution({
        exchangeOrderId: primaryOrderId,
        quantity: "0.001",
        price: "99.4",
      }),
    "EXECUTION_SEQ_EXHAUSTED",
  );
  assert.equal(executionNear.exportSnapshot().executionSeq, Number.MAX_SAFE_INTEGER);
  assert.equal(
    executionNear.exportSnapshot().executionIntegrityFault?.code,
    "EXECUTION_SEQ_EXHAUSTED",
  );
  assert.equal(executionNear.canIncreaseRisk(), false);
});

test("C6-14 generated order and execution IDs remain deterministic and collision-safe", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const b1 = plannedEntry(simulator, "B1");
  const b2 = plannedEntry(simulator, "B2");
  const firstOrder = ackPlace(simulator, b1.intentId);
  const secondOrder = ackPlace(simulator, b2.intentId);
  assert.equal(firstOrder, "sim-ord-0001");
  assert.equal(secondOrder, "sim-ord-0002");
  const firstExecution = simulator.applyExecution({
    exchangeOrderId: firstOrder,
    quantity: "0.001",
    price: "99.4",
  });
  const secondExecution = simulator.applyExecution({
    exchangeOrderId: firstOrder,
    quantity: "0.001",
    price: "99.4",
  });
  assert.ok(firstExecution);
  assert.ok(secondExecution);
  assert.equal(firstExecution.executionId, "sim-exec-0001");
  assert.equal(secondExecution.executionId, "sim-exec-0002");
  assert.notEqual(firstExecution.executionId, secondExecution.executionId);
  assert.equal(
    simulator.exportSnapshot().orders.filter((order) => order.exchangeOrderId === firstOrder)
      .length,
    1,
  );
  assert.equal(simulator.listExecutions().length, 2);
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C6-15 Corrective 4 replay/exposure/authority and Corrective 5 transactional semantics remain unchanged", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  const duplicateOrderId = simulator.injectOwnedDuplicate("B1", "99.4", "0.01");
  const rows = ownedWorkingRows(simulator);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.exchangeOrderId).sort(),
    [primaryOrderId, duplicateOrderId].sort(),
  );
  const first = simulator.applyExecution({
    executionId: "c6-15-keep",
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  assert.ok(first);
  const beforeReplay = simulator.exportSnapshot();
  const replay = simulator.applyExecution({
    executionId: "c6-15-keep",
    exchangeOrderId: primaryOrderId,
    quantity: "0.0040",
    price: "99.40",
  });
  assert.ok(replay);
  assert.equal(replay.executionId, "c6-15-keep");
  assert.equal(
    tradingCollectionBytes(simulator.exportSnapshot()),
    tradingCollectionBytes(beforeReplay),
  );
  assert.equal(simulator.exportSnapshot().executionConflict, false);
  assert.equal(simulator.canIncreaseRisk(), true);

  const beforeConflict = simulator.exportSnapshot();
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "c6-15-keep",
        exchangeOrderId: primaryOrderId,
        quantity: "0.009",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_ID_CONFLICT"),
  );
  const afterConflict = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(afterConflict), tradingCollectionBytes(beforeConflict));
  assert.equal(afterConflict.executionConflict, true);
  assert.equal(afterConflict.executionIntegrityFault, null);
  assert.equal(afterConflict.executions[0]?.quantity, "0.004");
  assert.equal(simulator.canIncreaseRisk(), false);

  const overfill = DeterministicSimulator.create(testInit());
  const overfillOrderId = ackPlace(overfill, plannedEntry(overfill, "B1").intentId);
  overfill.applyExecution({
    executionId: "c6-15-partial",
    exchangeOrderId: overfillOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  assertRejectedWithoutTradingMutation(
    overfill,
    () =>
      overfill.applyExecution({
        executionId: "c6-15-overfill",
        exchangeOrderId: overfillOrderId,
        quantity: "0.007",
        price: "99.4",
      }),
    "EXECUTION_OVERFILL",
  );
  assert.equal(overfill.exportSnapshot().executionIntegrityFault?.code, "EXECUTION_OVERFILL");
  assert.equal(overfill.level("B1").executedQuantity, "0.004");

  assert.ok(intent.clientOrderId);
  assert.equal(authorityLedgerBytes(simulator.exportSnapshot()).includes(primaryOrderId), true);
  assert.equal(
    classifyOwnership(
      {
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: "forged-c6-15",
        scopeKey: CURRENT_SCOPE,
        anchorEpoch: "epoch-1",
      },
      {
        currentScopeKey: CURRENT_SCOPE,
        currentAnchorEpoch: "epoch-1",
        knownClientOrderIds: new Set([intent.clientOrderId]),
        knownExchangeOrderIds: new Set(["forged-c6-15"]),
        clientOrderEpochById: new Map([[intent.clientOrderId, "epoch-1"]]),
      },
    ),
    "AMBIGUOUS",
  );
});

test("C6-16 all previous P1, C1-C13, D1-D13, C3, C4, and C5 cases remain present and green", () => {
  const files = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => readFileSync(join(TEST_DIR, name), "utf8"));
  const strategy = readFileSync(join(TEST_DIR, "../strategy/geometry.test.ts"), "utf8");
  const domain = readFileSync(join(TEST_DIR, "../domain/ids-config.test.ts"), "utf8");
  const corpus = `${files.join("\n")}\n${strategy}\n${domain}`;
  const required = [
    "P1-G01",
    "P1-G02",
    "P1-G03",
    "P1-G04",
    "P1-G05",
    "P1-S01",
    "P1-S02",
    "P1-S03",
    "P1-S04",
    "P1-S05",
    "P1-S06",
    "P1-S07",
    "P1-S08",
    "P1-S09",
    "P1-S10",
    "P1-I01",
    "P1-I02",
    "P1-I03",
    "P1-I04",
    "P1-I05",
    "P1-I06",
    "P1-I07",
    "P1-R01",
    "P1-R02",
    "P1-R03",
    "P1-R04",
    "P1-R05",
    "C1 partial BUY entry",
    "C2 partial SELL entry",
    "C3 multiple partial entry executions",
    "C4 partial exit execution",
    "C5 next exit after C4",
    "C6 UNKNOWN/retry",
    "C7 completed entry/exit cycle",
    "C8 restart/export-import preserves mutation sequence",
    "C9 matching scope/epoch",
    "C10 AMBIGUOUS order blocks risk",
    "C11 authoritative decimal export",
    "C12 export -> import -> export",
    "C13 malformed/non-canonical snapshot decimal",
    "D1 snapshot order forged",
    "D2 forged imported ownership",
    "D3 legitimate ACK-linked",
    "D4 intent experiment/run/scope/anchor mismatch",
    "D5 deterministic intentId/clientOrderId mismatch",
    "D6 order-to-intent",
    "D7 order remaining",
    "D8 execution totals",
    "D9 openInventory or signed position",
    "D10 serialized riskIncreaseBlocked=false",
    "D11 foreign scope/epoch",
    "D12 export -> import -> export remains deterministic",
    "D13 all C1-C13",
    "C3-1",
    "C3-2",
    "C3-3",
    "C3-4",
    "C3-5",
    "C3-6",
    "C3-7",
    "C3-8",
    "C3-9",
    "C3-10",
    "C4-1",
    "C4-2",
    "C4-3",
    "C4-4",
    "C4-5",
    "C4-6",
    "C4-7",
    "C4-8",
    "C4-9",
    "C4-10",
    "C4-11",
    "C4-12",
    "C4-13",
    "C4-authority-ledger",
    "C5-1",
    "C5-2",
    "C5-3",
    "C5-4",
    "C5-5",
    "C5-6",
    "C5-7",
    "C5-8",
    "C5-9",
    "C5-10",
    "C5-11",
    "C5-12",
    "C5-13",
    "C5-14",
    "C5-15",
    "C5-16",
    "C5-17",
    "C5-18",
  ];
  for (const id of required) {
    assert.equal(corpus.includes(id), true, `missing required case ${id}`);
  }

  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  assert.equal(simulator.level("B1").state, "ENTRY_WORKING");
  simulator.applyExecution({
    executionId: "c6-16-fill",
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  assert.equal(simulator.level("B1").state, "POSITION_OPEN");
  assert.ok(simulator.level("B1").exitIntentId);
  assert.equal(simulator.getPosition().quantity, "0.01");
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  assert.equal(restored.level("B1").state, "POSITION_OPEN");
  assert.equal(restored.level("B1").openInventory, "0.01");
  assert.equal(restored.canIncreaseRisk(), true);
  assert.ok(intent.clientOrderId);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: primaryOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
});
