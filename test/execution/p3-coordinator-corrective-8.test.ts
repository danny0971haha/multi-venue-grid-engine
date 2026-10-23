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
  type ExecutionReplayResult,
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

// What a stream execution gets back when another operation holds the coordinator.
const BUSY_DROP: ExecutionReplayResult = {
  reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED", "COORDINATOR_BUSY"],
  recorded: [],
};
// The same, for one whose stream sequence cannot be read.
const BUSY_DROP_NO_SEQUENCE: ExecutionReplayResult = {
  reasonCodes: ["EXECUTION_STREAM_SEQUENCE_UNUSABLE", ...BUSY_DROP.reasonCodes],
  recorded: [],
};

const UNUSABLE = "EXECUTION_STREAM_EVENT_UNUSABLE";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "g3-rc8-"));
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
// it runs; the operation then finishes, which checks the delivered execution.
async function deliverDuring<T>(
  held: Held,
  read: "scan" | "replay",
  coordinator: ExecutionCoordinator,
  operation: () => Promise<T>,
  execution: ExecutionObservation,
  expected: ExecutionReplayResult,
): Promise<T> {
  const release = held.hold(read);
  const running = operation();
  assert.deepEqual(await coordinator.ingestStreamExecution(execution), expected);
  release();
  return running;
}

// The stream's report of the given execution with the given quantity.
function streamed(execution: ExecutionObservation, quantity: string): ExecutionObservation {
  const copy = { ...structuredClone(execution), quantity };
  copy.meta = { ...copy.meta, source: "stream", sequence: "1" };
  return copy;
}

function throwingGetter<T extends object>(target: T, field: string, inMeta = false): T {
  const owner = inMeta ? (target as { meta: object }).meta : target;
  Object.defineProperty(owner, field, {
    enumerable: true,
    get() {
      throw new Error(`${field} unavailable`);
    },
  });
  return target;
}

// A field this coordinator does not check, in a form that cannot be copied or read.
const ANCILLARY_FORMS: {
  name: string;
  apply(report: ExecutionObservation): ExecutionObservation;
}[] = [
  {
    name: "a feeAmount that is a function",
    apply: (report) => ({ ...report, feeAmount: (() => "0.01") as unknown as string }),
  },
  {
    name: "a feeAsset that is a function",
    apply: (report) => ({ ...report, feeAsset: (() => "USDC") as unknown as string }),
  },
  {
    name: "a liquidity that is a function",
    apply: (report) => ({ ...report, liquidity: (() => "MAKER") as unknown as "MAKER" }),
  },
  {
    name: "a feeAmount getter that throws",
    apply: (report) => throwingGetter(report, "feeAmount"),
  },
  {
    name: "a meta.serverTime that is a function",
    apply: (report) => ({
      ...report,
      meta: { ...report.meta, serverTime: (() => OBSERVED_AT) as unknown as string },
    }),
  },
  {
    name: "a meta.receivedAt getter that throws",
    apply: (report) => throwingGetter(report, "receivedAt", true),
  },
];

// A checked field that is not a string or cannot be read. It is checked as a value that is
// not a string, so the report is kept as a mismatch with that field null.
const MALFORMED_FACTS: {
  name: string;
  field: "clientOrderId" | "side" | "quantity" | "price";
  apply(report: ExecutionObservation): ExecutionObservation;
}[] = [
  {
    name: "a quantity getter that throws",
    field: "quantity",
    apply: (report) => throwingGetter(report, "quantity"),
  },
  {
    name: "a quantity that is a function",
    field: "quantity",
    apply: (report) => ({ ...report, quantity: (() => "0.006") as unknown as string }),
  },
  {
    name: "a price getter that throws",
    field: "price",
    apply: (report) => throwingGetter(report, "price"),
  },
  {
    name: "a side that is a function",
    field: "side",
    apply: (report) => ({ ...report, side: (() => "BUY") as unknown as "BUY" }),
  },
  {
    name: "a client order ID getter that throws",
    field: "clientOrderId",
    apply: (report) => throwingGetter(report, "clientOrderId"),
  },
];

