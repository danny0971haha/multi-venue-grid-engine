import assert from "node:assert/strict";
import test from "node:test";

import { classifyOwnership } from "../../src/domain/ownership.js";
import { makeScopeKey } from "../../src/domain/ids.js";
import { decimalAdd } from "../../src/math/decimal.js";
import { DeterministicSimulator, type SimulatorSnapshot } from "../../src/simulator/engine.js";
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

function ownedWorkingRows(simulator: DeterministicSimulator) {
  return [...simulator.possibleExposure().ownedWorkingRiskIncreasing].sort((left, right) =>
    left.exchangeOrderId < right.exchangeOrderId
      ? -1
      : left.exchangeOrderId > right.exchangeOrderId
        ? 1
        : 0,
  );
}

function reservedQuantity(simulator: DeterministicSimulator) {
  return ownedWorkingRows(simulator).reduce((total, row) => decimalAdd(total, row.quantity), "0");
}

function isExecutionIdConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message === "EXECUTION_ID_CONFLICT") {
    return true;
  }
  return "code" in error && (error as { code: unknown }).code === "EXECUTION_ID_CONFLICT";
}

function tradingCollectionBytes(snapshot: SimulatorSnapshot) {
  return JSON.stringify({
    orders: snapshot.orders,
    levels: snapshot.levels,
    position: snapshot.position,
    executions: snapshot.executions,
    authorityLinks: snapshot.authorityLinks,
    orderSeq: snapshot.orderSeq,
    executionSeq: snapshot.executionSeq,
  });
}

function authorityLedgerBytes(snapshot: SimulatorSnapshot) {
  return JSON.stringify(snapshot.authorityLinks);
}

function seedOwnedB1(simulator: DeterministicSimulator) {
  const intent = plannedEntry(simulator, "B1");
  const primaryOrderId = ackPlace(simulator, intent.intentId);
  return { intent, primaryOrderId };
}

test("C4-1 two proven-owned working GRID_ENTRY orders on one level are two exposure rows", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const duplicateOrderId = simulator.injectOwnedDuplicate("B1", "99.4", "0.01");
  assert.notEqual(duplicateOrderId, primaryOrderId);
  assert.equal(simulator.classifyObserved(openIdentity(simulator, primaryOrderId)), "OWNED");
  assert.equal(simulator.classifyObserved(openIdentity(simulator, duplicateOrderId)), "OWNED");

  const rows = ownedWorkingRows(simulator);
  assert.equal(rows.length, 2);
  const ids = rows.map((row) => row.exchangeOrderId).sort();
  assert.deepEqual(ids, [primaryOrderId, duplicateOrderId].sort());
  assert.equal(
    rows.every((row) => row.logicalLevelId === "B1" && row.side === "BUY" && row.price === "99.4"),
    true,
  );
  assert.equal(
    rows.every((row) => row.quantity === "0.01"),
    true,
  );
  assert.equal(rows.filter((row) => row.exchangeOrderId === primaryOrderId).length, 1);
  assert.equal(rows.filter((row) => row.exchangeOrderId === duplicateOrderId).length, 1);
});

test("C4-2 reserved quantity includes both duplicate owned working orders", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const duplicateOrderId = simulator.injectOwnedDuplicate("B1", "99.4", "0.01");
  const rows = ownedWorkingRows(simulator);
  assert.equal(rows.length, 2);
  assert.equal(reservedQuantity(simulator), "0.02");
  assert.equal(
    rows.some((row) => row.exchangeOrderId === primaryOrderId && row.quantity === "0.01"),
    true,
  );
  assert.equal(
    rows.some((row) => row.exchangeOrderId === duplicateOrderId && row.quantity === "0.01"),
    true,
  );
  assert.notEqual(simulator.level("B1").remainingQuantity, "0.02");
});

test("C4-3 partially filled owned order reserves exact remainingQuantity", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const open = simulator.listOpenOrders().find((order) => order.exchangeOrderId === primaryOrderId);
  assert.ok(open);
  assert.equal(open.remainingQuantity, "0.006");
  assert.equal(open.originalQuantity, "0.01");
  const rows = ownedWorkingRows(simulator);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.exchangeOrderId, primaryOrderId);
  assert.equal(rows[0]?.quantity, "0.006");
  assert.notEqual(rows[0]?.quantity, open.originalQuantity);
  assert.notEqual(rows[0]?.quantity, simulator.level("B1").originalQuantity);
});

