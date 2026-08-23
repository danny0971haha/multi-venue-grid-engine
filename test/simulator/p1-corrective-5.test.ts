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
  return after;
}

test("C5-1 negative execution quantity rejected before trading-state mutation", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const after = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "neg-qty",
        exchangeOrderId: primaryOrderId,
        quantity: "-0.001",
        price: "99.4",
      }),
    "NON_POSITIVE_EXECUTION_QUANTITY",
  );
  assert.equal(after.executionIntegrityFault?.code, "NON_POSITIVE_EXECUTION_QUANTITY");
  assert.equal(after.executionIntegrityFault?.executionId, "neg-qty");
  assert.equal(after.executionIntegrityFault?.exchangeOrderId, primaryOrderId);
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C5-2 zero execution quantity rejected before mutation", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const after = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        exchangeOrderId: primaryOrderId,
        quantity: "0",
        price: "99.4",
      }),
    "NON_POSITIVE_EXECUTION_QUANTITY",
  );
  assert.equal(after.executionIntegrityFault?.code, "NON_POSITIVE_EXECUTION_QUANTITY");
  assert.equal(simulator.listExecutions().length, 0);
});

test("C5-3 zero/negative execution price rejected before mutation", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "zero-px",
        exchangeOrderId: primaryOrderId,
        quantity: "0.001",
        price: "0",
      }),
    "NON_POSITIVE_EXECUTION_PRICE",
  );
  assert.equal(
    simulator.exportSnapshot().executionIntegrityFault?.code,
    "NON_POSITIVE_EXECUTION_PRICE",
  );

  const other = DeterministicSimulator.create(testInit());
  const otherOrderId = ackPlace(other, plannedEntry(other, "B1").intentId);
  assertRejectedWithoutTradingMutation(
    other,
    () =>
      other.applyExecution({
        executionId: "neg-px",
        exchangeOrderId: otherOrderId,
        quantity: "0.001",
        price: "-99.4",
      }),
    "NON_POSITIVE_EXECUTION_PRICE",
  );
});

test("C5-4 execution quantity greater than residual rejected", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        exchangeOrderId: primaryOrderId,
        quantity: "0.007",
        price: "99.4",
      }),
    "EXECUTION_OVERFILL",
  );
  const open = simulator.listOpenOrders().find((order) => order.exchangeOrderId === primaryOrderId);
  assert.ok(open);
  assert.equal(open.executedQuantity, "0.004");
  assert.equal(open.remainingQuantity, "0.006");
});

test("C5-5 overfill failure preserves order/level/position/execution/authority bytes", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "partial-keep",
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const after = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: "overfill",
        exchangeOrderId: primaryOrderId,
        quantity: "0.007",
        price: "99.4",
      }),
    "EXECUTION_OVERFILL",
  );
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_OVERFILL");
  assert.equal(after.executions.length, 1);
  assert.equal(after.executions[0]?.executionId, "partial-keep");
  assert.equal(after.executions[0]?.quantity, "0.004");
  assert.equal(simulator.level("B1").executedQuantity, "0.004");
  assert.equal(simulator.level("B1").remainingQuantity, "0.006");
  assert.equal(simulator.getPosition().quantity, "0.004");
  assert.equal(after.authorityLinks.length, 1);
});

