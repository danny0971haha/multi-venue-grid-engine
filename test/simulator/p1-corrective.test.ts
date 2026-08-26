import assert from "node:assert/strict";
import test from "node:test";

import { classifyOwnership } from "../../src/domain/ownership.js";
import { makeScopeKey } from "../../src/domain/ids.js";
import {
  isCanonicalDecimalString,
  parseDecimalString,
  toTenthString,
} from "../../src/math/decimal.js";
import {
  DeterministicSimulator,
  SnapshotImportError,
  type SimulatorSnapshot,
} from "../../src/simulator/engine.js";
import { theoreticalEntryPrice } from "../../src/strategy/geometry.js";
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

function walkDecimalStrings(
  value: unknown,
  path: string,
  visit: (path: string, text: string) => void,
) {
  if (typeof value === "string") {
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && /[0-9]/.test(value)) {
      visit(path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkDecimalStrings(item, `${path}[${index}]`, visit);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        key.endsWith("At") ||
        key === "schemaVersion" ||
        key === "version" ||
        key === "source" ||
        key === "status" ||
        key === "type" ||
        key === "side" ||
        key === "purpose" ||
        key === "ownership" ||
        key === "state" ||
        key.includes("Id") ||
        key.includes("Key") ||
        key.includes("Epoch") ||
        key.includes("Scope") ||
        key.includes("Generation") ||
        key === "requestFingerprint" ||
        key === "strategy" ||
        key === "accountScope" ||
        key === "venue" ||
        key === "market" ||
        key === "clientOrderIdPattern" ||
        key === "liquidity" ||
        key === "feeAsset" ||
        key === "serverTime" ||
        key === "sequence"
      ) {
        if (
          key.includes("Price") ||
          key.includes("Quantity") ||
          key.includes("Notional") ||
          key.includes("Usd") ||
          key === "quantity" ||
          key === "price" ||
          key === "leverage" ||
          key === "openInventory" ||
          key.endsWith("Quantity") ||
          key.includes("Tick") ||
          key.includes("Step")
        ) {
          walkDecimalStrings(item, `${path}.${key}`, visit);
        }
        continue;
      }
      walkDecimalStrings(item, `${path}.${key}`, visit);
    }
  }
}

test("C1 partial BUY entry 0.004/0.01 + cancel remainder -> exit quantity exactly 0.004", () => {
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
  assert.equal(level.state, "POSITION_OPEN");
  assert.equal(level.openInventory, "0.004");
  assert.equal(level.entryExecutedQuantity, "0.004");
  assert.ok(level.exitIntentId);
  const exitIntent = snapshotIntent(simulator, level.exitIntentId);
  assert.equal(exitIntent.quantity, "0.004");
  assert.notEqual(exitIntent.quantity, intent.quantity);
  assert.notEqual(exitIntent.quantity, level.originalQuantity);
});

test("C2 partial SELL entry 0.004/0.01 + cancel remainder -> exit quantity exactly 0.004", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "S1");
  const exchangeOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId,
    quantity: "0.004",
    price: "100.6",
  });
  const cancelled = simulator.requestCancel(exchangeOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const level = simulator.level("S1");
  assert.equal(level.state, "POSITION_OPEN");
  assert.equal(level.openInventory, "0.004");
  assert.ok(level.exitIntentId);
  assert.equal(snapshotIntent(simulator, level.exitIntentId).quantity, "0.004");
});

test("C3 multiple partial entry executions + cancel -> exit quantity equals exact cumulative executed quantity", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B2");
  const exchangeOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    executionId: "c3-a",
    exchangeOrderId,
    quantity: "0.002",
    price: "98.8",
  });
  simulator.applyExecution({
    executionId: "c3-b",
    exchangeOrderId,
    quantity: "0.003",
    price: "98.8",
  });
  const cancelled = simulator.requestCancel(exchangeOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const level = simulator.level("B2");
  assert.equal(level.entryExecutedQuantity, "0.005");
  assert.equal(level.openInventory, "0.005");
  assert.ok(level.exitIntentId);
  assert.equal(snapshotIntent(simulator, level.exitIntentId).quantity, "0.005");
});

