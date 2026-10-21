import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ClientOrderLookup,
  type ExecutionContradiction,
  type ExecutionPage,
  type ExecutionVenuePort,
  INTENT_JOURNAL_KIND,
  INTENT_JOURNAL_STATE_NAME,
  IntentRegistry,
  IntentRegistryError,
  type IntentRegistryState,
  openDurableExecutionState,
} from "../../src/execution/index.js";
import { initializeExactPair } from "../../src/persistence/atomic-pair-store.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import {
  buildIntent,
  clientIdOf,
  createHarness,
  grant,
  type Harness,
  OBSERVED_AT,
  SCOPE_KEY,
} from "./helpers.js";

// Every order below is for quantity 1 at price 100. Each pair of executions starts with HALF;
// the second one decides whether the exact total is below, equal to or above the order.
const QUANTITY = "1";
const HALF = "0.5";
// HALF + this = 1 - 1e-41, which needs 41 significant digits.
const JUST_BELOW_HALF = `0.4${"9".repeat(40)}`;
const BELOW_TOTAL = `0.${"9".repeat(41)}`;
const BELOW_RESIDUAL = `0.${"0".repeat(40)}1`;
// HALF + this = 1 + 1e-41, which needs 42 significant digits.
const JUST_ABOVE_HALF = `0.5${"0".repeat(39)}1`;
const ABOVE_TOTAL = `1.${"0".repeat(40)}1`;
// A tiny partial fill whose residual, 1 - 6e-41, needs 41 significant digits.
const TINY = `0.${"0".repeat(40)}6`;
const TINY_RESIDUAL = `0.${"9".repeat(40)}4`;
// A quantity whose sum with HALF, or difference from QUANTITY, exceeds the exact digit bound.
const UNBOUNDED = `0.${"0".repeat(1100)}1`;

const ORDER_ID = "sim-order-1";

function quantityIntent(): OrderIntent {
  return buildIntent({ quantity: QUANTITY });
}

function execution(
  intent: OrderIntent,
  executionId: string,
  quantity: string,
  sequence: string | null = null,
): ExecutionObservation {
  return {
    venue: "sim",
    market: "BTC_USDC_PERP",
    executionId,
    exchangeOrderId: ORDER_ID,
    clientOrderId: clientIdOf(intent),
    side: "BUY",
    price: "100",
    quantity,
    feeAmount: null,
    feeAsset: null,
    liquidity: "UNKNOWN",
    meta: {
      venue: "sim",
      source: sequence === null ? "rest" : "stream",
      serverTime: OBSERVED_AT,
      receivedAt: OBSERVED_AT,
      observedAt: OBSERVED_AT,
      freshnessMs: 0,
      sequence,
    },
  };
}

function recorded(executionId: string, quantity: string) {
  return { executionId, exchangeOrderId: ORDER_ID, quantity, price: "100" };
}

function overfill(intent: OrderIntent, executionId: string, quantity: string) {
  return {
    reasonCode: "EXECUTION_OVERFILL",
    executionId,
    exchangeOrderId: ORDER_ID,
    clientOrderId: clientIdOf(intent),
    side: "BUY",
    quantity,
    price: "100",
  } satisfies ExecutionContradiction;
}

function residualOrder(remainingQuantity: string) {
  return {
    side: "BUY",
    price: "100",
    remainingQuantity,
    reduceOnly: false,
    owned: true,
  };
}

function contradictionsOf(state: unknown): unknown {
  return (state as IntentRegistryState).executionContradictions;
}

function recordOf(h: Harness, intent: OrderIntent) {
  const record = h.registry.get(intent.intentId);
  assert.ok(record !== null);
  return record;
}

