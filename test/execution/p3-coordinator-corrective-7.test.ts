import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ContinuationDecision,
  type ExecutionContradiction,
  ExecutionCoordinator,
  type ExecutionReplayResult,
  type ExecutionVenuePort,
  IntentRegistry,
  type IntentRegistryState,
  openDurableExecutionState,
  runRestartGate,
} from "../../src/execution/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import {
  buildIntent,
  clientIdOf,
  createHarness,
  flatExposure,
  grant,
  OBSERVED_AT,
  openFence,
  riskSource,
  runningHaltAuthority,
  SCOPE_KEY,
} from "./helpers.js";

// What a stream execution gets back when another operation holds the coordinator.
const BUSY_DROP: ExecutionReplayResult = {
  reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED", "COORDINATOR_BUSY"],
  recorded: [],
};

// What it gets back when, in addition, it cannot be read into a copy.
const UNREAD_DROP: ExecutionReplayResult = {
  reasonCodes: [
    "EXECUTION_STREAM_SEQUENCE_UNUSABLE",
    "EXECUTION_STREAM_EVENT_DROPPED",
    "COORDINATOR_BUSY",
  ],
  recorded: [],
};

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "g3-rc5-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function openOk(directory: string) {
  const state = await openDurableExecutionState({
    directory,
    scopeKey: SCOPE_KEY,
    latch: new RuntimePersistenceLatch(),
  });
  assert.ok(state.ok, state.ok ? "" : state.reasonCodes.join(","));
  return state;
}

function coordinatorOver(
  state: Awaited<ReturnType<typeof openOk>>,
  venue: ExecutionVenuePort,
): ExecutionCoordinator {
  return new ExecutionCoordinator({
    config: {
      experimentId: "exp-1",
      runId: "run-1",
      scopeKey: SCOPE_KEY,
      writeBudgetPerCycle: 100,
    },
    registry: state.registry,
    venue,
    fence: openFence(),
    journal: state.journal,
    exposure: flatExposure(),
    checkpoints: state.checkpoints,
    executionCursor: state.executionCursor,
    riskInputs: riskSource(),
    haltAuthority: runningHaltAuthority(),
  });
}

type Held = {
  port: ExecutionVenuePort;
  // Keeps the next open-order scan or execution read pending until the returned release runs.
  hold(read: "scan" | "replay"): () => void;
};

