import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { OrderIntent } from "../../src/domain/types.js";
import {
  type ClientOrderLookup,
  createLeaseMutationFence,
  ExecutionCoordinator,
  type ExecutionVenuePort,
  IntentRegistry,
  IntentRegistryError,
  type IntentRegistryState,
} from "../../src/execution/index.js";
import {
  acquireRuntimeLease,
  fixedLeaseClock,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  buildIntent,
  clientIdOf,
  createHarness,
  flatExposure,
  type Harness,
  notSentFence,
  openFence,
  SCOPE_KEY,
} from "./helpers.js";

function assertRegistryError(run: () => unknown, reasonCode: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof IntentRegistryError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

// Places an intent that the venue acknowledges, so it is LINKED.
async function placeLinked(h: Harness, intent: OrderIntent = buildIntent()): Promise<OrderIntent> {
  const placed = await h.coordinator.submit(intent);
  assert.equal(placed.record?.status, "LINKED");
  return intent;
}

function restart(h: Harness, port?: ExecutionVenuePort): Promise<Harness> {
  const registry = IntentRegistry.fromState(h.journal.latest());
  return createHarness(
    port === undefined ? { venue: h.venue, registry } : { venue: h.venue, port, registry },
  );
}

// A port over the harness venue whose cancel and lookup can be intercepted.
function portOver(
  h: Harness,
  overrides: Partial<Pick<ExecutionVenuePort, "cancelOrder" | "lookupClientOrder">>,
): ExecutionVenuePort {
  return {
    placeOrder: (intent) => h.venue.placeOrder(intent),
    cancelOrder: overrides.cancelOrder ?? ((request) => h.venue.cancelOrder(request)),
    lookupClientOrder:
      overrides.lookupClientOrder ?? ((clientOrderId) => h.venue.lookupClientOrder(clientOrderId)),
    listOpenOrders: () => h.venue.listOpenOrders(),
    listExecutionsSince: (cursor) => h.venue.listExecutionsSince(cursor),
  };
}

describe("P3-E06 cancel UNKNOWN", () => {
  test("a dropped cancel blocks risk until the order is observed active", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.scriptCancel("UNKNOWN_DROPPED");

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.disposition, "RECORDED");
    assert.equal(result.record?.status, "CANCEL_UNVERIFIED");
    assert.deepEqual(result.reasonCodes, ["VENUE_OUTCOME_UNKNOWN"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual((await h.coordinator.submit(buildIntent({ sequence: "2" }))).reasonCodes, [
      "UNRESOLVED_INTENT_FOR_SLOT",
    ]);
    assert.deepEqual(
      (await h.coordinator.submit(buildIntent({ logicalLevelId: "B2" }))).reasonCodes,
      ["UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE"],
    );
    assert.deepEqual((await h.coordinator.cancel(intent.intentId)).reasonCodes, [
      "CANCEL_UNRESOLVED",
    ]);
    assert.equal(h.venue.calls.cancel, 1);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items, [
      { intentId: intent.intentId, status: "LINKED", reasonCodes: ["ORDER_STILL_ACTIVE"] },
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), true);

    const retried = await h.coordinator.cancel(intent.intentId);
    assert.deepEqual(retried.reasonCodes, ["CANCEL_ACK"]);
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "CANCELLED");
    assert.equal(h.venue.calls.cancel, 2);
  });

  test("a cancel applied behind a lost response is CANCELLED only after observation", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.scriptCancel("UNKNOWN_APPLIED");

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "CANCEL_UNVERIFIED");
    assert.equal(h.venue.orderForClientOrderId(clientIdOf(intent))?.status, "CANCELLED");
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["CANCEL_VERIFIED"]);
    assert.equal(h.registry.get(intent.intentId)?.status, "CANCELLED");
  });

  test("a thrown cancel is a transport unknown, not a failure", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.scriptCancel("THROW_APPLIED");

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "CANCEL_UNVERIFIED");
    assert.deepEqual(result.reasonCodes, ["TRANSPORT_OUTCOME_UNKNOWN", "FENCED_CALLBACK_THREW"]);
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "CANCELLED");
  });

  test("a failed lookup or a vanished order proves nothing", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.scriptCancel("UNKNOWN_APPLIED");
    await h.coordinator.cancel(intent.intentId);

    h.venue.failNextLookups(1);
    const failed = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(failed.items[0]?.reasonCodes, ["LOOKUP_FAILED"]);

    h.venue.forgetOrder("sim-order-1");
    const vanished = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(vanished.items[0]?.reasonCodes, ["ORDER_NOT_OBSERVED"]);
    assert.equal(h.registry.get(intent.intentId)?.status, "CANCEL_UNVERIFIED");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a restart with a written-ahead cancel reconciles before anything is sent", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.journal.scriptPersist("OK", "FAIL");

    const result = await h.coordinator.cancel(intent.intentId);
    assert.deepEqual(result.reasonCodes, ["CANCEL_ACK", "JOURNAL_WRITE_FAILED"]);
    assert.equal(h.coordinator.isJournalLatched(), true);

    const restarted = await restart(h);
    assert.equal(restarted.registry.get(intent.intentId)?.status, "CANCEL_PREPARED");
    assert.equal(restarted.coordinator.canIncreaseRisk(), false);
    assert.deepEqual((await restarted.coordinator.cancel(intent.intentId)).reasonCodes, [
      "CANCEL_UNRESOLVED",
    ]);

    const reconciled = await restarted.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["CANCEL_VERIFIED"]);
    assert.equal(restarted.coordinator.canIncreaseRisk(), true);
    assert.equal(h.venue.calls.cancel, 1);
  });
});

