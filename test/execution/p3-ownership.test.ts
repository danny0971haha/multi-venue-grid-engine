import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { isEngineClientOrderId, makeClientOrderId } from "../../src/domain/ids.js";
import type { ExchangeOrderObservation, OrderIntent } from "../../src/domain/types.js";
import {
  createLeaseMutationFence,
  type ExecutionVenuePort,
  type ExposureInputSource,
  type FenceResult,
  IntentRegistry,
  type IntentRegistryState,
  type MutationFence,
} from "../../src/execution/index.js";
import {
  acquireRuntimeLease,
  fixedLeaseClock,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { plannedExposureDecision } from "../../src/risk/index.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import {
  buildIntent,
  clientIdOf,
  createHarness,
  grant,
  type Harness,
  MemoryJournal,
  OBSERVED_AT,
  openFence,
  SCOPE_KEY,
} from "./helpers.js";

const EPOCH = "epoch-1";

function newVenue(): SimulatedVenue {
  return new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
}

// A port over the venue whose open-order snapshot can be replaced.
function portWithSnapshot(
  venue: SimulatedVenue,
  listOpenOrders: () => Promise<unknown>,
): ExecutionVenuePort {
  return {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
    listOpenOrders: listOpenOrders as ExecutionVenuePort["listOpenOrders"],
    listExecutionsSince: (cursor) => venue.listExecutionsSince(cursor),
  };
}

// Lets mutations run except where the script says NOT_SENT; unscripted calls are sent.
function scriptedFence(...outcomes: Array<"SENT" | "NOT_SENT">): MutationFence {
  const open = openFence();
  return {
    leaseGeneration: "1",
    async run<T>(mutation: () => Promise<T>): Promise<FenceResult<T>> {
      if ((outcomes.shift() ?? "SENT") === "NOT_SENT") {
        return { outcome: "NOT_SENT", value: null, reasonCodes: ["MUTATION_NOT_SENT"] };
      }
      return open.run(mutation);
    },
  };
}

function exposureOf(signedPosition: string | null, markOrMidPrice: string | null) {
  return { read: async () => ({ signedPosition, markOrMidPrice }) };
}

async function placeLinked(h: Harness, intent: OrderIntent): Promise<OrderIntent> {
  if (!intent.reduceOnly) {
    await grant(h.coordinator);
  }
  const placed = await h.coordinator.submit(intent);
  assert.equal(placed.record?.status, "LINKED");
  return intent;
}

// Places `count` linked orders in slot B1, so each is an owned duplicate of the first.
async function placeDuplicates(h: Harness, count: number): Promise<OrderIntent[]> {
  const intents: OrderIntent[] = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    intents.push(await placeLinked(h, buildIntent({ sequence: String(sequence) })));
  }
  return intents;
}

// A harness whose open-order snapshot shows nothing while `lagging` is set, as a venue whose
// order list has not caught up with its acknowledgements. The continuation gate's scan sees
// only the snapshot, so this is how more than two owned duplicates can accumulate.
async function laggingHarness(
  options: { fence?: MutationFence; writeBudgetPerCycle?: number } = {},
): Promise<{ h: Harness; lag: { lagging: boolean } }> {
  const venue = newVenue();
  const lag = { lagging: false };
  const port = portWithSnapshot(venue, async () => (lag.lagging ? [] : venue.listOpenOrders()));
  return { h: await createHarness({ ...options, venue, port }), lag };
}

function openIds(venue: SimulatedVenue): Promise<string[]> {
  return venue.listOpenOrders().then((orders) => orders.map((order) => order.exchangeOrderId));
}

function ownershipById(scan: { orders: Array<{ exchangeOrderId: string; ownership: string }> }) {
  return Object.fromEntries(scan.orders.map((order) => [order.exchangeOrderId, order.ownership]));
}

