import path from "node:path";

import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ClientOrderLookup,
  ExecutionCoordinator,
  type ExecutionContradiction,
  type ExecutionVenuePort,
  openDurableExecutionState,
  recoverInterruptedIntents,
  runRestartGate,
  type SubmitResult,
} from "../../src/execution/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  buildIntent,
  flatExposure,
  openFence,
  riskSource,
  runningHaltAuthority,
  SCOPE_KEY,
} from "../execution/helpers.js";
import { FileBackedVenue, PHASE3E_OBSERVED_AT } from "./phase3e-venue.js";

// One process per step, all over the same durable execution directory and venue log.
// PREPARE: leaves the quantity-1 order B1 unresolved on the route: a place whose response is
// lost after the venue stored the order (UNKNOWN), or a linked order whose cancel is lost
// before it reaches the venue (CANCEL_UNVERIFIED).
// CONTRADICT: restarts against a lookup that reports one B1 execution above the order quantity.
// OMIT: restarts against the venue's own lookup, which shows B1 open with no executions, then
// runs the continuation gate and submits the next level B2 whatever the gate said.
export type G3Rc6WorkerCommand = {
  step: "PREPARE" | "CONTRADICT" | "OMIT";
  route: "place" | "cancel";
  root: string;
};

export type G3Rc6WorkerReport = {
  open: { ok: boolean; reasonCodes: string[] };
  recovery?: { ok: boolean; reasonCodes: string[] };
  gate?: {
    allowRiskIncrease: boolean;
    reasonCodes: string[];
    reconcile: { reasonCodes: string[]; items: Array<{ status: string; reasonCodes: string[] }> };
  };
  prepared?: SubmitSummary;
  contradictions?: ExecutionContradiction[];
  continuation?: { allowRiskIncrease: boolean; reasonCodes: string[] };
  next?: SubmitSummary;
};

type SubmitSummary = { disposition: string; status: string | null; reasonCodes: string[] };

// Above the order quantity of 1 by 1e-40.
const ABOVE_TOTAL = `1.${"0".repeat(39)}1`;

function firstIntent(): OrderIntent {
  return buildIntent({ quantity: "1" });
}

function nextIntent(): OrderIntent {
  return buildIntent({ sequence: "2", logicalLevelId: "B2" });
}

function summarize(result: SubmitResult): SubmitSummary {
  return {
    disposition: result.disposition,
    status: result.record?.status ?? null,
    reasonCodes: result.reasonCodes,
  };
}

function lost(reason: string, requestFingerprint: string) {
  return { kind: "UNKNOWN" as const, reason, requestFingerprint, lastKnownMeta: null };
}

// The venue's log stays the truth for every call the step does not replace.
function portFor(command: G3Rc6WorkerCommand, venue: FileBackedVenue): ExecutionVenuePort {
  const port: ExecutionVenuePort = {
    placeOrder: (intent) => venue.placeOrder(intent),
    cancelOrder: (request) => venue.cancelOrder(request),
    lookupClientOrder: (clientOrderId) => venue.lookupClientOrder(clientOrderId),
    listOpenOrders: () => venue.listOpenOrders(),
    listExecutionsSince: (cursor) => venue.listExecutionsSince(cursor),
  };
  if (command.step === "PREPARE" && command.route === "place") {
    port.placeOrder = async (intent) => {
      const result = await venue.placeOrder(intent);
      return result.kind === "ACK" ? lost("TEST_RESPONSE_LOST", intent.intentId) : result;
    };
  }
  if (command.step === "PREPARE" && command.route === "cancel") {
    port.cancelOrder = async (request) => lost("TEST_REQUEST_LOST", request.exchangeOrderId);
  }
  if (command.step === "CONTRADICT") {
    port.lookupClientOrder = async (clientOrderId) => contradicting(venue, clientOrderId);
  }
  return port;
}

async function contradicting(
  venue: FileBackedVenue,
  clientOrderId: string,
): Promise<ClientOrderLookup> {
  const order = (await venue.openOrders()).find((item) => item.clientOrderId === clientOrderId);
  if (order === undefined) {
    throw new Error("G3_RC6_ORDER_NOT_OPEN");
  }
  const execution: ExecutionObservation = {
    venue: "sim",
    market: "BTC_USDC_PERP",
    executionId: "exec-a",
    exchangeOrderId: order.exchangeOrderId,
    clientOrderId: order.clientOrderId,
    side: "BUY",
    price: "100",
    quantity: ABOVE_TOTAL,
    feeAmount: null,
    feeAsset: null,
    liquidity: "UNKNOWN",
    meta: {
      venue: "sim",
      source: "rest",
      serverTime: PHASE3E_OBSERVED_AT,
      receivedAt: PHASE3E_OBSERVED_AT,
      observedAt: PHASE3E_OBSERVED_AT,
      freshnessMs: 0,
      sequence: null,
    },
  };
  return { order: null, executions: [execution] };
}

async function main(): Promise<void> {
  const command = JSON.parse(process.argv[2] as string) as G3Rc6WorkerCommand;
  const report: G3Rc6WorkerReport = { open: { ok: false, reasonCodes: [] } };
  const durable = await openDurableExecutionState({
    directory: path.join(command.root, "execution"),
    scopeKey: SCOPE_KEY,
    latch: new RuntimePersistenceLatch(),
  });
  report.open = { ok: durable.ok, reasonCodes: durable.ok ? [] : durable.reasonCodes };
  if (!durable.ok) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const recovery = await recoverInterruptedIntents(durable.registry, durable.journal);
  report.recovery = { ok: recovery.ok, reasonCodes: recovery.reasonCodes };
  const venue = await FileBackedVenue.open(path.join(command.root, "venue"), command.step);
  const coordinator = new ExecutionCoordinator({
    config: {
      experimentId: "exp-1",
      runId: "run-1",
      scopeKey: SCOPE_KEY,
      writeBudgetPerCycle: 100,
    },
    registry: durable.registry,
    venue: portFor(command, venue),
    fence: openFence(),
    journal: durable.journal,
    exposure: flatExposure(),
    checkpoints: durable.checkpoints,
    executionCursor: durable.executionCursor,
    riskInputs: riskSource(),
    haltAuthority: runningHaltAuthority(),
  });

  const gate = await runRestartGate(coordinator, "epoch-1");
  report.gate = {
    allowRiskIncrease: gate.allowRiskIncrease,
    reasonCodes: gate.reasonCodes,
    reconcile: {
      reasonCodes: gate.reconcile.reasonCodes,
      items: gate.reconcile.items.map((item) => ({
        status: item.status,
        reasonCodes: item.reasonCodes,
      })),
    },
  };
  if (command.step === "PREPARE") {
    const first = firstIntent();
    await coordinator.evaluateContinuation("epoch-1");
    let prepared = await coordinator.submit(first);
    if (command.route === "cancel" && prepared.record?.status === "LINKED") {
      prepared = await coordinator.cancel(first.intentId);
    }
    report.prepared = summarize(prepared);
  }
  report.contradictions = durable.registry.executionContradictions();
  if (command.step === "OMIT") {
    const continuation = await coordinator.evaluateContinuation("epoch-1");
    report.continuation = {
      allowRiskIncrease: continuation.allowRiskIncrease,
      reasonCodes: continuation.reasonCodes,
    };
    report.next = summarize(await coordinator.submit(nextIntent()));
    report.contradictions = durable.registry.executionContradictions();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