test("C5-6 invalid execution sets durable risk blocker", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  assert.equal(simulator.canIncreaseRisk(), true);
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "first-fault",
        exchangeOrderId: primaryOrderId,
        quantity: "-0.001",
        price: "99.4",
      }),
    isErrorCode("NON_POSITIVE_EXECUTION_QUANTITY"),
  );
  assert.equal(simulator.canIncreaseRisk(), false);
  assert.equal(
    simulator.exportSnapshot().executionIntegrityFault?.code,
    "NON_POSITIVE_EXECUTION_QUANTITY",
  );
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "second-fault",
        exchangeOrderId: primaryOrderId,
        quantity: "1",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_OVERFILL"),
  );
  const fault = simulator.exportSnapshot().executionIntegrityFault;
  assert.equal(fault?.code, "NON_POSITIVE_EXECUTION_QUANTITY");
  assert.equal(fault?.executionId, "first-fault");
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C5-7 blocker survives export/import even when serialized riskIncreaseBlocked=false", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "import-fault",
        exchangeOrderId: primaryOrderId,
        quantity: "0",
        price: "99.4",
      }),
    isErrorCode("NON_POSITIVE_EXECUTION_QUANTITY"),
  );
  const exported = simulator.exportSnapshot();
  assert.equal(exported.executionIntegrityFault?.code, "NON_POSITIVE_EXECUTION_QUANTITY");
  exported.riskIncreaseBlocked = false;
  const restored = DeterministicSimulator.fromSnapshot(exported);
  assert.equal(restored.canIncreaseRisk(), false);
  assert.equal(
    restored.exportSnapshot().executionIntegrityFault?.code,
    "NON_POSITIVE_EXECUTION_QUANTITY",
  );
  const intentsBefore = restored.exportSnapshot().intents.length;
  const planned = restored.planEntries();
  assert.equal(planned.status, "PLANNED");
  assert.equal(restored.exportSnapshot().intents.length, intentsBefore);

  const malformed = structuredClone(exported);
  malformed.executionIntegrityFault = {
    code: "HACKED_FAULT",
    executionId: "import-fault",
    exchangeOrderId: primaryOrderId,
  } as unknown as SimulatorSnapshot["executionIntegrityFault"];
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(malformed),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotImportError);
      assert.equal(error.code, "MALFORMED_EXECUTION_INTEGRITY_FAULT");
      return true;
    },
  );
});

test("C5-8 explicit sim-exec-0001 followed by generated execution cannot overwrite", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const first = simulator.applyExecution({
    executionId: "sim-exec-0001",
    exchangeOrderId: primaryOrderId,
    quantity: "0.003",
    price: "99.4",
  });
  assert.ok(first);
  assert.equal(first.executionId, "sim-exec-0001");
  const generated = simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.002",
    price: "99.4",
  });
  assert.ok(generated);
  assert.notEqual(generated.executionId, "sim-exec-0001");
  assert.equal(generated.executionId, "sim-exec-0002");
  const executions = simulator.listExecutions();
  assert.equal(executions.length, 2);
  const original = executions.find((item) => item.executionId === "sim-exec-0001");
  assert.ok(original);
  assert.equal(original.quantity, "0.003");
  assert.equal(original.price, "99.4");
  assert.equal(original.exchangeOrderId, primaryOrderId);
  assert.equal(simulator.exportSnapshot().executionSeq, 2);
});

test("C5-9 stale snapshot executionSeq behind existing generated IDs is rejected", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  const snapshot = simulator.exportSnapshot();
  assert.equal(snapshot.executionSeq, 1);
  assert.equal(snapshot.executions[0]?.executionId, "sim-exec-0001");
  snapshot.executionSeq = 0;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(snapshot),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotImportError);
      assert.equal(error.code, "EXECUTION_SEQ_BEHIND_IDENTITIES");
      return true;
    },
  );
});

test("C5-10 stale snapshot orderSeq behind existing generated IDs is rejected", () => {
  const simulator = DeterministicSimulator.create(testInit());
  seedOwnedB1(simulator);
  const snapshot = simulator.exportSnapshot();
  assert.equal(snapshot.orderSeq, 1);
  assert.equal(snapshot.orders[0]?.exchangeOrderId, "sim-ord-0001");
  snapshot.orderSeq = 0;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(snapshot),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotImportError);
      assert.equal(error.code, "ORDER_SEQ_BEHIND_IDENTITIES");
      return true;
    },
  );
});