describe("P3-E07 cancel confirmed without fill", () => {
  test("an ACK is not a cancel until the venue shows the order cancelled", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "CANCEL_UNVERIFIED");
    assert.deepEqual(result.reasonCodes, ["CANCEL_ACK"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items, [
      { intentId: intent.intentId, status: "CANCELLED", reasonCodes: ["CANCEL_VERIFIED"] },
    ]);
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.executedQuantity, "0");
    assert.deepEqual(record?.executions, []);
    assert.equal(h.registry.intentIdForExchangeOrderId("sim-order-1"), intent.intentId);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    assert.deepEqual(IntentRegistry.fromState(h.journal.latest()).get(intent.intentId), record);

    assert.deepEqual((await h.coordinator.cancel(intent.intentId)).reasonCodes, [
      "ORDER_ALREADY_CLOSED",
    ]);
    assert.equal(h.venue.calls.cancel, 1);
  });

  test("a rejected cancel of an open order resolves back to LINKED", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.scriptCancel("REJECT");

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "CANCEL_UNVERIFIED");
    assert.deepEqual(result.reasonCodes, ["CANCEL_REJECTED"]);
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "LINKED");
  });

  test("disappearance without execution evidence is never a fill", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    await h.coordinator.cancel(intent.intentId);
    h.venue.forgetOrder("sim-order-1");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reconciled = await h.coordinator.reconcileUnresolved();
      assert.deepEqual(reconciled.items[0]?.reasonCodes, ["ORDER_NOT_OBSERVED"]);
    }
    assert.equal(h.registry.get(intent.intentId)?.status, "CANCEL_UNVERIFIED");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a venue result that proves nothing stays unverified", async () => {
    const results: Array<[unknown, string]> = [
      [
        { kind: "ACK", ack: { exchangeOrderId: "sim-order-9", cancelled: true } },
        "ACK_IDENTITY_MISMATCH",
      ],
      [
        { kind: "ACK", ack: { exchangeOrderId: "sim-order-1", cancelled: false } },
        "ACK_IDENTITY_MISMATCH",
      ],
      [{ kind: "ACK", ack: null }, "ACK_IDENTITY_MISMATCH"],
      [{ kind: "QUEUED" }, "UNRECOGNIZED_VENUE_RESULT"],
      [null, "TRANSPORT_OUTCOME_UNKNOWN"],
    ];
    for (const [value, reasonCode] of results) {
      const base = await createHarness();
      const intent = await placeLinked(base);
      const h = await restart(
        base,
        portOver(base, {
          cancelOrder: async () => value as Awaited<ReturnType<ExecutionVenuePort["cancelOrder"]>>,
        }),
      );
      const result = await h.coordinator.cancel(intent.intentId);
      assert.equal(result.record?.status, "CANCEL_UNVERIFIED", reasonCode);
      assert.deepEqual(result.reasonCodes, [reasonCode]);
      assert.equal(h.coordinator.canIncreaseRisk(), false);
    }
  });
});