describe("P3-E09 owned duplicate cleanup", () => {
  test("the survivor is the lowest exchange order ID, whatever the snapshot order", async () => {
    for (const reversed of [false, true]) {
      const venue = newVenue();
      const port = portWithSnapshot(venue, async () => {
        const orders = await venue.listOpenOrders();
        return reversed ? orders.reverse() : orders;
      });
      const h = await createHarness({ venue, port });
      const [first, second] = await placeDuplicates(h, 2);
      assert.ok(first !== undefined && second !== undefined);

      const scan = await h.coordinator.scanOpenOrders(EPOCH);
      assert.deepEqual(scan.reasonCodes, ["OWNED_DUPLICATE_OPEN_ORDER"]);
      assert.deepEqual(ownershipById(scan), { "sim-order-1": "OWNED", "sim-order-2": "OWNED" });
      assert.deepEqual(scan.duplicates, [
        {
          logicalLevelId: "B1",
          survivorExchangeOrderId: "sim-order-1",
          cancelExchangeOrderIds: ["sim-order-2"],
          disposition: "CANCEL_OWNED_DUPLICATE",
        },
      ]);
      assert.equal(h.coordinator.canIncreaseRisk(), false);
      const blocked = await h.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
      assert.deepEqual(blocked.reasonCodes, ["OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE"]);

      const cleanup = await h.coordinator.cleanupOwnedDuplicates(EPOCH);
      assert.deepEqual(cleanup.reasonCodes, []);
      assert.deepEqual(
        cleanup.cancels.map(({ intentId, exchangeOrderId, status }) => ({
          intentId,
          exchangeOrderId,
          status,
        })),
        [
          {
            intentId: second.intentId,
            exchangeOrderId: "sim-order-2",
            status: "CANCEL_UNVERIFIED",
          },
        ],
      );
      assert.equal(venue.calls.cancel, 1);
      assert.deepEqual(await openIds(venue), ["sim-order-1"]);
    }
  });

  test("a cancelled duplicate stays reserved until reconciliation proves it closed", async () => {
    const h = await createHarness();
    await placeDuplicates(h, 2);
    await h.coordinator.cleanupOwnedDuplicates(EPOCH);

    assert.equal(h.coordinator.exposureReservation().ownedActiveOrders.length, 2);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    // The duplicate is gone from the venue, but its cancel is not yet resolved.
    assert.deepEqual((await h.coordinator.scanOpenOrders(EPOCH)).reasonCodes, []);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(
      reconciled.items.map((item) => item.status),
      ["CANCELLED"],
    );
    assert.equal(h.coordinator.exposureReservation().ownedActiveOrders.length, 1);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("a duplicate whose cancel is unverified and still open keeps blocking", async () => {
    const h = await createHarness();
    await placeDuplicates(h, 2);
    h.venue.scriptCancel("UNKNOWN_DROPPED");
    await h.coordinator.cleanupOwnedDuplicates(EPOCH);
    const rescan = await h.coordinator.scanOpenOrders(EPOCH);
    assert.deepEqual(rescan.reasonCodes, ["OWNED_DUPLICATE_OPEN_ORDER"]);

    // A second cleanup does not resend the unresolved cancel.
    const again = await h.coordinator.cleanupOwnedDuplicates(EPOCH);
    assert.deepEqual(again.cancels[0]?.reasonCodes, ["CANCEL_UNRESOLVED"]);
    assert.equal(h.venue.calls.cancel, 1);
  });

  test("a cancel that is not sent stops the cleanup before later sends", async () => {
    const { h, lag } = await laggingHarness({
      fence: scriptedFence("SENT", "SENT", "SENT", "NOT_SENT"),
    });
    lag.lagging = true;
    const [, second, third] = await placeDuplicates(h, 3);
    lag.lagging = false;
    assert.ok(second !== undefined && third !== undefined);

    const cleanup = await h.coordinator.cleanupOwnedDuplicates(EPOCH);
    assert.deepEqual(cleanup.reasonCodes, ["CLEANUP_INCOMPLETE"]);
    assert.deepEqual(cleanup.cancels, [
      {
        intentId: second.intentId,
        exchangeOrderId: "sim-order-2",
        status: "LINKED",
        reasonCodes: ["FENCE_NOT_SENT", "MUTATION_NOT_SENT"],
      },
      {
        intentId: third.intentId,
        exchangeOrderId: "sim-order-3",
        status: "LINKED",
        reasonCodes: ["CLEANUP_STOPPED_BEFORE_SEND", "PRIOR_CANCEL_NOT_SENT"],
      },
    ]);
    assert.equal(h.venue.calls.cancel, 0);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });
});

describe("P3-E10 ownership classification", () => {
  test("cleanup never cancels unowned or ambiguous orders, which keep blocking risk", async () => {
    const h = await createHarness();
    await placeDuplicates(h, 2);
    // Same side, price and quantity as the owned orders; only the client order ID differs.
    h.venue.addForeignOrder({
      clientOrderId: "manual-1",
      side: "BUY",
      price: "100",
      quantity: "0.01",
    });
    h.venue.addForeignOrder({ clientOrderId: null, side: "SELL", price: "101", quantity: "0.01" });
    const lookalike = `mv1${"0".repeat(20)}`;
    h.venue.addForeignOrder({ clientOrderId: lookalike, side: "BUY", price: "98", quantity: "1" });

    const scan = await h.coordinator.scanOpenOrders(EPOCH);
    assert.deepEqual(scan.reasonCodes, [
      "AMBIGUOUS_OPEN_ORDER",
      "OWNED_DUPLICATE_OPEN_ORDER",
      "UNOWNED_OPEN_ORDER",
    ]);
    assert.deepEqual(ownershipById(scan), {
      "sim-order-1": "OWNED",
      "sim-order-2": "OWNED",
      "sim-order-3": "UNOWNED",
      "sim-order-4": "AMBIGUOUS",
      "sim-order-5": "AMBIGUOUS",
    });

    const cleanup = await h.coordinator.cleanupOwnedDuplicates(EPOCH);
    assert.deepEqual(
      cleanup.cancels.map((cancel) => cancel.exchangeOrderId),
      ["sim-order-2"],
    );
    assert.equal(h.venue.calls.cancel, 1);
    await h.coordinator.reconcileUnresolved();
    assert.deepEqual(await openIds(h.venue), [
      "sim-order-1",
      "sim-order-3",
      "sim-order-4",
      "sim-order-5",
    ]);

    const rescan = await h.coordinator.scanOpenOrders(EPOCH);
    assert.deepEqual(rescan.reasonCodes, ["AMBIGUOUS_OPEN_ORDER", "UNOWNED_OPEN_ORDER"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    const entry = await h.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
    assert.deepEqual(entry.reasonCodes, ["OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE"]);
    const exit = await h.coordinator.submit(
      buildIntent({ logicalLevelId: "S1", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true }),
    );
    assert.equal(exit.record?.status, "LINKED");
  });

  test("an engine order from an older anchor epoch is unowned and not cleaned up", async () => {
    const h = await createHarness();
    await placeDuplicates(h, 2);
    const scan = await h.coordinator.scanOpenOrders("epoch-2");
    assert.deepEqual(scan.reasonCodes, ["UNOWNED_OPEN_ORDER"]);
    assert.deepEqual(scan.duplicates, []);
    await h.coordinator.cleanupOwnedDuplicates("epoch-2");
    assert.equal(h.venue.calls.cancel, 0);
  });

  test("an order that contradicts its record is ambiguous and not a duplicate", async () => {
    const venue = newVenue();
    const port = portWithSnapshot(venue, async () =>
      (await venue.listOpenOrders()).map((order) =>
        order.exchangeOrderId === "sim-order-2" ? { ...order, price: "101" } : order,
      ),
    );
    const h = await createHarness({ venue, port });
    await placeDuplicates(h, 2);

    const scan = await h.coordinator.scanOpenOrders(EPOCH);
    assert.deepEqual(ownershipById(scan), { "sim-order-1": "OWNED", "sim-order-2": "AMBIGUOUS" });
    assert.deepEqual(scan.reasonCodes, ["AMBIGUOUS_OPEN_ORDER"]);
    await h.coordinator.cleanupOwnedDuplicates(EPOCH);
    assert.equal(venue.calls.cancel, 0);
  });

  test("a venue reporting fewer executions than recorded is ambiguous", async () => {
    const venue = newVenue();
    let regress = false;
    const port = portWithSnapshot(venue, async () =>
      (await venue.listOpenOrders()).map((order) =>
        regress ? { ...order, executedQuantity: "0", remainingQuantity: "0.01" } : order,
      ),
    );
    const h = await createHarness({ venue, port });
    const intent = await placeLinked(h, buildIntent());
    venue.fill("sim-order-1", "0.004", "100");
    // An unverified cancel whose order is still open brings the execution into the record.
    venue.scriptCancel("UNKNOWN_DROPPED");
    await h.coordinator.cancel(intent.intentId);
    await h.coordinator.reconcileUnresolved();
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.status, "LINKED");
    assert.equal(record?.executedQuantity, "0.004");

    assert.deepEqual((await h.coordinator.scanOpenOrders(EPOCH)).reasonCodes, []);
    regress = true;
    const scan = await h.coordinator.scanOpenOrders(EPOCH);
    assert.deepEqual(ownershipById(scan), { "sim-order-1": "AMBIGUOUS" });
  });

  test("a closed record's order observed open again is not owned", async () => {
    const venue = newVenue();
    const stale: ExchangeOrderObservation[] = [];
    const port = portWithSnapshot(venue, async () => structuredClone(stale));
    const h = await createHarness({ venue, port });
    const intent = await placeLinked(h, buildIntent());
    const observed = venue.orderForClientOrderId(clientIdOf(intent));
    assert.ok(observed !== null);
    stale.push(observed);
    await h.coordinator.cancel(intent.intentId);
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "CANCELLED");

    const scan = await h.coordinator.scanOpenOrders(EPOCH);
    assert.deepEqual(ownershipById(scan), { "sim-order-1": "AMBIGUOUS" });
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a failed or invalid snapshot blocks risk increase until a clean scan", async () => {
    const venue = newVenue();
    let snapshot: () => Promise<unknown> = () => venue.listOpenOrders();
    const h = await createHarness({ venue, port: portWithSnapshot(venue, () => snapshot()) });
    await placeLinked(h, buildIntent());
    const valid = (await venue.listOpenOrders())[0];
    assert.ok(valid !== undefined);

    snapshot = async () => {
      throw new Error("TEST_LIST_FAILED");
    };
    assert.deepEqual((await h.coordinator.scanOpenOrders(EPOCH)).reasonCodes, [
      "OPEN_ORDER_SCAN_FAILED",
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const invalidSnapshots: unknown[] = [
      null,
      { orders: [valid] },
      [null],
      [{ ...valid, venue: "other" }],
      [{ ...valid, market: "ETH_USDC_PERP" }],
      [{ ...valid, exchangeOrderId: "" }],
      [{ ...valid, status: "FILLED" }],
      [{ ...valid, clientOrderId: "" }],
      [valid, valid],
    ];
    for (const invalid of invalidSnapshots) {
      snapshot = async () => invalid;
      const scan = await h.coordinator.scanOpenOrders(EPOCH);
      assert.deepEqual(
        scan.reasonCodes,
        ["OPEN_ORDER_OBSERVATION_INVALID"],
        JSON.stringify(invalid),
      );
      assert.equal(h.coordinator.canIncreaseRisk(), false);
    }

    snapshot = () => venue.listOpenOrders();
    assert.deepEqual((await h.coordinator.scanOpenOrders(EPOCH)).reasonCodes, []);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("a scan that throws unexpectedly leaves risk increase blocked", async () => {
    const venue = newVenue();
    let poison = false;
    const port = portWithSnapshot(venue, async () => {
      const orders = await venue.listOpenOrders();
      if (!poison) {
        return orders;
      }
      // Passes snapshot validation, then throws while the record is matched.
      return orders.map((order) => ({
        ...order,
        get price(): string {
          throw new Error("TEST_POISONED_OBSERVATION");
        },
      }));
    });
    const h = await createHarness({ venue, port });
    await placeLinked(h, buildIntent());
    assert.deepEqual((await h.coordinator.scanOpenOrders(EPOCH)).reasonCodes, []);
    poison = true;
    await assert.rejects(h.coordinator.scanOpenOrders(EPOCH), /TEST_POISONED_OBSERVATION/);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("engine client order ID format check", () => {
    const engine = makeClientOrderId({
      scopeKey: SCOPE_KEY,
      anchorEpoch: EPOCH,
      logicalLevelId: "B1",
      purpose: "GRID_ENTRY",
      intentId: "intent-1",
    });
    assert.equal(isEngineClientOrderId(engine), true);
    for (const other of [
      "manual-1",
      `mv1${"0".repeat(19)}`,
      `mv1${"0".repeat(21)}`,
      `mv1${"A".repeat(20)}`,
      `xmv1${"0".repeat(20)}`,
      `0x${"0".repeat(32)}`,
    ]) {
      assert.equal(isEngineClientOrderId(other), false, other);
    }
  });
});

describe("P3-E11 whole-batch exposure gate", () => {
  test("a batch over the cap with existing reservations sends nothing", async () => {
    const h = await createHarness();
    await placeLinked(h, buildIntent({ quantity: "0.7" }));

    await grant(h.coordinator);
    const over = await h.coordinator.submitBatch([
      buildIntent({ logicalLevelId: "B2", quantity: "0.4" }),
      buildIntent({ logicalLevelId: "B3", quantity: "0.41" }),
    ]);
    assert.deepEqual(over, {
      disposition: "REFUSED",
      reasonCodes: ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"],
      items: [],
    });
    assert.equal(h.venue.calls.place, 1);
    assert.equal(h.registry.list().length, 1);

    await grant(h.coordinator);
    const fits = await h.coordinator.submitBatch([
      buildIntent({ logicalLevelId: "B2", quantity: "0.4" }),
      buildIntent({ logicalLevelId: "B3", quantity: "0.4" }),
    ]);
    assert.equal(fits.disposition, "SUBMITTED");
    assert.deepEqual(
      fits.items.map((item) => item.status),
      ["LINKED", "LINKED"],
    );

    await grant(h.coordinator);
    const single = await h.coordinator.submit(buildIntent({ logicalLevelId: "B4" }));
    assert.deepEqual(single.reasonCodes, ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"]);
    assert.equal(h.venue.calls.place, 3);
  });

  test("the position counts and opposite sides do not net", async () => {
    const h = await createHarness({ exposure: exposureOf("1", "100") });
    await grant(h.coordinator);
    const buy = await h.coordinator.submit(buildIntent({ quantity: "0.51" }));
    assert.deepEqual(buy.reasonCodes, ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"]);
    await grant(h.coordinator);
    const sell = await h.coordinator.submit(
      buildIntent({ logicalLevelId: "S1", side: "SELL", quantity: "1.51" }),
    );
    assert.deepEqual(sell.reasonCodes, ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"]);
    assert.equal(h.venue.calls.place, 0);
    await grant(h.coordinator);
    const fits = await h.coordinator.submit(buildIntent({ quantity: "0.5" }));
    assert.equal(fits.record?.status, "LINKED");
  });

  test("missing or failing exposure inputs refuse risk increase", async () => {
    const throwing: ExposureInputSource = {
      read: async () => {
        throw new Error("TEST_EXPOSURE_READ_FAILED");
      },
    };
    const cases: Array<[ExposureInputSource, string[]]> = [
      [throwing, ["PLANNED_EXPOSURE_DENIED", "EXPOSURE_INPUT_UNAVAILABLE"]],
      [
        { read: async () => null as never },
        ["PLANNED_EXPOSURE_DENIED", "EXPOSURE_INPUT_UNAVAILABLE"],
      ],
      [exposureOf(null, "100"), ["PLANNED_EXPOSURE_DENIED", "STALE_OR_MISSING_INPUT"]],
      [exposureOf("0", null), ["PLANNED_EXPOSURE_DENIED", "STALE_OR_MISSING_INPUT"]],
    ];
    for (const [exposure, reasonCodes] of cases) {
      const h = await createHarness({ exposure });
      await grant(h.coordinator);
      assert.deepEqual((await h.coordinator.submit(buildIntent())).reasonCodes, reasonCodes);
      await grant(h.coordinator);
      const batch = await h.coordinator.submitBatch([buildIntent()]);
      assert.deepEqual(batch.reasonCodes, reasonCodes);
      assert.equal(h.venue.calls.place, 0);
      assert.equal(h.registry.list().length, 0);
    }
  });

  test("reduce-only exits skip the gate; a reduce-only entry is still counted", async () => {
    const h = await createHarness({
      exposure: {
        read: async () => {
          throw new Error("TEST_EXPOSURE_READ_FAILED");
        },
      },
    });
    const exits = await h.coordinator.submitBatch([
      buildIntent({ logicalLevelId: "S1", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true }),
      buildIntent({ logicalLevelId: "S2", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true }),
    ]);
    assert.equal(exits.disposition, "SUBMITTED");

    const gated = await createHarness({ exposure: exposureOf("0", "100") });
    await grant(gated.coordinator);
    const entry = await gated.coordinator.submit(
      buildIntent({ quantity: "1.51", reduceOnly: true }),
    );
    assert.deepEqual(entry.reasonCodes, ["PLANNED_EXPOSURE_DENIED", "PLANNED_NOTIONAL"]);
  });

  test("a market entry is unbounded and refused", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    const market = await h.coordinator.submit(
      buildIntent({ type: "MARKET", price: null, timeInForce: "IOC" }),
    );
    assert.deepEqual(market.reasonCodes, [
      "PLANNED_EXPOSURE_DENIED",
      "UNBOUNDED_EXPOSURE",
      "STALE_OR_MISSING_INPUT",
      "PLANNED_NOTIONAL",
    ]);
    assert.equal(h.venue.calls.place, 0);
  });

  test("possibly-live, partially filled and unresolved-cancel records stay reserved", async () => {
    const registry = new IntentRegistry();
    const link = (intent: OrderIntent, exchangeOrderId: string, executed?: string) =>
      registry.link(intent.intentId, {
        exchangeOrderId,
        authority: { source: "ACK", evidenceId: `ack:${exchangeOrderId}` },
        executions:
          executed === undefined
            ? []
            : [
                {
                  executionId: `exec-${exchangeOrderId}`,
                  exchangeOrderId,
                  quantity: executed,
                  price: "99",
                },
              ],
        reasonCodes: ["VENUE_ACK"],
      });
    const seed = (overrides: Parameters<typeof buildIntent>[0]) => {
      const intent = buildIntent(overrides);
      registry.prepare(intent);
      return intent;
    };

    seed({ logicalLevelId: "B1", quantity: "0.1" });
    registry.markUnknown(
      seed({ logicalLevelId: "S2", side: "SELL", price: "101", quantity: "0.2" }).intentId,
      [],
    );
    link(seed({ logicalLevelId: "B3", price: "99", quantity: "0.3" }), "ex-3", "0.1");
    const unverified = seed({ logicalLevelId: "B4", quantity: "0.4" });
    link(unverified, "ex-4");
    registry.markCancelPrepared(unverified.intentId, []);
    registry.markCancelUnverified(unverified.intentId, []);
    const prepared = seed({ logicalLevelId: "B5", quantity: "0.5" });
    link(prepared, "ex-5");
    registry.markCancelPrepared(prepared.intentId, []);
    link(seed({ logicalLevelId: "B6", type: "MARKET", price: null, timeInForce: "IOC" }), "ex-6");
    // Reduce-only exits and closed records reserve nothing.
    link(
      seed({ logicalLevelId: "S1", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true }),
      "ex-7",
    );
    registry.markNotSent(seed({ logicalLevelId: "B8" }).intentId, []);
    registry.markRejected(seed({ logicalLevelId: "B9" }).intentId, []);
    const cancelled = seed({ logicalLevelId: "B10" });
    link(cancelled, "ex-10");
    registry.markCancelPrepared(cancelled.intentId, []);
    registry.markCancelUnverified(cancelled.intentId, []);
    registry.resolveCancel(cancelled.intentId, {
      status: "CANCELLED",
      executions: [],
      reasonCodes: [],
    });

    const reservation = (await createHarness({ registry })).coordinator.exposureReservation();
    const sorted = (items: unknown[]) => items.map((item) => JSON.stringify(item)).sort();
    assert.deepEqual(
      sorted(reservation.ownedActiveOrders),
      sorted([
        { side: "BUY", price: "99", remainingQuantity: "0.2", reduceOnly: false, owned: true },
        { side: "BUY", price: "100", remainingQuantity: "0.4", reduceOnly: false, owned: true },
        { side: "BUY", price: "100", remainingQuantity: "0.5", reduceOnly: false, owned: true },
      ]),
    );
    assert.deepEqual(
      sorted(reservation.unknownReservations),
      sorted([
        { side: "BUY", price: "100", quantity: "0.1" },
        { side: "SELL", price: "101", quantity: "0.2" },
        { side: "BUY", price: null, quantity: "0.01" },
      ]),
    );
  });
});

describe("P3-E12 batch stop", () => {
  test("after a send is not proven, the rest of the batch is neither sent nor recorded", async () => {
    const h = await createHarness({ fence: scriptedFence("SENT", "NOT_SENT") });
    const intents = ["B1", "B2", "B3"].map((logicalLevelId) => buildIntent({ logicalLevelId }));
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch(intents);
    assert.deepEqual(result.reasonCodes, ["BATCH_INCOMPLETE"]);
    assert.deepEqual(
      result.items.map(({ status, reasonCodes }) => ({ status, reasonCodes })),
      [
        { status: "LINKED", reasonCodes: ["VENUE_ACK"] },
        { status: "NOT_SENT", reasonCodes: ["FENCE_NOT_SENT", "MUTATION_NOT_SENT"] },
        {
          status: "NOT_SENT",
          reasonCodes: ["BATCH_STOPPED_BEFORE_SEND", "PRIOR_MUTATION_NOT_SENT"],
        },
      ],
    );
    assert.equal(h.registry.get(intents[2]?.intentId as string), null);
    assert.equal(h.venue.calls.place, 1);
  });

  test("real runtime lease released mid-batch stops the batch", async () => {
    resetLeaseProcessStateForTests();
    const directory = await mkdtemp(path.join(os.tmpdir(), "phase3c-lease-"));
    try {
      const latch = new RuntimePersistenceLatch();
      const clock = fixedLeaseClock(1_000_000n);
      const acquired = await acquireRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerA",
        processInstanceId: "procA",
        latch,
        clock,
      });
      const authority = acquired.authority;
      assert.ok(authority !== null);
      const lease = { directory, scopeKey: SCOPE_KEY, authority, latch, clock };
      let released: string | null = null;
      // Releases the lease after the first item's outcome is persisted, outside any fenced
      // callback, as a lost lease would appear between two sends.
      class ReleasingJournal extends MemoryJournal {
        override async persist(state: IntentRegistryState): Promise<void> {
          await super.persist(state);
          if (this.snapshots.length === 2) {
            released = (await releaseRuntimeLease(lease)).disposition;
          }
        }
      }
      const h = await createHarness({
        journal: new ReleasingJournal(),
        fence: createLeaseMutationFence(lease),
      });
      const intents = ["B1", "B2", "B3"].map((logicalLevelId) =>
        buildIntent({ logicalLevelId, leaseGeneration: authority.generation }),
      );
      await grant(h.coordinator);
      const result = await h.coordinator.submitBatch(intents);
      assert.equal(released, "RELEASED");
      assert.deepEqual(result.reasonCodes, ["BATCH_INCOMPLETE"]);
      assert.deepEqual(
        result.items.map((item) => item.status),
        ["LINKED", "NOT_SENT", "NOT_SENT"],
      );
      assert.ok(result.items[1]?.reasonCodes.includes("MUTATION_NOT_SENT"));
      assert.deepEqual(result.items[2]?.reasonCodes, [
        "BATCH_STOPPED_BEFORE_SEND",
        "PRIOR_MUTATION_NOT_SENT",
      ]);
      assert.equal(h.registry.list().length, 2);
      assert.equal(h.venue.calls.place, 1);
    } finally {
      resetLeaseProcessStateForTests();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unknown outcome blocks the risk-increasing rest of the batch", async () => {
    const h = await createHarness();
    h.venue.scriptPlace("ACK", "UNKNOWN_DROPPED");
    const intents = ["B1", "B2", "B3"].map((logicalLevelId) => buildIntent({ logicalLevelId }));
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch(intents);
    assert.deepEqual(result.reasonCodes, ["BATCH_INCOMPLETE"]);
    assert.deepEqual(
      result.items.map((item) => item.status),
      ["LINKED", "UNKNOWN", "NOT_SENT"],
    );
    assert.deepEqual(result.items[2]?.reasonCodes, [
      "BATCH_STOPPED_BEFORE_SEND",
      "UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE",
    ]);
    assert.equal(h.venue.calls.place, 2);
  });

  test("a journal failure latches and stops the rest of the batch", async () => {
    const journal = new MemoryJournal();
    journal.scriptPersist("OK", "FAIL");
    const h = await createHarness({ journal });
    const intents = ["B1", "B2"].map((logicalLevelId) => buildIntent({ logicalLevelId }));
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch(intents);
    assert.deepEqual(result.reasonCodes, ["BATCH_INCOMPLETE"]);
    assert.deepEqual(result.items[0]?.reasonCodes, ["VENUE_ACK", "JOURNAL_WRITE_FAILED"]);
    assert.deepEqual(result.items[1]?.reasonCodes, [
      "BATCH_STOPPED_BEFORE_SEND",
      "JOURNAL_LATCHED",
    ]);
    assert.equal(h.venue.calls.place, 1);
  });

  test("a plain venue rejection does not stop the batch", async () => {
    const h = await createHarness();
    h.venue.scriptPlace("REJECT");
    const intents = ["B1", "B2"].map((logicalLevelId) => buildIntent({ logicalLevelId }));
    await grant(h.coordinator);
    const result = await h.coordinator.submitBatch(intents);
    assert.deepEqual(result.reasonCodes, []);
    assert.deepEqual(
      result.items.map((item) => item.status),
      ["REJECTED", "LINKED"],
    );
    assert.equal(h.venue.calls.place, 2);
  });
});

describe("P3 batch pre-send checks", () => {
  test("an invalid batch is refused before any send or record", async () => {
    const recorded = buildIntent({ logicalLevelId: "B9" });
    const cases: Array<[unknown, string]> = [
      [[], "EMPTY_BATCH"],
      [null, "EMPTY_BATCH"],
      [
        [buildIntent(), { ...buildIntent({ logicalLevelId: "B2" }), quantity: "-1" }],
        "INVALID_INTENT_FIELDS",
      ],
      [[buildIntent(), buildIntent()], "BATCH_IDENTITY_CONFLICT"],
      [[buildIntent(), buildIntent({ sequence: "2" })], "BATCH_SLOT_CONFLICT"],
      [[buildIntent(), recorded], "INTENT_ALREADY_RECORDED"],
      [
        [buildIntent(), buildIntent({ logicalLevelId: "B2", leaseGeneration: "2" })],
        "INTENT_LEASE_GENERATION_MISMATCH",
      ],
    ];
    for (const [batch, reasonCode] of cases) {
      const h = await createHarness();
      await placeLinked(h, recorded);
      await grant(h.coordinator);
      const result = await h.coordinator.submitBatch(batch as OrderIntent[]);
      assert.deepEqual(result, { disposition: "REFUSED", reasonCodes: [reasonCode], items: [] });
      assert.equal(h.venue.calls.place, 1, reasonCode);
      assert.equal(h.registry.list().length, 1, reasonCode);
    }
  });

  test("a latched journal refuses a batch", async () => {
    const journal = new MemoryJournal();
    journal.scriptPersist("FAIL");
    const h = await createHarness({ journal });
    await grant(h.coordinator);
    await h.coordinator.submit(buildIntent());
    assert.equal(h.coordinator.isJournalLatched(), true);
    const result = await h.coordinator.submitBatch([buildIntent({ logicalLevelId: "B2" })]);
    assert.deepEqual(result.reasonCodes, ["JOURNAL_LATCHED"]);
    assert.equal(h.venue.calls.place, 0);
  });

  test("operations and cycle resets are refused while another operation runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await createHarness({
      exposure: {
        read: async () => {
          await gate;
          return { signedPosition: "0", markOrMidPrice: "100" };
        },
      },
    });
    await grant(h.coordinator);
    const pending = h.coordinator.submit(buildIntent());
    assert.deepEqual(
      (await h.coordinator.submitBatch([buildIntent({ logicalLevelId: "B2" })])).reasonCodes,
      ["COORDINATOR_BUSY"],
    );
    assert.deepEqual((await h.coordinator.scanOpenOrders(EPOCH)).reasonCodes, ["COORDINATOR_BUSY"]);
    assert.deepEqual((await h.coordinator.cleanupOwnedDuplicates(EPOCH)).reasonCodes, [
      "COORDINATOR_BUSY",
    ]);
    assert.equal(h.coordinator.startCycle(), false);
    release();
    assert.equal((await pending).record?.status, "LINKED");
    assert.equal(h.coordinator.startCycle(), true);
  });
});

describe("P3 write budget", () => {
  test("the budget must be a positive safe integer", async () => {
    for (const writeBudgetPerCycle of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await assert.rejects(createHarness({ writeBudgetPerCycle }), /INVALID_WRITE_BUDGET/);
    }
  });

  test("places beyond the budget are refused until the next cycle", async () => {
    const h = await createHarness({ writeBudgetPerCycle: 2 });
    await placeLinked(h, buildIntent({ logicalLevelId: "B1" }));
    await placeLinked(h, buildIntent({ logicalLevelId: "B2" }));
    const third = buildIntent({ logicalLevelId: "B3" });
    await grant(h.coordinator);
    assert.deepEqual((await h.coordinator.submit(third)).reasonCodes, ["WRITE_BUDGET_EXHAUSTED"]);
    assert.equal(h.venue.calls.place, 2);
    assert.equal(h.registry.get(third.intentId), null);
    assert.equal(h.coordinator.startCycle(), true);
    await placeLinked(h, third);
  });

  test("a batch larger than the remaining budget is refused whole", async () => {
    const h = await createHarness({ writeBudgetPerCycle: 3 });
    await placeLinked(h, buildIntent({ logicalLevelId: "B1" }));
    const levels = ["B2", "B3", "B4"].map((logicalLevelId) => buildIntent({ logicalLevelId }));
    await grant(h.coordinator);
    assert.deepEqual((await h.coordinator.submitBatch(levels)).reasonCodes, [
      "WRITE_BUDGET_EXHAUSTED",
    ]);
    assert.equal(h.venue.calls.place, 1);
    await grant(h.coordinator);
    const fits = await h.coordinator.submitBatch(levels.slice(0, 2));
    assert.deepEqual(fits.reasonCodes, []);
    assert.equal(h.venue.calls.place, 3);
  });

  test("an attempted send counts even when the fence does not send it", async () => {
    const h = await createHarness({ writeBudgetPerCycle: 1, fence: scriptedFence("NOT_SENT") });
    await grant(h.coordinator);
    const first = await h.coordinator.submit(buildIntent({ logicalLevelId: "B1" }));
    assert.equal(first.record?.status, "NOT_SENT");
    await grant(h.coordinator);
    const second = await h.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
    assert.deepEqual(second.reasonCodes, ["WRITE_BUDGET_EXHAUSTED"]);
  });

  test("cancels count toward the budget, including duplicate cleanup", async () => {
    const h = await createHarness({ writeBudgetPerCycle: 1 });
    const intent = await placeLinked(h, buildIntent());
    const refusedCancel = await h.coordinator.cancel(intent.intentId);
    assert.deepEqual(refusedCancel.reasonCodes, ["WRITE_BUDGET_EXHAUSTED"]);
    assert.equal(h.registry.get(intent.intentId)?.status, "LINKED");
    assert.equal(h.venue.calls.cancel, 0);
    h.coordinator.startCycle();
    assert.equal((await h.coordinator.cancel(intent.intentId)).record?.status, "CANCEL_UNVERIFIED");
    // That cancel used this cycle's only write, so even a reduce-only exit is refused.
    const exit = await h.coordinator.submit(
      buildIntent({ logicalLevelId: "S1", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true }),
    );
    assert.deepEqual(exit.reasonCodes, ["WRITE_BUDGET_EXHAUSTED"]);
    assert.equal(h.venue.calls.place, 1);

    const { h: dup, lag } = await laggingHarness({ writeBudgetPerCycle: 3 });
    lag.lagging = true;
    await placeDuplicates(dup, 3);
    lag.lagging = false;
    const cleanup = await dup.coordinator.cleanupOwnedDuplicates(EPOCH);
    assert.deepEqual(cleanup.reasonCodes, ["CLEANUP_INCOMPLETE"]);
    assert.deepEqual(
      cleanup.cancels.map((cancel) => cancel.reasonCodes),
      [["WRITE_BUDGET_EXHAUSTED"], ["CLEANUP_STOPPED_BEFORE_SEND", "PRIOR_CANCEL_NOT_SENT"]],
    );
    assert.equal(dup.venue.calls.cancel, 0);
  });
});

describe("plannedExposureDecision", () => {
  const flat = {
    signedPosition: "0",
    markOrMidPrice: "100",
    ownedActiveOrders: [],
    unknownReservations: [],
  };
  const entry = (quantity: string, overrides: Record<string, unknown> = {}) =>
    ({
      side: "BUY",
      price: "100",
      quantity,
      reduceOnly: false,
      purpose: "GRID_ENTRY",
      ...overrides,
    }) as Parameters<typeof plannedExposureDecision>[0]["proposedBatch"][number];

  test("the cap is inclusive at 150", () => {
    const at = plannedExposureDecision({ ...flat, proposedBatch: [entry("1.5")] });
    assert.equal(at.allowed, true);
    assert.deepEqual(at.reasonCodes, []);
    const over = plannedExposureDecision({ ...flat, proposedBatch: [entry("1.5001")] });
    assert.deepEqual(over, {
      allowed: false,
      plannedGrossNotional: over.plannedGrossNotional,
      reasonCodes: ["PLANNED_NOTIONAL"],
    });
  });

  test("unknown reservations count on their own side", () => {
    const reserved = {
      ...flat,
      unknownReservations: [{ side: "SELL" as const, price: "100", quantity: "1" }],
    };
    assert.equal(
      plannedExposureDecision({ ...reserved, proposedBatch: [entry("1.5")] }).allowed,
      true,
    );
    const short = plannedExposureDecision({
      ...reserved,
      proposedBatch: [entry("0.51", { side: "SELL" })],
    });
    assert.deepEqual(short.reasonCodes, ["PLANNED_NOTIONAL"]);
  });

  test("unbounded, invalid, cancel and missing inputs are denied", () => {
    const cases: Array<[Parameters<typeof plannedExposureDecision>[0], string[]]> = [
      [
        { ...flat, proposedBatch: [entry("1", { price: null })] },
        ["UNBOUNDED_EXPOSURE", "STALE_OR_MISSING_INPUT", "PLANNED_NOTIONAL"],
      ],
      [{ ...flat, proposedBatch: [entry("1", { purpose: "CANCEL" })] }, ["INVALID_RISK_INPUT"]],
      [
        { ...flat, proposedBatch: [entry("1", { purpose: "CANCEL", reduceOnly: true })] },
        ["INVALID_RISK_INPUT"],
      ],
      [{ ...flat, signedPosition: null, proposedBatch: [entry("1")] }, ["STALE_OR_MISSING_INPUT"]],
      [{ ...flat, markOrMidPrice: null, proposedBatch: [entry("1")] }, ["STALE_OR_MISSING_INPUT"]],
    ];
    for (const [args, reasonCodes] of cases) {
      const decision = plannedExposureDecision(args);
      assert.equal(decision.allowed, false);
      assert.deepEqual(decision.reasonCodes, reasonCodes);
    }
    const invalid = plannedExposureDecision({
      ...flat,
      ownedActiveOrders: [
        { side: "BUY", price: "abc", remainingQuantity: "1", reduceOnly: false, owned: true },
      ],
      proposedBatch: [entry("0.01")],
    });
    assert.equal(invalid.allowed, false);
    assert.equal(invalid.plannedGrossNotional, null);
    assert.ok(invalid.reasonCodes.length > 0);
  });

  test("a reduce-only proposal adds no exposure", () => {
    const decision = plannedExposureDecision({
      ...flat,
      proposedBatch: [entry("2", { side: "SELL", reduceOnly: true, purpose: "GRID_EXIT" })],
    });
    assert.equal(decision.allowed, true);
  });
});