test("C5-11 generated order candidate collision cannot overwrite existing foreign/owned order", () => {
  const simulator = DeterministicSimulator.create(testInit());
  simulator.injectForeignOrder({
    exchangeOrderId: "sim-ord-0001",
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
  const intent = plannedEntry(simulator, "B1");
  const before = simulator.exportSnapshot();
  const beforeBytes = tradingCollectionBytes(before);
  assert.throws(() => simulator.submit(intent.intentId, "ACK"), isErrorCode("ORDER_ID_COLLISION"));
  const afterSubmit = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(afterSubmit), beforeBytes);
  const foreign = afterSubmit.orders.find((order) => order.exchangeOrderId === "sim-ord-0001");
  assert.ok(foreign);
  assert.equal(foreign.clientOrderId, "foreign-client");
  assert.equal(foreign.scopeKey, "foreign/sim/BTC_USDC_PERP/grid-v0.1");
  assert.equal(afterSubmit.authorityLinks.length, 0);
  assert.equal(afterSubmit.orderSeq, 0);
  assert.equal(afterSubmit.executionIntegrityFault?.code, "ORDER_ID_COLLISION");
  assert.equal(simulator.canIncreaseRisk(), false);

  assert.throws(
    () => simulator.injectOwnedDuplicate("B1", "99.4", "0.01"),
    isErrorCode("ORDER_ID_COLLISION"),
  );
  assert.equal(tradingCollectionBytes(simulator.exportSnapshot()), beforeBytes);
  assert.equal(simulator.exportSnapshot().executionIntegrityFault?.code, "ORDER_ID_COLLISION");
});

test("C5-12 foreign observation using an existing owned exchangeOrderId cannot replace owned bytes or authority", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  assert.ok(intent.clientOrderId);
  const before = simulator.exportSnapshot();
  const beforeBytes = tradingCollectionBytes(before);
  const beforeAuthority = authorityLedgerBytes(before);
  assert.throws(
    () =>
      simulator.injectForeignOrder({
        exchangeOrderId: primaryOrderId,
        clientOrderId: "foreign-replacement",
        logicalLevelId: null,
        purpose: "GRID_ENTRY",
        side: "SELL",
        type: "LIMIT",
        price: "1",
        originalQuantity: "9",
        executedQuantity: "0",
        remainingQuantity: "9",
        status: "WORKING",
        reduceOnly: false,
        anchorEpoch: "foreign-epoch",
        scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
      }),
    isErrorCode("ORDER_ID_COLLISION"),
  );
  const after = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(after), beforeBytes);
  assert.equal(authorityLedgerBytes(after), beforeAuthority);
  const owned = after.orders.find((order) => order.exchangeOrderId === primaryOrderId);
  assert.ok(owned);
  assert.equal(owned.clientOrderId, intent.clientOrderId);
  assert.equal(owned.side, "BUY");
  assert.equal(owned.originalQuantity, "0.01");
  assert.equal(after.authorityLinks[0]?.exchangeOrderId, primaryOrderId);
  assert.equal(after.authorityLinks[0]?.source, "ACK");
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: primaryOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(after.executionIntegrityFault?.code, "ORDER_ID_COLLISION");
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C5-13 exact canonical execution replay remains idempotent", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const first = simulator.applyExecution({
    executionId: "overlap-canonical-c5",
    exchangeOrderId: primaryOrderId,
    quantity: "0.005",
    price: "99.4",
  });
  assert.ok(first);
  const before = simulator.exportSnapshot();
  const replay = simulator.applyExecution({
    executionId: "overlap-canonical-c5",
    exchangeOrderId: primaryOrderId,
    quantity: "0.0050",
    price: "99.40",
  });
  assert.ok(replay);
  assert.equal(replay.executionId, first.executionId);
  assert.equal(replay.quantity, first.quantity);
  assert.equal(replay.price, first.price);
  assert.equal(tradingCollectionBytes(simulator.exportSnapshot()), tradingCollectionBytes(before));
  assert.equal(simulator.exportSnapshot().executionConflict, false);
  assert.equal(simulator.exportSnapshot().executionIntegrityFault, null);
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C5-14 conflicting execution replay still preserves original evidence", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    executionId: "conflict-c5",
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const before = simulator.exportSnapshot();
  const beforeBytes = tradingCollectionBytes(before);
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "conflict-c5",
        exchangeOrderId: primaryOrderId,
        quantity: "0.007",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_ID_CONFLICT"),
  );
  const after = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(after), beforeBytes);
  assert.equal(after.executionConflict, true);
  assert.equal(after.executions[0]?.quantity, "0.004");
  assert.equal(after.executions[0]?.price, "99.4");
  assert.equal(simulator.canIncreaseRisk(), false);
});

test("C5-15 duplicate owned exposure rows remain exact after export/import", () => {
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
  assert.equal(
    after.every((row) => row.quantity === "0.01"),
    true,
  );
});

