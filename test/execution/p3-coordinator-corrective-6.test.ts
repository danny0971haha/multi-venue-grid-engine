import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ClientOrderLookup,
  type ExecutionContradiction,
  type ExecutionPage,
  type ExecutionVenuePort,
  INTENT_JOURNAL_KIND,
  INTENT_JOURNAL_STATE_NAME,
  openDurableExecutionState,
} from "../../src/execution/index.js";
import { initializeExactPair } from "../../src/persistence/atomic-pair-store.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import type { G3Rc6WorkerCommand, G3Rc6WorkerReport } from "../fixtures/g3-rc6-lookup-worker.js";
import { readEvents } from "../fixtures/phase3e-venue.js";
import {
  buildIntent,
  clientIdOf,
  createHarness,
  grant,
  type Harness,
  OBSERVED_AT,
  SCOPE_KEY,
} from "./helpers.js";

const WORKER_PATH = fileURLToPath(new URL("../fixtures/g3-rc6-lookup-worker.ts", import.meta.url));
const CHILD_TIMEOUT_MS = 20_000;

// Every unresolved order below is B1 for quantity 1 at price 100.
const QUANTITY = "1";
const HALF = "0.5";
// One execution above the order quantity by 1e-40.
const ABOVE = `1.${"0".repeat(39)}1`;
// HALF + this = 1 - 1e-41.
const JUST_BELOW_HALF = `0.4${"9".repeat(40)}`;
// HALF + this = 1 + 1e-40.
const JUST_ABOVE_HALF = `0.5${"0".repeat(38)}1`;
// Its exact sum with HALF or with QUANTITY needs more digits than exact arithmetic allows.
const UNBOUNDED = `0.${"0".repeat(1100)}1`;
// Above HALF on its own, but its exact sum with HALF is too long to compute.
const DEEP_ABOVE_HALF = `0.5${"0".repeat(1100)}1`;

type Route = "place" | "cancel";
const ROUTES: Route[] = ["place", "cancel"];

// The status each route leaves B1 in, and how the venue's own lookup of the still open order
// with no executions resolves it.
const UNRESOLVED_STATUS: Record<Route, string> = { place: "UNKNOWN", cancel: "CANCEL_UNVERIFIED" };
const RELINKED: Record<Route, { status: string; reasonCodes: string[] }> = {
  place: { status: "LINKED", reasonCodes: ["RECONCILED_BY_CLIENT_ORDER_ID"] },
  cancel: { status: "LINKED", reasonCodes: ["ORDER_STILL_ACTIVE"] },
};

function quantityIntent(): OrderIntent {
  return buildIntent({ quantity: QUANTITY });
}

function nextIntent(): OrderIntent {
  return buildIntent({ sequence: "2", logicalLevelId: "B2" });
}

function exchangeOrderIdOf(venue: SimulatedVenue, intent: OrderIntent): string {
  const order = venue.orderForClientOrderId(clientIdOf(intent));
  assert.ok(order !== null);
  return order.exchangeOrderId;
}

// An execution of the intent's order at the venue, unless the overrides say otherwise.
function execution(
  venue: SimulatedVenue,
  intent: OrderIntent,
  executionId: string,
  quantity: string,
  overrides: Partial<ExecutionObservation> = {},
): ExecutionObservation {
  return {
    venue: "sim",
    market: "BTC_USDC_PERP",
    executionId,
    exchangeOrderId: exchangeOrderIdOf(venue, intent),
    clientOrderId: clientIdOf(intent),
    side: "BUY",
    price: "100",
    quantity,
    feeAmount: null,
    feeAsset: null,
    liquidity: "UNKNOWN",
    meta: {
      venue: "sim",
      source: "rest",
      serverTime: OBSERVED_AT,
      receivedAt: OBSERVED_AT,
      observedAt: OBSERVED_AT,
      freshnessMs: 0,
      sequence: null,
    },
    ...overrides,
  };
}

function streamed(execution: ExecutionObservation, sequence: string): ExecutionObservation {
  return { ...execution, meta: { ...execution.meta, source: "stream", sequence } };
}

function entry(reasonCode: string, execution: ExecutionObservation): ExecutionContradiction {
  return {
    reasonCode,
    executionId: execution.executionId,
    exchangeOrderId: execution.exchangeOrderId,
    clientOrderId: execution.clientOrderId,
    side: execution.side,
    quantity: execution.quantity,
    price: execution.price,
  };
}

