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
  type ExecutionPage,
  type ExecutionVenuePort,
  INTENT_JOURNAL_KIND,
  INTENT_JOURNAL_STATE_NAME,
  INTENT_REGISTRY_SCHEMA_VERSION,
  IntentRegistry,
  IntentRegistryError,
  type IntentRegistryState,
  openDurableExecutionState,
  runRestartGate,
} from "../../src/execution/index.js";
import { initializeExactPair } from "../../src/persistence/atomic-pair-store.js";
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

// Old-state fixture: the last schema before contradictions were persisted.
const V1_STATE = { schemaVersion: "phase3-intent-registry-1", records: [] };

// New-state fixture, in the current schema: one persisted contradiction no record explains.
const NEW_STATE = {
  schemaVersion: "phase3-intent-registry-3",
  records: [],
  executionContradictions: [
    {
      reasonCode: "UNATTRIBUTED_EXECUTION",
      executionId: "foreign-exec-1",
      exchangeOrderId: "foreign-order-1",
      clientOrderId: null,
      side: "SELL",
      quantity: "0.002",
      price: "101",
    },
  ],
};

// A stream execution of an order no record links.
const FOREIGN_EXECUTION: ExecutionObservation = {
  venue: "sim",
  market: "BTC_USDC_PERP",
  executionId: "foreign-exec-1",
  exchangeOrderId: "foreign-order-1",
  clientOrderId: null,
  side: "SELL",
  price: "101",
  quantity: "0.002",
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

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "g3-c3-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function open(directory: string) {
  return openDurableExecutionState({
    directory,
    scopeKey: SCOPE_KEY,
    latch: new RuntimePersistenceLatch(),
  });
}

async function openOk(directory: string) {
  const state = await open(directory);
  assert.ok(state.ok, state.ok ? "" : state.reasonCodes.join(","));
  return state;
}