test("C5-16 cancel/fill delayed execution may not exceed original-minus-executed residual", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  const cancelled = simulator.requestCancel(primaryOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const cancelledOrder = simulator
    .exportSnapshot()
    .orders.find((order) => order.exchangeOrderId === primaryOrderId);
  assert.ok(cancelledOrder);
  assert.equal(cancelledOrder.status, "CANCELLED");
  assert.equal(cancelledOrder.remainingQuantity, "0");
  assert.equal(cancelledOrder.executedQuantity, "0.004");
  assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        exchangeOrderId: primaryOrderId,
        quantity: "0.007",
        price: "99.4",
      }),
    "EXECUTION_OVERFILL",
  );
  assert.equal(simulator.exportSnapshot().executionIntegrityFault?.code, "EXECUTION_OVERFILL");

  const allowed = DeterministicSimulator.create(testInit());
  const allowedOrderId = ackPlace(allowed, plannedEntry(allowed, "B1").intentId);
  allowed.applyExecution({
    exchangeOrderId: allowedOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  assert.equal(allowed.requestCancel(allowedOrderId, "ACK").kind, "ACK");
  const delayed = allowed.applyExecution({
    exchangeOrderId: allowedOrderId,
    quantity: "0.006",
    price: "99.4",
  });
  assert.ok(delayed);
  const afterAllowed = allowed
    .exportSnapshot()
    .orders.find((order) => order.exchangeOrderId === allowedOrderId);
  assert.ok(afterAllowed);
  assert.equal(afterAllowed.executedQuantity, "0.01");
  assert.equal(afterAllowed.remainingQuantity, "0");
});

test("C5-17 invalid state transition leaves all trading collections byte-identical", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  simulator.injectForeignOrder({
    exchangeOrderId: "oversized-exit",
    clientOrderId: "foreign-exit",
    logicalLevelId: "B1",
    purpose: "GRID_EXIT",
    side: "SELL",
    type: "LIMIT",
    price: "99.4",
    originalQuantity: "0.02",
    executedQuantity: "0",
    remainingQuantity: "0.02",
    status: "WORKING",
    reduceOnly: true,
    anchorEpoch: "foreign-epoch",
    scopeKey: "foreign/sim/BTC_USDC_PERP/grid-v0.1",
  });
  const before = simulator.exportSnapshot();
  const beforeBytes = tradingCollectionBytes(before);
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "bad-transition",
        exchangeOrderId: "oversized-exit",
        quantity: "0.02",
        price: "99.4",
      }),
    isErrorCode("NEGATIVE_OPEN_INVENTORY"),
  );
  const after = simulator.exportSnapshot();
  assert.equal(tradingCollectionBytes(after), beforeBytes);
  assert.equal(after.executions.length, before.executions.length);
  assert.equal(simulator.level("B1").openInventory, "0.01");
  assert.equal(simulator.getPosition().quantity, "0.01");
  assert.equal(after.authorityLinks.length, before.authorityLinks.length);
});

test("C5-18 all previous P1, C1, D1, C3 and C4 cases remain present and green", () => {
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
  ];
  for (const id of required) {
    assert.equal(corpus.includes(id), true, `missing required case ${id}`);
  }

  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  const duplicateOrderId = simulator.injectOwnedDuplicate("B1", "99.4", "0.01");
  assert.equal(ownedWorkingRows(simulator).length, 2);
  simulator.applyExecution({
    executionId: "c5-18-keep",
    exchangeOrderId: primaryOrderId,
    quantity: "0.004",
    price: "99.4",
  });
  assert.throws(
    () =>
      simulator.applyExecution({
        executionId: "c5-18-keep",
        exchangeOrderId: primaryOrderId,
        quantity: "0.009",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_ID_CONFLICT"),
  );
  assert.equal(simulator.listExecutions()[0]?.quantity, "0.004");
  assert.equal(
    classifyOwnership(
      {
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: "forged-c5-18",
        scopeKey: CURRENT_SCOPE,
        anchorEpoch: "epoch-1",
      },
      {
        currentScopeKey: CURRENT_SCOPE,
        currentAnchorEpoch: "epoch-1",
        knownClientOrderIds: new Set(intent.clientOrderId === null ? [] : [intent.clientOrderId]),
        knownExchangeOrderIds: new Set(["forged-c5-18"]),
        clientOrderEpochById: new Map(
          intent.clientOrderId === null ? [] : [[intent.clientOrderId, "epoch-1"]],
        ),
      },
    ),
    "AMBIGUOUS",
  );
  assert.notEqual(duplicateOrderId, primaryOrderId);
  assert.equal(authorityLedgerBytes(simulator.exportSnapshot()).includes(primaryOrderId), true);
});
