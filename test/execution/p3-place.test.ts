import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { makeClientOrderId, makeIntentId } from "../../src/domain/ids.js";
import {
  createLeaseMutationFence,
  type ExecutionVenuePort,
  INTENT_REGISTRY_SCHEMA_VERSION,
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
  MemoryJournal,
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

describe("P3-E01 place ACK", () => {
  test("ACK links a stable intent -> client ID -> exchange ID mapping", async () => {
    const h = createHarness();
    const intent = buildIntent();
    const result = await h.coordinator.submit(intent);

    assert.equal(result.disposition, "RECORDED");
    assert.equal(result.record?.status, "LINKED");
    assert.equal(result.record?.exchangeOrderId, "sim-order-1");
    assert.deepEqual(result.record?.authority, { source: "ACK", evidenceId: "ack:sim-order-1" });
    assert.equal(h.registry.intentIdForClientOrderId(clientIdOf(intent)), intent.intentId);
    assert.equal(h.registry.intentIdForExchangeOrderId("sim-order-1"), intent.intentId);
    assert.equal(h.coordinator.canIncreaseRisk(), true);

    const restored = IntentRegistry.fromState(h.journal.latest());
    assert.deepEqual(restored.get(intent.intentId), result.record);
    assert.equal(restored.intentIdForExchangeOrderId("sim-order-1"), intent.intentId);
  });

  test("resubmitting the same intent never sends a second order", async () => {
    const h = createHarness();
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    const again = await h.coordinator.submit(structuredClone(intent));

    assert.equal(again.disposition, "ALREADY_RECORDED");
    assert.deepEqual(again.reasonCodes, ["INTENT_ALREADY_RECORDED"]);
    assert.equal(h.venue.calls.place, 1);
  });

  test("same intent ID with different content is refused", async () => {
    const h = createHarness();
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    const conflict = await h.coordinator.submit({ ...intent, price: "101" });

    assert.equal(conflict.disposition, "REFUSED");
    assert.deepEqual(conflict.reasonCodes, ["INTENT_CONTENT_CONFLICT"]);
    assert.equal(h.venue.calls.place, 1);
  });
});

describe("P3-E02 place REJECTED", () => {
  test("rejection leaves no working order and does not block risk", async () => {
    const h = createHarness();
    h.venue.scriptPlace("REJECT");
    const intent = buildIntent();
    const result = await h.coordinator.submit(intent);

    assert.equal(result.record?.status, "REJECTED");
    assert.equal(result.record?.exchangeOrderId, null);
    assert.deepEqual(result.reasonCodes, ["VENUE_REJECTED"]);
    assert.equal(h.venue.orderForClientOrderId(clientIdOf(intent)), null);
    assert.equal(h.coordinator.canIncreaseRisk(), true);

    const retry = await h.coordinator.submit(buildIntent({ sequence: "2" }));
    assert.equal(retry.record?.status, "LINKED");
  });
});

describe("P3-E03 UNKNOWN later found by client ID", () => {
  test("blocks risk, then adopts the existing order without a duplicate", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    const first = await h.coordinator.submit(intent);

    assert.equal(first.record?.status, "UNKNOWN");
    assert.deepEqual(first.reasonCodes, ["VENUE_OUTCOME_UNKNOWN"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const other = await h.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
    assert.equal(other.disposition, "REFUSED");
    assert.deepEqual(other.reasonCodes, ["UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE"]);

    const resubmit = await h.coordinator.submit(intent);
    assert.equal(resubmit.disposition, "ALREADY_RECORDED");
    assert.equal(h.venue.calls.place, 1);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled, {
      reasonCodes: [],
      items: [
        {
          intentId: intent.intentId,
          status: "LINKED",
          reasonCodes: ["RECONCILED_BY_CLIENT_ORDER_ID"],
        },
      ],
    });
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.exchangeOrderId, "sim-order-1");
    assert.deepEqual(record?.authority, {
      source: "AUTHORITATIVE_OBSERVATION",
      evidenceId: "order:sim-order-1",
    });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    assert.equal(h.venue.calls.place, 1);
  });

  test("risk-reducing exit in another slot is still admitted while unresolved", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    await h.coordinator.submit(buildIntent());
    const exit = await h.coordinator.submit(
      buildIntent({ logicalLevelId: "S1", purpose: "GRID_EXIT", side: "SELL", reduceOnly: true }),
    );

    assert.equal(exit.record?.status, "LINKED");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("lost journal: duplicate client ID rejection is UNKNOWN and reconciles to the original", async () => {
    const before = createHarness();
    const intent = buildIntent();
    await before.coordinator.submit(intent);

    const after = createHarness({ venue: before.venue });
    const result = await after.coordinator.submit(intent);
    assert.equal(result.record?.status, "UNKNOWN");
    assert.deepEqual(result.reasonCodes, ["DUPLICATE_CLIENT_ORDER_ID_REJECTION"]);
    assert.equal(after.coordinator.canIncreaseRisk(), false);

    await after.coordinator.reconcileUnresolved();
    assert.equal(after.registry.get(intent.intentId)?.exchangeOrderId, "sim-order-1");
    assert.equal(
      after.venue.orderForClientOrderId(clientIdOf(intent))?.exchangeOrderId,
      "sim-order-1",
    );
  });
});

describe("P3-E04 UNKNOWN with execution evidence", () => {
  test("full execution without the order record is authoritative", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    h.venue.fill("sim-order-1", "0.01", "100");
    h.venue.forgetOrder("sim-order-1");

    await h.coordinator.reconcileUnresolved();
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.status, "LINKED");
    assert.equal(record?.executedQuantity, "0.01");
    assert.deepEqual(record?.authority, {
      source: "AUTHORITATIVE_OBSERVATION",
      evidenceId: "execution:sim-exec-1",
    });
    assert.equal(h.registry.intentIdForExecutionId("sim-exec-1"), intent.intentId);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("partial fill preserves executed quantity when the order is visible", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    h.venue.fill("sim-order-1", "0.004", "99.5");

    await h.coordinator.reconcileUnresolved();
    const record = h.registry.get(intent.intentId);
    assert.equal(record?.status, "LINKED");
    assert.equal(record?.executedQuantity, "0.004");
    assert.deepEqual(record?.executions, [
      {
        executionId: "sim-exec-1",
        exchangeOrderId: "sim-order-1",
        quantity: "0.004",
        price: "99.5",
      },
    ]);
  });

  test("partial executions without the order stay unresolved", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.forgetOrder("sim-order-1");

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["ORDER_STATE_UNPROVEN"]);
    assert.equal(h.registry.get(intent.intentId)?.status, "UNKNOWN");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a thrown transport call is UNKNOWN, never REJECTED", async () => {
    const h = createHarness();
    h.venue.scriptPlace("THROW_ACCEPTED");
    const intent = buildIntent();
    const result = await h.coordinator.submit(intent);

    assert.equal(result.record?.status, "UNKNOWN");
    assert.deepEqual(result.reasonCodes, ["TRANSPORT_OUTCOME_UNKNOWN", "FENCED_CALLBACK_THREW"]);
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "LINKED");
  });
});