function seedJournal(directory: string, payload: unknown) {
  return initializeExactPair({
    directory,
    stateName: INTENT_JOURNAL_STATE_NAME,
    expectedKind: INTENT_JOURNAL_KIND,
    expectedScopeKey: SCOPE_KEY,
    payload,
    latch: new RuntimePersistenceLatch(),
    bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
  });
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

function streamed(
  execution: ExecutionObservation,
  changes: Partial<ExecutionObservation> = {},
): ExecutionObservation {
  const copy = { ...structuredClone(execution), ...changes };
  copy.meta = { ...copy.meta, source: "stream", sequence: "1" };
  return copy;
}

function assertHalted(decision: ContinuationDecision, reasonCode: string): void {
  assert.equal(decision.action, "HALT");
  assert.equal(decision.allowRiskIncrease, false);
  assert.ok(decision.reasonCodes.includes(reasonCode), decision.reasonCodes.join(","));
}

function contradiction(
  intent: OrderIntent | null,
  fields: Partial<ExecutionContradiction> & Pick<ExecutionContradiction, "reasonCode">,
): ExecutionContradiction {
  return {
    executionId: "sim-exec-1",
    exchangeOrderId: "sim-order-1",
    clientOrderId: intent === null ? null : clientIdOf(intent),
    side: "BUY",
    quantity: "0.004",
    price: "100",
    ...fields,
  };
}

function contradictionsOf(state: unknown): unknown {
  return (state as IntentRegistryState).executionContradictions;
}

const nextIntent = () => buildIntent({ sequence: "2", logicalLevelId: "B2", price: "99" });

// Gate 3 F3: the coordinator records sim-exec-1 as 0.004 from a replay that reaches the venue
// end, then the stream reports the same execution ID as 0.006. Returns the linked intent.
async function streamConflict(
  coordinator: ExecutionCoordinator,
  venue: Pick<SimulatedVenue, "fill">,
): Promise<OrderIntent> {
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
  assert.deepEqual(
    await coordinator.ingestStreamExecution(streamed(execution, { quantity: "0.006" })),
    { reasonCodes: ["EXECUTION_CONFLICT"], recorded: [] },
  );
  return intent;
}

// Runs the lost-ack flow: the place ack is lost, the order fills 0.004, the stream reports
// that execution with the given quantity, and only then does the lookup link the order and
// record the venue's execution. Returns the journal written before the link as well.
async function lostAckThenStream(streamQuantity: string) {
  const h = await createHarness();
  h.venue.scriptPlace("UNKNOWN_ACCEPTED");
  const intent = buildIntent();
  await grant(h.coordinator);
  assert.equal((await h.coordinator.submit(intent)).record?.status, "UNKNOWN");
  const execution = h.venue.fill("sim-order-1", "0.004", "100");
  assert.deepEqual(
    await h.coordinator.ingestStreamExecution(streamed(execution, { quantity: streamQuantity })),
    { reasonCodes: ["EXECUTION_FOR_UNLINKED_INTENT"], recorded: [] },
  );
  const journalBeforeLink = h.journal.latest();
  await h.coordinator.reconcileUnresolved();
  assert.equal(h.registry.get(intent.intentId)?.status, "LINKED");
  assert.deepEqual(h.registry.get(intent.intentId)?.executions, [
    { executionId: "sim-exec-1", exchangeOrderId: "sim-order-1", quantity: "0.004", price: "100" },
  ]);
  const entry = contradiction(intent, {
    reasonCode: "EXECUTION_FOR_UNLINKED_INTENT",
    quantity: streamQuantity,
  });
  return { h, entry, journalBeforeLink };
}

describe("Gate 3 corrective C3: execution contradictions survive replay and restart", {
  concurrency: 1,
}, () => {
  test("G3-C3-1 an empty replay tail does not clear a stream execution conflict", async () => {
    const h = await createHarness();
    const intent = await streamConflict(h.coordinator, h.venue);

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: [],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assertHalted(await h.coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
    const refusedResult = await h.coordinator.submit(nextIntent());
    assert.equal(refusedResult.disposition, "REFUSED");
    assert.equal(h.registry.get(nextIntent().intentId), null);
    assert.equal(h.venue.calls.place, 1);

    const entry = contradiction(intent, { reasonCode: "EXECUTION_CONFLICT", quantity: "0.006" });
    assert.deepEqual(h.registry.executionContradictions(), [entry]);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [entry]);
    // The recorded execution keeps its first facts.
    assert.equal(h.registry.get(intent.intentId)?.executedQuantity, "0.004");

    const rebuilt = await createHarness({
      venue: h.venue,
      registry: IntentRegistry.fromState(h.journal.latest()),
      checkpoints: h.checkpoints,
    });
    assert.deepEqual(rebuilt.coordinator.riskIncreaseBlockers(), ["EXECUTION_CONFLICT"]);
  });

  test("G3-C3-2 a replay conflict outlives the next complete replay and a journal rebuild", async () => {
    const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
    let edit = (page: ExecutionPage): ExecutionPage => page;
    const port: ExecutionVenuePort = {
      placeOrder: (intent) => venue.placeOrder(intent),
      cancelOrder: (request) => venue.cancelOrder(request),
      lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
      listOpenOrders: () => venue.listOpenOrders(),
      listExecutionsSince: async (cursor) => edit(await venue.listExecutionsSince(cursor)),
    };
    const h = await createHarness({ venue, port });
    await grant(h.coordinator);
    const intent = buildIntent();
    assert.equal((await h.coordinator.submit(intent)).record?.status, "LINKED");
    venue.fill("sim-order-1", "0.004", "100");
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
    venue.overlapExecutionReads(1);

    edit = (page) => ({
      ...page,
      executions: page.executions.map((execution) => ({ ...execution, price: "101" })),
    });
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    edit = (page) => page;
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_CONFLICT"],
      recorded: [],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const entry = contradiction(intent, { reasonCode: "EXECUTION_CONFLICT", price: "101" });
    assert.deepEqual(contradictionsOf(h.journal.latest()), [entry]);
    const rebuilt = await createHarness({
      venue,
      port,
      registry: IntentRegistry.fromState(h.journal.latest()),
      checkpoints: h.checkpoints,
    });
    assert.deepEqual(rebuilt.coordinator.riskIncreaseBlockers(), ["EXECUTION_CONFLICT"]);
  });

  test("G3-C3-3 a durable reopen restores the conflict before any new risk", async () => {
    await withDirectory(async (directory) => {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const intent = await streamConflict(coordinatorOver(await openOk(directory), venue), venue);

      const reopened = await openOk(directory);
      const coordinator = coordinatorOver(reopened, venue);
      const gate = await runRestartGate(coordinator, "epoch-1");
      assert.equal(gate.allowRiskIncrease, false);
      assert.deepEqual(gate.reasonCodes, ["EXECUTION_CONFLICT"]);
      assert.deepEqual(gate.replay, { reasonCodes: ["EXECUTION_CONFLICT"], recorded: [] });
      assertHalted(await coordinator.evaluateContinuation("epoch-1"), "EXECUTION_CONFLICT");
      assert.equal((await coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(venue.calls.place, 1);
      assert.deepEqual(reopened.registry.executionContradictions(), [
        contradiction(intent, { reasonCode: "EXECUTION_CONFLICT", quantity: "0.006" }),
      ]);
    });
  });

  test("G3-C3-4 a fresh process restores the conflict and sends nothing", async () => {
    await withDirectory(async (root) => {
      const venueDirectory = path.join(root, "venue");
      const executionDirectory = path.join(root, "execution");
      await mkdir(executionDirectory, { recursive: true });
      const venue = await FileBackedVenue.open(venueDirectory, "run1");
      await streamConflict(coordinatorOver(await openOk(executionDirectory), venue), venue);

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

  test("G3-C3-5 control: an unlinked-intent execution later recorded with the same facts clears", async () => {
    const { h, entry, journalBeforeLink } = await lostAckThenStream("0.004");

    assert.deepEqual(await h.coordinator.replayExecutions(), { reasonCodes: [], recorded: [] });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    assert.deepEqual(contradictionsOf(journalBeforeLink), [entry]);
    assert.deepEqual(h.registry.executionContradictions(), []);
    assert.deepEqual(contradictionsOf(h.journal.latest()), []);
  });

  test("G3-C3-6 an unlinked-intent execution recorded with other facts stays blocking", async () => {
    const { h, entry, journalBeforeLink } = await lostAckThenStream("0.005");

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_FOR_UNLINKED_INTENT"],
      recorded: [],
    });
    assertHalted(
      await h.coordinator.evaluateContinuation("epoch-1"),
      "EXECUTION_FOR_UNLINKED_INTENT",
    );
    assert.deepEqual(contradictionsOf(journalBeforeLink), [entry]);
    assert.deepEqual(h.registry.executionContradictions(), [entry]);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [entry]);
  });

  test("G3-C3-7 an unattributed stream execution outlives an empty replay tail", async () => {
    const h = await createHarness();
    assert.deepEqual(
      await h.coordinator.ingestStreamExecution(structuredClone(FOREIGN_EXECUTION)),
      {
        reasonCodes: ["UNATTRIBUTED_EXECUTION"],
        recorded: [],
      },
    );
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["UNATTRIBUTED_EXECUTION"],
      recorded: [],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    assert.deepEqual(contradictionsOf(h.journal.latest()), NEW_STATE.executionContradictions);
  });
});

describe("Gate 3 corrective C3: persisted schema (REVIEW_CHANGE_PROTOCOL §13)", () => {
  test("G3-C3-8 the schema version is 3 and an empty registry exports no contradictions", () => {
    assert.equal(INTENT_REGISTRY_SCHEMA_VERSION, "phase3-intent-registry-3");
    assert.deepEqual(new IntentRegistry().exportState(), {
      schemaVersion: "phase3-intent-registry-3",
      records: [],
      executionContradictions: [],
    });
  });

  test("G3-C3-9 an old-schema journal fails closed on open", async () => {
    await withDirectory(async (directory) => {
      await seedJournal(directory, V1_STATE);
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_INVALID_STATE"],
      });
    });
  });

  test("G3-C3-10 a newer-schema journal fails closed on open", async () => {
    await withDirectory(async (directory) => {
      await seedJournal(directory, { ...NEW_STATE, schemaVersion: "phase3-intent-registry-4" });
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_SCHEMA_VERSION_MISMATCH"],
      });
    });
  });

  test("G3-C3-11 a new-schema journal round-trips and its contradiction blocks the restart gate", async () => {
    await withDirectory(async (directory) => {
      await seedJournal(directory, NEW_STATE);
      const state = await openOk(directory);
      assert.deepEqual(state.registry.exportState(), NEW_STATE);
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const gate = await runRestartGate(coordinatorOver(state, venue), "epoch-1");
      assert.equal(gate.allowRiskIncrease, false);
      assert.deepEqual(gate.reasonCodes, ["UNATTRIBUTED_EXECUTION"]);
    });
  });

  test("G3-C3-12 corrupt or mismatched contradictions are rejected, never repaired", async () => {
    const entry = NEW_STATE.executionContradictions[0] as ExecutionContradiction;
    const withEntries = (entries: unknown[]) => ({
      ...NEW_STATE,
      executionContradictions: entries,
    });
    const withEntry = (patch: Record<string, unknown>) => withEntries([{ ...entry, ...patch }]);
    const { executionContradictions: _dropped, ...withoutKey } = NEW_STATE;
    const { price: _price, ...missingField } = entry;
    const later = { ...entry, executionId: "foreign-exec-2", exchangeOrderId: "foreign-order-2" };
    const cases: Array<[string, unknown]> = [
      ["IMPORT_INVALID_STATE", withoutKey],
      ["IMPORT_INVALID_STATE", { ...NEW_STATE, executionContradictions: null }],
      ["IMPORT_INVALID_STATE", { ...NEW_STATE, executionContradictions: {} }],
      ["IMPORT_INVALID_CONTRADICTION", withEntries([null])],
      ["IMPORT_INVALID_CONTRADICTION", withEntries([[]])],
      ["IMPORT_INVALID_CONTRADICTION", withEntries([missingField])],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ extra: true })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ reasonCode: "EXECUTION_REPLAY_INCOMPLETE" })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ reasonCode: "EXECUTION_OBSERVATION_INVALID" })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ reasonCode: "UNKNOWN_REASON" })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ executionId: "" })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ exchangeOrderId: null })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ quantity: 0.002 })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ side: false })],
      ["IMPORT_CONTRADICTIONS_NOT_SORTED", withEntries([later, entry])],
      ["IMPORT_CONTRADICTIONS_NOT_SORTED", withEntries([entry, entry])],
    ];
    for (const [reasonCode, state] of cases) {
      assert.throws(
        () => IntentRegistry.fromState(structuredClone(state)),
        (error: unknown) => {
          assert.ok(error instanceof IntentRegistryError);
          assert.equal(error.reasonCode, reasonCode);
          return true;
        },
        reasonCode,
      );
    }
    assert.deepEqual(
      IntentRegistry.fromState(withEntries([entry, later])).executionContradictions(),
      [entry, later],
    );

    // A recorded execution with the same facts explains an attribution entry, so a journal
    // holding both was not written by this registry.
    const { h, entry: explained } = await lostAckThenStream("0.004");
    const linked = h.journal.latest() as IntentRegistryState;
    assert.throws(
      () => IntentRegistry.fromState({ ...linked, executionContradictions: [explained] }),
      (error: unknown) => {
        assert.ok(error instanceof IntentRegistryError);
        assert.equal(error.reasonCode, "IMPORT_CONTRADICTION_ALREADY_EXPLAINED");
        return true;
      },
    );

    await withDirectory(async (directory) => {
      await seedJournal(directory, withEntry({ reasonCode: "EXECUTION_REPLAY_INCOMPLETE" }));
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_INVALID_CONTRADICTION"],
      });
    });
  });
});
