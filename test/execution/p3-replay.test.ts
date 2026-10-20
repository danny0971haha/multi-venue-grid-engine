import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ExecutionCursor,
  type ExecutionPage,
  type ExecutionVenuePort,
  IntentRegistry,
  IntentRegistryError,
} from "../../src/execution/index.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import {
  buildIntent,
  clientIdOf,
  createHarness,
  grant,
  type Harness,
  OBSERVED_AT,
} from "./helpers.js";

const START_CURSOR = {
  venue: "sim",
  market: "BTC_USDC_PERP",
  opaque: "sim-exec-cursor:0",
  lastExecutionId: null,
  lastExecutionTime: null,
} as ExecutionCursor;

type PageEdit = (page: ExecutionPage) => ExecutionPage | Promise<ExecutionPage>;
type EditableHarness = Harness & { edit(next: PageEdit): void };

function assertRegistryError(run: () => unknown, reasonCode: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof IntentRegistryError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

async function placeLinked(h: Harness, intent: OrderIntent = buildIntent()): Promise<OrderIntent> {
  if (!intent.reduceOnly) {
    await grant(h.coordinator);
  }
  const placed = await h.coordinator.submit(intent);
  assert.equal(placed.record?.status, "LINKED");
  return intent;
}

function portOver(
  venue: SimulatedVenue,
  listExecutionsSince: ExecutionVenuePort["listExecutionsSince"],
): ExecutionVenuePort {
  return {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
    listOpenOrders: () => venue.listOpenOrders(),
    listExecutionsSince,
  };
}

// A harness whose execution pages pass through a replaceable edit before the coordinator
// sees them; every other call goes straight to the simulated venue.
async function editableHarness(): Promise<EditableHarness> {
  const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
  let current: PageEdit = (page) => page;
  const port = portOver(venue, async (cursor) => current(await venue.listExecutionsSince(cursor)));
  const h = await createHarness({ venue, port });
  return {
    ...h,
    edit(next) {
      current = next;
    },
  };
}

function withExecutions(executions: unknown[]): PageEdit {
  return (page) => ({ ...page, executions: executions as ExecutionObservation[] });
}

function withSequence(execution: ExecutionObservation, sequence: string | null) {
  const copy = structuredClone(execution);
  copy.meta.sequence = sequence;
  return copy;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordOf(h: Harness, intent: OrderIntent) {
  const record = h.registry.get(intent.intentId);
  assert.ok(record !== null);
  return record;
}

function executionIdsOf(h: Harness, intent: OrderIntent): string[] {
  return recordOf(h, intent).executions.map((execution) => execution.executionId);
}

describe("P3-E13 replay overlap is idempotent by execution ID", () => {
  test("overlapping pages record every execution once and reach the venue end", async () => {
    const h = await createHarness();
    const first = await placeLinked(h);
    const second = await placeLinked(
      h,
      buildIntent({ sequence: "2", logicalLevelId: "B2", price: "99" }),
    );
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.fill("sim-order-2", "0.01", "99");
    h.venue.fill("sim-order-1", "0.006", "100");
    h.venue.setExecutionPageSize(2);
    h.venue.overlapExecutionReads(1);
    const reads = h.venue.calls.executions;

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-1", "sim-exec-2", "sim-exec-3"],
    });
    assert.equal(h.venue.calls.executions - reads, 2);
    assert.equal(recordOf(h, first).status, "FILLED");
    assert.equal(recordOf(h, first).executedQuantity, "0.01");
    assert.deepEqual(recordOf(h, first).reasonCodes, ["FILLED_BY_EXECUTION_EVIDENCE"]);
    assert.deepEqual(executionIdsOf(h, first), ["sim-exec-1", "sim-exec-3"]);
    assert.equal(recordOf(h, second).status, "FILLED");
    assert.deepEqual(executionIdsOf(h, second), ["sim-exec-2"]);
    assert.deepEqual(h.coordinator.executionCursor(), {
      ...START_CURSOR,
      opaque: "sim-exec-cursor:3",
      lastExecutionId: "sim-exec-3",
      lastExecutionTime: OBSERVED_AT,
    });
    assert.deepEqual(h.checkpoints.latest(), h.coordinator.executionCursor());
    assert.equal(h.coordinator.canIncreaseRisk(), true);

    // A replay that only re-reads recorded executions changes nothing and writes no journal.
    const journalWrites = h.journal.snapshots.length;
    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(h.journal.snapshots.length, journalWrites);
    assert.equal(recordOf(h, first).executedQuantity, "0.01");
  });

  test("the cursor advances page by page and never past a page whose checkpoint failed", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.fill("sim-order-1", "0.003", "100");
    h.venue.setExecutionPageSize(1);
    h.checkpoints.scriptPersist("OK", "FAIL");

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CHECKPOINT_WRITE_FAILED", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: ["sim-exec-1", "sim-exec-2"],
    });
    assert.equal(h.coordinator.executionCursor()?.opaque, "sim-exec-cursor:1");
    assert.deepEqual(h.checkpoints.latest(), h.coordinator.executionCursor());
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(h.coordinator.executionCursor()?.opaque, "sim-exec-cursor:2");
    assert.equal(recordOf(h, intent).executedQuantity, "0.007");
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("a crash between the journal write and the checkpoint write re-reads safely", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.checkpoints.scriptPersist("FAIL");

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CHECKPOINT_WRITE_FAILED", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: ["sim-exec-1"],
    });
    assert.deepEqual(h.coordinator.executionCursor(), START_CURSOR);
    assert.deepEqual(h.checkpoints.latest(), START_CURSOR);

    // The journal holds the execution but the checkpoint does not, as after a crash between them.
    const restarted = await createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
      checkpoints: h.checkpoints,
    });
    assert.deepEqual(restarted.coordinator.executionBlockerCodes(), []);
    assert.deepEqual(executionIdsOf(restarted, intent), ["sim-exec-1"]);
    assert.equal(recordOf(restarted, intent).executedQuantity, "0.004");
    assert.equal(recordOf(restarted, intent).status, "LINKED");
    assert.equal(restarted.coordinator.executionCursor()?.opaque, "sim-exec-cursor:1");
    assert.equal(restarted.coordinator.canIncreaseRisk(), true);
  });

  test("a journal failure latches and leaves the cursor for a restart to re-read", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    const checkpointWrites = h.checkpoints.snapshots.length;
    h.journal.scriptPersist("FAIL");

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_REPLAY_INCOMPLETE", "JOURNAL_WRITE_FAILED"],
      recorded: ["sim-exec-1"],
    });
    assert.equal(h.checkpoints.snapshots.length, checkpointWrites);
    assert.deepEqual(h.coordinator.executionCursor(), START_CURSOR);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["JOURNAL_LATCHED"],
      recorded: [],
    });
    assert.deepEqual(h.coordinator.executionBlockerCodes(), [
      "EXECUTION_REPLAY_INCOMPLETE",
      "JOURNAL_WRITE_FAILED",
    ]);

    const restarted = await createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
      checkpoints: h.checkpoints,
      replay: false,
    });
    assert.deepEqual(executionIdsOf(restarted, intent), []);
    assert.deepEqual(await restarted.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
    assert.equal(recordOf(restarted, intent).executedQuantity, "0.004");
  });
});