describe("P3-E08 cancel races with fill", () => {
  test("PLACE -> ACK -> PARTIAL_FILL -> CANCEL_RACE -> FILL: execution evidence wins", async () => {
    const base = await createHarness();
    const intent = await placeLinked(base);
    base.venue.fill("sim-order-1", "0.004", "100");
    // The remainder fills while the cancel is in flight, so the venue sees the fill first.
    const h = await restart(
      base,
      portOver(base, {
        cancelOrder(request) {
          base.venue.fill(request.exchangeOrderId, "0.006", "100");
          return base.venue.cancelOrder(request);
        },
      }),
    );

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "CANCEL_UNVERIFIED");
    assert.deepEqual(result.reasonCodes, ["CANCEL_REJECTED"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["ORDER_FILLED"]);
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.status, "FILLED");
    assert.equal(record?.executedQuantity, "0.01");
    assert.deepEqual(
      record?.executions.map((execution) => [execution.executionId, execution.quantity]),
      [
        ["sim-exec-1", "0.004"],
        ["sim-exec-2", "0.006"],
      ],
    );
    assert.equal(h.registry.intentIdForExecutionId("sim-exec-2"), intent.intentId);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    assert.deepEqual((await h.coordinator.cancel(intent.intentId)).reasonCodes, [
      "ORDER_ALREADY_CLOSED",
    ]);
  });

  test("a partial fill before a confirmed cancel keeps the executed quantity", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.cancel(intent.intentId);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["CANCEL_VERIFIED"]);
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.status, "CANCELLED");
    assert.equal(record?.executedQuantity, "0.004");
    assert.deepEqual(
      record?.executions.map((execution) => execution.executionId),
      ["sim-exec-1"],
    );
  });

  test("a fill after an unknown cancel wins over the cancel", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.scriptCancel("UNKNOWN_DROPPED");
    await h.coordinator.cancel(intent.intentId);
    h.venue.fill("sim-order-1", "0.01", "100");

    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "FILLED");
  });

  test("executions covering the quantity prove a fill even if the order vanished", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.scriptCancel("UNKNOWN_DROPPED");
    await h.coordinator.cancel(intent.intentId);
    h.venue.fill("sim-order-1", "0.006", "100");
    h.venue.forgetOrder("sim-order-1");

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["FILLED_BY_EXECUTION_EVIDENCE"]);
    assert.equal(h.registry.get(intent.intentId)?.executedQuantity, "0.01");
  });

  test("contradicting or incomplete evidence never resolves the cancel", async () => {
    // LINKED with one recorded execution, then a cancel that never reached the venue.
    const base = await createHarness();
    base.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await base.coordinator.submit(intent);
    const first = base.venue.fill("sim-order-1", "0.004", "100");
    await base.coordinator.reconcileUnresolved();
    assert.equal(base.registry.get(intent.intentId)?.executions.length, 1);
    base.venue.scriptCancel("UNKNOWN_DROPPED");
    await base.coordinator.cancel(intent.intentId);

    const rest = { ...first, executionId: "sim-exec-9", quantity: "0.006" };
    const cases: Array<[string, (lookup: ClientOrderLookup) => ClientOrderLookup]> = [
      [
        "LOOKUP_ORDER_MISMATCH",
        (l) => ({ ...l, order: l.order && { ...l.order, exchangeOrderId: "sim-order-9" } }),
      ],
      ["LOOKUP_ORDER_MISMATCH", (l) => ({ ...l, order: l.order && { ...l.order, side: "SELL" } })],
      ["EXECUTION_EVIDENCE_MISSING", (l) => ({ ...l, executions: [] })],
      [
        "LOOKUP_EXECUTION_MISMATCH",
        (l) => ({ ...l, executions: [{ ...first, quantity: "0.005" }] }),
      ],
      [
        "LOOKUP_EXECUTION_MISMATCH",
        (l) => ({
          ...l,
          executions: [...l.executions, { ...rest, exchangeOrderId: "sim-order-9" }],
        }),
      ],
      [
        "LOOKUP_EXECUTION_MISMATCH",
        (l) => ({ ...l, executions: [...l.executions, { ...first, price: "101" }] }),
      ],
      [
        "LOOKUP_OVERFILL",
        (l) => ({ ...l, executions: [...l.executions, { ...rest, quantity: "0.007" }] }),
      ],
      [
        "EXECUTION_EVIDENCE_INCOMPLETE",
        (l) => ({ ...l, order: l.order && { ...l.order, executedQuantity: "0" } }),
      ],
      [
        "ORDER_STATUS_UNPROVEN",
        (l) => ({ ...l, order: l.order && { ...l.order, status: "EXPIRED" } }),
      ],
      [
        "ORDER_STATUS_UNPROVEN",
        (l) => ({ ...l, order: l.order && { ...l.order, status: "FILLED" } }),
      ],
      [
        "ORDER_STATUS_UNPROVEN",
        (l) => ({
          order: l.order && { ...l.order, executedQuantity: "0.01", status: "CANCELLED" },
          executions: [...l.executions, rest],
        }),
      ],
      [
        "ORDER_STATUS_UNPROVEN",
        (l) => ({
          order: l.order && { ...l.order, executedQuantity: "0.01", status: "OPEN" },
          executions: [...l.executions, rest],
        }),
      ],
      ["ORDER_NOT_OBSERVED", (l) => ({ ...l, order: null })],
    ];
    for (const [reasonCode, mutate] of cases) {
      const h = await restart(
        base,
        portOver(base, {
          lookupClientOrder: async (clientOrderId) =>
            mutate(await base.venue.lookupClientOrder(clientOrderId)),
        }),
      );
      const reconciled = await h.coordinator.reconcileUnresolved();
      assert.deepEqual(reconciled.items[0]?.reasonCodes, [reasonCode]);
      assert.equal(h.registry.get(intent.intentId)?.status, "CANCEL_UNVERIFIED", reasonCode);
      assert.equal(h.coordinator.canIncreaseRisk(), false);
    }
  });

  test("an execution owned by another intent never resolves the cancel", async () => {
    const h = await createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const owner = buildIntent();
    await h.coordinator.submit(owner);
    const owned = h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.reconcileUnresolved();
    const intent = await placeLinked(h, buildIntent({ logicalLevelId: "B2" }));
    h.venue.scriptCancel("UNKNOWN_DROPPED");
    await h.coordinator.cancel(intent.intentId);

    const restarted = await restart(
      h,
      portOver(h, {
        async lookupClientOrder(clientOrderId) {
          const lookup = await h.venue.lookupClientOrder(clientOrderId);
          const stolen = {
            ...owned,
            exchangeOrderId: "sim-order-2",
            clientOrderId: intent.clientOrderId,
          };
          return {
            order: lookup.order && { ...lookup.order, executedQuantity: "0.004" },
            executions: [stolen],
          };
        },
      }),
    );
    const reconciled = await restarted.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["EXECUTION_ID_COLLISION"]);
    assert.equal(restarted.coordinator.canIncreaseRisk(), false);
  });
});