test("C4-4 CANCELLED, fully FILLED and disappeared orders are absent from owned working exposure", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const b1 = plannedEntry(simulator, "B1");
  const b2 = plannedEntry(simulator, "B2");
  const b3 = plannedEntry(simulator, "B3");
  const b4 = plannedEntry(simulator, "B4");
  const cancelledId = ackPlace(simulator, b1.intentId);
  const filledId = ackPlace(simulator, b2.intentId);
  const disappearedId = ackPlace(simulator, b3.intentId);
  const workingId = ackPlace(simulator, b4.intentId);

  const cancelled = simulator.requestCancel(cancelledId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  simulator.applyExecution({
    exchangeOrderId: filledId,
    quantity: "0.01",
    price: "98.8",
  });
  simulator.disappear(disappearedId);

  const rows = ownedWorkingRows(simulator);
  const ids = rows.map((row) => row.exchangeOrderId);
  assert.equal(ids.includes(cancelledId), false);
  assert.equal(ids.includes(filledId), false);
  assert.equal(ids.includes(disappearedId), false);
  assert.equal(ids.includes(workingId), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.quantity, "0.01");
});

test("C4-5 UNOWNED and AMBIGUOUS are omitted from owned exposure but AMBIGUOUS blocks risk", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  simulator.injectForeignOrder({
    exchangeOrderId: "foreign-unowned",
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
  simulator.injectAmbiguousOrder("ambiguous-current", "BUY", "99.4", "0.01");
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: "foreign-client",
      exchangeOrderId: "foreign-unowned",
      scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
      anchorEpoch: "foreign-epoch",
    }),
    "UNOWNED",
  );
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: null,
      exchangeOrderId: "ambiguous-current",
      scopeKey: null,
      anchorEpoch: null,
    }),
    "AMBIGUOUS",
  );
  assert.notEqual(
    simulator.classifyObserved({
      clientOrderId: null,
      exchangeOrderId: "ambiguous-current",
      scopeKey: null,
      anchorEpoch: null,
    }),
    "UNOWNED",
  );
  assert.equal(simulator.canIncreaseRisk(), false);
  const rows = ownedWorkingRows(simulator);
  const ids = rows.map((row) => row.exchangeOrderId);
  assert.deepEqual(ids, [primaryOrderId]);
  assert.equal(ids.includes("foreign-unowned"), false);
  assert.equal(ids.includes("ambiguous-current"), false);
  assert.equal(intent.clientOrderId !== null, true);
});

test("C4-6 export/import preserves every duplicate exposure row and exchangeOrderId", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const duplicateOrderId = simulator.injectOwnedDuplicate("B1", "99.4", "0.01");
  const before = ownedWorkingRows(simulator);
  assert.equal(before.length, 2);
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  const after = ownedWorkingRows(restored);
  assert.deepEqual(after, before);
  assert.deepEqual(
    after.map((row) => row.exchangeOrderId).sort(),
    [primaryOrderId, duplicateOrderId].sort(),
  );
  assert.equal(reservedQuantity(restored), "0.02");
});

test("C4-7 same execution ID + exact same canonical payload is idempotent", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const first = simulator.applyExecution({
    executionId: "overlap-canonical",
    exchangeOrderId: primaryOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  assert.ok(first);
  const beforeLevel = simulator.level("B1");
  const beforePosition = simulator.getPosition().quantity;
  const beforeExecutions = JSON.stringify(simulator.listExecutions());
  const beforeAuthority = authorityLedgerBytes(simulator.exportSnapshot());
  const replay = simulator.applyExecution({
    executionId: "overlap-canonical",
    exchangeOrderId: primaryOrderId,
    quantity: "0.0050",
    price: "99.40",
  });
  assert.ok(replay);
  assert.equal(replay.executionId, first.executionId);
  assert.equal(replay.exchangeOrderId, first.exchangeOrderId);
  assert.equal(replay.quantity, first.quantity);
  assert.equal(replay.price, first.price);
  assert.equal(simulator.level("B1").executedQuantity, beforeLevel.executedQuantity);
  assert.equal(simulator.level("B1").remainingQuantity, beforeLevel.remainingQuantity);
  assert.equal(simulator.getPosition().quantity, beforePosition);
  assert.equal(JSON.stringify(simulator.listExecutions()), beforeExecutions);
  assert.equal(simulator.listExecutions().length, 1);
  assert.equal(authorityLedgerBytes(simulator.exportSnapshot()), beforeAuthority);
  assert.equal(simulator.exportSnapshot().executionConflict, false);
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C4-8 same execution ID + different quantity produces EXECUTION_ID_CONFLICT", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "conflict-qty",
    exchangeOrderId: primaryOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-qty",
        exchangeOrderId: primaryOrderId,
        quantity: "0.006",
        price: "99.4",
      }),
    isExecutionIdConflict,
  );
  assert.equal(simulator.canIncreaseRisk(), false);
  assert.equal(simulator.exportSnapshot().executionConflict, true);
});