describe("P3-E13 replay conflicts fail closed", () => {
  test("a re-read execution with different facts blocks and records nothing from its page", async () => {
    const h = await editableHarness();
    const intent = await placeLinked(h);
    const recorded = h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.replayExecutions();
    h.venue.fill("sim-order-1", "0.003", "100");
    h.venue.overlapExecutionReads(1);
    const cursor = h.coordinator.executionCursor();

    for (const changed of [{ quantity: "0.005" }, { price: "101" }]) {
      h.edit((page) => ({
        ...page,
        executions: page.executions.map((execution) =>
          execution.executionId === recorded.executionId ? { ...execution, ...changed } : execution,
        ),
      }));
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_CONFLICT", "EXECUTION_REPLAY_INCOMPLETE"],
        recorded: [],
      });
      assert.deepEqual(executionIdsOf(h, intent), ["sim-exec-1"]);
      assert.equal(recordOf(h, intent).executedQuantity, "0.004");
      assert.deepEqual(h.coordinator.executionCursor(), cursor);
      assert.equal(h.coordinator.canIncreaseRisk(), false);
    }

    // A later read that agrees with the record cannot clear a conflict the venue reported.
    h.edit((page) => page);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: ["sim-exec-2"],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0.007");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("an execution ID already recorded for another order is a collision", async () => {
    const h = await editableHarness();
    const first = await placeLinked(h);
    const second = await placeLinked(
      h,
      buildIntent({ sequence: "2", logicalLevelId: "B2", price: "99" }),
    );
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.replayExecutions();

    h.edit(
      withExecutions([
        { ...execution, exchangeOrderId: "sim-order-2", clientOrderId: clientIdOf(second) },
      ]),
    );
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_ID_COLLISION", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.deepEqual(executionIdsOf(h, first), ["sim-exec-1"]);
    assert.deepEqual(executionIdsOf(h, second), []);
    assert.equal(h.registry.intentIdForExecutionId("sim-exec-1"), first.intentId);
  });

  test("a repeated execution ID within one page is recorded once unless its facts differ", async () => {
    const h = await editableHarness();
    const intent = await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    const cursor = h.coordinator.executionCursor();

    h.edit(withExecutions([execution, { ...execution, quantity: "0.003" }]));
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.deepEqual(h.coordinator.executionCursor(), cursor);

    h.edit(withExecutions([execution, structuredClone(execution)]));
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: ["sim-exec-1"],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    // Both reported versions stay as evidence; recording one of them explains neither.
    assert.deepEqual(
      h.registry.executionContradictions(),
      ["0.003", "0.004"].map((quantity) => ({
        reasonCode: "EXECUTION_CONFLICT",
        executionId: "sim-exec-1",
        exchangeOrderId: "sim-order-1",
        clientOrderId: clientIdOf(intent),
        side: "BUY",
        quantity,
        price: "100",
      })),
    );
  });

  test("executions that would overfill an order block without recording", async () => {
    const h = await editableHarness();
    const intent = await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    const extra = { ...execution, executionId: "sim-exec-extra", quantity: "0.007" };

    // Two new executions in one page that together exceed the order.
    h.edit(withExecutions([execution, extra]));
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_OVERFILL", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0");

    h.edit((page) => page);
    await h.coordinator.replayExecutions();
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");

    // A new execution that exceeds the order together with what is already recorded.
    h.edit(withExecutions([extra]));
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_OVERFILL", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
    assert.equal(recordOf(h, intent).status, "LINKED");
  });

  test("a new execution for a closed order blocks", async () => {
    const h = await editableHarness();
    const cancelled = await placeLinked(h);
    const filled = await placeLinked(
      h,
      buildIntent({ sequence: "2", logicalLevelId: "B2", price: "99" }),
    );
    await h.coordinator.cancel(cancelled.intentId);
    await h.coordinator.reconcileUnresolved();
    assert.equal(recordOf(h, cancelled).status, "CANCELLED");
    const fill = h.venue.fill("sim-order-2", "0.01", "99");
    await h.coordinator.replayExecutions();
    assert.equal(recordOf(h, filled).status, "FILLED");

    for (const late of [
      { ...fill, executionId: "sim-exec-late-1", exchangeOrderId: "sim-order-1", price: "100" },
      { ...fill, executionId: "sim-exec-late-2", quantity: "0.001" },
    ]) {
      const owner = late.exchangeOrderId === "sim-order-1" ? cancelled : filled;
      h.edit(withExecutions([{ ...late, clientOrderId: clientIdOf(owner) }]));
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_AFTER_CLOSE", "EXECUTION_REPLAY_INCOMPLETE"],
        recorded: [],
      });
    }
    assert.equal(recordOf(h, cancelled).executedQuantity, "0");
    assert.equal(recordOf(h, filled).executedQuantity, "0.01");
  });

  test("malformed or mismatched executions block", async () => {
    const h = await editableHarness();
    const intent = await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    const cases: Array<[unknown, string]> = [
      [null, "EXECUTION_OBSERVATION_INVALID"],
      [{ ...execution, venue: "other" }, "EXECUTION_OBSERVATION_INVALID"],
      [{ ...execution, market: "ETH_USDC_PERP" }, "EXECUTION_OBSERVATION_INVALID"],
      [{ ...execution, executionId: "" }, "EXECUTION_OBSERVATION_INVALID"],
      [{ ...execution, exchangeOrderId: "" }, "EXECUTION_OBSERVATION_INVALID"],
      [{ ...execution, side: "SELL" }, "EXECUTION_MISMATCH"],
      [{ ...execution, clientOrderId: null }, "EXECUTION_MISMATCH"],
      [{ ...execution, quantity: "0" }, "EXECUTION_MISMATCH"],
      [{ ...execution, price: "-1" }, "EXECUTION_MISMATCH"],
      [{ ...execution, quantity: "0.0040" }, "EXECUTION_MISMATCH"],
    ];
    for (const [observed, reasonCode] of cases) {
      h.edit(withExecutions([observed]));
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: [reasonCode, "EXECUTION_REPLAY_INCOMPLETE"],
        recorded: [],
      });
    }
    assert.equal(recordOf(h, intent).executedQuantity, "0");
  });
});

