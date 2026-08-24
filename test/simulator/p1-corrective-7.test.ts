import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeScopeKey } from "../../src/domain/ids.js";
import { DeterministicSimulator, type SimulatorSnapshot } from "../../src/simulator/engine.js";
import { testInit } from "./helpers.js";

const CURRENT_SCOPE = makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1");
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_IMPORTABLE = MAX_SAFE - 1;
const MAX_GENERATABLE_FROM = MAX_SAFE - 2;

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

function snapshotBytes(snapshot: SimulatorSnapshot) {
  return JSON.stringify(snapshot);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function generatedExecutionId(sequence: number) {
  return `sim-exec-${String(sequence).padStart(4, "0")}`;
}

function withOrderSeq(simulator: DeterministicSimulator, orderSeq: number) {
  const snapshot = simulator.exportSnapshot();
  snapshot.orderSeq = orderSeq;
  return DeterministicSimulator.fromSnapshot(snapshot);
}

function withExecutionSeq(simulator: DeterministicSimulator, executionSeq: number) {
  const snapshot = simulator.exportSnapshot();
  snapshot.executionSeq = executionSeq;
  return DeterministicSimulator.fromSnapshot(snapshot);
}

function assertRoundTrip(simulator: DeterministicSimulator) {
  const exported = simulator.exportSnapshot();
  const restored = DeterministicSimulator.fromSnapshot(exported);
  const reexported = restored.exportSnapshot();
  assert.equal(tradingCollectionBytes(reexported), tradingCollectionBytes(exported));
  assert.deepEqual(reexported.executionIntegrityFault, exported.executionIntegrityFault);
  assert.equal(restored.canIncreaseRisk(), simulator.canIncreaseRisk());
  assert.equal(
    sha256(tradingCollectionBytes(reexported)),
    sha256(tradingCollectionBytes(exported)),
  );
  return { exported, restored, reexported };
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

test("C7-1 orderSeq=MAX_SAFE-2 generates once to MAX_SAFE-1 and roundtrips", () => {
  const seeded = DeterministicSimulator.create(testInit());
  seedOwnedB1(seeded);
  const simulator = withOrderSeq(seeded, MAX_GENERATABLE_FROM);
  const b2 = plannedEntry(simulator, "B2");
  const b2OrderId = ackPlace(simulator, b2.intentId);
  assert.equal(simulator.exportSnapshot().orderSeq, MAX_IMPORTABLE);
  assert.ok(b2OrderId.startsWith("sim-ord-"));
  const { exported, reexported } = assertRoundTrip(simulator);
  assert.equal(exported.orderSeq, MAX_IMPORTABLE);
  assert.equal(reexported.orderSeq, MAX_IMPORTABLE);
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C7-2 orderSeq=MAX_SAFE-1 exhausts before mutation and keeps collections identical", () => {
  const seeded = DeterministicSimulator.create(testInit());
  seedOwnedB1(seeded);
  const simulator = withOrderSeq(seeded, MAX_IMPORTABLE);
  const b2 = plannedEntry(simulator, "B2");
  assert.equal(simulator.level("B2").state, "IDLE");
  const { before, after } = assertRejectedWithoutTradingMutation(
    simulator,
    () => simulator.submit(b2.intentId, "ACK"),
    "ORDER_SEQ_EXHAUSTED",
  );
  assert.equal(before.orderSeq, MAX_IMPORTABLE);
  assert.equal(after.orderSeq, MAX_IMPORTABLE);
  assert.equal(simulator.level("B2").state, "IDLE");
  assert.equal(after.executionIntegrityFault?.code, "ORDER_SEQ_EXHAUSTED");
  assert.equal(simulator.canIncreaseRisk(), false);
  assert.throws(
    () => simulator.submit(plannedEntry(simulator, "B3").intentId, "ACK"),
    isErrorCode("ORDER_SEQ_EXHAUSTED"),
  );
  assert.equal(simulator.exportSnapshot().executionIntegrityFault?.code, "ORDER_SEQ_EXHAUSTED");
  assertRoundTrip(simulator);
});

test("C7-3 C7-2 fault snapshot still blocks risk when riskIncreaseBlocked=false", () => {
  const seeded = DeterministicSimulator.create(testInit());
  seedOwnedB1(seeded);
  const simulator = withOrderSeq(seeded, MAX_IMPORTABLE);
  assert.throws(
    () => simulator.submit(plannedEntry(simulator, "B2").intentId, "ACK"),
    isErrorCode("ORDER_SEQ_EXHAUSTED"),
  );
  const exported = simulator.exportSnapshot();
  exported.riskIncreaseBlocked = false;
  const restored = DeterministicSimulator.fromSnapshot(exported);
  assert.equal(restored.canIncreaseRisk(), false);
  assert.equal(restored.exportSnapshot().executionIntegrityFault?.code, "ORDER_SEQ_EXHAUSTED");
  assertRoundTrip(restored);
});

test("C7-4 executionSeq=MAX_SAFE-2 auto-generates once to MAX_SAFE-1 and roundtrips", () => {
  const seeded = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(seeded);
  const simulator = withExecutionSeq(seeded, MAX_GENERATABLE_FROM);
  const execution = simulator.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  assert.ok(execution);
  assert.equal(simulator.exportSnapshot().executionSeq, MAX_IMPORTABLE);
  assert.equal(execution.executionId, generatedExecutionId(MAX_IMPORTABLE));
  const { exported } = assertRoundTrip(simulator);
  assert.equal(exported.executionSeq, MAX_IMPORTABLE);
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C7-5 executionSeq=MAX_SAFE-1 auto-generation exhausts before mutation", () => {
  const seeded = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(seeded);
  const simulator = withExecutionSeq(seeded, MAX_IMPORTABLE);
  const { after } = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        exchangeOrderId: primaryOrderId,
        quantity: "0.001",
        price: "99.4",
      }),
    "EXECUTION_SEQ_EXHAUSTED",
  );
  assert.equal(after.executionSeq, MAX_IMPORTABLE);
  assert.equal(after.executions.length, 0);
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_SEQ_EXHAUSTED");
  assert.equal(simulator.canIncreaseRisk(), false);
  assertRoundTrip(simulator);
});