describe("P3 cancel admission", () => {
  test("only a linked, open order of this scope is cancellable", async () => {
    const h = await createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED", "REJECT", "UNKNOWN_DROPPED");
    const filled = buildIntent();
    const rejected = buildIntent({ logicalLevelId: "B2" });
    const unknown = buildIntent({ logicalLevelId: "B3" });
    await h.coordinator.submit(filled);
    h.venue.fill("sim-order-1", "0.01", "100");
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(filled.intentId)?.executedQuantity, "0.01");
    assert.equal((await h.coordinator.submit(rejected)).record?.status, "REJECTED");
    assert.equal((await h.coordinator.submit(unknown)).record?.status, "UNKNOWN");

    const cases: Array<[OrderIntent, string]> = [
      [buildIntent({ sequence: "9" }), "INTENT_NOT_REGISTERED"],
      [unknown, "CANCEL_REQUIRES_LINKED_ORDER"],
      [rejected, "CANCEL_REQUIRES_LINKED_ORDER"],
      [filled, "ORDER_FULLY_EXECUTED"],
    ];
    for (const [intent, reasonCode] of cases) {
      const result = await h.coordinator.cancel(intent.intentId);
      assert.equal(result.disposition, "REFUSED");
      assert.deepEqual(result.reasonCodes, [reasonCode]);
    }

    const open = await placeLinked(
      h,
      buildIntent({ logicalLevelId: "B4", purpose: "GRID_EXIT", reduceOnly: true }),
    );
    const otherRun = new ExecutionCoordinator({
      config: {
        experimentId: "exp-1",
        runId: "run-2",
        scopeKey: SCOPE_KEY,
        writeBudgetPerCycle: 100,
      },
      registry: h.registry,
      venue: h.venue,
      fence: openFence(),
      journal: h.journal,
      exposure: flatExposure(),
      checkpoints: h.checkpoints,
      executionCursor: null,
    });
    assert.deepEqual((await otherRun.cancel(open.intentId)).reasonCodes, ["INTENT_SCOPE_MISMATCH"]);
    assert.equal(h.venue.calls.cancel, 0);
  });

  test("one operation at a time, and a latched journal refuses cancels", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    const first = h.coordinator.cancel(intent.intentId);
    assert.deepEqual((await h.coordinator.cancel(intent.intentId)).reasonCodes, [
      "COORDINATOR_BUSY",
    ]);
    await first;

    const latched = await createHarness();
    const open = await placeLinked(latched);
    latched.journal.scriptPersist("FAIL");
    await latched.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
    assert.deepEqual((await latched.coordinator.cancel(open.intentId)).reasonCodes, [
      "JOURNAL_LATCHED",
    ]);
    assert.equal(latched.venue.calls.cancel, 0);
  });
});