function item(intent: OrderIntent, status: string, reasonCode: string) {
  return { intentId: intent.intentId, status, reasonCodes: [reasonCode] };
}

function contradictionsOf(state: unknown): unknown {
  return (state as { executionContradictions: unknown }).executionContradictions;
}

function recordOf(h: Harness, intent: OrderIntent) {
  const record = h.registry.get(intent.intentId);
  assert.ok(record !== null);
  return record;
}

// A port over the venue whose client order lookup and execution pages can be replaced while
// the test runs. A null field lets the venue answer.
type Switch = {
  respond: ((venue: SimulatedVenue) => ClientOrderLookup) | null;
  page: ExecutionObservation[] | null;
};

async function switchable(): Promise<{ h: Harness; sw: Switch }> {
  const sw: Switch = { respond: null, page: null };
  const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
  const port: ExecutionVenuePort = {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: async (clientOrderId) =>
      sw.respond === null ? venue.lookupClientOrder(clientOrderId) : sw.respond(venue),
    listOpenOrders: () => venue.listOpenOrders(),
    listExecutionsSince: async (cursor): Promise<ExecutionPage> => {
      const page = await venue.listExecutionsSince(cursor);
      return sw.page === null ? page : { ...page, executions: structuredClone(sw.page) };
    },
  };
  return { h: await createHarness({ venue, port }), sw };
}

async function placeLinked(h: Harness, intent: OrderIntent): Promise<void> {
  await grant(h.coordinator);
  assert.equal((await h.coordinator.submit(intent)).record?.status, "LINKED");
}

// Leaves the intent unresolved on the route: a place the venue stored whose response was lost,
// or a linked order whose cancel was lost before it reached the venue.
async function leaveUnresolved(route: Route, h: Harness, intent: OrderIntent): Promise<void> {
  if (route === "place") {
    h.venue.scriptPlace("UNKNOWN_ACCEPTED");
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(intent)).record?.status, "UNKNOWN");
    return;
  }
  await placeLinked(h, intent);
  h.venue.scriptCancel("UNKNOWN_DROPPED");
  assert.equal((await h.coordinator.cancel(intent.intentId)).record?.status, "CANCEL_UNVERIFIED");
}

// The reviewer's case: the venue reports one matching execution above the order quantity.
function overfilling(intent: OrderIntent) {
  return (venue: SimulatedVenue): ClientOrderLookup => ({
    order: null,
    executions: [execution(venue, intent, "exec-a", ABOVE)],
  });
}

async function assertDenied(h: Harness, reasonCode: string): Promise<void> {
  const decision = await h.coordinator.evaluateContinuation("epoch-1");
  assert.equal(decision.allowRiskIncrease, false, decision.reasonCodes.join(","));
  assert.ok(decision.reasonCodes.includes(reasonCode), decision.reasonCodes.join(","));
}

async function assertNextRefused(h: Harness): Promise<void> {
  const placed = h.venue.calls.place;
  assert.equal((await h.coordinator.submit(nextIntent())).disposition, "REFUSED");
  assert.equal(h.venue.calls.place, placed);
}

// The venue's own lookup now shows the order open with no executions; that omission
// resolves the record but must leave the contradiction blocking risk.
async function omitAndAssertBlocked(
  route: Route,
  h: Harness,
  sw: Switch,
  intent: OrderIntent,
  reasonCode: string,
  expected: ExecutionContradiction[],
): Promise<void> {
  sw.respond = null;
  assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
    reasonCodes: [],
    items: [{ intentId: intent.intentId, ...RELINKED[route] }],
  });
  assert.equal(recordOf(h, intent).executedQuantity, "0");
  assert.deepEqual(recordOf(h, intent).executions, []);
  assert.deepEqual(h.registry.executionContradictions(), expected);
  assert.equal(h.coordinator.canIncreaseRisk(), false);
  await assertDenied(h, reasonCode);
  await assertNextRefused(h);
  assert.deepEqual(contradictionsOf(h.journal.latest()), expected);
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "g3-rc6-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

async function runWorker(command: G3Rc6WorkerCommand): Promise<G3Rc6WorkerReport> {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER_PATH, JSON.stringify(command)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      exitOf(child),
    ]);
    assert.equal(exitCode, 0, stderr);
    return JSON.parse(stdout) as G3Rc6WorkerReport;
  } finally {
    forceKill(child);
  }
}