test("C4-9 same execution ID + different price produces EXECUTION_ID_CONFLICT", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "conflict-px",
    exchangeOrderId: primaryOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-px",
        exchangeOrderId: primaryOrderId,
        quantity: "0.005",
        price: "99.5",
      }),
    isExecutionIdConflict,
  );
  assert.equal(simulator.canIncreaseRisk(), false);
  assert.equal(simulator.exportSnapshot().executionConflict, true);
});

test("C4-10 same execution ID + different exchangeOrderId produces EXECUTION_ID_CONFLICT", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const b2 = plannedEntry(simulator, "B2");
  const otherOrderId = ackPlace(simulator, b2.intentId);
  simulator.applyExecution({
    executionId: "conflict-order",
    exchangeOrderId: primaryOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-order",
        exchangeOrderId: otherOrderId,
        quantity: "0.005",
        price: "99.4",
      }),
    isExecutionIdConflict,
  );
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-order",
        exchangeOrderId: "missing-order",
        quantity: "0.005",
        price: "99.4",
      }),
    isExecutionIdConflict,
  );
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C4-11 conflict mutates only the explicit reconciliation blocker", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "conflict-bytes",
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const before = simulator.exportSnapshot();
  const beforeBytes = tradingCollectionBytes(before);
  assert.equal(before.executionConflict, false);
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-bytes",
        exchangeOrderId: primaryOrderId,
        quantity: "0.007",
        price: "99.4",
      }),
    isExecutionIdConflict,
  );
  const after = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(after), beforeBytes);
  assert.equal(after.executionConflict, true);
  assert.equal(after.executionGap, before.executionGap);
  assert.equal(after.riskIncreaseBlocked, before.riskIncreaseBlocked);
  assert.equal(simulator.canIncreaseRisk(), false);
  assert.equal(simulator.level("B1").executedQuantity, "0.004");
  assert.equal(simulator.level("B1").remainingQuantity, "0.006");
  assert.equal(simulator.getPosition().quantity, "0.004");
  assert.equal(simulator.listExecutions().length, 1);
  assert.equal(simulator.listExecutions()[0]?.quantity, "0.004");
});

test("C4-12 export/import preserves execution conflict as a risk blocker", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "conflict-restart",
    exchangeOrderId: primaryOrderId,
    quantity: "0.003",
    price: "99.4",
  });
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-restart",
        exchangeOrderId: primaryOrderId,
        quantity: "0.008",
        price: "99.4",
      }),
    isExecutionIdConflict,
  );
  const exported = simulator.exportSnapshot();
  assert.equal(exported.executionConflict, true);
  exported.riskIncreaseBlocked = false;
  const restored = DeterministicSimulator.fromSnapshot(exported);
  assert.equal(restored.canIncreaseRisk(), false);
  assert.equal(restored.exportSnapshot().executionConflict, true);
  const intentsBefore = restored.exportSnapshot().intents.length;
  const ordersBefore = restored.exportSnapshot().orders.length;
  const planned = restored.planEntries();
  assert.equal(planned.status, "PLANNED");
  assert.equal(restored.exportSnapshot().intents.length, intentsBefore);
  assert.equal(restored.exportSnapshot().orders.length, ordersBefore);
  assert.equal(restored.level("B2").state, "IDLE");
  assert.equal(restored.level("B2").workingExchangeOrderId, null);
});