test("C4 partial exit execution + cancel remainder -> residual level inventory is exact", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  const entryOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId: entryOrderId,
    quantity: "0.01",
    price: "97.0",
  });
  const firstExitId = simulator.level("B5").exitIntentId;
  assert.ok(firstExitId);
  assert.equal(snapshotIntent(simulator, firstExitId).quantity, "0.01");
  const exitOrderId = ackPlace(simulator, firstExitId);
  simulator.applyExecution({
    exchangeOrderId: exitOrderId,
    quantity: "0.004",
    price: "97.6",
  });
  assert.equal(simulator.level("B5").state, "EXIT_PARTIAL");
  const cancelled = simulator.requestCancel(exitOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const level = simulator.level("B5");
  assert.equal(level.state, "POSITION_OPEN");
  assert.equal(level.entryExecutedQuantity, "0.01");
  assert.equal(level.exitExecutedQuantity, "0.004");
  assert.equal(level.openInventory, "0.006");
});

test("C5 next exit after C4 has a new intentId and quantity equal to residual inventory", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  const entryOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId: entryOrderId,
    quantity: "0.01",
    price: "97.0",
  });
  const firstExitId = simulator.level("B5").exitIntentId;
  assert.ok(firstExitId);
  const exitOrderId = ackPlace(simulator, firstExitId);
  simulator.applyExecution({
    exchangeOrderId: exitOrderId,
    quantity: "0.004",
    price: "97.6",
  });
  const cancelled = simulator.requestCancel(exitOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  const level = simulator.level("B5");
  assert.ok(level.exitIntentId);
  assert.notEqual(level.exitIntentId, firstExitId);
  const nextExit = snapshotIntent(simulator, level.exitIntentId);
  assert.equal(nextExit.quantity, "0.006");
  assert.equal(nextExit.quantity, level.openInventory);
  assert.notEqual(nextExit.clientOrderId, snapshotIntent(simulator, firstExitId).clientOrderId);
});

test("C6 UNKNOWN/retry of one unresolved mutation preserves the same intentId", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const first = plannedEntry(simulator, "B3");
  const unknown = simulator.submit(first.intentId, "UNKNOWN");
  assert.equal(unknown.kind, "UNKNOWN");
  const retried = plannedEntry(simulator, "B3");
  assert.equal(retried.intentId, first.intentId);
  assert.equal(retried.clientOrderId, first.clientOrderId);
  const restored = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  assert.equal(plannedEntry(restored, "B3").intentId, first.intentId);
});

test("C7 completed entry/exit cycle -> next entry uses a new deterministic intentId/clientOrderId", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const first = plannedEntry(simulator, "B1");
  const entryOrderId = ackPlace(simulator, first.intentId);
  simulator.applyExecution({
    exchangeOrderId: entryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const exitIntentId = simulator.level("B1").exitIntentId;
  assert.ok(exitIntentId);
  const exitOrderId = ackPlace(simulator, exitIntentId);
  simulator.applyExecution({
    exchangeOrderId: exitOrderId,
    quantity: "0.01",
    price: "100",
  });
  assert.equal(simulator.level("B1").state, "IDLE");
  const second = plannedEntry(simulator, "B1");
  assert.notEqual(second.intentId, first.intentId);
  assert.notEqual(second.clientOrderId, first.clientOrderId);
  const again = plannedEntry(simulator, "B1");
  assert.equal(again.intentId, second.intentId);
});

test("C8 restart/export-import preserves mutation sequence and does not reuse/duplicate identity", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const first = plannedEntry(simulator, "B1");
  const entryOrderId = ackPlace(simulator, first.intentId);
  simulator.applyExecution({
    exchangeOrderId: entryOrderId,
    quantity: "0.01",
    price: "99.4",
  });
  const exitIntentId = simulator.level("B1").exitIntentId;
  assert.ok(exitIntentId);
  const exitOrderId = ackPlace(simulator, exitIntentId);
  simulator.applyExecution({
    exchangeOrderId: exitOrderId,
    quantity: "0.01",
    price: "100",
  });
  const afterCycle = DeterministicSimulator.fromSnapshot(simulator.exportSnapshot());
  const next = plannedEntry(afterCycle, "B1");
  assert.notEqual(next.intentId, first.intentId);
  const again = DeterministicSimulator.fromSnapshot(afterCycle.exportSnapshot());
  const replayed = plannedEntry(again, "B1");
  assert.equal(replayed.intentId, next.intentId);
  assert.equal(replayed.clientOrderId, next.clientOrderId);
  assert.equal(
    again.level("B1").entryMutationSequence,
    afterCycle.level("B1").entryMutationSequence,
  );
  assert.equal(
    again
      .exportSnapshot()
      .intents.filter((item) => item.logicalLevelId === "B1" && item.purpose === "GRID_ENTRY")
      .length,
    2,
  );
});