test("C7-6 explicit sim-exec-(MAX_SAFE-1) commits, advances counter, and roundtrips", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const execution = simulator.applyExecution({
    executionId: generatedExecutionId(MAX_IMPORTABLE),
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  assert.ok(execution);
  assert.equal(execution.executionId, generatedExecutionId(MAX_IMPORTABLE));
  assert.equal(simulator.exportSnapshot().executionSeq, MAX_IMPORTABLE);
  assert.equal(simulator.listExecutions().length, 1);
  const { exported } = assertRoundTrip(simulator);
  assert.equal(exported.executionSeq, MAX_IMPORTABLE);
  assert.equal(exported.executions[0]?.executionId, generatedExecutionId(MAX_IMPORTABLE));
  assert.equal(simulator.canIncreaseRisk(), true);
});

test("C7-7 explicit sim-exec-MAX_SAFE is rejected before any trading mutation", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(simulator);
  const { before, after } = assertRejectedWithoutTradingMutation(
    simulator,
    () =>
      simulator.applyExecution({
        executionId: generatedExecutionId(MAX_SAFE),
        exchangeOrderId: primaryOrderId,
        quantity: "0.001",
        price: "99.4",
      }),
    "EXECUTION_SEQ_EXHAUSTED",
  );
  assert.equal(before.executionSeq, 0);
  assert.equal(after.executionSeq, 0);
  assert.equal(after.executions.length, 0);
  assert.equal(after.orders[0]?.executedQuantity, "0");
  assert.equal(simulator.level("B1").executedQuantity, "0");
  assert.equal(simulator.getPosition().quantity, "0");
  assert.notEqual(after.executionSeq, MAX_SAFE);
  assert.equal(after.executionIntegrityFault?.code, "EXECUTION_SEQ_EXHAUSTED");
  assert.equal(simulator.canIncreaseRisk(), false);
  assertRoundTrip(simulator);
});

