import assert from "node:assert/strict";
import test from "node:test";

import { classifyOwnership } from "../../src/domain/ownership.js";
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

function findOrder(snapshot: SimulatorSnapshot, exchangeOrderId: string) {
  const order = snapshot.orders.find((item) => item.exchangeOrderId === exchangeOrderId);
  assert.ok(order);
  return order;
}

function findAuthority(snapshot: SimulatorSnapshot, exchangeOrderId: string) {
  const link = snapshot.authorityLinks.find((item) => item.exchangeOrderId === exchangeOrderId);
  assert.ok(link);
  return link;
}

function forgedCurrentScopeOrder(input: {
  exchangeOrderId: string;
  clientOrderId: string;
  ownership?: "OWNED" | "UNOWNED" | "AMBIGUOUS";
}) {
  return {
    exchangeOrderId: input.exchangeOrderId,
    clientOrderId: input.clientOrderId,
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
    ownership: input.ownership ?? "OWNED",
    presentInOpenBook: true,
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  };
}

test("C3-1 real current clientOrderId cannot self-bootstrap ownership", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  assert.ok(intent.clientOrderId);
  ackPlace(simulator, intent.intentId);

  assert.equal(
    classifyOwnership(
      {
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: "forged-real-client",
        scopeKey: CURRENT_SCOPE,
        anchorEpoch: "epoch-1",
      },
      {
        currentScopeKey: CURRENT_SCOPE,
        currentAnchorEpoch: "epoch-1",
        knownClientOrderIds: new Set([intent.clientOrderId]),
        knownExchangeOrderIds: new Set(),
        clientOrderEpochById: new Map([[intent.clientOrderId, "epoch-1"]]),
      },
    ),
    "AMBIGUOUS",
  );

  simulator.injectForeignOrder({
    exchangeOrderId: "forged-real-client",
    clientOrderId: intent.clientOrderId,
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
  assert.equal(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: "forged-real-client",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "AMBIGUOUS",
  );
  assert.notEqual(
    simulator.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: "forged-real-client",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(simulator.canIncreaseRisk(), false);
  const observed = simulator
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "forged-real-client");
  assert.equal(observed?.ownership, "AMBIGUOUS");

  const snapshot = simulator.exportSnapshot();
  snapshot.orders.push(
    forgedCurrentScopeOrder({
      exchangeOrderId: "imported-forged-real-client",
      clientOrderId: intent.clientOrderId,
      ownership: "OWNED",
    }),
  );
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: "imported-forged-real-client",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "AMBIGUOUS",
  );
  assert.equal(restored.canIncreaseRisk(), false);
});

test("C3-2 structural clone without authority is not OWNED", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  const snapshot = simulator.exportSnapshot();
  const owned = findOrder(snapshot, ownedOrderId);
  snapshot.orders.push({
    ...owned,
    exchangeOrderId: "structural-clone",
    ownership: "OWNED",
  });
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: owned.clientOrderId,
      exchangeOrderId: "structural-clone",
      scopeKey: owned.scopeKey,
      anchorEpoch: owned.anchorEpoch,
    }),
    "AMBIGUOUS",
  );
  assert.notEqual(
    restored.classifyObserved({
      clientOrderId: owned.clientOrderId,
      exchangeOrderId: "structural-clone",
      scopeKey: owned.scopeKey,
      anchorEpoch: owned.anchorEpoch,
    }),
    "OWNED",
  );
  assert.equal(
    restored.classifyObserved({
      clientOrderId: owned.clientOrderId,
      exchangeOrderId: ownedOrderId,
      scopeKey: owned.scopeKey,
      anchorEpoch: owned.anchorEpoch,
    }),
    "OWNED",
  );
  assert.equal(
    classifyOwnership(
      {
        clientOrderId: owned.clientOrderId,
        exchangeOrderId: "structural-clone",
        scopeKey: CURRENT_SCOPE,
        anchorEpoch: "epoch-1",
      },
      {
        currentScopeKey: CURRENT_SCOPE,
        currentAnchorEpoch: "epoch-1",
        knownClientOrderIds: new Set(owned.clientOrderId === null ? [] : [owned.clientOrderId]),
        knownExchangeOrderIds: new Set(["structural-clone"]),
        clientOrderEpochById: new Map(
          owned.clientOrderId === null ? [] : [[owned.clientOrderId, "epoch-1"]],
        ),
      },
    ),
    "AMBIGUOUS",
  );
});