test("C9 matching scope/epoch + unknown client/exchange identity -> AMBIGUOUS", () => {
  assert.equal(
    classifyOwnership(
      {
        clientOrderId: "unknown-client",
        exchangeOrderId: "unknown-ex",
        scopeKey: CURRENT_SCOPE,
        anchorEpoch: "epoch-1",
      },
      {
        currentScopeKey: CURRENT_SCOPE,
        currentAnchorEpoch: "epoch-1",
        knownClientOrderIds: new Set(),
        knownExchangeOrderIds: new Set(),
        clientOrderEpochById: new Map(),
      },
    ),
    "AMBIGUOUS",
  );
  const simulator = DeterministicSimulator.create(testInit());
  simulator.injectForeignOrder({
    exchangeOrderId: "unknown-ex",
    clientOrderId: "unknown-client",
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
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  });
  const observed = simulator
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "unknown-ex");
  assert.equal(observed?.ownership, "AMBIGUOUS");
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: "unknown-client",
      exchangeOrderId: "unknown-ex",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "AMBIGUOUS",
  );
});

test("C10 AMBIGUOUS order blocks risk increase/reseed and is never a cancel candidate", () => {
  const blocked = DeterministicSimulator.create(testInit());
  blocked.injectForeignOrder({
    exchangeOrderId: "amb-c10",
    clientOrderId: "unknown-client-c10",
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
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  });
  assert.equal(blocked.canIncreaseRisk(), false);
  const refusedSeed = blocked.planEntries();
  assert.equal(refusedSeed.status, "PLANNED");
  if (refusedSeed.status === "PLANNED") {
    assert.equal(refusedSeed.intents.length, 0);
  }

  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  simulator.injectForeignOrder({
    exchangeOrderId: "amb-same-price",
    clientOrderId: "unknown-same-price",
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
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  });
  assert.equal(simulator.canIncreaseRisk(), false);
  const plan = simulator.planDuplicateCleanupByPrice("99.4");
  assert.equal(simulator.cancelCandidatesInclude(plan, "amb-same-price"), false);
  assert.equal(plan.cancelExchangeOrderIds.includes("amb-same-price"), false);
  assert.equal(plan.cancelExchangeOrderIds.includes(ownedOrderId), false);
  const cancelAmbiguous = simulator.requestCancel("amb-same-price", "ACK");
  assert.equal(cancelAmbiguous.kind, "NOT_SENT");
  const afterCycleBlock = plannedEntry(simulator, "B1");
  assert.equal(afterCycleBlock.intentId, intent.intentId);
});

test("C11 authoritative decimal export has one canonical representation", () => {
  assert.equal(parseDecimalString("97.0"), "97");
  assert.equal(parseDecimalString("103.0"), "103");
  assert.equal(isCanonicalDecimalString("97"), true);
  assert.equal(isCanonicalDecimalString("97.0"), false);
  assert.equal(isCanonicalDecimalString("103.0"), false);
  assert.equal(toTenthString("97"), "97.0");
  assert.equal(theoreticalEntryPrice("100", "B5"), "97");
  assert.equal(theoreticalEntryPrice("100", "S5"), "103");
  const simulator = DeterministicSimulator.create(testInit());
  plannedEntry(simulator, "B5");
  const snapshot = simulator.exportSnapshot();
  const b5 = snapshot.levels.find((level) => level.logicalLevelId === "B5");
  assert.ok(b5);
  assert.equal(b5.theoreticalEntryPrice, "97");
  assert.equal(b5.normalizedEntryPrice, "97");
  const encoded = JSON.stringify(snapshot);
  assert.equal(encoded.includes('"theoreticalEntryPrice":"97"'), true);
  assert.equal(encoded.includes('"theoreticalEntryPrice":"97.0"'), false);
  assert.equal(encoded.includes("Decimal"), false);
  walkDecimalStrings(snapshot, "snapshot", (path, text) => {
    if (
      path.includes("Price") ||
      path.includes("Quantity") ||
      path.includes("Notional") ||
      path.includes("Usd") ||
      path.includes("Inventory") ||
      path.endsWith(".quantity") ||
      path.endsWith(".price") ||
      path.includes("Tick") ||
      path.includes("Step") ||
      path.includes("leverage") ||
      path.includes("Fraction")
    ) {
      assert.equal(isCanonicalDecimalString(text), true, `${path} is not canonical: ${text}`);
    }
  });
});