describe("P3 cancel fencing and write-ahead", () => {
  test("a fence or venue NOT_SENT restores LINKED", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    const fenced = await createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
      fence: notSentFence(),
    });
    const result = await fenced.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "LINKED");
    assert.deepEqual(result.reasonCodes, ["FENCE_NOT_SENT", "MUTATION_NOT_SENT"]);
    assert.equal(h.venue.calls.cancel, 0);
    assert.equal(fenced.coordinator.canIncreaseRisk(), true);

    const venueNotSent = await restart(
      h,
      portOver(h, { cancelOrder: async () => ({ kind: "NOT_SENT", reason: "TEST" }) }),
    );
    const notSent = await venueNotSent.coordinator.cancel(intent.intentId);
    assert.equal(notSent.record?.status, "LINKED");
    assert.deepEqual(notSent.reasonCodes, ["VENUE_NOT_SENT"]);
    assert.equal(
      IntentRegistry.fromState(venueNotSent.journal.latest()).get(intent.intentId)?.status,
      "LINKED",
    );
  });

  test("real runtime lease: cancels while held, NOT_SENT after release", async () => {
    resetLeaseProcessStateForTests();
    const directory = await mkdtemp(path.join(os.tmpdir(), "phase3b-lease-"));
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
      const h = await createHarness({ fence: createLeaseMutationFence(lease) });
      const generation = authority.generation;
      const held = await placeLinked(h, buildIntent({ leaseGeneration: generation }));
      const later = await placeLinked(
        h,
        buildIntent({ leaseGeneration: generation, logicalLevelId: "B2" }),
      );

      assert.deepEqual((await h.coordinator.cancel(held.intentId)).reasonCodes, ["CANCEL_ACK"]);
      const released = await releaseRuntimeLease(lease);
      assert.equal(released.disposition, "RELEASED");
      const after = await h.coordinator.cancel(later.intentId);
      assert.equal(after.record?.status, "LINKED");
      assert.ok(after.reasonCodes.includes("MUTATION_NOT_SENT"));
      assert.equal(h.venue.calls.cancel, 1);
    } finally {
      resetLeaseProcessStateForTests();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CANCEL_PREPARED is durable before the venue sees the cancel", async () => {
    const base = await createHarness();
    const intent = await placeLinked(base);
    const statusesAtSend: string[] = [];
    const h = await createHarness({
      venue: base.venue,
      journal: base.journal,
      registry: base.registry,
      port: portOver(base, {
        cancelOrder(request) {
          const state = base.journal.latest() as IntentRegistryState;
          statusesAtSend.push(state.records[0]?.status ?? "MISSING");
          return base.venue.cancelOrder(request);
        },
      }),
    });
    await h.coordinator.cancel(intent.intentId);
    assert.deepEqual(statusesAtSend, ["CANCEL_PREPARED"]);
  });

  test("a failed write-ahead latches and never sends the cancel", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.journal.scriptPersist("FAIL");

    const result = await h.coordinator.cancel(intent.intentId);
    assert.equal(result.record?.status, "LINKED");
    assert.deepEqual(result.reasonCodes, ["JOURNAL_WRITE_FAILED"]);
    assert.equal(h.venue.calls.cancel, 0);
    assert.equal(h.coordinator.isJournalLatched(), true);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.equal((await restart(h)).registry.get(intent.intentId)?.status, "LINKED");
  });
});