describe("P3-E05 no definitive evidence", () => {
  test("remains blocked and never retries the slot under a new ID", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_DROPPED");
    const intent = buildIntent();
    await h.coordinator.submit(intent);

    const reconciled = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items, [
      { intentId: intent.intentId, status: "UNKNOWN", reasonCodes: ["NO_DEFINITIVE_EVIDENCE"] },
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const retry = await h.coordinator.submit(buildIntent({ sequence: "2" }));
    assert.equal(retry.disposition, "REFUSED");
    assert.deepEqual(retry.reasonCodes, ["UNRESOLVED_INTENT_FOR_SLOT"]);
    assert.equal(h.venue.calls.place, 1);
  });

  test("a failed lookup proves nothing and keeps the intent unresolved", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    h.venue.failNextLookups(1);

    const failed = await h.coordinator.reconcileUnresolved();
    assert.deepEqual(failed.items[0]?.reasonCodes, ["LOOKUP_FAILED"]);
    assert.equal(h.registry.get(intent.intentId)?.status, "UNKNOWN");

    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(intent.intentId)?.status, "LINKED");
  });

  test("a lookup that contradicts the intent does not link", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await h.coordinator.submit(intent);
    const port: ExecutionVenuePort = {
      placeOrder: (value) => h.venue.placeOrder(value),
      cancelOrder: (request) => h.venue.cancelOrder(request),
      async lookupClientOrder(clientOrderId) {
        const lookup = await h.venue.lookupClientOrder(clientOrderId);
        return { ...lookup, order: lookup.order && { ...lookup.order, side: "SELL" } };
      },
      listOpenOrders: () => h.venue.listOpenOrders(),
    };
    const restarted = createHarness({
      venue: h.venue,
      port,
      registry: IntentRegistry.fromState(h.journal.latest()),
    });

    const reconciled = await restarted.coordinator.reconcileUnresolved();
    assert.deepEqual(reconciled.items[0]?.reasonCodes, ["LOOKUP_ORDER_MISMATCH"]);
    assert.equal(restarted.coordinator.canIncreaseRisk(), false);
  });
});