type UnusableForm = {
  name: string;
  // Whether the stream sequence can still be read from it.
  sequenceReadable: boolean;
  // The kept fields that differ from the report of sim-exec-1 at 0.006.
  kept: Partial<ExecutionContradiction>;
  apply(report: ExecutionObservation): ExecutionObservation;
};

const NOTHING_KEPT: Partial<ExecutionContradiction> = {
  executionId: null,
  exchangeOrderId: null,
  clientOrderId: null,
  side: null,
  quantity: null,
  price: null,
};

// Reports that cannot be checked as an execution of this market with its own identity.
const UNUSABLE_FORMS: UnusableForm[] = [
  {
    name: "a revoked proxy",
    sequenceReadable: false,
    kept: NOTHING_KEPT,
    apply(report) {
      const { proxy, revoke } = Proxy.revocable(report, {});
      revoke();
      return proxy;
    },
  },
  {
    name: "a value that is not an object",
    sequenceReadable: false,
    kept: NOTHING_KEPT,
    apply: () => null as unknown as ExecutionObservation,
  },
  {
    name: "an execution ID getter that throws",
    sequenceReadable: true,
    kept: { executionId: null },
    apply: (report) => throwingGetter(report, "executionId"),
  },
  {
    name: "an execution ID that is a function",
    sequenceReadable: true,
    kept: { executionId: null },
    apply: (report) => ({ ...report, executionId: (() => "sim-exec-1") as unknown as string }),
  },
  {
    name: "a missing exchange order ID",
    sequenceReadable: true,
    kept: { exchangeOrderId: null },
    apply(report) {
      const { exchangeOrderId: _dropped, ...rest } = report;
      return rest as ExecutionObservation;
    },
  },
  {
    name: "another venue's label",
    sequenceReadable: true,
    kept: {},
    apply: (report) => ({ ...report, venue: "other" }),
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

// Replays twice past an empty tail, then checks that only the persisted code blocks and that
// neither the continuation gate nor a submit gets through.
async function assertBlockedAfterEmptyReplays(
  h: Awaited<ReturnType<typeof heldHarness>>["h"],
  reasonCode: string,
): Promise<void> {
  for (let replay = 0; replay < 2; replay += 1) {
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [reasonCode],
      recorded: [],
    });
  }
  assert.deepEqual(h.coordinator.riskIncreaseBlockers(), [reasonCode]);
  assertHalted(await h.coordinator.evaluateContinuation("epoch-1"), reasonCode);
  assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
  assert.equal(h.registry.get(nextIntent().intentId), null);
  assert.equal(h.venue.calls.place, 1);
}

// Opens the directory again, as a restarted runtime would, and checks that the restart gate,
// the continuation gate and a submit are all refused for the persisted entry.
async function assertReopenBlocked(
  directory: string,
  venue: SimulatedVenue,
  entry: ExecutionContradiction,
): Promise<void> {
  const reopened = await openOk(directory);
  assert.deepEqual(reopened.registry.executionContradictions(), [entry]);
  const coordinator = coordinatorOver(reopened, venue);
  const gate = await runRestartGate(coordinator, "epoch-1");
  assert.equal(gate.allowRiskIncrease, false);
  assert.deepEqual(gate.reasonCodes, [entry.reasonCode]);
  assert.deepEqual(gate.replay, { reasonCodes: [entry.reasonCode], recorded: [] });
  assertHalted(await coordinator.evaluateContinuation("epoch-1"), entry.reasonCode);
  assert.equal((await coordinator.submit(nextIntent())).disposition, "REFUSED");
  assert.equal(venue.calls.place, 1);
}

