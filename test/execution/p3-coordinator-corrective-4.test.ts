import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ContinuationDecision,
  type ExecutionContradiction,
  ExecutionCoordinator,
  type ExecutionVenuePort,
  IntentRegistry,
  type IntentRegistryState,
  openDurableExecutionState,
  runRestartGate,
} from "../../src/execution/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import type {
  Phase3ERestartReport,
  Phase3EWorkerCommand,
} from "../fixtures/phase3e-fatal-worker.js";
import { FileBackedVenue, readEvents } from "../fixtures/phase3e-venue.js";
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

const WORKER_PATH = fileURLToPath(new URL("../fixtures/phase3e-fatal-worker.ts", import.meta.url));
const CHILD_TIMEOUT_MS = 20_000;

// What a stream execution gets back when another operation holds the coordinator.
const BUSY_DROP = {
  reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED", "COORDINATOR_BUSY"],
  recorded: [],
};

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "g3-rc1-"));
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

function command(
  root: string,
  overrides: Partial<Phase3EWorkerCommand> & Pick<Phase3EWorkerCommand, "mode" | "label">,
): Phase3EWorkerCommand {
  return {
    root,
    clockMs: "1000000",
    guard: "FATAL_GUARD",
    fault: "THROW",
    faultTick: 4,
    readyPath: null,
    sequenceBase: 0,
    ...overrides,
  };
}

function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", reject);
  });
}