test("C12 export -> import -> export preserves canonical financial bytes and schema version", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  const entryOrderId = ackPlace(simulator, intent.intentId);
  simulator.applyExecution({
    exchangeOrderId: entryOrderId,
    quantity: "0.01",
    price: "97.0",
  });
  const first = simulator.exportSnapshot();
  assert.equal(first.schemaVersion, "phase1-simulator-2");
  const firstJson = JSON.stringify(first);
  const restored = DeterministicSimulator.fromSnapshot(JSON.parse(firstJson) as SimulatorSnapshot);
  const second = restored.exportSnapshot();
  assert.equal(second.schemaVersion, "phase1-simulator-2");
  assert.equal(JSON.stringify(second), firstJson);
  const b5 = second.levels.find((level) => level.logicalLevelId === "B5");
  assert.equal(b5?.theoreticalEntryPrice, "97");
  assert.equal(b5?.openInventory, "0.01");
  assert.equal(b5?.entryMutationSequence, "1");
  assert.equal(b5?.exitMutationSequence, "1");
});

test("C13 malformed/non-canonical snapshot decimal is rejected or returns explicit reconciliation-required disposition", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B5");
  ackPlace(simulator, intent.intentId);
  const valid = simulator.exportSnapshot();

  const nonCanonical = structuredClone(valid);
  const nonCanonicalLevel = nonCanonical.levels.find((level) => level.logicalLevelId === "B5");
  assert.ok(nonCanonicalLevel);
  nonCanonicalLevel.theoreticalEntryPrice = "97.0";
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(nonCanonical),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotImportError);
      assert.equal(error.disposition, "BLOCK_RISK_INCREASE");
      assert.match(error.code, /NON_CANONICAL_DECIMAL|INVALID_SNAPSHOT/);
      return true;
    },
  );

  const negative = structuredClone(valid);
  const negativeLevel = negative.levels.find((level) => level.logicalLevelId === "B1");
  assert.ok(negativeLevel);
  negativeLevel.executedQuantity = "-1";
  assert.throws(() => DeterministicSimulator.fromSnapshot(negative), SnapshotImportError);

  const overExecuted = structuredClone(valid);
  const overLevel = overExecuted.orders[0];
  assert.ok(overLevel);
  overLevel.originalQuantity = "0.01";
  overLevel.executedQuantity = "0.02";
  assert.throws(() => DeterministicSimulator.fromSnapshot(overExecuted), SnapshotImportError);

  const dangling = structuredClone(valid);
  const danglingLevel = dangling.levels.find((level) => level.logicalLevelId === "B1");
  assert.ok(danglingLevel);
  danglingLevel.entryIntentId = "missing-intent";
  assert.throws(() => DeterministicSimulator.fromSnapshot(dangling), SnapshotImportError);

  const missingSequence = structuredClone(valid);
  const sequenceLevel = missingSequence.levels.find((level) => level.logicalLevelId === "B1");
  assert.ok(sequenceLevel);
  Reflect.deleteProperty(sequenceLevel, "entryMutationSequence");
  assert.throws(() => DeterministicSimulator.fromSnapshot(missingSequence), SnapshotImportError);

  const badSchema = structuredClone(valid);
  (badSchema as { schemaVersion: string }).schemaVersion = "phase1-simulator-0";
  assert.throws(() => DeterministicSimulator.fromSnapshot(badSchema), SnapshotImportError);

  const duplicateExec = structuredClone(valid);
  const firstExecution = duplicateExec.executions[0];
  if (firstExecution !== undefined) {
    duplicateExec.executions.push({ ...firstExecution });
    assert.throws(() => DeterministicSimulator.fromSnapshot(duplicateExec), SnapshotImportError);
  } else {
    duplicateExec.executions.push(
      {
        venue: "sim",
        market: "BTC_USDC_PERP",
        executionId: "dup",
        exchangeOrderId: "missing-order",
        clientOrderId: null,
        side: "BUY",
        price: "99.4",
        quantity: "0.001",
        feeAmount: null,
        feeAsset: null,
        liquidity: "UNKNOWN",
        meta: valid.position.meta,
      },
      {
        venue: "sim",
        market: "BTC_USDC_PERP",
        executionId: "dup",
        exchangeOrderId: "missing-order",
        clientOrderId: null,
        side: "BUY",
        price: "99.4",
        quantity: "0.001",
        feeAmount: null,
        feeAsset: null,
        liquidity: "UNKNOWN",
        meta: valid.position.meta,
      },
    );
    assert.throws(() => DeterministicSimulator.fromSnapshot(duplicateExec), SnapshotImportError);
  }
});