describe("P3 deterministic client order IDs", () => {
  test("derivation is stable and collision-free over a large sweep", () => {
    const seen = new Set<string>();
    const purposes = ["GRID_ENTRY", "GRID_EXIT", "RISK_REDUCTION", "EMERGENCY_FLATTEN"] as const;
    for (let level = 0; level < 200; level += 1) {
      for (const purpose of purposes) {
        for (let sequence = 0; sequence < 200; sequence += 1) {
          const base = {
            scopeKey: SCOPE_KEY,
            anchorEpoch: "epoch-1",
            logicalLevelId: `L${level}`,
            purpose,
          };
          const intentId = makeIntentId({
            ...base,
            experimentId: "exp-1",
            runId: "run-1",
            sequence: String(sequence),
          });
          const clientOrderId = makeClientOrderId({ ...base, intentId });
          assert.match(clientOrderId, /^mv1[0-9a-f]{20}$/);
          seen.add(clientOrderId);
        }
      }
    }
    assert.equal(seen.size, 200 * 4 * 200);
    assert.equal(buildIntent().clientOrderId, buildIntent().clientOrderId);
  });

  test("a client ID not derived from the intent is refused before any send", async () => {
    const h = createHarness();
    const forged = await h.coordinator.submit({
      ...buildIntent(),
      clientOrderId: `mv1${"0".repeat(20)}`,
    });
    const missing = await h.coordinator.submit({ ...buildIntent(), clientOrderId: null });

    assert.deepEqual(forged.reasonCodes, ["CLIENT_ORDER_ID_NOT_DETERMINISTIC"]);
    assert.deepEqual(missing.reasonCodes, ["CLIENT_ORDER_ID_NOT_DETERMINISTIC"]);
    assert.equal(h.venue.calls.place, 0);
    assert.deepEqual(h.registry.list(), []);
  });

  test("malformed and cancel intents are refused", async () => {
    const h = createHarness();
    const extra = await h.coordinator.submit({ ...buildIntent(), note: "x" } as never);
    const cancel = await h.coordinator.submit(buildIntent({ purpose: "CANCEL" }));
    const market = await h.coordinator.submit(buildIntent({ type: "MARKET" }));

    assert.deepEqual(extra.reasonCodes, ["INVALID_INTENT_FIELDS"]);
    assert.deepEqual(cancel.reasonCodes, ["CANCEL_IS_NOT_A_PLACE"]);
    assert.deepEqual(market.reasonCodes, ["INVALID_INTENT_FIELDS"]);
    assert.equal(h.venue.calls.place, 0);
  });

  test("registry refuses to prepare the same intent twice", () => {
    const registry = new IntentRegistry();
    registry.prepare(buildIntent());
    assertRegistryError(() => registry.prepare(buildIntent()), "INTENT_ALREADY_REGISTERED");
  });
});