// Delivers the report during a scan of a file-backed run, then restarts in a fresh process
// and checks that it reopens blocked by the persisted entry and places nothing.
async function assertFreshProcessBlocked(
  report: (execution: ExecutionObservation) => ExecutionObservation,
  expected: ExecutionReplayResult,
  reasonCode: string,
): Promise<void> {
  await withDirectory(async (root) => {
    const venueDirectory = path.join(root, "venue");
    const executionDirectory = path.join(root, "execution");
    await mkdir(executionDirectory, { recursive: true });
    const venue = await FileBackedVenue.open(venueDirectory, "run1");
    const held = holdable(venue);
    const first = coordinatorOver(await openOk(executionDirectory), held.port);
    const { execution } = await linkedFill(first, venue);
    await deliverDuring(
      held,
      "scan",
      first,
      () => first.scanOpenOrders("epoch-1"),
      report(execution),
      expected,
    );

    const restarted = await restartInFreshProcess(
      command(root, { mode: "RESTART", label: "restart", sequenceBase: 10 }),
    );
    assert.deepEqual(restarted.open, { ok: true, reasonCodes: [] });
    assert.deepEqual(restarted.gate, {
      allowRiskIncrease: false,
      reasonCodes: [reasonCode],
      recordedExecutions: [],
    });
    assert.equal(restarted.continuation?.action, "HALT");
    assert.equal(restarted.continuation?.allowRiskIncrease, false);
    assert.ok(restarted.continuation?.reasonCodes.includes(reasonCode));
    assert.equal(restarted.postGateSubmit?.disposition, "REFUSED");
    assert.deepEqual(restarted.finalStatuses, { B1: "LINKED" });
    assert.deepEqual(
      readEvents(venueDirectory).filter(
        (event) => event.label === "restart" && event.type === "PLACE",
      ),
      [],
    );
  });
}