describe("Gate 3 re-review RC6: a lookup overfill survives a later omission", () => {
  for (const route of ROUTES) {
    test(`G3-RC6-1 [${route}] the overfill is durable and blocks through omission, replay and continuation`, async () => {
      const { h, sw } = await switchable();
      const intent = quantityIntent();
      await leaveUnresolved(route, h, intent);
      const status = UNRESOLVED_STATUS[route];

      sw.respond = overfilling(intent);
      assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
        reasonCodes: [],
        items: [item(intent, status, "LOOKUP_OVERFILL")],
      });
      const expected = overfilling(intent)(h.venue).executions.map((item) =>
        entry("EXECUTION_OVERFILL", item),
      );
      assert.equal(recordOf(h, intent).status, status);
      assert.equal(recordOf(h, intent).executedQuantity, "0");
      assert.deepEqual(h.registry.executionContradictions(), expected);
      assert.deepEqual(contradictionsOf(h.journal.latest()), expected);
      assert.equal(h.coordinator.canIncreaseRisk(), false);

      // Same process: an empty execution tail still reports it.
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_OVERFILL"],
        recorded: [],
      });
      assert.deepEqual(h.registry.executionContradictions(), expected);
      await omitAndAssertBlocked(route, h, sw, intent, "EXECUTION_OVERFILL", expected);
      assert.deepEqual(await h.coordinator.replayExecutions(), {
        reasonCodes: ["EXECUTION_OVERFILL"],
        recorded: [],
      });
      await assertDenied(h, "EXECUTION_OVERFILL");
    });

    test(`G3-RC6-2 [${route}] a durable reopen keeps the overfill after the lookup omits it`, async () => {
      const { h, sw } = await switchable();
      const intent = quantityIntent();
      await leaveUnresolved(route, h, intent);
      sw.respond = overfilling(intent);
      await h.coordinator.reconcileUnresolved();
      const expected = overfilling(intent)(h.venue).executions.map((item) =>
        entry("EXECUTION_OVERFILL", item),
      );

      await withDirectory(async (directory) => {
        const seeded = await initializeExactPair({
          directory,
          stateName: INTENT_JOURNAL_STATE_NAME,
          expectedKind: INTENT_JOURNAL_KIND,
          expectedScopeKey: SCOPE_KEY,
          payload: h.journal.latest(),
          latch: new RuntimePersistenceLatch(),
          bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
        });
        assert.equal(seeded.disposition, "REQUESTED_STATE_COMMITTED");
        const opened = await openDurableExecutionState({
          directory,
          scopeKey: SCOPE_KEY,
          latch: new RuntimePersistenceLatch(),
        });
        assert.ok(opened.ok);
        assert.deepEqual(opened.registry.executionContradictions(), expected);

        // The reopened coordinator asks the venue itself, which shows the order open and empty.
        const reopened = await createHarness({ venue: h.venue, registry: opened.registry });
        assert.deepEqual((await reopened.coordinator.reconcileUnresolved()).items, [
          { intentId: intent.intentId, ...RELINKED[route] },
        ]);
        assert.deepEqual(reopened.registry.executionContradictions(), expected);
        assert.equal(reopened.coordinator.canIncreaseRisk(), false);
        await assertDenied(reopened, "EXECUTION_OVERFILL");
        await assertNextRefused(reopened);
      });
    });

    test(`G3-RC6-3 [${route}] fresh processes keep the overfill and place nothing more`, async () => {
      await withDirectory(async (root) => {
        await mkdir(path.join(root, "execution"), { recursive: true });
        const status = UNRESOLVED_STATUS[route];
        const prepared = await runWorker({ step: "PREPARE", route, root });
        assert.deepEqual(prepared.open, { ok: true, reasonCodes: [] });
        assert.equal(prepared.gate?.allowRiskIncrease, true);
        assert.equal(prepared.prepared?.status, status);

        const contradicted = await runWorker({ step: "CONTRADICT", route, root });
        assert.deepEqual(contradicted.open, { ok: true, reasonCodes: [] });
        assert.deepEqual(contradicted.gate?.reconcile.items, [
          { status, reasonCodes: ["LOOKUP_OVERFILL"] },
        ]);
        assert.equal(contradicted.gate?.allowRiskIncrease, false);
        const expected: ExecutionContradiction[] = [
          {
            reasonCode: "EXECUTION_OVERFILL",
            executionId: "exec-a",
            exchangeOrderId: "sim-order-1",
            clientOrderId: clientIdOf(quantityIntent()),
            side: "BUY",
            quantity: ABOVE,
            price: "100",
          },
        ];
        assert.deepEqual(contradicted.contradictions, expected);

        const omitted = await runWorker({ step: "OMIT", route, root });
        assert.deepEqual(omitted.open, { ok: true, reasonCodes: [] });
        assert.deepEqual(omitted.gate?.reconcile, { reasonCodes: [], items: [RELINKED[route]] });
        assert.equal(omitted.gate?.allowRiskIncrease, false);
        assert.ok(omitted.gate?.reasonCodes.includes("EXECUTION_OVERFILL"));
        assert.equal(omitted.continuation?.allowRiskIncrease, false);
        assert.ok(omitted.continuation?.reasonCodes.includes("EXECUTION_OVERFILL"));
        assert.equal(omitted.next?.disposition, "REFUSED");
        assert.deepEqual(omitted.contradictions, expected);

        const placements = readEvents(path.join(root, "venue")).filter(
          (event) => event.type === "PLACE",
        );
        assert.equal(placements.length, 1);
      });
    });

    test(`G3-RC6-4 [${route}] a failed write of the overfill latches, and omission cannot clear it`, async () => {
      const { h, sw } = await switchable();
      const intent = quantityIntent();
      await leaveUnresolved(route, h, intent);
      const status = UNRESOLVED_STATUS[route];

      sw.respond = overfilling(intent);
      h.journal.scriptPersist("FAIL");
      assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
        reasonCodes: ["JOURNAL_WRITE_FAILED"],
        items: [item(intent, status, "LOOKUP_OVERFILL")],
      });
      assert.equal(h.coordinator.isJournalLatched(), true);
      assert.deepEqual(contradictionsOf(h.journal.latest()), []);

      sw.respond = null;
      assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
        reasonCodes: ["JOURNAL_LATCHED"],
        items: [],
      });
      assert.equal(recordOf(h, intent).status, status);
      assert.equal(h.coordinator.canIncreaseRisk(), false);
      await assertDenied(h, "JOURNAL_LATCHED");
      await assertNextRefused(h);
    });
  }
});