test("C4-13 reduce-only GRID_EXIT is excluded from owned working risk-increasing exposure", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  const entryId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId: entryId,
    quantity: "0.01",
    price: "97.0",
  });
  const exitIntentId = simulator.level("B5").exitIntentId;
  assert.ok(exitIntentId);
  const exitId = ackPlace(simulator, exitIntentId);
  const exit = simulator.listOpenOrders().find((order) => order.exchangeOrderId === exitId);
  assert.ok(exit);
  assert.equal(exit.reduceOnly, true);
  assert.equal(simulator.classifyObserved(openIdentity(simulator, exitId)), "OWNED");
  const rows = ownedWorkingRows(simulator);
  assert.equal(
    rows.some((row) => row.exchangeOrderId === exitId),
    false,
  );
});

test("C4-authority-ledger is not modified or weakened by corrective 4", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  assert.ok(intent.clientOrderId);
  const beforeExposure = authorityLedgerBytes(simulator.exportSnapshot());
  ownedWorkingRows(simulator);
  assert.equal(authorityLedgerBytes(simulator.exportSnapshot()), beforeExposure);

  simulator.injectForeignOrder({
    exchangeOrderId: "forged-real-client-c4",
    clientOrderId: intent.clientOrderId,
    logicalLevelId: "B1",
    purpose: "GRID_ENTRY",
    side: "BUY",
    type: "LIMIT",
    price: "99.4",
    originalQuantity: "0.01",
    executedQuantity: "0",
    remainingQuantity: "0.01",
    status: "WORKING",
    reduceOnly: false,
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  });
  assert.equal(
    classifyOwnership(
      {
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: "forged-real-client-c4",
        scopeKey: CURRENT_SCOPE,
        anchorEpoch: "epoch-1",
      },
      {
        currentScopeKey: CURRENT_SCOPE,
        currentAnchorEpoch: "epoch-1",
        knownClientOrderIds: new Set([intent.clientOrderId]),
        knownExchangeOrderIds: new Set(["forged-real-client-c4"]),
        clientOrderEpochById: new Map([[intent.clientOrderId, "epoch-1"]]),
      },
    ),
    "AMBIGUOUS",
  );
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: "forged-real-client-c4",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "AMBIGUOUS",
  );
  assert.notEqual(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: "forged-real-client-c4",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  const refused = simulator.requestCancel("forged-real-client-c4", "ACK");
  assert.equal(refused.kind, "NOT_SENT");
  if (refused.kind === "NOT_SENT") {
    assert.equal(refused.reason, "REFUSES_UNPROVEN_CANCEL_AUTHORITY");
  }
  const byLevel = simulator.planDuplicateCleanup("B1");
  assert.equal(byLevel.cancelExchangeOrderIds.includes("forged-real-client-c4"), false);
  assert.equal(byLevel.survivorExchangeOrderId, primaryOrderId);

  simulator.applyExecution({
    executionId: "ledger-keep",
    exchangeOrderId: primaryOrderId,
    quantity: "0.002",
    price: "99.4",
  });
  const beforeConflict = authorityLedgerBytes(simulator.exportSnapshot());
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "ledger-keep",
        exchangeOrderId: primaryOrderId,
        quantity: "0.009",
        price: "99.4",
      }),
    isExecutionIdConflict,
  );
  assert.equal(authorityLedgerBytes(simulator.exportSnapshot()), beforeConflict);
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: primaryOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  const snapshot = simulator.exportSnapshot();
  assert.equal(snapshot.authorityLinks.length, 1);
  assert.equal(snapshot.authorityLinks[0]?.exchangeOrderId, primaryOrderId);
  assert.equal(snapshot.authorityLinks[0]?.source, "ACK");
});

function openIdentity(simulator: DeterministicSimulator, exchangeOrderId: string) {
  const order = simulator.listOpenOrders().find((item) => item.exchangeOrderId === exchangeOrderId);
  assert.ok(order);
  return {
    clientOrderId: order.clientOrderId,
    exchangeOrderId: order.exchangeOrderId,
    scopeKey: CURRENT_SCOPE,
    anchorEpoch: "epoch-1" as const,
  };
}