describe("Gate 3 re-review RC8: checked stream facts are read apart from other fields", {
  concurrency: 1,
}, () => {
  for (const form of ANCILLARY_FORMS) {
    test(`G3-RC8-1 ${form.name} on a conflict delivered during a scan keeps the conflict`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);

      await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.scanOpenOrders("epoch-1"),
        form.apply(streamed(execution, "0.006")),
        BUSY_DROP,
      );
      assert.deepEqual(h.coordinator.riskIncreaseBlockers(), [
        "EXECUTION_CONFLICT",
        "EXECUTION_STREAM_EVENT_DROPPED",
      ]);
      assert.deepEqual(h.registry.executionContradictions(), [conflictEntry(intent)]);
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
      await assertBlockedAfterEmptyReplays(h, "EXECUTION_CONFLICT");
      // The recorded execution keeps the venue's facts.
      assert.equal(h.registry.get(intent.intentId)?.executedQuantity, "0.004");
    });

    test(`G3-RC8-2 ${form.name} on a conflict delivered during a replay keeps the conflict`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);

      assert.deepEqual(
        await deliverDuring(
          held,
          "replay",
          h.coordinator,
          () => h.coordinator.replayExecutions(),
          form.apply(streamed(execution, "0.006")),
          BUSY_DROP,
        ),
        { reasonCodes: ["EXECUTION_STREAM_EVENT_DROPPED"], recorded: [] },
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
      await assertBlockedAfterEmptyReplays(h, "EXECUTION_CONFLICT");
    });

    test(`G3-RC8-3 ${form.name} on a conflict delivered during a continuation gate denies it and the next one`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);

      const decision = await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.evaluateContinuation("epoch-1"),
        form.apply(streamed(execution, "0.006")),
        BUSY_DROP,
      );
      assert.equal(decision.allowRiskIncrease, false);
      assert.ok(
        decision.reasonCodes.includes("EXECUTION_STREAM_EVENT_DROPPED"),
        decision.reasonCodes.join(","),
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
      await assertBlockedAfterEmptyReplays(h, "EXECUTION_CONFLICT");
    });

    test(`G3-RC8-4 ${form.name} on a conflict delivered during a scan: a durable reopen restores it`, async () => {
      await withDirectory(async (directory) => {
        const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
        const held = holdable(venue);
        const first = coordinatorOver(await openOk(directory), held.port);
        const { intent, execution } = await linkedFill(first, venue);
        await deliverDuring(
          held,
          "scan",
          first,
          () => first.scanOpenOrders("epoch-1"),
          form.apply(streamed(execution, "0.006")),
          BUSY_DROP,
        );
        await assertReopenBlocked(directory, venue, conflictEntry(intent));
      });
    });

    test(`G3-RC8-5 control: ${form.name} on a conflict ingested while idle keeps the same conflict`, async () => {
      const { h } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);

      assert.deepEqual(
        await h.coordinator.ingestStreamExecution(form.apply(streamed(execution, "0.006"))),
        { reasonCodes: ["EXECUTION_CONFLICT"], recorded: [] },
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
      await assertBlockedAfterEmptyReplays(h, "EXECUTION_CONFLICT");
    });

    test(`G3-RC8-6 control: ${form.name} on a valid execution delivered during a scan is recorded and clears`, async () => {
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
        form.apply(streamed(execution, "0.004")),
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
  }

  test("G3-RC8-7 control: the cloneable report delivered during a scan keeps the same conflict", async () => {
    const { h, held } = await heldHarness();
    const { intent, execution } = await linkedFill(h.coordinator, h.venue);

    await deliverDuring(
      held,
      "scan",
      h.coordinator,
      () => h.coordinator.scanOpenOrders("epoch-1"),
      streamed(execution, "0.006"),
      BUSY_DROP,
    );
    assert.deepEqual(contradictionsOf(h.journal.latest()), [conflictEntry(intent)]);
    await assertBlockedAfterEmptyReplays(h, "EXECUTION_CONFLICT");
  });

  test("G3-RC8-8 a feeAmount that is a function on a conflict delivered during a scan: a fresh process restores it and sends nothing", async () => {
    await assertFreshProcessBlocked(
      (execution) => ({
        ...streamed(execution, "0.006"),
        feeAmount: (() => "0.01") as unknown as string,
      }),
      BUSY_DROP,
      "EXECUTION_CONFLICT",
    );
  });

  for (const malformed of MALFORMED_FACTS) {
    test(`G3-RC8-9 ${malformed.name} delivered during a scan is kept as a mismatch, as when idle`, async () => {
      const busy = await heldHarness();
      const { intent, execution } = await linkedFill(busy.h.coordinator, busy.h.venue);
      const mismatch = conflictEntry(intent, {
        reasonCode: "EXECUTION_MISMATCH",
        [malformed.field]: null,
      });

      await deliverDuring(
        busy.held,
        "scan",
        busy.h.coordinator,
        () => busy.h.coordinator.scanOpenOrders("epoch-1"),
        malformed.apply(streamed(execution, "0.006")),
        BUSY_DROP,
      );
      assert.deepEqual(contradictionsOf(busy.h.journal.latest()), [mismatch]);
      await assertBlockedAfterEmptyReplays(busy.h, "EXECUTION_MISMATCH");

      const idle = await heldHarness();
      const idleFill = await linkedFill(idle.h.coordinator, idle.h.venue);
      assert.deepEqual(
        await idle.h.coordinator.ingestStreamExecution(
          malformed.apply(streamed(idleFill.execution, "0.006")),
        ),
        { reasonCodes: ["EXECUTION_MISMATCH"], recorded: [] },
      );
      assert.deepEqual(contradictionsOf(idle.h.journal.latest()), [mismatch]);
    });
  }

  test("G3-RC8-10 a quantity getter that throws delivered during a scan: a durable reopen restores the mismatch", async () => {
    await withDirectory(async (directory) => {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const held = holdable(venue);
      const first = coordinatorOver(await openOk(directory), held.port);
      const { intent, execution } = await linkedFill(first, venue);
      await deliverDuring(
        held,
        "scan",
        first,
        () => first.scanOpenOrders("epoch-1"),
        throwingGetter(streamed(execution, "0.006"), "quantity"),
        BUSY_DROP,
      );
      await assertReopenBlocked(
        directory,
        venue,
        conflictEntry(intent, { reasonCode: "EXECUTION_MISMATCH", quantity: null }),
      );
    });
  });

  for (const form of UNUSABLE_FORMS) {
    test(`G3-RC8-11 ${form.name} delivered during a scan is kept as unusable and outlives empty replays`, async () => {
      const { h, held } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);
      const entry = conflictEntry(intent, { reasonCode: UNUSABLE, ...form.kept });

      await deliverDuring(
        held,
        "scan",
        h.coordinator,
        () => h.coordinator.scanOpenOrders("epoch-1"),
        form.apply(streamed(execution, "0.006")),
        form.sequenceReadable ? BUSY_DROP : BUSY_DROP_NO_SEQUENCE,
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [entry]);
      assert.ok(
        h.coordinator.riskIncreaseBlockers().includes(UNUSABLE),
        h.coordinator.riskIncreaseBlockers().join(","),
      );
      await assertBlockedAfterEmptyReplays(h, UNUSABLE);
    });

    test(`G3-RC8-12 ${form.name} ingested while idle is kept as unusable`, async () => {
      const { h } = await heldHarness();
      const { intent, execution } = await linkedFill(h.coordinator, h.venue);

      assert.deepEqual(
        await h.coordinator.ingestStreamExecution(form.apply(streamed(execution, "0.006"))),
        {
          reasonCodes: [
            ...(form.sequenceReadable ? [] : ["EXECUTION_STREAM_SEQUENCE_UNUSABLE"]),
            UNUSABLE,
          ],
          recorded: [],
        },
      );
      assert.deepEqual(contradictionsOf(h.journal.latest()), [
        conflictEntry(intent, { reasonCode: UNUSABLE, ...form.kept }),
      ]);
      await assertBlockedAfterEmptyReplays(h, UNUSABLE);
    });
  }

  test("G3-RC8-13 a revoked proxy delivered during a scan: a durable reopen restores the unusable entry", async () => {
    await withDirectory(async (directory) => {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const held = holdable(venue);
      const first = coordinatorOver(await openOk(directory), held.port);
      const { intent, execution } = await linkedFill(first, venue);
      const { proxy, revoke } = Proxy.revocable(streamed(execution, "0.006"), {});
      revoke();
      await deliverDuring(
        held,
        "scan",
        first,
        () => first.scanOpenOrders("epoch-1"),
        proxy,
        BUSY_DROP_NO_SEQUENCE,
      );
      await assertReopenBlocked(
        directory,
        venue,
        conflictEntry(intent, { reasonCode: UNUSABLE, ...NOTHING_KEPT }),
      );
    });
  });

  test("G3-RC8-14 a revoked proxy delivered during a scan: a fresh process restores it and sends nothing", async () => {
    await assertFreshProcessBlocked(
      (execution) => {
        const { proxy, revoke } = Proxy.revocable(streamed(execution, "0.006"), {});
        revoke();
        return proxy;
      },
      BUSY_DROP_NO_SEQUENCE,
      UNUSABLE,
    );
  });

  test("G3-RC8-15 control: an unusable execution in a replay page still stops that replay without being kept", async () => {
    const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
    let foreignLabel = false;
    const port: ExecutionVenuePort = {
      placeOrder: (intent) => venue.placeOrder(intent),
      cancelOrder: (request) => venue.cancelOrder(request),
      lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
      listOpenOrders: () => venue.listOpenOrders(),
      listExecutionsSince: async (cursor) => {
        const page = await venue.listExecutionsSince(cursor);
        return foreignLabel
          ? {
              ...page,
              executions: page.executions.map((item) => ({ ...item, venue: "other" })),
            }
          : page;
      },
    };
    const h = await createHarness({ venue, port });
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(buildIntent())).record?.status, "LINKED");
    h.venue.fill("sim-order-1", "0.004", "100");
    foreignLabel = true;

    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_OBSERVATION_INVALID", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    // The replay page can be read again, so nothing is persisted and the cursor stays.
    assert.deepEqual(h.registry.executionContradictions(), []);
    foreignLabel = false;
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
  });
});