function assertRegistryError(run: () => unknown, reasonCode: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof IntentRegistryError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

// A port over the venue whose execution pages and client order lookups can be replaced; every
// other call goes straight to the simulated venue.
type Overrides = {
  pageExecutions?: ExecutionObservation[];
  lookup?: (venue: SimulatedVenue) => ClientOrderLookup;
};

async function harnessWith(overrides: Overrides): Promise<Harness> {
  const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
  const port: ExecutionVenuePort = {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: async (clientOrderId) =>
      overrides.lookup === undefined
        ? venue.lookupClientOrder(clientOrderId)
        : overrides.lookup(venue),
    listOpenOrders: () => venue.listOpenOrders(),
    listExecutionsSince: async (cursor): Promise<ExecutionPage> => {
      const page = await venue.listExecutionsSince(cursor);
      return overrides.pageExecutions === undefined
        ? page
        : { ...page, executions: structuredClone(overrides.pageExecutions) };
    },
  };
  return createHarness({ venue, port });
}

async function placeLinked(h: Harness, intent: OrderIntent): Promise<void> {
  await grant(h.coordinator);
  assert.equal((await h.coordinator.submit(intent)).record?.status, "LINKED");
}

async function placeUnknown(h: Harness, intent: OrderIntent): Promise<void> {
  h.venue.scriptPlace("UNKNOWN_ACCEPTED");
  await grant(h.coordinator);
  assert.equal((await h.coordinator.submit(intent)).record?.status, "UNKNOWN");
}

async function cancelUnverified(h: Harness, intent: OrderIntent): Promise<void> {
  h.venue.scriptCancel("UNKNOWN_DROPPED");
  assert.equal((await h.coordinator.cancel(intent.intentId)).record?.status, "CANCEL_UNVERIFIED");
}

// The venue's own view of the order with the given executed quantity and status.
function observedOrder(
  venue: SimulatedVenue,
  intent: OrderIntent,
  executedQuantity: string,
  remainingQuantity: string,
  status: "OPEN" | "FILLED" | "CANCELLED",
) {
  const order = venue.orderForClientOrderId(clientIdOf(intent));
  assert.ok(order !== null);
  return { ...order, executedQuantity, remainingQuantity, status };
}

// Streams HALF and then the given second quantity into a LINKED quantity-1 order.
async function streamPair(second: string) {
  const h = await createHarness();
  const intent = quantityIntent();
  await placeLinked(h, intent);
  assert.deepEqual(
    await h.coordinator.ingestStreamExecution(execution(intent, "exec-a", HALF, "1")),
    { reasonCodes: [], recorded: ["exec-a"] },
  );
  const result = await h.coordinator.ingestStreamExecution(
    execution(intent, "exec-b", second, "2"),
  );
  return { h, intent, result };
}

describe("Gate 3 re-review RC3: stream executions are aggregated exactly", () => {
  test("G3-RC3-1 a pair just below the order quantity stays partial with its exact residual", async () => {
    const { h, intent, result } = await streamPair(JUST_BELOW_HALF);
    assert.deepEqual(result, { reasonCodes: [], recorded: ["exec-b"] });
    const record = recordOf(h, intent);
    assert.equal(record.status, "LINKED");
    assert.equal(record.executedQuantity, BELOW_TOTAL);
    assert.deepEqual(record.executions, [
      recorded("exec-a", HALF),
      recorded("exec-b", JUST_BELOW_HALF),
    ]);
    assert.deepEqual(h.coordinator.exposureReservation(), {
      ownedActiveOrders: [residualOrder(BELOW_RESIDUAL)],
      unknownReservations: [],
    });
  });

  test("G3-RC3-2 control: a pair exactly at the order quantity fills it", async () => {
    const { h, intent, result } = await streamPair(HALF);
    assert.deepEqual(result, { reasonCodes: [], recorded: ["exec-b"] });
    assert.equal(recordOf(h, intent).status, "FILLED");
    assert.equal(recordOf(h, intent).executedQuantity, QUANTITY);
    assert.deepEqual(h.coordinator.exposureReservation(), {
      ownedActiveOrders: [],
      unknownReservations: [],
    });
  });

  test("G3-RC3-3 a pair just above the order quantity is a persisted overfill, never a fill", async () => {
    const { h, intent, result } = await streamPair(JUST_ABOVE_HALF);
    assert.deepEqual(result, { reasonCodes: ["EXECUTION_OVERFILL"], recorded: [] });
    const record = recordOf(h, intent);
    assert.equal(record.status, "LINKED");
    assert.equal(record.executedQuantity, HALF);
    assert.deepEqual(record.executions, [recorded("exec-a", HALF)]);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [
      overfill(intent, "exec-b", JUST_ABOVE_HALF),
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(h.coordinator.exposureReservation(), {
      ownedActiveOrders: [residualOrder(HALF)],
      unknownReservations: [],
    });
  });

  test("G3-RC3-4 a tiny partial fill reserves its exact residual, never less", async () => {
    const h = await createHarness();
    const intent = quantityIntent();
    await placeLinked(h, intent);
    assert.deepEqual(
      await h.coordinator.ingestStreamExecution(execution(intent, "exec-a", TINY, "1")),
      { reasonCodes: [], recorded: ["exec-a"] },
    );
    assert.equal(recordOf(h, intent).executedQuantity, TINY);
    assert.deepEqual(h.coordinator.exposureReservation(), {
      ownedActiveOrders: [residualOrder(TINY_RESIDUAL)],
      unknownReservations: [],
    });
  });
});

describe("Gate 3 re-review RC3: replayed executions are aggregated exactly", () => {
  async function replayPair(second: string) {
    const intent = quantityIntent();
    const pageExecutions: ExecutionObservation[] = [];
    const h = await harnessWith({ pageExecutions });
    await placeLinked(h, intent);
    pageExecutions.push(execution(intent, "exec-a", HALF), execution(intent, "exec-b", second));
    const result = await h.coordinator.replayExecutions();
    return { h, intent, result };
  }

  test("G3-RC3-5 a replayed pair just below the order quantity stays partial", async () => {
    const { h, intent, result } = await replayPair(JUST_BELOW_HALF);
    assert.deepEqual(result, { reasonCodes: [], recorded: ["exec-a", "exec-b"] });
    assert.equal(recordOf(h, intent).status, "LINKED");
    assert.equal(recordOf(h, intent).executedQuantity, BELOW_TOTAL);
    assert.deepEqual(h.coordinator.exposureReservation().ownedActiveOrders, [
      residualOrder(BELOW_RESIDUAL),
    ]);
  });

  test("G3-RC3-6 control: a replayed pair exactly at the order quantity fills it", async () => {
    const { h, intent, result } = await replayPair(HALF);
    assert.deepEqual(result, { reasonCodes: [], recorded: ["exec-a", "exec-b"] });
    assert.equal(recordOf(h, intent).status, "FILLED");
    assert.equal(recordOf(h, intent).executedQuantity, QUANTITY);
  });

  test("G3-RC3-7 a replayed pair just above the order quantity is a persisted overfill", async () => {
    const { h, intent, result } = await replayPair(JUST_ABOVE_HALF);
    assert.deepEqual(result, {
      reasonCodes: ["EXECUTION_OVERFILL", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.equal(recordOf(h, intent).status, "LINKED");
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.deepEqual(contradictionsOf(h.journal.latest()), [
      overfill(intent, "exec-a", HALF),
      overfill(intent, "exec-b", JUST_ABOVE_HALF),
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });
});

describe("Gate 3 re-review RC3: reconciliation lookups are aggregated exactly", () => {
  async function lookupPair(
    second: string,
    order: (venue: SimulatedVenue, intent: OrderIntent) => ClientOrderLookup["order"],
  ) {
    const intent = quantityIntent();
    const h = await harnessWith({
      lookup: (venue) => ({
        order: order(venue, intent),
        executions: [execution(intent, "exec-a", HALF), execution(intent, "exec-b", second)],
      }),
    });
    await placeUnknown(h, intent);
    const result = await h.coordinator.reconcileUnresolved();
    return { h, intent, result };
  }

  const noOrder = () => null;

  test("G3-RC3-8 a pair just below the quantity without the order proves nothing", async () => {
    const { h, intent, result } = await lookupPair(JUST_BELOW_HALF, noOrder);
    assert.deepEqual(result.items, [
      { intentId: intent.intentId, status: "UNKNOWN", reasonCodes: ["ORDER_STATE_UNPROVEN"] },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("G3-RC3-9 a pair just below the quantity of an open order links it as partial", async () => {
    const { h, intent, result } = await lookupPair(JUST_BELOW_HALF, (venue, item) =>
      observedOrder(venue, item, BELOW_TOTAL, BELOW_RESIDUAL, "OPEN"),
    );
    assert.deepEqual(result.items, [
      {
        intentId: intent.intentId,
        status: "LINKED",
        reasonCodes: ["RECONCILED_BY_CLIENT_ORDER_ID"],
      },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, BELOW_TOTAL);
    assert.deepEqual(h.coordinator.exposureReservation().ownedActiveOrders, [
      residualOrder(BELOW_RESIDUAL),
    ]);
  });

  test("G3-RC3-10 control: a pair exactly at the quantity of a filled order links it", async () => {
    const { h, intent, result } = await lookupPair(HALF, (venue, item) =>
      observedOrder(venue, item, QUANTITY, "0", "FILLED"),
    );
    assert.deepEqual(result.items, [
      {
        intentId: intent.intentId,
        status: "LINKED",
        reasonCodes: ["RECONCILED_BY_CLIENT_ORDER_ID"],
      },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, QUANTITY);
  });

  test("G3-RC3-11 a pair just above the quantity is an unresolved overfill", async () => {
    const { h, intent, result } = await lookupPair(JUST_ABOVE_HALF, noOrder);
    assert.deepEqual(result.items, [
      { intentId: intent.intentId, status: "UNKNOWN", reasonCodes: ["LOOKUP_OVERFILL"] },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });
});

describe("Gate 3 re-review RC3: cancel lookups are aggregated exactly", () => {
  async function cancelLookupPair(
    second: string,
    order: (venue: SimulatedVenue, intent: OrderIntent) => ClientOrderLookup["order"],
  ) {
    const intent = quantityIntent();
    let lookups = 0;
    const h = await harnessWith({
      lookup: (venue) => {
        lookups += 1;
        return {
          order: order(venue, intent),
          executions: [execution(intent, "exec-a", HALF), execution(intent, "exec-b", second)],
        };
      },
    });
    await placeLinked(h, intent);
    await cancelUnverified(h, intent);
    const result = await h.coordinator.reconcileUnresolved();
    assert.equal(lookups, 1);
    return { h, intent, result };
  }

  const noOrder = () => null;

  test("G3-RC3-12 a pair just below the quantity without the order is never a fill", async () => {
    const { h, intent, result } = await cancelLookupPair(JUST_BELOW_HALF, noOrder);
    assert.deepEqual(result.items, [
      {
        intentId: intent.intentId,
        status: "CANCEL_UNVERIFIED",
        reasonCodes: ["ORDER_NOT_OBSERVED"],
      },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("G3-RC3-13 a pair just below the quantity of a cancelled order keeps the partial", async () => {
    const { h, intent, result } = await cancelLookupPair(JUST_BELOW_HALF, (venue, item) =>
      observedOrder(venue, item, BELOW_TOTAL, BELOW_RESIDUAL, "CANCELLED"),
    );
    assert.deepEqual(result.items, [
      { intentId: intent.intentId, status: "CANCELLED", reasonCodes: ["CANCEL_VERIFIED"] },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, BELOW_TOTAL);
  });

  test("G3-RC3-14 control: a pair exactly at the quantity fills the order", async () => {
    const { h, intent, result } = await cancelLookupPair(HALF, noOrder);
    assert.deepEqual(result.items, [
      {
        intentId: intent.intentId,
        status: "FILLED",
        reasonCodes: ["FILLED_BY_EXECUTION_EVIDENCE"],
      },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, QUANTITY);
  });

  test("G3-RC3-15 a pair just above the quantity is an unresolved overfill", async () => {
    const { h, intent, result } = await cancelLookupPair(JUST_ABOVE_HALF, noOrder);
    assert.deepEqual(result.items, [
      {
        intentId: intent.intentId,
        status: "CANCEL_UNVERIFIED",
        reasonCodes: ["LOOKUP_OVERFILL"],
      },
    ]);
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });
});

describe("Gate 3 re-review RC3: reopen keeps exact quantities and raw evidence", () => {
  // Reopens the journal into a coordinator that neither replays nor scans.
  async function reopen(h: Harness) {
    const registry = IntentRegistry.fromState(h.journal.latest());
    return createHarness({ venue: h.venue, registry, replay: false, scan: false });
  }

  test("G3-RC3-16 a partial just below the quantity reopens with its exact residual", async () => {
    const { h, intent } = await streamPair(JUST_BELOW_HALF);
    const reopened = await reopen(h);
    assert.equal(recordOf(reopened, intent).status, "LINKED");
    assert.equal(recordOf(reopened, intent).executedQuantity, BELOW_TOTAL);
    assert.deepEqual(reopened.coordinator.exposureReservation().ownedActiveOrders, [
      residualOrder(BELOW_RESIDUAL),
    ]);
  });

  test("G3-RC3-17 control: a fill exactly at the quantity reopens as FILLED", async () => {
    const { h, intent } = await streamPair(HALF);
    const reopened = await reopen(h);
    assert.equal(recordOf(reopened, intent).status, "FILLED");
    assert.equal(recordOf(reopened, intent).executedQuantity, QUANTITY);
  });

  test("G3-RC3-18 an overfill just above the quantity reopens as a blocking contradiction", async () => {
    const { h, intent } = await streamPair(JUST_ABOVE_HALF);
    const reopened = await reopen(h);
    assert.equal(recordOf(reopened, intent).executedQuantity, HALF);
    assert.deepEqual(reopened.registry.executionContradictions(), [
      overfill(intent, "exec-b", JUST_ABOVE_HALF),
    ]);
    assert.equal(reopened.coordinator.canIncreaseRisk(), false);
  });
});

// Old-state fixtures: what a build that rounded execution aggregates to 40 significant digits
// would have persisted. Each record keeps its raw executions; only the aggregate and status
// were rounded onto the order quantity.
async function roundedState(second: string): Promise<IntentRegistryState> {
  const { h } = await streamPair(JUST_BELOW_HALF);
  const state = h.journal.latest() as IntentRegistryState;
  const record = state.records[0];
  assert.ok(record !== undefined);
  record.status = "FILLED";
  record.executedQuantity = QUANTITY;
  record.reasonCodes = ["FILLED_BY_EXECUTION_EVIDENCE"];
  const last = record.executions[1];
  assert.ok(last !== undefined);
  last.quantity = second;
  return state;
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "g3-rc3-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Gate 3 re-review RC3: rounded historical records (REVIEW_CHANGE_PROTOCOL §13)", () => {
  test("G3-RC3-19 a record rounded up from just below the quantity fails closed on import", async () => {
    const state = await roundedState(JUST_BELOW_HALF);
    assertRegistryError(() => IntentRegistry.fromState(state), "IMPORT_EXECUTED_QUANTITY_MISMATCH");
  });

  test("G3-RC3-20 a record rounded down from just above the quantity fails closed on import", async () => {
    const state = await roundedState(JUST_ABOVE_HALF);
    assertRegistryError(() => IntentRegistry.fromState(state), "IMPORT_EXECUTED_QUANTITY_MISMATCH");
  });

  test("G3-RC3-21 a durable reopen of a rounded record fails closed and leaves its bytes", async () => {
    const state = await roundedState(JUST_BELOW_HALF);
    await withDirectory(async (directory) => {
      const seeded = await initializeExactPair({
        directory,
        stateName: INTENT_JOURNAL_STATE_NAME,
        expectedKind: INTENT_JOURNAL_KIND,
        expectedScopeKey: SCOPE_KEY,
        payload: state,
        latch: new RuntimePersistenceLatch(),
        bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
      });
      assert.equal(seeded.disposition, "REQUESTED_STATE_COMMITTED");
      const primary = path.join(directory, `${INTENT_JOURNAL_STATE_NAME}.json`);
      const files = async () =>
        Promise.all([readFile(primary, "utf8"), readFile(`${primary}.bak`, "utf8")]);
      const before = await files();
      const opened = await openDurableExecutionState({
        directory,
        scopeKey: SCOPE_KEY,
        latch: new RuntimePersistenceLatch(),
      });
      assert.deepEqual(opened, {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_EXECUTED_QUANTITY_MISMATCH"],
      });
      assert.deepEqual(await files(), before);
    });
  });

  test("G3-RC3-22 control: an exact record of the same executions imports unchanged", async () => {
    const { h } = await streamPair(JUST_BELOW_HALF);
    const state = h.journal.latest() as IntentRegistryState;
    assert.deepEqual(IntentRegistry.fromState(state).exportState(), state);
  });
});

describe("Gate 3 re-review RC3: aggregates beyond the exact digit bound fail closed", () => {
  test("G3-RC3-23 a stream execution whose total is unbounded is refused and blocks", async () => {
    const { h, intent, result } = await streamPair(UNBOUNDED);
    assert.deepEqual(result, { reasonCodes: ["EXECUTION_QUANTITY_UNBOUNDED"], recorded: [] });
    assert.equal(recordOf(h, intent).executedQuantity, HALF);
    assert.deepEqual(recordOf(h, intent).executions, [recorded("exec-a", HALF)]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("G3-RC3-24 a replayed page whose total is unbounded is refused and blocks", async () => {
    const intent = quantityIntent();
    const pageExecutions: ExecutionObservation[] = [];
    const h = await harnessWith({ pageExecutions });
    await placeLinked(h, intent);
    pageExecutions.push(execution(intent, "exec-a", HALF), execution(intent, "exec-b", UNBOUNDED));
    const cursor = h.coordinator.executionCursor();
    const result = await h.coordinator.replayExecutions();
    assert.deepEqual(result, {
      reasonCodes: ["EXECUTION_QUANTITY_UNBOUNDED", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.deepEqual(h.coordinator.executionCursor(), cursor);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("G3-RC3-25 a lookup whose total is unbounded stays unresolved", async () => {
    const intent = quantityIntent();
    const h = await harnessWith({
      lookup: () => ({
        order: null,
        executions: [execution(intent, "exec-a", HALF), execution(intent, "exec-b", UNBOUNDED)],
      }),
    });
    await placeUnknown(h, intent);
    const result = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(result.items, [
      { intentId: intent.intentId, status: "UNKNOWN", reasonCodes: ["LOOKUP_QUANTITY_UNBOUNDED"] },
    ]);
  });

  test("G3-RC3-26 a cancel lookup whose total is unbounded stays unresolved", async () => {
    const intent = quantityIntent();
    const h = await harnessWith({
      lookup: () => ({
        order: null,
        executions: [execution(intent, "exec-a", HALF), execution(intent, "exec-b", UNBOUNDED)],
      }),
    });
    await placeLinked(h, intent);
    await cancelUnverified(h, intent);
    const result = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(result.items, [
      {
        intentId: intent.intentId,
        status: "CANCEL_UNVERIFIED",
        reasonCodes: ["LOOKUP_QUANTITY_UNBOUNDED"],
      },
    ]);
  });

  test("G3-RC3-27 the registry refuses an unbounded total on link and on import", async () => {
    const intent = quantityIntent();
    const registry = new IntentRegistry();
    registry.prepare(intent);
    assertRegistryError(
      () =>
        registry.link(intent.intentId, {
          exchangeOrderId: ORDER_ID,
          authority: { source: "AUTHORITATIVE_OBSERVATION", evidenceId: `order:${ORDER_ID}` },
          executions: [recorded("exec-a", HALF), recorded("exec-b", UNBOUNDED)],
          reasonCodes: [],
        }),
      "EXECUTION_QUANTITY_UNBOUNDED",
    );
    const state = await roundedState(UNBOUNDED);
    assertRegistryError(() => IntentRegistry.fromState(state), "EXECUTION_QUANTITY_UNBOUNDED");
  });

  test("G3-RC3-28 a residual beyond the exact digit bound reserves the full quantity", async () => {
    const h = await createHarness();
    const intent = quantityIntent();
    await placeLinked(h, intent);
    assert.deepEqual(
      await h.coordinator.ingestStreamExecution(execution(intent, "exec-a", UNBOUNDED, "1")),
      { reasonCodes: [], recorded: ["exec-a"] },
    );
    assert.deepEqual(h.coordinator.exposureReservation(), {
      ownedActiveOrders: [residualOrder(QUANTITY)],
      unknownReservations: [],
    });
  });
});

describe("Gate 3 re-review RC3: a single execution is never rounded", () => {
  async function streamSingle(quantity: string) {
    const h = await createHarness();
    const intent = quantityIntent();
    await placeLinked(h, intent);
    const result = await h.coordinator.ingestStreamExecution(
      execution(intent, "exec-a", quantity, "1"),
    );
    return { h, intent, result };
  }

  test("G3-RC3-29 one execution just below the order quantity stays partial through reopen", async () => {
    const { h, intent, result } = await streamSingle(BELOW_TOTAL);
    assert.deepEqual(result, { reasonCodes: [], recorded: ["exec-a"] });
    assert.equal(recordOf(h, intent).status, "LINKED");
    assert.equal(recordOf(h, intent).executedQuantity, BELOW_TOTAL);
    assert.deepEqual(h.coordinator.exposureReservation().ownedActiveOrders, [
      residualOrder(BELOW_RESIDUAL),
    ]);
    const reopened = IntentRegistry.fromState(h.journal.latest()).get(intent.intentId);
    assert.equal(reopened?.status, "LINKED");
    assert.equal(reopened?.executedQuantity, BELOW_TOTAL);
  });

  test("G3-RC3-30 one execution just above the order quantity is a persisted overfill through reopen", async () => {
    const { h, intent, result } = await streamSingle(ABOVE_TOTAL);
    assert.deepEqual(result, { reasonCodes: ["EXECUTION_OVERFILL"], recorded: [] });
    assert.equal(recordOf(h, intent).status, "LINKED");
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.deepEqual(contradictionsOf(h.journal.latest()), [
      overfill(intent, "exec-a", ABOVE_TOTAL),
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(h.coordinator.exposureReservation().ownedActiveOrders, [
      residualOrder(QUANTITY),
    ]);
    const reopened = IntentRegistry.fromState(h.journal.latest());
    assert.equal(reopened.get(intent.intentId)?.executedQuantity, "0");
    assert.deepEqual(reopened.executionContradictions(), [overfill(intent, "exec-a", ABOVE_TOTAL)]);
  });
});