describe("Gate 3 re-review RC6: other material lookup contradictions are kept", () => {
  type Case = {
    name: string;
    reasonCode: string;
    // Runs before B1 is left unresolved.
    before?: (h: Harness) => Promise<void>;
    lookup: (venue: SimulatedVenue, intent: OrderIntent) => ClientOrderLookup;
    durable: (lookup: ClientOrderLookup) => ExecutionContradiction[];
    blocker: string;
  };

  const owner = buildIntent({ logicalLevelId: "B3" });
  const cases: Case[] = [
    {
      name: "an execution on the other side",
      reasonCode: "LOOKUP_EXECUTION_MISMATCH",
      lookup: (venue, intent) => ({
        order: null,
        executions: [execution(venue, intent, "exec-a", HALF, { side: "SELL" })],
      }),
      durable: (lookup) => lookup.executions.map((item) => entry("EXECUTION_MISMATCH", item)),
      blocker: "EXECUTION_MISMATCH",
    },
    {
      name: "one execution ID reported with two quantities",
      reasonCode: "LOOKUP_EXECUTION_MISMATCH",
      lookup: (venue, intent) => ({
        order: null,
        executions: [
          execution(venue, intent, "exec-a", "0.25"),
          execution(venue, intent, "exec-a", HALF),
        ],
      }),
      durable: (lookup) => lookup.executions.map((item) => entry("EXECUTION_CONFLICT", item)),
      blocker: "EXECUTION_CONFLICT",
    },
    {
      name: "an execution on another exchange order beside the open order",
      reasonCode: "LOOKUP_EXECUTION_MISMATCH",
      lookup: (venue, intent) => ({
        order: venue.orderForClientOrderId(clientIdOf(intent)),
        executions: [execution(venue, intent, "exec-x", HALF, { exchangeOrderId: "sim-order-9" })],
      }),
      durable: (lookup) => lookup.executions.map((item) => entry("EXECUTION_MISMATCH", item)),
      blocker: "EXECUTION_MISMATCH",
    },
    {
      name: "an execution ID another intent already owns",
      reasonCode: "EXECUTION_ID_COLLISION",
      // B3 owns the venue's first execution before B1 is placed.
      before: async (h) => {
        await placeLinked(h, owner);
        h.venue.fill(exchangeOrderIdOf(h.venue, owner), "0.005", "100");
        assert.deepEqual(await h.coordinator.replayExecutions(), {
          reasonCodes: [],
          recorded: ["sim-exec-1"],
        });
      },
      lookup: (venue, intent) => ({
        order: null,
        executions: [execution(venue, intent, "sim-exec-1", HALF)],
      }),
      durable: (lookup) => lookup.executions.map((item) => entry("EXECUTION_ID_COLLISION", item)),
      blocker: "EXECUTION_ID_COLLISION",
    },
  ];

  let number = 5;
  for (const { name, reasonCode, before, lookup, durable, blocker } of cases) {
    for (const route of ROUTES) {
      test(`G3-RC6-${number} [${route}] ${name} is kept and blocks after omission`, async () => {
        const { h, sw } = await switchable();
        const intent = quantityIntent();
        await before?.(h);
        await leaveUnresolved(route, h, intent);

        const observed = lookup(h.venue, intent);
        sw.respond = () => structuredClone(observed);
        assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
          reasonCodes: [],
          items: [item(intent, UNRESOLVED_STATUS[route], reasonCode)],
        });
        const expected = durable(observed);
        assert.deepEqual(h.registry.executionContradictions(), expected);
        assert.deepEqual(contradictionsOf(h.journal.latest()), expected);
        await omitAndAssertBlocked(route, h, sw, intent, blocker, expected);
      });
    }
    number += 1;
  }
});