describe("P3 unattributed executions", () => {
  test("an execution of a foreign order blocks and pins the cursor", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    const foreign = h.venue.addForeignOrder({
      clientOrderId: null,
      side: "BUY",
      price: "98",
      quantity: "0.01",
    });
    h.venue.fill(foreign, "0.01", "98");
    const cursor = h.coordinator.executionCursor();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_REPLAY_INCOMPLETE", "UNATTRIBUTED_EXECUTION"],
        recorded: [],
      });
      assert.deepEqual(h.coordinator.executionCursor(), cursor);
    }
    // The page is never applied in part, so the owned execution before it is not recorded.
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("an execution for an intent whose ack was lost blocks until the order is linked", async () => {
    const h = await createHarness();
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    const intent = buildIntent();
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(intent)).record?.status, "UNKNOWN");
    h.venue.fill("sim-order-1", "0.004", "100");

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_FOR_UNLINKED_INTENT", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    await h.coordinator.reconcileUnresolved();
    assert.equal(recordOf(h, intent).status, "LINKED");
    assert.deepEqual(executionIdsOf(h, intent), ["sim-exec-1"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("an execution naming a recorded client ID on another order is a mismatch", async () => {
    const h = await editableHarness();
    const intent = await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    h.edit(
      withExecutions([{ ...execution, executionId: "sim-exec-9", exchangeOrderId: "sim-order-9" }]),
    );

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_MISMATCH", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0");
  });
});