// Old-state fixture: a version 2 journal with a contradiction it could hold.
const V2_STATE = {
  schemaVersion: "phase3-intent-registry-2",
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

// New-state fixture: an unusable stream event with some readable facts, and one with none,
// in the order the registry exports them.
const V3_STATE = {
  schemaVersion: "phase3-intent-registry-3",
  records: [],
  executionContradictions: [
    {
      reasonCode: UNUSABLE,
      executionId: null,
      exchangeOrderId: "foreign-order-1",
      clientOrderId: null,
      side: "SELL",
      quantity: "0.002",
      price: "101",
    },
    {
      reasonCode: UNUSABLE,
      executionId: null,
      exchangeOrderId: null,
      clientOrderId: null,
      side: null,
      quantity: null,
      price: null,
    },
  ],
};

describe("Gate 3 re-review RC8: persisted schema (REVIEW_CHANGE_PROTOCOL §13)", () => {
  test("G3-RC8-16 the schema version is 3 and an empty registry exports no contradictions", () => {
    assert.equal(INTENT_REGISTRY_SCHEMA_VERSION, "phase3-intent-registry-3");
    assert.deepEqual(new IntentRegistry().exportState(), {
      schemaVersion: "phase3-intent-registry-3",
      records: [],
      executionContradictions: [],
    });
  });

  test("G3-RC8-17 a version 2 journal fails closed on open", async () => {
    assert.throws(
      () => IntentRegistry.fromState(structuredClone(V2_STATE)),
      (error: unknown) => {
        assert.ok(error instanceof IntentRegistryError);
        assert.equal(error.reasonCode, "IMPORT_SCHEMA_VERSION_MISMATCH");
        return true;
      },
    );
    await withDirectory(async (directory) => {
      await seedJournal(directory, V2_STATE);
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_SCHEMA_VERSION_MISMATCH"],
      });
    });
  });

  test("G3-RC8-18 a version 3 journal round-trips and its unusable entries block the restart gate", async () => {
    await withDirectory(async (directory) => {
      await seedJournal(directory, V3_STATE);
      const state = await openOk(directory);
      assert.deepEqual(state.registry.exportState(), V3_STATE);
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const coordinator = coordinatorOver(state, venue);
      const gate = await runRestartGate(coordinator, "epoch-1");
      assert.equal(gate.allowRiskIncrease, false);
      assert.deepEqual(gate.reasonCodes, [UNUSABLE]);
      assert.equal((await coordinator.submit(nextIntent())).disposition, "REFUSED");
      assert.equal(venue.calls.place, 0);
    });
  });

  test("G3-RC8-19 corrupt or newer unusable entries are rejected, never repaired", async () => {
    const [partial, blank] = V3_STATE.executionContradictions as [
      ExecutionContradiction,
      ExecutionContradiction,
    ];
    const withEntries = (entries: unknown[]) => ({ ...V3_STATE, executionContradictions: entries });
    const withEntry = (patch: Record<string, unknown>) => withEntries([{ ...partial, ...patch }]);
    const { side: _side, ...missingField } = partial;
    const cases: Array<[string, unknown]> = [
      [
        "IMPORT_SCHEMA_VERSION_MISMATCH",
        { ...V3_STATE, schemaVersion: "phase3-intent-registry-4" },
      ],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ executionId: 1 })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ exchangeOrderId: false })],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ quantity: 0.002 })],
      ["IMPORT_INVALID_CONTRADICTION", withEntries([missingField])],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ extra: null })],
      // Only an unusable stream event may lack its identity.
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ reasonCode: "EXECUTION_CONFLICT" })],
      [
        "IMPORT_INVALID_CONTRADICTION",
        withEntry({
          reasonCode: "UNATTRIBUTED_EXECUTION",
          executionId: "foreign-exec-1",
          exchangeOrderId: null,
        }),
      ],
      ["IMPORT_INVALID_CONTRADICTION", withEntry({ reasonCode: "EXECUTION_OBSERVATION_INVALID" })],
      ["IMPORT_CONTRADICTIONS_NOT_SORTED", withEntries([blank, partial])],
      ["IMPORT_CONTRADICTIONS_NOT_SORTED", withEntries([blank, blank])],
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
    // An unusable entry with every fact present is kept as observed.
    const full = { ...partial, executionId: "foreign-exec-1" };
    assert.deepEqual(IntentRegistry.fromState(withEntries([full])).executionContradictions(), [
      full,
    ]);

    // The registry refuses to record an entry the import would refuse.
    assert.throws(
      () =>
        new IntentRegistry().recordContradictions([
          { ...partial, reasonCode: "EXECUTION_CONFLICT" },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof IntentRegistryError);
        assert.equal(error.reasonCode, "INVALID_EXECUTION_CONTRADICTION");
        return true;
      },
    );

    await withDirectory(async (directory) => {
      await seedJournal(directory, withEntry({ reasonCode: "EXECUTION_CONFLICT" }));
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_INVALID_CONTRADICTION"],
      });
    });
  });
});
