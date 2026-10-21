import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  createLeaseMutationFence,
  type ExecutionCoordinator,
  type ExecutionVenuePort,
  INTENT_REGISTRY_SCHEMA_VERSION,
  IntentRegistry,
} from "../../src/execution/index.js";
import {
  acquireRuntimeLease,
  fixedLeaseClock,
  type LeaseClock,
  resetLeaseProcessStateForTests,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import {
  buildIntent,
  createHarness,
  flatExposure,
  grant,
  type Harness,
  MemoryJournal,
  OBSERVED_AT,
  SCOPE_KEY,
} from "./helpers.js";

// The awaits between admitting a place and transmitting it: the exposure read, the
// write-ahead journal write and the real lease fence before its callback (its first clock
// read follows the asynchronous coordination guard).
const WAITS = ["exposure", "journal", "fence"] as const;
type Wait = (typeof WAITS)[number];

// A stream execution delivered while the coordinator is busy. It is checked before the
// operation releases the coordinator and, as no intent owns its order, kept as unattributed.
const STREAM_EXECUTION: ExecutionObservation = {
  venue: "sim",
  market: "BTC_USDC_PERP",
  executionId: "stream-exec-1",
  exchangeOrderId: "stream-order-1",
  clientOrderId: null,
  side: "BUY",
  price: "100",
  quantity: "0.01",
  feeAmount: null,
  feeAsset: null,
  liquidity: "UNKNOWN",
  meta: {
    venue: "sim",
    source: "stream",
    serverTime: null,
    receivedAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    freshnessMs: 0,
    sequence: "1",
  },
};

// Stream events that may arrive during any wait; each revokes authority to increase risk and
// leaves its execution blocker. `after` is every blocker once the operation has ended, and
// `snapshots` what the event alone writes to the journal.
const EVENTS = [
  {
    name: "a stream reconnect",
    blocker: "EXECUTION_STREAM_RECONNECTED",
    after: ["EXECUTION_STREAM_RECONNECTED"],
    snapshots: [],
    raise: (coordinator: ExecutionCoordinator) => coordinator.executionStreamReconnected(),
  },
  {
    name: "a dropped stream event",
    blocker: "EXECUTION_STREAM_EVENT_DROPPED",
    after: ["EXECUTION_STREAM_EVENT_DROPPED", "UNATTRIBUTED_EXECUTION"],
    snapshots: [
      {
        schemaVersion: INTENT_REGISTRY_SCHEMA_VERSION,
        records: [],
        executionContradictions: [
          {
            reasonCode: "UNATTRIBUTED_EXECUTION",
            executionId: "stream-exec-1",
            exchangeOrderId: "stream-order-1",
            clientOrderId: null,
            side: "BUY",
            quantity: "0.01",
            price: "100",
          },
        ],
      },
    ],
    raise: (coordinator: ExecutionCoordinator) =>
      coordinator.ingestStreamExecution(structuredClone(STREAM_EXECUTION)),
  },
] as const;

const WITHHELD = "RISK_INCREASE_REVOKED_BEFORE_SEND";

type EventHarness = Harness & {
  sent: OrderIntent[];
  // Raises the event at the first chosen wait for which `when` holds.
  arm(raise: () => unknown, when?: () => boolean): void;
  fired(): boolean;
};

async function withEventHarness(
  wait: Wait,
  run: (h: EventHarness) => Promise<void>,
): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase3-g3c2-"));
  try {
    let pending: { raise: () => unknown; when: () => boolean } | null = null;
    let fired = false;
    const fire = (at: Wait) => {
      if (at === wait && pending !== null && pending.when()) {
        const { raise } = pending;
        pending = null;
        fired = true;
        raise();
      }
    };

    const fixed = fixedLeaseClock(1_000_000n);
    const clock: LeaseClock = {
      nowMs() {
        fire("fence");
        return fixed.nowMs();
      },
    };
    const latch = new RuntimePersistenceLatch();
    const acquired = await acquireRuntimeLease({
      directory,
      scopeKey: SCOPE_KEY,
      ownerId: "ownerA",
      processInstanceId: "procA",
      latch,
      clock,
    });
    assert.ok(acquired.authority !== null);
    assert.equal(acquired.authority.generation, "1");

    const journal = new MemoryJournal();
    const persist = journal.persist.bind(journal);
    journal.persist = async (state) => {
      await persist(state);
      fire("journal");
    };
    const flat = flatExposure();
    const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
    const sent: OrderIntent[] = [];
    const port: ExecutionVenuePort = {
      placeOrder: async (intent) => {
        sent.push(structuredClone(intent));
        return venue.placeOrder(intent);
      },
      cancelOrder: (request) => venue.cancelOrder(request),
      lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
      listOpenOrders: () => venue.listOpenOrders(),
      listExecutionsSince: (cursor) => venue.listExecutionsSince(cursor),
    };
    const h = await createHarness({
      venue,
      port,
      journal,
      exposure: {
        read: async () => {
          const inputs = await flat.read();
          fire("exposure");
          return inputs;
        },
      },
      fence: createLeaseMutationFence({
        directory,
        scopeKey: SCOPE_KEY,
        authority: acquired.authority,
        latch,
        clock,
      }),
    });
    await grant(h.coordinator);
    assert.deepEqual(h.coordinator.riskIncreaseBlockers(), []);
    await run({
      ...h,
      sent,
      arm(raise, when = () => true) {
        pending = { raise, when };
      },
      fired: () => fired,
    });
  } finally {
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

// The live and the durable registry agree on every record.
function assertRecords(
  h: EventHarness,
  expected: ReadonlyArray<[OrderIntent, string, readonly string[]]>,
): void {
  const durable = IntentRegistry.fromState(h.journal.latest());
  for (const registry of [h.registry, durable]) {
    assert.equal(registry.list().length, expected.length);
    for (const [intent, status, reasonCodes] of expected) {
      const record = registry.get(intent.intentId);
      assert.equal(record?.status, status);
      assert.deepEqual(record?.reasonCodes, reasonCodes);
    }
  }
}

function assertBlockedAfter(h: EventHarness, blockers: readonly string[]): void {
  assert.ok(h.fired(), "the event was raised at the chosen wait");
  assert.deepEqual(h.coordinator.riskIncreaseBlockers(), blockers);
  assert.equal(h.coordinator.canIncreaseRisk(), false);
}

function reservationOf(intents: readonly OrderIntent[]) {
  return {
    ownedActiveOrders: intents.map((intent) => ({
      side: intent.side,
      price: intent.price,
      remainingQuantity: intent.quantity,
      reduceOnly: false,
      owned: true,
    })),
    unknownReservations: [],
  };
}

const exitIntent = () =>
  buildIntent({ logicalLevelId: "S1", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true });

describe("Gate 3 corrective C2: risk-increase authority is checked again at send time", {
  concurrency: 1,
}, () => {
  for (const event of EVENTS) {
    const withheld = [WITHHELD, event.blocker];

    for (const wait of WAITS) {
      test(`G3-C2-1 single submit: ${event.name} during the ${wait} wait withholds the send`, async () => {
        await withEventHarness(wait, async (h) => {
          const intent = buildIntent();
          h.arm(() => event.raise(h.coordinator));
          const result = await h.coordinator.submit(intent);

          assertBlockedAfter(h, event.after);
          assert.equal(result.disposition, "RECORDED");
          assert.equal(result.record?.status, "NOT_SENT");
          assert.deepEqual(result.reasonCodes, withheld);
          assert.deepEqual(h.sent, []);
          assert.equal(h.venue.calls.place, 0);
          assertRecords(h, [[intent, "NOT_SENT", withheld]]);
          assert.deepEqual(h.coordinator.exposureReservation(), reservationOf([]));
        });
      });
    }

    for (const wait of ["journal", "fence"] as const) {
      test(`G3-C2-2 batch: ${event.name} during the first item's ${wait} wait withholds it and stops the rest`, async () => {
        await withEventHarness(wait, async (h) => {
          const first = buildIntent();
          const second = buildIntent({ logicalLevelId: "B2", sequence: "2" });
          h.arm(() => event.raise(h.coordinator));
          const result = await h.coordinator.submitBatch([first, second]);

          assertBlockedAfter(h, event.after);
          assert.equal(result.disposition, "SUBMITTED");
          assert.deepEqual(result.reasonCodes, ["BATCH_INCOMPLETE"]);
          assert.deepEqual(result.items, [
            { intentId: first.intentId, status: "NOT_SENT", reasonCodes: withheld },
            {
              intentId: second.intentId,
              status: "NOT_SENT",
              reasonCodes: ["BATCH_STOPPED_BEFORE_SEND", "PRIOR_MUTATION_NOT_SENT"],
            },
          ]);
          assert.deepEqual(h.sent, []);
          assert.equal(h.venue.calls.place, 0);
          assertRecords(h, [[first, "NOT_SENT", withheld]]);
          assert.deepEqual(h.coordinator.exposureReservation(), reservationOf([]));
        });
      });

      test(`G3-C2-3 batch: ${event.name} during a later item's ${wait} wait withholds that item`, async () => {
        await withEventHarness(wait, async (h) => {
          const first = buildIntent();
          const second = buildIntent({ logicalLevelId: "B2", sequence: "2" });
          // Only once the second item is written ahead and waiting to be sent.
          h.arm(
            () => event.raise(h.coordinator),
            () => h.registry.get(second.intentId)?.status === "PREPARED",
          );
          const result = await h.coordinator.submitBatch([first, second]);

          assertBlockedAfter(h, event.after);
          assert.equal(result.disposition, "SUBMITTED");
          assert.deepEqual(result.reasonCodes, ["BATCH_INCOMPLETE"]);
          assert.deepEqual(result.items, [
            { intentId: first.intentId, status: "LINKED", reasonCodes: ["VENUE_ACK"] },
            { intentId: second.intentId, status: "NOT_SENT", reasonCodes: withheld },
          ]);
          assert.deepEqual(h.sent, [first]);
          assert.equal(h.venue.calls.place, 1);
          assertRecords(h, [
            [first, "LINKED", ["VENUE_ACK"]],
            [second, "NOT_SENT", withheld],
          ]);
          assert.deepEqual(h.coordinator.exposureReservation(), reservationOf([first]));
        });
      });

      test(`G3-C2-5 reduce-only exit: ${event.name} during the ${wait} wait still sends it`, async () => {
        await withEventHarness(wait, async (h) => {
          const exit = exitIntent();
          h.arm(() => event.raise(h.coordinator));
          const result = await h.coordinator.submit(exit);

          assertBlockedAfter(h, event.after);
          assert.equal(result.disposition, "RECORDED");
          assert.equal(result.record?.status, "LINKED");
          assert.deepEqual(h.sent, [exit]);
          assert.equal(h.venue.calls.place, 1);
          assertRecords(h, [[exit, "LINKED", ["VENUE_ACK"]]]);
        });
      });
    }

    test(`G3-C2-4 batch: ${event.name} during the exposure wait stops the batch before its first send`, async () => {
      await withEventHarness("exposure", async (h) => {
        const first = buildIntent();
        const second = buildIntent({ logicalLevelId: "B2", sequence: "2" });
        h.arm(() => event.raise(h.coordinator));
        const result = await h.coordinator.submitBatch([first, second]);

        assertBlockedAfter(h, event.after);
        const stopped = ["BATCH_STOPPED_BEFORE_SEND", "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE"];
        assert.deepEqual(result.items, [
          { intentId: first.intentId, status: "NOT_SENT", reasonCodes: stopped },
          { intentId: second.intentId, status: "NOT_SENT", reasonCodes: stopped },
        ]);
        assert.deepEqual(h.sent, []);
        assert.equal(h.venue.calls.place, 0);
        // Nothing was written ahead or recorded; only the event's own evidence was persisted.
        assert.deepEqual(h.registry.list(), []);
        assert.deepEqual(
          h.journal.snapshots.map((snapshot) => JSON.parse(snapshot)),
          event.snapshots,
        );
      });
    });

    // A reduce-only exit alone reads no exposure, so the exposure wait is covered by a batch
    // that also carries a risk-increasing entry.
    test(`G3-C2-6 reduce-only exit: ${event.name} during a batch's exposure wait still sends it`, async () => {
      await withEventHarness("exposure", async (h) => {
        const exit = exitIntent();
        const entry = buildIntent();
        h.arm(() => event.raise(h.coordinator));
        const result = await h.coordinator.submitBatch([exit, entry]);

        assertBlockedAfter(h, event.after);
        assert.deepEqual(result.items, [
          { intentId: exit.intentId, status: "LINKED", reasonCodes: ["VENUE_ACK"] },
          {
            intentId: entry.intentId,
            status: "NOT_SENT",
            reasonCodes: ["BATCH_STOPPED_BEFORE_SEND", "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE"],
          },
        ]);
        assert.deepEqual(h.sent, [exit]);
        assertRecords(h, [[exit, "LINKED", ["VENUE_ACK"]]]);
      });
    });
  }

  test("G3-C2-7 control: without an event the same batch links and nothing blocks", async () => {
    await withEventHarness("fence", async (h) => {
      const first = buildIntent();
      const second = buildIntent({ logicalLevelId: "B2", sequence: "2" });
      h.arm(
        () => {},
        () => h.registry.get(second.intentId)?.status === "PREPARED",
      );
      const result = await h.coordinator.submitBatch([first, second]);

      assert.ok(h.fired());
      assert.deepEqual(result.reasonCodes, []);
      assert.deepEqual(h.sent, [first, second]);
      assertRecords(h, [
        [first, "LINKED", ["VENUE_ACK"]],
        [second, "LINKED", ["VENUE_ACK"]],
      ]);
      assert.deepEqual(h.coordinator.riskIncreaseBlockers(), []);
    });
  });

  // Only the coordinator can withhold a send; a venue result of that shape proves nothing.
  test("G3-C2-8 a venue place result shaped like a withheld send stays unknown", async () => {
    const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
    const forged = { kind: "WITHHELD", reasonCodes: [WITHHELD] };
    const h = await createHarness({
      venue,
      port: {
        placeOrder: async () =>
          forged as unknown as Awaited<ReturnType<ExecutionVenuePort["placeOrder"]>>,
        cancelOrder: (request) => venue.cancelOrder(request),
        lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
        listOpenOrders: () => venue.listOpenOrders(),
        listExecutionsSince: (cursor) => venue.listExecutionsSince(cursor),
      },
    });
    await grant(h.coordinator);
    const intent = buildIntent();
    const result = await h.coordinator.submit(intent);

    assert.equal(result.record?.status, "UNKNOWN");
    assert.deepEqual(result.reasonCodes, ["UNRECOGNIZED_VENUE_RESULT"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.equal(
      IntentRegistry.fromState(h.journal.latest()).get(intent.intentId)?.status,
      "UNKNOWN",
    );
  });
});