describe("P3-E14 stream executions", () => {
  test("out-of-order and repeated stream events end in the same state as a replay", async () => {
    const streamed = await createHarness();
    const intent = await placeLinked(streamed);
    streamed.coordinator.executionStreamReconnected();
    const [first, second, third] = [
      streamed.venue.fill("sim-order-1", "0.004", "100"),
      streamed.venue.fill("sim-order-1", "0.003", "100"),
      streamed.venue.fill("sim-order-1", "0.003", "100"),
    ].map((execution, index) => withSequence(execution, String(index + 1))) as [
      ExecutionObservation,
      ExecutionObservation,
      ExecutionObservation,
    ];

    // The late sequence 1 must not lower the baseline, or sequence 3 would read as a gap.
    const steps: Array<[ExecutionObservation, string[]]> = [
      [second, ["sim-exec-2"]],
      [first, ["sim-exec-1"]],
      [third, ["sim-exec-3"]],
      [second, []],
      [first, []],
    ];
    for (const [execution, recorded] of steps) {
      assert.deepEqual(await streamed.coordinator.ingestStreamExecution(execution), {
        reasonCodes: [],
        recorded,
      });
    }
    assert.equal(recordOf(streamed, intent).status, "FILLED");
    assert.equal(recordOf(streamed, intent).executedQuantity, "0.01");
    assert.deepEqual(streamed.coordinator.executionBlockerCodes(), [
      "EXECUTION_STREAM_RECONNECTED",
    ]);
    assert.equal(streamed.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(await streamed.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: [],
    });
    assert.equal(streamed.coordinator.canIncreaseRisk(), true);

    const replayed = await createHarness();
    await placeLinked(replayed, intent);
    replayed.venue.fill("sim-order-1", "0.004", "100");
    replayed.venue.fill("sim-order-1", "0.003", "100");
    replayed.venue.fill("sim-order-1", "0.003", "100");
    await replayed.coordinator.replayExecutions();
    assert.deepEqual(recordOf(streamed, intent), recordOf(replayed, intent));
  });

  test("a stream execution that conflicts with a recorded one blocks risk", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.replayExecutions();
    h.coordinator.executionStreamReconnected();
    await h.coordinator.replayExecutions();

    assert.deepEqual(
      await h.coordinator.ingestStreamExecution({
        ...withSequence(execution, "1"),
        quantity: "0.005",
      }),
      { reasonCodes: ["EXECUTION_CONFLICT"], recorded: [] },
    );
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
    assert.deepEqual(h.coordinator.executionBlockerCodes(), ["EXECUTION_CONFLICT"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a sequence gap blocks risk increase until a replay records the missed execution", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.coordinator.executionStreamReconnected();
    await h.coordinator.replayExecutions();
    const first = withSequence(h.venue.fill("sim-order-1", "0.004", "100"), "7");
    h.venue.fill("sim-order-1", "0.003", "100");
    const third = withSequence(h.venue.fill("sim-order-1", "0.002", "100"), "9");

    assert.deepEqual(await h.coordinator.ingestStreamExecution(first), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
    assert.deepEqual(await h.coordinator.ingestStreamExecution(third), {
      reasonCodes: ["EXECUTION_STREAM_GAP"],
      recorded: ["sim-exec-3"],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    const entry = buildIntent({ sequence: "2", logicalLevelId: "B2" });
    assert.deepEqual((await h.coordinator.submit(entry)).reasonCodes, [
      "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE",
    ]);
    assert.equal(h.venue.calls.place, 1);

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-2"],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0.009");
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("sequences are compared exactly, without number rounding", async () => {
    const h = await createHarness();
    await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.replayExecutions();

    // Above 2^53 both would round to different neighbours as numbers and look like a gap.
    for (const sequences of [
      ["0", "1"],
      ["9007199254740993", "9007199254740994"],
    ]) {
      h.coordinator.executionStreamReconnected();
      await h.coordinator.replayExecutions();
      for (const sequence of sequences) {
        assert.deepEqual(
          await h.coordinator.ingestStreamExecution(withSequence(execution, sequence)),
          { reasonCodes: [], recorded: [] },
        );
      }
      assert.equal(h.coordinator.canIncreaseRisk(), true);
    }
  });

  test("an unusable stream sequence blocks risk increase", async () => {
    const h = await createHarness();
    await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    const unusable: unknown[] = [null, "", "01", "-1", "1.0", " 1", "abc", 1];

    for (const sequence of unusable) {
      h.coordinator.executionStreamReconnected();
      await h.coordinator.replayExecutions();
      assert.equal(h.coordinator.canIncreaseRisk(), true);
      const observed = withSequence(execution, null);
      (observed.meta as { sequence: unknown }).sequence = sequence;
      assert.deepEqual(await h.coordinator.ingestStreamExecution(observed), {
        reasonCodes: ["EXECUTION_STREAM_SEQUENCE_UNUSABLE"],
        recorded: [],
      });
      assert.equal(h.coordinator.canIncreaseRisk(), false);
    }
    const withoutMeta = { ...execution, meta: null } as unknown as ExecutionObservation;
    assert.deepEqual(await h.coordinator.ingestStreamExecution(withoutMeta), {
      reasonCodes: ["EXECUTION_STREAM_SEQUENCE_UNUSABLE"],
      recorded: [],
    });
  });

  test("a stream event that arrives during another operation is dropped and blocks risk", async () => {
    const h = await editableHarness();
    const intent = await placeLinked(h);
    h.coordinator.executionStreamReconnected();
    const gate = deferred();
    h.edit(async (page) => {
      await gate.promise;
      return page;
    });
    const execution = withSequence(h.venue.fill("sim-order-1", "0.004", "100"), "1");

    const replay = h.coordinator.replayExecutions();
    assert.deepEqual(await h.coordinator.ingestStreamExecution(execution), {
      reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED", "COORDINATOR_BUSY"],
      recorded: [],
    });
    gate.resolve();
    assert.deepEqual(await replay, {
      reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED"],
      recorded: ["sim-exec-1"],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    h.edit((page) => page);
    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("a stream event after a journal failure is dropped", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.coordinator.executionStreamReconnected();
    await h.coordinator.replayExecutions();
    const first = withSequence(h.venue.fill("sim-order-1", "0.004", "100"), "1");
    const second = withSequence(h.venue.fill("sim-order-1", "0.003", "100"), "2");
    h.journal.scriptPersist("FAIL");

    assert.deepEqual(await h.coordinator.ingestStreamExecution(first), {
      reasonCodes: ["JOURNAL_WRITE_FAILED"],
      recorded: ["sim-exec-1"],
    });
    assert.deepEqual(await h.coordinator.ingestStreamExecution(second), {
      reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED", "JOURNAL_LATCHED"],
      recorded: [],
    });
    assert.deepEqual(executionIdsOf(h, intent), ["sim-exec-1"]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a stream execution never moves the replay cursor", async () => {
    const h = await createHarness();
    await placeLinked(h);
    const cursor = h.coordinator.executionCursor();
    const checkpointWrites = h.checkpoints.snapshots.length;
    const execution = withSequence(h.venue.fill("sim-order-1", "0.004", "100"), "1");

    assert.deepEqual((await h.coordinator.ingestStreamExecution(execution)).recorded, [
      "sim-exec-1",
    ]);
    assert.deepEqual(h.coordinator.executionCursor(), cursor);
    assert.equal(h.checkpoints.snapshots.length, checkpointWrites);
  });
});

describe("P3-E15 reconnect requires REST reconciliation before new risk", () => {
  test("a reconnect blocks risk increase until a replay started after it completes", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    h.coordinator.executionStreamReconnected();
    // Executed while the stream was down; only the REST replay can see it.
    h.venue.fill("sim-order-1", "0.004", "100");

    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(h.coordinator.executionBlockerCodes(), ["EXECUTION_STREAM_RECONNECTED"]);
    const entry = buildIntent({ sequence: "2", logicalLevelId: "B2" });
    assert.deepEqual((await h.coordinator.submit(entry)).reasonCodes, [
      "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE",
    ]);
    assert.deepEqual((await h.coordinator.submitBatch([entry])).reasonCodes, [
      "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE",
    ]);
    assert.equal(h.venue.calls.place, 1);

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(entry)).record?.status, "LINKED");
  });

  test("a reconnect starts a new stream sequence", async () => {
    const h = await createHarness();
    await placeLinked(h);
    const execution = h.venue.fill("sim-order-1", "0.004", "100");
    h.coordinator.executionStreamReconnected();
    await h.coordinator.replayExecutions();
    await h.coordinator.ingestStreamExecution(withSequence(execution, "5"));

    h.coordinator.executionStreamReconnected();
    await h.coordinator.replayExecutions();
    assert.deepEqual(await h.coordinator.ingestStreamExecution(withSequence(execution, "9")), {
      reasonCodes: [],
      recorded: [],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("a reconnect during a replay keeps risk blocked", async () => {
    const h = await editableHarness();
    await placeLinked(h);
    const gate = deferred();
    h.edit(async (page) => {
      await gate.promise;
      return page;
    });

    const replay = h.coordinator.replayExecutions();
    h.coordinator.executionStreamReconnected();
    gate.resolve();
    assert.deepEqual(await replay, {
      reasonCodes: ["EXECUTION_STREAM_RECONNECTED"],
      recorded: [],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });

  test("risk-reducing work is not blocked by an execution blocker", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.coordinator.executionStreamReconnected();

    assert.equal((await h.coordinator.cancel(intent.intentId)).record?.status, "CANCEL_UNVERIFIED");
    assert.equal(h.venue.calls.cancel, 1);
    await h.coordinator.reconcileUnresolved();
    assert.equal(recordOf(h, intent).status, "CANCELLED");
    const exit = await h.coordinator.submit(
      buildIntent({
        sequence: "2",
        logicalLevelId: "S1",
        purpose: "GRID_EXIT",
        side: "SELL",
        reduceOnly: true,
      }),
    );
    assert.equal(exit.record?.status, "LINKED");
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("a new coordinator blocks risk increase until its first replay completes", async () => {
    const h = await createHarness({ replay: false });
    assert.deepEqual(h.coordinator.executionBlockerCodes(), ["EXECUTION_REPLAY_INCOMPLETE"]);
    assert.equal(h.coordinator.executionCursor(), null);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual((await h.coordinator.submit(buildIntent())).reasonCodes, [
      "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE",
    ]);
    assert.equal(h.venue.calls.place, 0);

    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.deepEqual(h.coordinator.executionCursor(), START_CURSOR);
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(buildIntent())).record?.status, "LINKED");
  });

  test("a restarted coordinator records executions missed while it was down", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    await h.coordinator.replayExecutions();
    h.venue.fill("sim-order-1", "0.006", "100");

    const restarted = await createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
      checkpoints: h.checkpoints,
      replay: false,
    });
    assert.equal(restarted.coordinator.executionCursor()?.opaque, "sim-exec-cursor:1");
    assert.equal(restarted.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(await restarted.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-2"],
    });
    assert.equal(recordOf(restarted, intent).status, "FILLED");
    assert.equal(restarted.coordinator.canIncreaseRisk(), true);
  });

  test("a failed read keeps risk blocked and the cursor unmoved", async () => {
    const h = await createHarness();
    await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.failNextExecutionReads(1);

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_REPLAY_INCOMPLETE", "EXECUTION_REPLAY_READ_FAILED"],
      recorded: [],
    });
    assert.deepEqual(h.coordinator.executionCursor(), START_CURSOR);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
  });

  test("an invalid page keeps risk blocked and the cursor unmoved", async () => {
    const h = await editableHarness();
    const cursor = h.coordinator.executionCursor();
    const pages: unknown[] = [
      null,
      {},
      { executions: null, nextCursor: START_CURSOR, hasMore: false },
      { executions: [], nextCursor: START_CURSOR, hasMore: "false" },
      { executions: [], nextCursor: null, hasMore: false },
      { executions: [], nextCursor: { ...START_CURSOR, venue: "other" }, hasMore: false },
      { executions: [], nextCursor: { ...START_CURSOR, market: "ETH_USDC_PERP" }, hasMore: false },
      { executions: [], nextCursor: { ...START_CURSOR, opaque: "" }, hasMore: false },
      { executions: [], nextCursor: { ...START_CURSOR, lastExecutionId: "" }, hasMore: false },
      { executions: [], nextCursor: { ...START_CURSOR, lastExecutionTime: "" }, hasMore: false },
    ];
    for (const page of pages) {
      h.edit(() => page as ExecutionPage);
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_PAGE_INVALID", "EXECUTION_REPLAY_INCOMPLETE"],
        recorded: [],
      });
      assert.deepEqual(h.coordinator.executionCursor(), cursor);
    }
  });

  test("a replay stops at the page limit with risk still blocked", async () => {
    for (const [available, reasonCodes] of [
      [100, []],
      [101, ["EXECUTION_REPLAY_INCOMPLETE", "EXECUTION_REPLAY_PAGE_LIMIT"]],
    ] as const) {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      let reads = 0;
      const port = portOver(venue, async () => {
        reads += 1;
        return {
          executions: [],
          nextCursor: { ...START_CURSOR, opaque: `page:${reads}` },
          hasMore: reads < available,
        };
      });
      const h = await createHarness({ venue, port, replay: false });
      assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes, recorded: [] });
      assert.equal(reads, 100);
      assert.equal(h.coordinator.executionCursor()?.opaque, "page:100");
    }
  });

  test("a venue whose cursor never advances hits the page limit", async () => {
    const h = await createHarness();
    const intent = await placeLinked(h);
    h.venue.fill("sim-order-1", "0.004", "100");
    h.venue.fill("sim-order-1", "0.003", "100");
    h.venue.setExecutionPageSize(1);
    h.venue.overlapExecutionReads(1);
    const reads = h.venue.calls.executions;

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_REPLAY_INCOMPLETE", "EXECUTION_REPLAY_PAGE_LIMIT"],
      recorded: ["sim-exec-1"],
    });
    assert.equal(h.venue.calls.executions - reads, 100);
    assert.equal(recordOf(h, intent).executedQuantity, "0.004");
  });

  test("an invalid start cursor is refused and a valid one is copied", async () => {
    const invalid: unknown[] = [
      {},
      { ...START_CURSOR, venue: "other" },
      { ...START_CURSOR, market: "ETH_USDC_PERP" },
      { ...START_CURSOR, opaque: "" },
      { ...START_CURSOR, lastExecutionId: "" },
      { ...START_CURSOR, lastExecutionTime: "" },
    ];
    for (const cursor of invalid) {
      await assert.rejects(
        createHarness({ executionCursor: cursor as ExecutionCursor, replay: false }),
        /INVALID_EXECUTION_CURSOR/,
      );
    }

    const cursor = { ...START_CURSOR, lastExecutionId: "sim-exec-0", lastExecutionTime: "t" };
    const h = await createHarness({ executionCursor: cursor as ExecutionCursor, replay: false });
    cursor.opaque = "changed";
    assert.equal(h.coordinator.executionCursor()?.opaque, "sim-exec-cursor:0");
    const copy = h.coordinator.executionCursor() as ExecutionCursor;
    copy.opaque = "changed";
    assert.equal(h.coordinator.executionCursor()?.opaque, "sim-exec-cursor:0");
  });

  test("a cursor the venue cannot read fails the replay", async () => {
    const h = await createHarness({
      executionCursor: { ...START_CURSOR, opaque: "sim-exec-cursor:x" },
      replay: false,
    });
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_REPLAY_INCOMPLETE", "EXECUTION_REPLAY_READ_FAILED"],
      recorded: [],
    });
  });
});

