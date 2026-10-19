import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { OrderIntent } from "../../src/domain/types.js";
import {
  createLeaseMutationFence,
  type ExecutionVenuePort,
  IntentRegistry,
  intentFingerprint,
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

// The awaits of one submission where a caller still holding its objects could change them:
// the exposure read, the write-ahead journal write and the real lease fence before its
// callback (its first clock read follows the asynchronous coordination guard).
const WAITS = ["exposure", "journal", "fence"] as const;
type Wait = (typeof WAITS)[number];

type MutationHarness = Harness & {
  sent: OrderIntent[];
  arm(mutate: () => void): void;
  fired(): boolean;
};

async function withMutationHarness(
  wait: Wait,
  run: (h: MutationHarness) => Promise<void>,
): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase3-g3c1-"));
  try {
    let pending: (() => void) | null = null;
    let fired = false;
    const fire = (at: Wait) => {
      if (at === wait && pending !== null) {
        const mutate = pending;
        pending = null;
        fired = true;
        mutate();
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
    await run({
      ...h,
      sent,
      arm(mutate) {
        pending = mutate;
      },
      fired: () => fired,
    });
  } finally {
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

// Everything after the public boundary describes the request the caller handed over: the
// transmitted orders, the live and durable records with their fingerprints, and the
// reservation. Nothing else is recorded or sent.
function assertOwnedSnapshot(h: MutationHarness, expected: readonly OrderIntent[]): void {
  assert.ok(h.fired(), "the mutation ran at the chosen wait");
  assert.deepEqual(h.sent, expected);
  assert.equal(h.venue.calls.place, expected.length);
  // The registry lists records by intent ID.
  const byIntentId = [...expected].sort((left, right) =>
    left.intentId < right.intentId ? -1 : left.intentId > right.intentId ? 1 : 0,
  );
  const durable = IntentRegistry.fromState(h.journal.latest());
  for (const registry of [h.registry, durable]) {
    const records = registry.list();
    assert.deepEqual(
      records.map((record) => record.intent),
      byIntentId,
    );
    for (const record of records) {
      assert.equal(record.status, "LINKED");
      assert.equal(record.requestFingerprint, intentFingerprint(record.intent));
    }
  }
  assert.deepEqual(h.coordinator.exposureReservation(), {
    ownedActiveOrders: byIntentId.map((intent) => ({
      side: intent.side,
      price: intent.price,
      remainingQuantity: intent.quantity,
      reduceOnly: false,
      owned: true,
    })),
    unknownReservations: [],
  });
}

// Replaces every identity field with that of a different valid intent at another level.
function changeIdentity(intent: OrderIntent, index: number): void {
  const other = buildIntent({
    logicalLevelId: `X${index}`,
    sequence: `9${index}`,
  });
  intent.intentId = other.intentId;
  intent.clientOrderId = other.clientOrderId;
  intent.logicalLevelId = other.logicalLevelId;
}

describe("Gate 3 corrective C1: one owned intent snapshot from boundary to send", {
  concurrency: 1,
}, () => {
  for (const wait of WAITS) {
    test(`G3-C1-1 single submit: a quantity change during the ${wait} wait is not sent`, async () => {
      await withMutationHarness(wait, async (h) => {
        const intent = buildIntent();
        const snapshot = structuredClone(intent);
        h.arm(() => {
          intent.quantity = "1000";
        });
        const result = await h.coordinator.submit(intent);

        assert.equal(result.disposition, "RECORDED");
        assert.equal(result.record?.status, "LINKED");
        assert.deepEqual(result.record?.intent, snapshot);
        assertOwnedSnapshot(h, [snapshot]);
      });
    });

    test(`G3-C1-2 single submit: an identity change during the ${wait} wait is not sent`, async () => {
      await withMutationHarness(wait, async (h) => {
        const intent = buildIntent();
        const snapshot = structuredClone(intent);
        h.arm(() => changeIdentity(intent, 0));
        const result = await h.coordinator.submit(intent);

        assert.equal(result.disposition, "RECORDED");
        assert.equal(result.record?.status, "LINKED");
        assert.deepEqual(result.record?.intent, snapshot);
        assertOwnedSnapshot(h, [snapshot]);
      });
    });

    test(`G3-C1-3 batch: quantity changes during the ${wait} wait are not sent`, async () => {
      await withMutationHarness(wait, async (h) => {
        const intents = [buildIntent(), buildIntent({ logicalLevelId: "B2", sequence: "2" })];
        const snapshots = structuredClone(intents);
        h.arm(() => {
          for (const intent of intents) {
            intent.quantity = "1000";
          }
        });
        const result = await h.coordinator.submitBatch(intents);

        assert.equal(result.disposition, "SUBMITTED");
        assert.deepEqual(
          result.items.map((item) => [item.intentId, item.status]),
          snapshots.map((intent) => [intent.intentId, "LINKED"]),
        );
        assertOwnedSnapshot(h, snapshots);
      });
    });

    test(`G3-C1-4 batch: identity changes during the ${wait} wait are not sent`, async () => {
      await withMutationHarness(wait, async (h) => {
        const intents = [buildIntent(), buildIntent({ logicalLevelId: "B2", sequence: "2" })];
        const snapshots = structuredClone(intents);
        h.arm(() => intents.forEach(changeIdentity));
        const result = await h.coordinator.submitBatch(intents);

        assert.equal(result.disposition, "SUBMITTED");
        assert.deepEqual(
          result.items.map((item) => [item.intentId, item.status]),
          snapshots.map((intent) => [intent.intentId, "LINKED"]),
        );
        assertOwnedSnapshot(h, snapshots);
      });
    });

    test(`G3-C1-5 batch: changing the caller's array during the ${wait} wait sends only the checked batch`, async () => {
      await withMutationHarness(wait, async (h) => {
        const intents = [buildIntent(), buildIntent({ logicalLevelId: "B2", sequence: "2" })];
        const snapshots = structuredClone(intents);
        h.arm(() => {
          intents[1] = buildIntent({
            logicalLevelId: "X1",
            sequence: "91",
            quantity: "1000",
          });
          intents.push(
            buildIntent({
              logicalLevelId: "X2",
              sequence: "92",
              quantity: "1000",
            }),
          );
        });
        const result = await h.coordinator.submitBatch(intents);

        assert.equal(result.disposition, "SUBMITTED");
        assert.deepEqual(
          result.items.map((item) => [item.intentId, item.status]),
          snapshots.map((intent) => [intent.intentId, "LINKED"]),
        );
        assertOwnedSnapshot(h, snapshots);
      });
    });
  }

  test("G3-C1-6 control: without a mutation the same submissions link unchanged", async () => {
    await withMutationHarness("journal", async (h) => {
      const intents = [buildIntent(), buildIntent({ logicalLevelId: "B2", sequence: "2" })];
      const snapshots = structuredClone(intents);
      h.arm(() => {});
      const result = await h.coordinator.submitBatch(intents);

      assert.equal(result.disposition, "SUBMITTED");
      assertOwnedSnapshot(h, snapshots);
    });
  });
});