describe("Gate 3 re-review RC6: an overfill is proven even when the exact total is too long", () => {
  for (const route of ROUTES) {
    test(`G3-RC6-9 [${route}] a lookup of the full quantity plus an unbounded execution is a kept overfill`, async () => {
      const { h, sw } = await switchable();
      const intent = quantityIntent();
      await leaveUnresolved(route, h, intent);
      const observed = {
        order: null,
        executions: [
          execution(h.venue, intent, "exec-a", QUANTITY),
          execution(h.venue, intent, "exec-b", UNBOUNDED),
        ],
      };
      sw.respond = () => structuredClone(observed);
      assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
        reasonCodes: [],
        items: [item(intent, UNRESOLVED_STATUS[route], "LOOKUP_OVERFILL")],
      });
      const expected = observed.executions.map((item) => entry("EXECUTION_OVERFILL", item));
      assert.deepEqual(contradictionsOf(h.journal.latest()), expected);
      await omitAndAssertBlocked(route, h, sw, intent, "EXECUTION_OVERFILL", expected);
    });
  }

  test("G3-RC6-10 a replayed page of the full quantity plus an unbounded execution is a kept overfill", async () => {
    const { h, sw } = await switchable();
    const intent = quantityIntent();
    await placeLinked(h, intent);
    const page = [
      execution(h.venue, intent, "exec-a", QUANTITY),
      execution(h.venue, intent, "exec-b", UNBOUNDED),
    ];
    sw.page = page;
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_OVERFILL", "EXECUTION_REPLAY_INCOMPLETE"],
      recorded: [],
    });
    const expected = page.map((item) => entry("EXECUTION_OVERFILL", item));
    assert.equal(recordOf(h, intent).executedQuantity, "0");
    assert.deepEqual(contradictionsOf(h.journal.latest()), expected);

    sw.page = null;
    assert.deepEqual(await h.coordinator.replayExecutions(), {
      reasonCodes: ["EXECUTION_OVERFILL"],
      recorded: [],
    });
    assert.deepEqual(h.registry.executionContradictions(), expected);
    await assertDenied(h, "EXECUTION_OVERFILL");
  });

  test("G3-RC6-11 a streamed execution above the remaining quantity is a kept overfill", async () => {
    const { h } = await switchable();
    const intent = quantityIntent();
    await placeLinked(h, intent);
    assert.deepEqual(
      await h.coordinator.ingestStreamExecution(
        streamed(execution(h.venue, intent, "exec-a", HALF), "1"),
      ),
      { reasonCodes: [], recorded: ["exec-a"] },
    );
    const deep = streamed(execution(h.venue, intent, "exec-b", DEEP_ABOVE_HALF), "2");
    assert.deepEqual(await h.coordinator.ingestStreamExecution(deep), {
      reasonCodes: ["EXECUTION_OVERFILL"],
      recorded: [],
    });
    assert.equal(recordOf(h, intent).executedQuantity, HALF);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [entry("EXECUTION_OVERFILL", deep)]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });

  test("G3-RC6-12 a cancel lookup above the remaining quantity keeps only the new execution", async () => {
    const { h, sw } = await switchable();
    const intent = quantityIntent();
    await placeLinked(h, intent);
    const first = execution(h.venue, intent, "exec-a", HALF);
    assert.deepEqual(await h.coordinator.ingestStreamExecution(streamed(first, "1")), {
      reasonCodes: [],
      recorded: ["exec-a"],
    });
    h.venue.scriptCancel("UNKNOWN_DROPPED");
    assert.equal((await h.coordinator.cancel(intent.intentId)).record?.status, "CANCEL_UNVERIFIED");

    const deep = execution(h.venue, intent, "exec-b", DEEP_ABOVE_HALF);
    sw.respond = () => structuredClone({ order: null, executions: [first, deep] });
    assert.deepEqual(await h.coordinator.reconcileUnresolved(), {
      reasonCodes: [],
      items: [item(intent, "CANCEL_UNVERIFIED", "LOOKUP_OVERFILL")],
    });
    assert.equal(recordOf(h, intent).executedQuantity, HALF);
    assert.deepEqual(contradictionsOf(h.journal.latest()), [entry("EXECUTION_OVERFILL", deep)]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
  });
});