test("C3-3 planned, NOT_SENT and REJECTED intents grant no authority", () => {
  const plannedSim = DeterministicSimulator.create(testInit());
  const planned = plannedEntry(plannedSim, "B1");
  assert.ok(planned.clientOrderId);
  plannedSim.injectForeignOrder({
    exchangeOrderId: "obs-planned",
    clientOrderId: planned.clientOrderId,
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
  assert.notEqual(
    plannedSim.classifyObserved({
      clientOrderId: planned.clientOrderId,
      exchangeOrderId: "obs-planned",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(plannedSim.exportSnapshot().authorityLinks.length, 0);

  const notSentSim = DeterministicSimulator.create(testInit());
  const notSentIntent = plannedEntry(notSentSim, "B2");
  const notSent = notSentSim.submit(notSentIntent.intentId, "NOT_SENT");
  assert.equal(notSent.kind, "NOT_SENT");
  assert.ok(notSentIntent.clientOrderId);
  notSentSim.injectForeignOrder({
    exchangeOrderId: "obs-not-sent",
    clientOrderId: notSentIntent.clientOrderId,
    logicalLevelId: "B2",
    purpose: "GRID_ENTRY",
    side: "BUY",
    type: "LIMIT",
    price: "98.8",
    originalQuantity: "0.01",
    executedQuantity: "0",
    remainingQuantity: "0.01",
    status: "WORKING",
    reduceOnly: false,
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  });
  assert.notEqual(
    notSentSim.classifyObserved({
      clientOrderId: notSentIntent.clientOrderId,
      exchangeOrderId: "obs-not-sent",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(notSentSim.exportSnapshot().authorityLinks.length, 0);

  const rejectedSim = DeterministicSimulator.create(testInit());
  const rejectedIntent = plannedEntry(rejectedSim, "B3");
  const rejected = rejectedSim.submit(rejectedIntent.intentId, "REJECTED");
  assert.equal(rejected.kind, "REJECTED");
  assert.ok(rejectedIntent.clientOrderId);
  rejectedSim.injectForeignOrder({
    exchangeOrderId: "obs-rejected",
    clientOrderId: rejectedIntent.clientOrderId,
    logicalLevelId: "B3",
    purpose: "GRID_ENTRY",
    side: "BUY",
    type: "LIMIT",
    price: "98.2",
    originalQuantity: "0.01",
    executedQuantity: "0",
    remainingQuantity: "0.01",
    status: "WORKING",
    reduceOnly: false,
    anchorEpoch: "epoch-1",
    scopeKey: CURRENT_SCOPE,
  });
  assert.notEqual(
    rejectedSim.classifyObserved({
      clientOrderId: rejectedIntent.clientOrderId,
      exchangeOrderId: "obs-rejected",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(rejectedSim.exportSnapshot().authorityLinks.length, 0);
});

test("C3-4 ACK-linked order remains OWNED after restart", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  const exported = simulator.exportSnapshot();
  assert.equal(exported.schemaVersion, "phase1-simulator-2");
  const link = findAuthority(exported, ownedOrderId);
  assert.equal(link.source, "ACK");
  assert.equal(link.intentId, intent.intentId);
  assert.equal(link.clientOrderId, intent.clientOrderId);
  assert.ok(link.evidenceId.length > 0);

  const restored = DeterministicSimulator.fromSnapshot(exported);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: ownedOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(findAuthority(restored.exportSnapshot(), ownedOrderId).source, "ACK");
  const before = restored.level("B1");
  const cancelled = restored.requestCancel(ownedOrderId, "ACK");
  assert.equal(cancelled.kind, "ACK");
  assert.equal(restored.level("B1").state, "IDLE");
  assert.notEqual(before.state, "IDLE");
});

test("C3-5 authoritative discovery remains OWNED after restart", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const unknown = simulator.submit(intent.intentId, "UNKNOWN");
  assert.equal(unknown.kind, "UNKNOWN");
  assert.equal(simulator.exportSnapshot().authorityLinks.length, 0);
  assert.equal(simulator.canIncreaseRisk(), false);

  const discovered = simulator.discoverOwnedOrder(intent.intentId);
  assert.equal(discovered.ownership, "OWNED");
  const exported = simulator.exportSnapshot();
  const link = findAuthority(exported, discovered.exchangeOrderId);
  assert.equal(link.source, "AUTHORITATIVE_OBSERVATION");
  assert.notEqual(link.source, "ACK");
  assert.equal(link.intentId, intent.intentId);

  const restored = DeterministicSimulator.fromSnapshot(exported);
  assert.equal(
    restored.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: discovered.exchangeOrderId,
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  assert.equal(
    findAuthority(restored.exportSnapshot(), discovered.exchangeOrderId).source,
    "AUTHORITATIVE_OBSERVATION",
  );
  assert.equal(restored.canIncreaseRisk(), true);
  assert.equal(restored.possibleExposure().unknownSubmissions.length, 0);
  assert.equal(restored.level("B1").state, "ENTRY_WORKING");
});

test("C3-6 forged order cannot enter duplicate cleanup", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  assert.ok(intent.clientOrderId);
  simulator.injectForeignOrder({
    exchangeOrderId: "forged-dup",
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
  const byLevel = simulator.planDuplicateCleanup("B1");
  assert.equal(simulator.cancelCandidatesInclude(byLevel, "forged-dup"), false);
  assert.equal(byLevel.cancelExchangeOrderIds.includes("forged-dup"), false);
  assert.equal(byLevel.survivorExchangeOrderId, ownedOrderId);
  const byPrice = simulator.planDuplicateCleanupByPrice("99.4");
  assert.equal(simulator.cancelCandidatesInclude(byPrice, "forged-dup"), false);
  assert.equal(byPrice.cancelExchangeOrderIds.includes("forged-dup"), false);
  assert.equal(byPrice.survivorExchangeOrderId, ownedOrderId);
});

test("C3-7 forged order cannot pass requestCancel", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  ackPlace(simulator, intent.intentId);
  assert.ok(intent.clientOrderId);
  simulator.injectForeignOrder({
    exchangeOrderId: "forged-cancel",
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
  const beforeLevel = simulator.level("B1");
  const beforeOrder = simulator
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "forged-cancel");
  assert.ok(beforeOrder);
  const refused = simulator.requestCancel("forged-cancel", "ACK");
  assert.equal(refused.kind, "NOT_SENT");
  if (refused.kind === "NOT_SENT") {
    assert.equal(refused.reason, "REFUSES_UNPROVEN_CANCEL_AUTHORITY");
  }
  const afterOrder = simulator
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "forged-cancel");
  assert.ok(afterOrder);
  assert.equal(afterOrder.status, beforeOrder.status);
  assert.equal(afterOrder.ownership, "AMBIGUOUS");
  const afterLevel = simulator.level("B1");
  assert.equal(afterLevel.state, beforeLevel.state);
  assert.equal(afterLevel.workingExchangeOrderId, beforeLevel.workingExchangeOrderId);
  assert.equal(afterLevel.entryIntentTerminal, beforeLevel.entryIntentTerminal);
});

test("C3-8 serialized ownership continues to be ignored", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  ackPlace(simulator, intent.intentId);
  assert.ok(intent.clientOrderId);
  const snapshot = simulator.exportSnapshot();
  snapshot.orders.push(
    forgedCurrentScopeOrder({
      exchangeOrderId: "forged-serialized-owned",
      clientOrderId: intent.clientOrderId,
      ownership: "OWNED",
    }),
  );
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.notEqual(
    restored.classifyObserved({
      clientOrderId: intent.clientOrderId,
      exchangeOrderId: "forged-serialized-owned",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "OWNED",
  );
  const observed = restored
    .listOpenOrders()
    .find((order) => order.exchangeOrderId === "forged-serialized-owned");
  assert.equal(observed?.ownership, "AMBIGUOUS");
  const refused = restored.requestCancel("forged-serialized-owned", "ACK");
  assert.equal(refused.kind, "NOT_SENT");
});

test("C3-9 malformed authority fails closed", () => {
  const simulator = DeterministicSimulator.create(testInit());
  const intent = plannedEntry(simulator, "B1");
  const ownedOrderId = ackPlace(simulator, intent.intentId);
  const valid = simulator.exportSnapshot();
  const validLink = findAuthority(valid, ownedOrderId);

  const danglingIntent = structuredClone(valid);
  findAuthority(danglingIntent, ownedOrderId).intentId = "missing-intent";
  assert.throws(() => DeterministicSimulator.fromSnapshot(danglingIntent), SnapshotImportError);

  const danglingOrder = structuredClone(valid);
  findAuthority(danglingOrder, ownedOrderId).exchangeOrderId = "missing-order";
  assert.throws(() => DeterministicSimulator.fromSnapshot(danglingOrder), SnapshotImportError);

  const clientMismatch = structuredClone(valid);
  findAuthority(clientMismatch, ownedOrderId).clientOrderId = "mv1deadbeefdeadbeefde";
  assert.throws(() => DeterministicSimulator.fromSnapshot(clientMismatch), SnapshotImportError);

  const scopeMismatch = structuredClone(valid);
  findAuthority(scopeMismatch, ownedOrderId).scopeKey = "other/sim/BTC_USDC_PERP/grid-v0.1";
  assert.throws(() => DeterministicSimulator.fromSnapshot(scopeMismatch), SnapshotImportError);

  const epochMismatch = structuredClone(valid);
  findAuthority(epochMismatch, ownedOrderId).anchorEpoch = "other-epoch";
  assert.throws(() => DeterministicSimulator.fromSnapshot(epochMismatch), SnapshotImportError);

  const duplicateEvidence = structuredClone(valid);
  duplicateEvidence.authorityLinks.push({
    ...validLink,
    exchangeOrderId: "other-order-for-dup-evidence",
  });
  duplicateEvidence.orders.push({
    ...findOrder(duplicateEvidence, ownedOrderId),
    exchangeOrderId: "other-order-for-dup-evidence",
  });
  assert.throws(() => DeterministicSimulator.fromSnapshot(duplicateEvidence), SnapshotImportError);

  const conflicting = structuredClone(valid);
  conflicting.authorityLinks.push({
    ...validLink,
    evidenceId: `${validLink.evidenceId}-conflict`,
    source: "AUTHORITATIVE_OBSERVATION",
  });
  assert.throws(() => DeterministicSimulator.fromSnapshot(conflicting), SnapshotImportError);

  const nullIntentWithAuthority = structuredClone(valid);
  findOrder(nullIntentWithAuthority, ownedOrderId).intentId = null;
  assert.throws(
    () => DeterministicSimulator.fromSnapshot(nullIntentWithAuthority),
    SnapshotImportError,
  );

  const oldSchema = structuredClone(valid);
  (oldSchema as { schemaVersion: string }).schemaVersion = "phase1-simulator-1";
  assert.throws(() => DeterministicSimulator.fromSnapshot(oldSchema), SnapshotImportError);
});

test("C3-10 ambiguous order remains a risk blocker after restart", () => {
  const simulator = DeterministicSimulator.create(testInit());
  simulator.injectForeignOrder({
    exchangeOrderId: "unproven-restart",
    clientOrderId: "unknown-but-current",
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
  const snapshot = simulator.exportSnapshot();
  snapshot.riskIncreaseBlocked = false;
  const restored = DeterministicSimulator.fromSnapshot(snapshot);
  assert.equal(restored.canIncreaseRisk(), false);
  const planned = restored.planEntries();
  assert.equal(planned.status, "PLANNED");
  if (planned.status === "PLANNED") {
    assert.equal(planned.intents.length, 0);
  }
  assert.equal(
    restored.classifyObserved({
      clientOrderId: "unknown-but-current",
      exchangeOrderId: "unproven-restart",
      scopeKey: CURRENT_SCOPE,
      anchorEpoch: "epoch-1",
    }),
    "AMBIGUOUS",
  );
});