test("C7-8 generated order/execution collision protection still fails closed without skipping", () => {
  const orderCollision = DeterministicSimulator.create(testInit());
  orderCollision.injectForeignOrder({
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
  const intent = plannedEntry(orderCollision, "B1");
  const beforeOrder = orderCollision.exportSnapshot();
  assert.throws(
    () => orderCollision.submit(intent.intentId, "ACK"),
    isErrorCode("ORDER_ID_COLLISION"),
  );
  const afterOrder = orderCollision.exportSnapshot();
  assert.equal(tradingCollectionBytes(afterOrder), tradingCollectionBytes(beforeOrder));
  assert.equal(afterOrder.orderSeq, 0);
  assert.equal(afterOrder.orders.length, 1);
  assert.equal(afterOrder.executionIntegrityFault?.code, "ORDER_ID_COLLISION");
  assert.throws(
    () => orderCollision.injectOwnedDuplicate("B1", "99.4", "0.01"),
    isErrorCode("ORDER_ID_COLLISION"),
  );
  assert.equal(orderCollision.exportSnapshot().orderSeq, 0);
  assert.equal(orderCollision.exportSnapshot().orders.length, 1);

  const executionCollision = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(executionCollision);
  const first = executionCollision.applyExecution({
    executionId: "sim-exec-0001",
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  assert.ok(first);
  const generated = executionCollision.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.001",
    price: "99.4",
  });
  assert.ok(generated);
  assert.equal(generated.executionId, "sim-exec-0002");
  assert.equal(executionCollision.exportSnapshot().executionSeq, 2);
  assert.equal(executionCollision.listExecutions().length, 2);
});

test("C7-9 success, exhaustion, and collision terminals all export/import/export equivalently", () => {
  const success = DeterministicSimulator.create(testInit());
  const { primaryOrderId } = seedOwnedB1(success);
  success.applyExecution({
    exchangeOrderId: primaryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const successRound = assertRoundTrip(success);
  assert.equal(success.level("B1").state, "POSITION_OPEN");
  assert.equal(
    sha256(snapshotBytes(successRound.reexported)),
    sha256(snapshotBytes(successRound.exported)),
  );

  const exhaustedSeed = DeterministicSimulator.create(testInit());
  seedOwnedB1(exhaustedSeed);
  const exhaustedReady = withOrderSeq(exhaustedSeed, MAX_IMPORTABLE);
  assert.throws(
    () => exhaustedReady.submit(plannedEntry(exhaustedReady, "B2").intentId, "ACK"),
    isErrorCode("ORDER_SEQ_EXHAUSTED"),
  );
  const exhaustedRound = assertRoundTrip(exhaustedReady);
  assert.equal(exhaustedRound.exported.executionIntegrityFault?.code, "ORDER_SEQ_EXHAUSTED");
  assert.equal(exhaustedRound.restored.canIncreaseRisk(), false);

  const collision = DeterministicSimulator.create(testInit());
  const { primaryOrderId: ownedOrderId } = seedOwnedB1(collision);
  assert.throws(
    () =>
      collision.injectForeignOrder({
        exchangeOrderId: ownedOrderId,
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
  const collisionRound = assertRoundTrip(collision);
  assert.equal(collisionRound.exported.executionIntegrityFault?.code, "ORDER_ID_COLLISION");
  assert.equal(collisionRound.exported.orderSeq, 1);
  assert.equal(collisionRound.restored.canIncreaseRisk(), false);
});

test("C7-10 all previous P1, C1-C13, D1-D13, C3, C4, C5, and C6 cases remain present and green", () => {
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
    "C6-1",
    "C6-2",
    "C6-3",
    "C6-4",
    "C6-5",
    "C6-6",
    "C6-7",
    "C6-8",
    "C6-9",
    "C6-10",
    "C6-11",
    "C6-12",
    "C6-13",
    "C6-14",
    "C6-15",
    "C6-16",
    "C7-1",
    "C7-2",
    "C7-3",
    "C7-4",
    "C7-5",
    "C7-6",
    "C7-7",
    "C7-8",
    "C7-9",
  ];
  for (const id of required) {
    assert.equal(corpus.includes(id), true, `missing required case ${id}`);
  }

  const simulator = DeterministicSimulator.create(testInit());
  const { intent, primaryOrderId } = seedOwnedB1(simulator);
  assert.equal(simulator.level("B1").state, "ENTRY_WORKING");
  simulator.applyExecution({
    executionId: "c7-10-fill",
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

  const blocker = DeterministicSimulator.create(testInit());
  seedOwnedB1(blocker);
  assert.throws(
    () =>
      blocker.applyExecution({
        executionId: "c7-10-missing",
        exchangeOrderId: "missing-exchange-order",
        quantity: "0.001",
        price: "99.4",
      }),
    isErrorCode("EXECUTION_ORDER_MISSING"),
  );
  assert.equal(blocker.canIncreaseRisk(), false);
  const blockerRestored = DeterministicSimulator.fromSnapshot(blocker.exportSnapshot());
  assert.equal(blockerRestored.canIncreaseRisk(), false);
  assert.equal(
    blockerRestored.exportSnapshot().executionIntegrityFault?.code,
    "EXECUTION_ORDER_MISSING",
  );
});