describe("Gate 3 re-review RC6: exact lookup arithmetic is unchanged", () => {
  type Case = {
    name: string;
    second: string;
    outcome: Record<Route, { status: string; reasonCode: string }>;
    overfill: boolean;
  };

  const cases: Case[] = [
    {
      name: "just below the quantity proves nothing and keeps nothing",
      second: JUST_BELOW_HALF,
      outcome: {
        place: { status: "UNKNOWN", reasonCode: "ORDER_STATE_UNPROVEN" },
        cancel: { status: "CANCEL_UNVERIFIED", reasonCode: "ORDER_NOT_OBSERVED" },
      },
      overfill: false,
    },
    {
      name: "exactly the quantity resolves and keeps nothing",
      second: HALF,
      outcome: {
        place: { status: "LINKED", reasonCode: "RECONCILED_BY_CLIENT_ORDER_ID" },
        cancel: { status: "FILLED", reasonCode: "FILLED_BY_EXECUTION_EVIDENCE" },
      },
      overfill: false,
    },
    {
      name: "just above the quantity is a kept overfill",
      second: JUST_ABOVE_HALF,
      outcome: {
        place: { status: "UNKNOWN", reasonCode: "LOOKUP_OVERFILL" },
        cancel: { status: "CANCEL_UNVERIFIED", reasonCode: "LOOKUP_OVERFILL" },
      },
      overfill: true,
    },
    {
      name: "with a total too long to compute that proves no overfill stays transient",
      second: UNBOUNDED,
      outcome: {
        place: { status: "UNKNOWN", reasonCode: "LOOKUP_QUANTITY_UNBOUNDED" },
        cancel: { status: "CANCEL_UNVERIFIED", reasonCode: "LOOKUP_QUANTITY_UNBOUNDED" },
      },
      overfill: false,
    },
  ];

  let number = 13;
  for (const { name, second, outcome, overfill } of cases) {
    for (const route of ROUTES) {
      test(`G3-RC6-${number} [${route}] a pair ${name}`, async () => {
        const { h, sw } = await switchable();
        const intent = quantityIntent();
        await leaveUnresolved(route, h, intent);
        const observed = {
          order: null,
          executions: [
            execution(h.venue, intent, "exec-a", HALF),
            execution(h.venue, intent, "exec-b", second),
          ],
        };
        sw.respond = () => structuredClone(observed);
        const { status, reasonCode } = outcome[route];
        assert.deepEqual((await h.coordinator.reconcileUnresolved()).items, [
          item(intent, status, reasonCode),
        ]);
        assert.deepEqual(
          h.registry.executionContradictions(),
          overfill ? observed.executions.map((item) => entry("EXECUTION_OVERFILL", item)) : [],
        );
      });
    }
    number += 1;
  }
});