function holdable(venue: ExecutionVenuePort): Held {
  const gates = { scan: Promise.resolve(), replay: Promise.resolve() };
  const port: ExecutionVenuePort = {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
    listOpenOrders: async () => {
      await gates.scan;
      return venue.listOpenOrders();
    },
    listExecutionsSince: async (cursor) => {
      await gates.replay;
      return venue.listExecutionsSince(cursor);
    },
  };
  return {
    port,
    hold(read) {
      let release = () => {};
      gates[read] = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

// Starts the operation with the given venue read held and delivers the stream execution while
// it runs. After the delivery has returned, `afterReturn` runs; then the operation finishes.
async function deliverDuring<T>(
  held: Held,
  read: "scan" | "replay",
  coordinator: ExecutionCoordinator,
  operation: () => Promise<T>,
  execution: ExecutionObservation,
  expected: ExecutionReplayResult,
  afterReturn: () => void = () => {},
): Promise<T> {
  const release = held.hold(read);
  const running = operation();
  assert.deepEqual(await coordinator.ingestStreamExecution(execution), expected);
  afterReturn();
  release();
  return running;
}

function streamed(execution: ExecutionObservation, quantity: string): ExecutionObservation {
  const copy = { ...structuredClone(execution), quantity };
  copy.meta = { ...copy.meta, source: "stream", sequence: "1" };
  return copy;
}

// A stream report of sim-exec-1 that the sender keeps a handle on. It reports 0.006, which
// the venue never executed; `rewrite` changes the sender's object to the venue's 0.004.
type SenderForm = {
  name: string;
  report(execution: ExecutionObservation): {
    delivered: ExecutionObservation;
    rewrite: () => void;
  };
};

const UNCLONEABLE_FORMS: SenderForm[] = [
  {
    name: "a transparent proxy",
    report(execution) {
      const target = streamed(execution, "0.006");
      return {
        delivered: new Proxy(target, {}),
        rewrite: () => {
          target.quantity = "0.004";
        },
      };
    },
  },
  {
    name: "an object with a function field",
    report(execution) {
      const target = Object.assign(streamed(execution, "0.006"), {
        describe: () => "stream fill",
      });
      return {
        delivered: target,
        rewrite: () => {
          target.quantity = "0.004";
        },
      };
    },
  },
  {
    name: "an object whose meta is a proxy",
    report(execution) {
      const target = streamed(execution, "0.006");
      target.meta = new Proxy(target.meta, {});
      return {
        delivered: target,
        rewrite: () => {
          target.quantity = "0.004";
        },
      };
    },
  },
];

// Stream reports that cannot be read into a copy.
const UNREADABLE_REPORTS: {
  name: string;
  report(execution: ExecutionObservation): ExecutionObservation;
}[] = [
  {
    name: "a quantity getter that throws",
    report(execution) {
      return Object.defineProperty(streamed(execution, "0.006"), "quantity", {
        enumerable: true,
        get() {
          throw new Error("quantity unavailable");
        },
      });
    },
  },
  {
    name: "a quantity that is a function",
    report(execution) {
      return {
        ...streamed(execution, "0.006"),
        quantity: (() => "0.006") as unknown as string,
      };
    },
  },
  {
    name: "a revoked proxy",
    report(execution) {
      const { proxy, revoke } = Proxy.revocable(streamed(execution, "0.006"), {});
      revoke();
      return proxy;
    },
  },
  {
    name: "a proxy that throws on reading meta",
    report(execution) {
      return new Proxy(streamed(execution, "0.006"), {
        get(target, property, receiver) {
          if (property === "meta") {
            throw new Error("meta unavailable");
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  },
];

function conflictEntry(
  intent: OrderIntent,
  fields: Partial<ExecutionContradiction> = {},
): ExecutionContradiction {
  return {
    reasonCode: "EXECUTION_CONFLICT",
    executionId: "sim-exec-1",
    exchangeOrderId: "sim-order-1",
    clientOrderId: clientIdOf(intent),
    side: "BUY",
    quantity: "0.006",
    price: "100",
    ...fields,
  };
}

function contradictionsOf(state: unknown): unknown {
  return (state as IntentRegistryState).executionContradictions;
}

function assertHalted(decision: ContinuationDecision, reasonCode: string): void {
  assert.equal(decision.action, "HALT");
  assert.equal(decision.allowRiskIncrease, false);
  assert.ok(decision.reasonCodes.includes(reasonCode), decision.reasonCodes.join(","));
}

const nextIntent = () => buildIntent({ sequence: "2", logicalLevelId: "B2", price: "99" });

// Links buildIntent(), fills it 0.004 and records that execution from a replay that reaches
// the venue end. Returns the intent and the venue's execution.
async function linkedFill(coordinator: ExecutionCoordinator, venue: Pick<SimulatedVenue, "fill">) {
  const gate = await runRestartGate(coordinator, "epoch-1");
  assert.equal(gate.allowRiskIncrease, true, gate.reasonCodes.join(","));
  await grant(coordinator);
  const intent = buildIntent();
  assert.equal((await coordinator.submit(intent)).record?.status, "LINKED");
  const execution = venue.fill("sim-order-1", "0.004", "100");
  assert.deepEqual(await coordinator.replayExecutions(), {
    reasonCodes: [],
    recorded: ["sim-exec-1"],
  });
  return { intent, execution };
}

async function heldHarness() {
  const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
  const held = holdable(venue);
  const h = await createHarness({ venue, port: held.port });
  return { h, held };
}

describe("Gate 3 re-review RC5: stream executions read once into owned copies while busy", {
  concurrency: 1,
}, () => {
  for (const form of UNCLONEABLE_FORMS) {
    test(`G3-RC5-1 ${form.name} rewritten after a busy delivery during a scan keeps the conflict`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);
      const { delivered, rewrite } = form.report(execution);

      await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.scanOpenOrders("epoch-1"),
        delivered,
        BUSY_DROP,
        rewrite,
      );
      assert.equal(delivered.quantity, "0.004");
      assert.deepEqual(h.registry.executionContradictions(), [conflictEntry(intent)]);
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);

      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_CONFLICT"],
        recorded: [],
      });
      assert.equal(h.coordinator.canIncreaseRisk(), false);
      assertHalted(await h.coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
      assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(h.registry.get(nextIntent().intentId), null);
      assert.equal(h.venue.calls.place, 1);
      assert.equal(h.registry.get(intent.intentId)?.executedQuantity, "0.004");
    });

    test(`G3-RC5-2 ${form.name} rewritten after a busy delivery during a replay keeps the conflict`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);
      const { delivered, rewrite } = form.report(execution);

      assert.deepEqual(
        await deliverDuring(
          held,
          "replay",
          h.coordinator,
          () => h.coordinator.replayExecutions(),
          delivered,
          BUSY_DROP,
          rewrite,
        ),
        { reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED"], recorded: [] },
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_CONFLICT"],
        recorded: [],
      });
      assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(h.venue.calls.place, 1);
    });

    test(`G3-RC5-3 ${form.name} rewritten after a busy delivery during a continuation gate denies it and the next one`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);
      const { delivered, rewrite } = form.report(execution);

      const decision = await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.evaluateContinuation("epoch-1"),
        delivered,
        BUSY_DROP,
        rewrite,
      );
      assert.equal(decision.allowRiskIncrease, false);
      assert.ok(
        decision.reasonCodes.includes("EXECUTION_STREAM_EVENT_DROPPED"),
        decision.reasonCodes.join(","),
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);

      assertHalted(await h.coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
      assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(h.venue.calls.place, 1);
    });

    test(`G3-RC5-4 ${form.name} rewritten after a busy delivery: a durable reopen restores the conflict`, async () => {
      await withDirectory(async (directory) => {
        const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
        const held = holdable(venue);
        const first = coordinatorOver(await openOk(directory), held.port);
        const { intent, execution } = await linkedFill(first, venue);
        const { delivered, rewrite } = form.report(execution);
        await deliverDuring(
          held,
          "scan",
          first,
          () => first.scanOpenOrders("epoch-1"),
          delivered,
          BUSY_DROP,
          rewrite,
        );

        const reopened = await openOk(directory);
        assert.deepEqual(reopened.registry.executionContradictions(), [conflictEntry(intent)]);
        const coordinator = coordinatorOver(reopened, venue);
        const gate = await runRestartGate(coordinator, "epoch-1");
        assert.equal(gate.allowRiskIncrease, false);
        assert.deepEqual(gate.reasonCodes, ["EXECUTION_CONFLICT"]);
        assert.deepEqual(gate.replay, { reasonCodes: ["EXECUTION_CONFLICT"], recorded: [] });
        assertHalted(await coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
        assert.equal((await coordinator.submit(nextIntent())).disposition, "REFUSED");
        assert.equal(venue.calls.place, 1);
      });
    });
  }

  for (const unreadable of UNREADABLE_REPORTS) {
    test(`G3-RC5-5 ${unreadable.name} delivered during a scan stays blocking after empty replays`, async () => {
      const { h, held } = await heldHarness();
      const { execution } = await linkedFill(h.coordinator, h.venue);

      await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.scanOpenOrders("epoch-1"),
        unreadable.report(execution),
        UNREAD_DROP,
      );
      assert.ok(
        h.coordinator.riskIncreaseBlockers().includes("EXECUTION_STREAM_EVENT_DROPPED"),
        h.coordinator.riskIncreaseBlockers().join(","),
      );
      // Nothing is known about it, so nothing is persisted, and no replay clears it.
      assert.deepEqual(contradictionsOf(h.journal.latest()), []);
      for (let replay = 0; replay < 2; replay += 1) {
        assert.deepEqual(await h.coordinator.replayExecutions(), {
          reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED"],
          recorded: [],
        });
      }
      assert.deepEqual(h.coordinator.riskIncreaseBlockers(), ["EXECUTION_STREAM_EVENT_DROPPED"]);
      const decision = await h.coordinator.evaluateContinuation("epoch-1");
      assert.equal(decision.allowRiskIncrease, false);
      assert.ok(
        decision.reasonCodes.includes("EXECUTION_STREAM_EVENT_DROPPED"),
        decision.reasonCodes.join(","),
      );
      assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(h.registry.get(nextIntent().intentId), null);
      assert.equal(h.venue.calls.place, 1);
    });
  }

  test("G3-RC5-6 an unreadable execution delivered during a replay stays blocking after it", async () => {
    const { h, held } = await heldHarness();
    const { execution } = await linkedFill(h.coordinator, h.venue);
    const { proxy, revoke } = Proxy.revocable(streamed(execution, "0.006"), {});
    revoke();

    assert.deepEqual(
      await deliverDuring(
        held,
        "replay",
        h.coordinator,
        () => h.coordinator.replayExecutions(),
        proxy,
        UNREAD_DROP,
      ),
      // The running replay keeps a sequence problem raised while it ran.
      {
        reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED", "EXECUTION_STREAM_SEQUENCE_UNUSABLE"],
        recorded: [],
      },
    );
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED"],
      recorded: [],
    });
    assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
    assert.equal(h.venue.calls.place, 1);
  });

  test("G3-RC5-7 a readable malformed field delivered during a scan is checked as a direct one is", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);
    const amount = { value: "0.006" };
    const delivered = {
      ...streamed(execution, "0.006"),
      quantity: amount as unknown as string,
    };

    await deliverDuring(
      held,
      "scan",
      h.coordinator,
      () => h.coordinator.scanOpenOrders("epoch-1"),
      delivered,
      BUSY_DROP,
      () => {
        amount.value = "0.004";
      },
    );
    // A direct ingest of the same report persists the same mismatch.
    const mismatch = conflictEntry(intent, { reasonCode: "EXECUTION_MISMATCH", quantity: null });
    assert.deepEqual(contradictionsOf(h.journal.latest()), [mismatch]);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_MISMATCH"],
      recorded: [],
    });
    assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
    assert.equal(h.venue.calls.place, 1);
  });

  test("G3-RC5-8 control: a cloneable report rewritten after a busy delivery keeps the conflict", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);
    const delivered = streamed(execution, "0.006");

    await deliverDuring(
      held,
      "scan",
      h.coordinator,
      () => h.coordinator.scanOpenOrders("epoch-1"),
      delivered,
      BUSY_DROP,
      () => {
        delivered.quantity = "0.004";
      },
    );
    assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: [],
    });
    assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
    assert.equal(h.venue.calls.place, 1);
  });

  for (const form of UNCLONEABLE_FORMS) {
    test(`G3-RC5-9 control: ${form.name} left unchanged after a busy delivery keeps the conflict`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);

      await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.scanOpenOrders("epoch-1"),
        form.report(execution).delivered,
        BUSY_DROP,
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_CONFLICT"],
        recorded: [],
      });
      assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(h.venue.calls.place, 1);
    });
  }

  test("G3-RC5-10 control: a valid proxied execution delivered during a scan is recorded and clears", async () => {
    const { h, held } = await heldHarness();
    await grant(h.coordinator);
    const intent = buildIntent();
    assert.equal((await h.coordinator.submit(intent)).record?.status, "LINKED");
    const execution = h.venue.fill("sim-order-1", "0.004", "100");

    await deliverDuring(
      held,
      "scan",
      h.coordinator,
      () => h.coordinator.scanOpenOrders("epoch-1"),
      new Proxy(streamed(execution, "0.004"), {}),
      BUSY_DROP,
    );
    const recorded = [
      {
        executionId: "sim-exec-1",
        exchangeOrderId: "sim-order-1",
        quantity: "0.004",
        price: "100",
      },
    ];
    assert.deepEqual(h.registry.get(intent.intentId)?.executions, recorded);
    assert.deepEqual(
      IntentRegistry.fromState(h.journal.latest()).get(intent.intentId)?.executions,
      recorded,
    );
    assert.deepEqual(h.coordinator.riskIncreaseBlockers(), ["EXECUTION_STREAM_EVENT_DROPPED"]);

    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    assert.deepEqual(h.registry.executionContradictions(), []);
  });
});