describe("P3 cancel registry invariants", () => {
  async function closedState(): Promise<IntentRegistryState> {
    const h = await createHarness();
    const cancelled = await placeLinked(h);
    const filled = await placeLinked(h, buildIntent({ logicalLevelId: "B2" }));
    const pending = await placeLinked(h, buildIntent({ logicalLevelId: "B3" }));
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.fill("sim-order-2", "0.01", "100");
    await h.coordinator.cancel(cancelled.intentId);
    await h.coordinator.cancel(filled.intentId);
    await h.coordinator.reconcileUnresolved();
    await h.coordinator.cancel(pending.intentId);
    return h.journal.latest() as IntentRegistryState;
  }

  test("cancel states round-trip through strict import", async () => {
    const state = await closedState();
    assert.deepEqual(
      state.records.map((record) => [record.status, record.executedQuantity]).sort(),
      [
        ["CANCELLED", "0.004"],
        ["CANCEL_UNVERIFIED", "0"],
        ["FILLED", "0.01"],
      ],
    );
    assert.deepEqual(IntentRegistry.fromState(state).exportState(), state);
  });

  test("import rejects a status that contradicts the executed quantity", async () => {
    const state = await closedState();
    const swaps: Record<string, string> = {
      CANCELLED: "FILLED",
      FILLED: "CANCELLED",
      CANCEL_UNVERIFIED: "FILLED",
    };
    for (const [index, record] of state.records.entries()) {
      const patched = structuredClone(state);
      const target = patched.records[index];
      assert.ok(target !== undefined);
      target.status = swaps[record.status] as typeof target.status;
      assertRegistryError(
        () => IntentRegistry.fromState(patched),
        "IMPORT_STATUS_QUANTITY_MISMATCH",
      );
    }
    const pendingFull = structuredClone(state);
    const filled = pendingFull.records.find((record) => record.status === "FILLED");
    assert.ok(filled !== undefined);
    filled.status = "CANCEL_UNVERIFIED";
    assertRegistryError(
      () => IntentRegistry.fromState(pendingFull),
      "IMPORT_STATUS_QUANTITY_MISMATCH",
    );
  });

  test("the registry never relinks or resolves outside a pending cancel", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    const id = intent.intentId;
    const link = {
      exchangeOrderId: "sim-order-1",
      authority: { source: "ACK" as const, evidenceId: "ack:sim-order-1" },
      executions: [],
      reasonCodes: [],
    };

    assertRegistryError(
      () => h.registry.resolveCancel(id, { status: "CANCELLED", executions: [], reasonCodes: [] }),
      "INVALID_TRANSITION:LINKED->CANCELLED",
    );
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.scriptCancel("UNKNOWN_DROPPED");
    await h.coordinator.cancel(id);
    assertRegistryError(
      () => h.registry.link(id, link),
      "INVALID_TRANSITION:CANCEL_UNVERIFIED->LINKED",
    );
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(id)?.executedQuantity, "0.004");

    await h.coordinator.cancel(id);
    assertRegistryError(
      () => h.registry.resolveCancel(id, { status: "CANCELLED", executions: [], reasonCodes: [] }),
      "EXECUTION_EVIDENCE_MISSING",
    );
    const recorded = h.registry.get(id)?.executions ?? [];
    assertRegistryError(
      () =>
        h.registry.resolveCancel(id, { status: "FILLED", executions: recorded, reasonCodes: [] }),
      "STATUS_QUANTITY_MISMATCH",
    );
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(id)?.status, "CANCELLED");
    assertRegistryError(
      () => h.registry.markCancelPrepared(id, []),
      "INVALID_TRANSITION:CANCELLED->CANCEL_PREPARED",
    );
  });
});