describe("IntentRegistry.applyExecutions", () => {
  const ORDER = "order-1";

  function linkedRegistry(): { registry: IntentRegistry; intent: OrderIntent } {
    const registry = new IntentRegistry();
    const intent = buildIntent();
    registry.prepare(intent);
    registry.link(intent.intentId, {
      exchangeOrderId: ORDER,
      authority: { source: "ACK", evidenceId: `ack:${ORDER}` },
      executions: [],
      reasonCodes: [],
    });
    return { registry, intent };
  }

  function execution(executionId: string, quantity: string, exchangeOrderId = ORDER) {
    return { executionId, exchangeOrderId, quantity, price: "100" };
  }

  test("a partial execution keeps the order working and the full quantity fills it", () => {
    const { registry, intent } = linkedRegistry();
    const partial = registry.applyExecutions(intent.intentId, [execution("e-2", "0.004")]);
    assert.equal(partial.status, "LINKED");
    assert.equal(partial.executedQuantity, "0.004");
    assert.deepEqual(partial.reasonCodes, []);

    const filled = registry.applyExecutions(intent.intentId, [
      execution("e-3", "0.002"),
      execution("e-1", "0.004"),
    ]);
    assert.equal(filled.status, "FILLED");
    assert.equal(filled.executedQuantity, "0.01");
    assert.deepEqual(filled.reasonCodes, ["FILLED_BY_EXECUTION_EVIDENCE"]);
    assert.deepEqual(
      filled.executions.map((item) => item.executionId),
      ["e-1", "e-2", "e-3"],
    );
    assert.equal(registry.intentIdForExecutionId("e-3"), intent.intentId);

    const restored = IntentRegistry.fromState(JSON.parse(JSON.stringify(registry.exportState())));
    assert.deepEqual(restored.get(intent.intentId), registry.get(intent.intentId));
    assertRegistryError(
      () => registry.applyExecutions(intent.intentId, [execution("e-4", "0.001")]),
      "INVALID_TRANSITION:FILLED->EXECUTED",
    );
  });

  test("a pending cancel can fill from executions", () => {
    const { registry, intent } = linkedRegistry();
    registry.markCancelPrepared(intent.intentId, ["CANCEL_PREPARED"]);
    assert.equal(
      registry.applyExecutions(intent.intentId, [execution("e-1", "0.004")]).status,
      "CANCEL_PREPARED",
    );
    registry.markCancelUnverified(intent.intentId, ["VENUE_OUTCOME_UNKNOWN"]);
    assert.equal(
      registry.applyExecutions(intent.intentId, [execution("e-2", "0.006")]).status,
      "FILLED",
    );
  });

  test("invalid executions change nothing", () => {
    const { registry, intent } = linkedRegistry();
    registry.applyExecutions(intent.intentId, [execution("e-1", "0.004")]);
    const other = buildIntent({ sequence: "2", logicalLevelId: "B2" });
    registry.prepare(other);
    registry.link(other.intentId, {
      exchangeOrderId: "order-2",
      authority: { source: "ACK", evidenceId: "ack:order-2" },
      executions: [execution("e-other", "0.001", "order-2")],
      reasonCodes: [],
    });
    const before = registry.exportState();

    const cases: Array<[Array<ReturnType<typeof execution>>, string]> = [
      [[], "NO_NEW_EXECUTIONS"],
      [[execution("e-1", "0.004")], "EXECUTION_ID_COLLISION"],
      [[execution("e-other", "0.001")], "EXECUTION_ID_COLLISION"],
      [[execution("e-2", "0.007")], "EXECUTION_OVERFILL"],
      [[execution("e-2", "0.001", "order-2")], "INVALID_EXECUTION"],
      [[execution("e-2", "0")], "INVALID_EXECUTION"],
      [[execution("e-2", "0.001"), execution("e-2", "0.001")], "DUPLICATE_EXECUTION_ID"],
    ];
    for (const [executions, reasonCode] of cases) {
      assertRegistryError(() => registry.applyExecutions(intent.intentId, executions), reasonCode);
    }
    assert.deepEqual(registry.exportState(), before);
  });

  test("records without a working linked order refuse executions", () => {
    const registry = new IntentRegistry();
    const prepared = buildIntent();
    registry.prepare(prepared);
    assertRegistryError(
      () => registry.applyExecutions(prepared.intentId, [execution("e-1", "0.001")]),
      "INVALID_TRANSITION:PREPARED->EXECUTED",
    );

    const { registry: cancelledRegistry, intent } = linkedRegistry();
    cancelledRegistry.markCancelPrepared(intent.intentId, ["CANCEL_PREPARED"]);
    cancelledRegistry.resolveCancel(intent.intentId, {
      status: "CANCELLED",
      executions: [],
      reasonCodes: ["CANCEL_CONFIRMED"],
    });
    assertRegistryError(
      () => cancelledRegistry.applyExecutions(intent.intentId, [execution("e-1", "0.001")]),
      "INVALID_TRANSITION:CANCELLED->EXECUTED",
    );
  });

  test("a linked order fills only through executions, never through a cancel resolution", () => {
    const { registry, intent } = linkedRegistry();
    assertRegistryError(
      () =>
        registry.resolveCancel(intent.intentId, {
          status: "FILLED",
          executions: [execution("e-1", "0.01")],
          reasonCodes: [],
        }),
      "INVALID_TRANSITION:LINKED->FILLED",
    );
    assert.equal(registry.get(intent.intentId)?.status, "LINKED");
  });
});