describe("P3 lease fence before every mutation", () => {
  test("intent from another lease generation or scope is refused", async () => {
    const h = createHarness({ fence: openFence("2") });
    const stale = await h.coordinator.submit(buildIntent());
    const foreign = await h.coordinator.submit(
      buildIntent({ runId: "run-2", leaseGeneration: "2" }),
    );

    assert.deepEqual(stale.reasonCodes, ["INTENT_LEASE_GENERATION_MISMATCH"]);
    assert.deepEqual(foreign.reasonCodes, ["INTENT_SCOPE_MISMATCH"]);
    assert.equal(h.venue.calls.place, 0);
  });

  test("fence NOT_SENT records NOT_SENT and never calls the venue", async () => {
    const h = createHarness({ fence: notSentFence() });
    const result = await h.coordinator.submit(buildIntent());

    assert.equal(result.record?.status, "NOT_SENT");
    assert.deepEqual(result.reasonCodes, ["FENCE_NOT_SENT", "MUTATION_NOT_SENT"]);
    assert.equal(h.venue.calls.place, 0);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("real runtime lease: sends while held, NOT_SENT after release", async () => {
    resetLeaseProcessStateForTests();
    const directory = await mkdtemp(path.join(os.tmpdir(), "phase3-lease-"));
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
      const h = createHarness({ fence: createLeaseMutationFence(lease) });
      const generation = authority.generation;

      const held = await h.coordinator.submit(buildIntent({ leaseGeneration: generation }));
      assert.equal(held.record?.status, "LINKED");

      const released = await releaseRuntimeLease(lease);
      assert.equal(released.disposition, "RELEASED");
      const after = await h.coordinator.submit(
        buildIntent({ leaseGeneration: generation, sequence: "2" }),
      );
      assert.equal(after.record?.status, "NOT_SENT");
      assert.ok(after.reasonCodes.includes("MUTATION_NOT_SENT"));
      assert.equal(h.venue.calls.place, 1);
    } finally {
      resetLeaseProcessStateForTests();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("P3 write-ahead journal", () => {
  test("PREPARED is durable before the venue sees the order", async () => {
    const journal = new MemoryJournal();
    const statusesAtSend: string[] = [];
    const base = createHarness({ journal });
    const port: ExecutionVenuePort = {
      placeOrder(intent) {
        const state = journal.latest() as IntentRegistryState;
        const record = state.records.find((item) => item.intent.intentId === intent.intentId);
        statusesAtSend.push(record?.status ?? "MISSING");
        return base.venue.placeOrder(intent);
      },
      cancelOrder: (request) => base.venue.cancelOrder(request),
      lookupClientOrder: (clientOrderId) => base.venue.lookupClientOrder(clientOrderId),
      listOpenOrders: () => base.venue.listOpenOrders(),
    };
    const h = createHarness({ venue: base.venue, port, journal });
    await h.coordinator.submit(buildIntent());

    assert.deepEqual(statusesAtSend, ["PREPARED"]);
    const latest = journal.latest() as IntentRegistryState;
    assert.equal(latest.records[0]?.status, "LINKED");
  });

  test("write-ahead failure sends nothing and latches the coordinator", async () => {
    const h = createHarness();
    h.journal.scriptPersist("FAIL");
    const result = await h.coordinator.submit(buildIntent());

    assert.equal(result.record?.status, "NOT_SENT");
    assert.deepEqual(result.reasonCodes, ["JOURNAL_WRITE_FAILED"]);
    assert.equal(h.venue.calls.place, 0);
    assert.equal(h.coordinator.isJournalLatched(), true);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const next = await h.coordinator.submit(buildIntent({ sequence: "2" }));
    assert.deepEqual(next.reasonCodes, ["JOURNAL_LATCHED"]);
    assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
      reasonCodes: ["JOURNAL_LATCHED"],
      items: [],
    });
  });

  test("post-send journal failure latches; restart reconciles before new risk", async () => {
    const h = createHarness();
    h.journal.scriptPersist("OK", "FAIL");
    const intent = buildIntent();
    const result = await h.coordinator.submit(intent);

    assert.equal(result.record?.status, "LINKED");
    assert.deepEqual(result.reasonCodes, ["VENUE_ACK", "JOURNAL_WRITE_FAILED"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const restarted = createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
    });
    assert.equal(restarted.registry.get(intent.intentId)?.status, "PREPARED");
    assert.equal(restarted.coordinator.canIncreaseRisk(), false);
    const blocked = await restarted.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
    assert.deepEqual(blocked.reasonCodes, ["UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE"]);

    await restarted.coordinator.reconcileUnresolved();
    assert.equal(restarted.registry.get(intent.intentId)?.exchangeOrderId, "sim-order-1");
    assert.equal(restarted.coordinator.canIncreaseRisk(), true);
    assert.equal(h.venue.calls.place, 1);
  });
});

describe("P3 strict registry import", () => {
  async function linkedState(): Promise<IntentRegistryState> {
    const h = createHarness();
    await h.coordinator.submit(buildIntent());
    await h.coordinator.submit(buildIntent({ logicalLevelId: "B2" }));
    return h.journal.latest() as IntentRegistryState;
  }

  test("valid state round-trips exactly", async () => {
    const state = await linkedState();
    assert.deepEqual(IntentRegistry.fromState(state).exportState(), state);
  });

  test("structural problems are rejected, never repaired", async () => {
    const cases: Array<[string, (state: IntentRegistryState) => unknown]> = [
      ["IMPORT_INVALID_STATE", (state) => ({ ...state, extra: true })],
      ["IMPORT_SCHEMA_VERSION_MISMATCH", (state) => ({ ...state, schemaVersion: "v0" })],
      [
        "IMPORT_RECORDS_NOT_SORTED",
        (state) => ({ ...state, records: [...state.records].reverse() }),
      ],
      ["IMPORT_INVALID_RECORD", (state) => withRecord(state, { extra: true })],
      ["IMPORT_INVALID_STATUS", (state) => withRecord(state, { status: "SETTLED" })],
      ["IMPORT_FINGERPRINT_MISMATCH", (state) => withRecord(state, { requestFingerprint: "0" })],
      ["IMPORT_LINK_INCONSISTENT", (state) => withRecord(state, { exchangeOrderId: null })],
      ["IMPORT_LINK_INCONSISTENT", (state) => withRecord(state, { status: "UNKNOWN" })],
      [
        "IMPORT_INVALID_AUTHORITY",
        (state) => withRecord(state, { authority: { source: "GUESS", evidenceId: "x" } }),
      ],
      [
        "IMPORT_EXECUTED_QUANTITY_MISMATCH",
        (state) => withRecord(state, { executedQuantity: "0.01" }),
      ],
      [
        "EXCHANGE_ORDER_ID_COLLISION",
        (state) => withRecord(state, { exchangeOrderId: "sim-order-2" }),
      ],
      [
        "IMPORT_INVALID_INTENT",
        (state) =>
          withRecord(state, {
            intent: { ...state.records[0]?.intent, clientOrderId: `mv1${"f".repeat(20)}` },
          }),
      ],
    ];
    const state = await linkedState();
    for (const [reasonCode, mutate] of cases) {
      assertRegistryError(
        () => IntentRegistry.fromState(mutate(structuredClone(state))),
        reasonCode,
      );
    }
    assert.equal(state.schemaVersion, INTENT_REGISTRY_SCHEMA_VERSION);
  });

  test("unresolved imported intents block risk until reconciled", async () => {
    const h = createHarness();
    h.venue.scriptPlace("UNKNOWN_DROPPED");
    await h.coordinator.submit(buildIntent());

    const restarted = createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
    });
    assert.equal(restarted.registry.unresolved().length, 1);
    assert.equal(restarted.coordinator.canIncreaseRisk(), false);
  });
});

function withRecord(state: IntentRegistryState, patch: Record<string, unknown>): unknown {
  const [first, ...rest] = state.records;
  return { ...state, records: [{ ...first, ...patch }, ...rest] };
}