function forceKill(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      forceKill(child);
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit`));
    }, CHILD_TIMEOUT_MS);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

// Runs the RESTART worker in a fresh process and returns its report.
async function restartInFreshProcess(cmd: Phase3EWorkerCommand): Promise<Phase3ERestartReport> {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER_PATH, JSON.stringify(cmd)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      exitOf(child),
    ]);
    assert.equal(exitCode, 0, stderr);
    return JSON.parse(stdout) as Phase3ERestartReport;
  } finally {
    forceKill(child);
  }
}

type Held = {
  port: ExecutionVenuePort;
  // Keeps the next open-order scan or execution read pending until the returned release runs.
  hold(read: "scan" | "replay"): () => void;
};

function holdable(venue: ExecutionVenuePort): Held {
  const pending = { scan: Promise.resolve(), replay: Promise.resolve() };
  const port: ExecutionVenuePort = {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
    listOpenOrders: async () => {
      await pending.scan;
      return venue.listOpenOrders();
    },
    listExecutionsSince: async (cursor) => {
      await pending.replay;
      return venue.listExecutionsSince(cursor);
    },
  };
  return {
    port,
    hold(read) {
      let release = () => {};
      pending[read] = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

// Starts the operation with the given venue read held, delivers each stream execution while
// it runs, runs `beforeRelease`, then lets the operation finish and returns its result.
async function duringHeld<T>(
  held: Held,
  read: "scan" | "replay",
  coordinator: ExecutionCoordinator,
  operation: () => Promise<T>,
  executions: ExecutionObservation[],
  beforeRelease: () => void = () => {},
): Promise<T> {
  const release = held.hold(read);
  const running = operation();
  for (const execution of executions) {
    assert.deepEqual(await coordinator.ingestStreamExecution(execution), BUSY_DROP);
  }
  beforeRelease();
  release();
  return running;
}

function streamed(
  execution: ExecutionObservation,
  changes: Partial<ExecutionObservation> = {},
  sequence = "1",
): ExecutionObservation {
  const copy = { ...structuredClone(execution), ...changes };
  copy.meta = { ...copy.meta, source: "stream", sequence };
  return copy;
}

// The stream's report of sim-exec-1 with a quantity the venue never executed.
function conflicting(execution: ExecutionObservation): ExecutionObservation {
  return streamed(execution, { quantity: "0.006" });
}

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

describe("Gate 3 re-review RC1: stream executions that arrive during another operation", {
  concurrency: 1,
}, () => {
  test("G3-RC1-1 a conflict delivered during a scan is persisted and outlives an empty replay tail", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);

    await duringHeld(held, "scan", h.coordinator, () => h.coordinator.scanOpenOrders("epoch-1"), [
      conflicting(execution),
    ]);
    assert.deepEqual(h.coordinator.riskIncreaseBlockers(), [
      "EXECUTION_CONFLICT",
      "EXECUTION_STREAM_EVENT_DROPPED",
    ]);
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
    // The recorded execution keeps the venue's facts.
    assert.equal(h.registry.get(intent.intentId)?.executedQuantity, "0.004");
  });

  test("G3-RC1-2 a conflict delivered during a replay is persisted and outlives the next replay", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);

    assert.deepEqual(
      await duringHeld(held, "replay", h.coordinator, () => h.coordinator.replayExecutions(), [
        conflicting(execution),
      ]),
      { reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED"], recorded: [] },
    );
    assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: [],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
    assert.equal(h.venue.calls.place, 1);
  });

  test("G3-RC1-3 a conflict delivered during a continuation gate denies it and the next one", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);

    // The gate's own replay runs after the event arrived; the queued event still blocks it.
    const decision = await duringHeld(
      held,
      "scan",
      h.coordinator,
      () => h.coordinator.evaluateContinuation("epoch-1"),
      [conflicting(execution)],
    );
    assert.equal(decision.allowRiskIncrease, false);
    assert.ok(
      decision.reasonCodes.includes("EXECUTION_STREAM_EVENT_DROPPED"),
      decision.reasonCodes.join(","),
    );
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);

    assertHalted(await h.coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
    assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
    assert.equal(h.venue.calls.place, 1);
  });

  test("G3-RC1-4 a durable reopen restores a conflict delivered during a scan", async () => {
    await withDirectory(async (directory) => {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const held = holdable(venue);
      const first = coordinatorOver(await openOk(directory), held.port);
      const { intent, execution } = await linkedFill(first, venue);
      await duringHeld(held, "scan", first, () => first.scanOpenOrders("epoch-1"), [
        conflicting(execution),
      ]);

      const reopened = await openOk(directory);
      const coordinator = coordinatorOver(reopened, venue);
      const gate = await runRestartGate(coordinator, "epoch-1");
      assert.equal(gate.allowRiskIncrease, false);
      assert.deepEqual(gate.reasonCodes, ["EXECUTION_CONFLICT"]);
      assert.deepEqual(gate.replay, { reasonCodes: ["EXECUTION_CONFLICT"], recorded: [] });
      assertHalted(await coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
      assert.equal((await coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(venue.calls.place, 1);
      assert.deepEqual(reopened.registry.executionContradictions(), [conflictEntry(intent)]);
    });
  });

  test("G3-RC1-5 a fresh process restores a conflict delivered during a scan and sends nothing", async () => {
    await withDirectory(async (root) => {
      const venueDirectory = path.join(root, "venue");
      const executionDirectory = path.join(root, "execution");
      await mkdir(executionDirectory, { recursive: true });
      const venue = await FileBackedVenue.open(venueDirectory, "run1");
      const held = holdable(venue);
      const first = coordinatorOver(await openOk(executionDirectory), held.port);
      const { execution } = await linkedFill(first, venue);
      await duringHeld(held, "scan", first, () => first.scanOpenOrders("epoch-1"), [
        conflicting(execution),
      ]);

      const report = await restartInFreshProcess(
        command(root, { mode: "RESTART", label: "restart", sequenceBase: 10 }),
      );
      assert.deepEqual(report.open, { ok: true, reasonCodes: [] });
      assert.deepEqual(report.gate, {
        allowRiskIncrease: false,
        reasonCodes: ["EXECUTION_CONFLICT"],
        recordedExecutions: [],
      });
      assert.equal(report.continuation?.action, "HALT");
      assert.equal(report.continuation?.allowRiskIncrease, false);
      assert.ok(report.continuation?.reasonCodes.includes("EXECUTION_CONFLICT"));
      assert.equal(report.postGateSubmit?.disposition, "REFUSED");
      assert.deepEqual(report.finalStatuses, { B1: "LINKED" });
      assert.deepEqual(
        readEvents(venueDirectory).filter(
          (event) => event.label === "restart" && event.type === "PLACE",
        ),
        [],
      );
    });
  });

  test("G3-RC1-6 a failed write of a conflict delivered during a scan latches and stays blocked", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);
    const written = h.journal.snapshots.length;

    // The scan itself writes nothing, so the scripted failure meets the queued event's write.
    await duringHeld(
      held,
      "scan",
      h.coordinator,
      () => h.coordinator.scanOpenOrders("epoch-1"),
      [conflicting(execution)],
      () => h.journal.scriptPersist("FAIL"),
    );
    assert.equal(h.coordinator.isJournalLatched(), true);
    assert.equal(h.journal.snapshots.length, written);
    assert.deepEqual(h.registry.executionContradictions(), [conflictEntry(intent)]);
    assert.deepEqual(h.coordinator.riskIncreaseBlockers(), [
      "EXECUTION_CONFLICT",
      "EXECUTION_STREAM_EVENT_DROPPED",
      "JOURNAL_LATCHED",
    ]);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["JOURNAL_LATCHED"],
      recorded: [],
    });
    assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
    assert.equal(h.venue.calls.place, 1);
  });

  test("G3-RC1-7 executions delivered during a scan are checked in arrival order", async () => {
    const { h, held } = await heldHarness();
    const { intent } = await linkedFill(h.coordinator, h.venue);
    const second = h.venue.fill("sim-order-1", "0.002", "100");

    await duringHeld(held, "scan", h.coordinator, () => h.coordinator.scanOpenOrders("epoch-1"), [
      streamed(second, {}, "1"),
      streamed(second, { quantity: "0.003" }, "2"),
    ]);
    assert.equal(h.registry.get(intent.intentId)?.executedQuantity, "0.006");
    const entry = conflictEntry(intent, { executionId: "sim-exec-2", quantity: "0.003" });
    assert.deepEqual(h.registry.executionContradictions(), [entry]);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [entry]);
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: [],
    });
  });

  test("G3-RC1-8 control: a valid execution delivered during a scan is recorded and clears", async () => {
    const { h, held } = await heldHarness();
    await grant(h.coordinator);
    const intent = buildIntent();
    assert.equal((await h.coordinator.submit(intent)).record?.status, "LINKED");
    const execution = h.venue.fill("sim-order-1", "0.004", "100");

    await duringHeld(held, "scan", h.coordinator, () => h.coordinator.scanOpenOrders("epoch-1"), [
      streamed(execution),
    ]);
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
