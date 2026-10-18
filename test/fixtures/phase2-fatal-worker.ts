import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { installFatalProcessGuard } from "../../src/execution/index.js";
import {
  applyRiskDecision,
  createScriptedHaltTransport,
  createSequentialHaltIdSource,
  DEFAULT_SNAPSHOT_SOURCE_ID,
  fixedHaltClock,
  HaltProcessFence,
  type HaltRuntimeContext,
  initializeDurableHalt,
  loadHaltAuthority,
} from "../../src/halt/index.js";
import {
  acquireRuntimeLease,
  createProcessInstanceId,
  fixedLeaseClock,
  type LeaseAuthority,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type { RiskInput } from "../../src/risk/index.js";
import { baselineRiskInput, EXPERIMENT_ID, SCOPE_KEY, snapshot } from "../halt/helpers.js";

// FATAL_LOOP: a stand-in strategy loop. On every idle tick it asks the halt engine for a risk
// decision and, only when that decision allows risk increase, places one spy order through
// the lease fence. It then injects a fatal fault while idle.
// RESTART: a fresh process that takes the lease, reads the durable halt pair, asks for a risk
// decision on input observed at its own clock and places one spy order only if the decision
// allows it. It reports what it saw on stdout.
export type Phase2WorkerCommand = {
  mode: "FATAL_LOOP" | "RESTART";
  root: string;
  label: string;
  clockMs: string;
  guard: "FATAL_GUARD" | "LOG_AND_IGNORE";
  fault: "THROW" | "REJECT";
  faultTick: number;
  risk: "CLEAN" | "DAILY_LOSS";
};

export type Phase2WorkerEvent = { label: string; type: string; [field: string]: unknown };

export type Phase2RestartReport = {
  lease: { disposition: string; reasonCodes: string[]; generation: string | null };
  pair?: { ok: boolean; status: string | null; generation: string | null };
  risk?: {
    durableStatus: string;
    runtimeDisposition: string;
    systemAllowRiskIncrease: boolean;
    reasonCodes: string[];
  };
  // null when the risk decision did not allow a place to be attempted.
  place?: { outcome: string; callbackCount: number; reasonCodes: string[] } | null;
};

const EVENTS_FILE = "events.jsonl";

const TICK_MS = 15;
const TICKS_AFTER_FAULT = 6;

function appendEvent(root: string, event: Phase2WorkerEvent): void {
  appendFileSync(path.join(root, EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

function riskInputAt(kind: Phase2WorkerCommand["risk"], clockMs: string): RiskInput {
  const freshness = {
    evaluatedAt: clockMs,
    maxStaleMs: "1000",
    positionObservedAt: clockMs,
    equityObservedAt: clockMs,
    markObservedAt: clockMs,
    pnlObservedAt: clockMs,
  };
  if (kind === "DAILY_LOSS") {
    return baselineRiskInput({ realizedTradingPnl: "-5", freshness });
  }
  return baselineRiskInput({ freshness });
}

function haltContext(args: {
  directory: string;
  label: string;
  clockMs: string;
  latch: RuntimePersistenceLatch;
  processFence: HaltProcessFence;
  authority: LeaseAuthority;
}): HaltRuntimeContext {
  const nowMs = BigInt(args.clockMs);
  return {
    directory: args.directory,
    scopeKey: SCOPE_KEY,
    experimentId: EXPERIMENT_ID,
    latch: args.latch,
    leaseAuthority: args.authority,
    leaseClock: fixedLeaseClock(nowMs),
    haltClock: fixedHaltClock(new Date(Number(nowMs)).toISOString()),
    haltIdSource: createSequentialHaltIdSource(args.label),
    processFence: args.processFence,
    expectedSnapshotSourceId: DEFAULT_SNAPSHOT_SOURCE_ID,
    transport: createScriptedHaltTransport({
      orders: [],
      snapshots: [
        snapshot({ leaseGeneration: args.authority.generation, observedAt: args.clockMs }),
      ],
    }),
  };
}

// The fake mutation: it only records that a place reached the venue boundary.
function placeSpyOrder(root: string, label: string, context: HaltRuntimeContext) {
  return runLeaseFencedMutation({
    directory: context.directory,
    scopeKey: context.scopeKey,
    authority: context.leaseAuthority,
    latch: context.latch,
    clock: context.leaseClock,
    mutation: () => {
      appendEvent(root, {
        label,
        type: "PLACE",
        leaseGeneration: context.leaseAuthority.generation,
      });
      return "ACK";
    },
  });
}

async function run(command: Phase2WorkerCommand): Promise<void> {
  const { root, label } = command;
  const directory = path.join(root, "state");
  mkdirSync(directory, { recursive: true });
  const latch = new RuntimePersistenceLatch();
  const processFence = new HaltProcessFence();

  if (command.mode === "RESTART") {
    installFatalProcessGuard(latch, processFence);
    const acquired = await acquireRuntimeLease({
      directory,
      scopeKey: SCOPE_KEY,
      ownerId: `owner-${label}`,
      processInstanceId: createProcessInstanceId(),
      latch,
      clock: fixedLeaseClock(BigInt(command.clockMs)),
    });
    const report: Phase2RestartReport = {
      lease: {
        disposition: acquired.disposition,
        reasonCodes: acquired.reasonCodes,
        generation: acquired.authority?.generation ?? null,
      },
    };
    appendEvent(root, { label, type: "LEASE", ...report.lease });
    if (acquired.disposition !== "ACQUIRED" || acquired.authority === null) {
      // Without the lease this process reads no halt state and sends nothing.
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }

    const loaded = await loadHaltAuthority({ directory, scopeKey: SCOPE_KEY });
    report.pair = loaded.ok
      ? { ok: true, status: loaded.record.status, generation: loaded.generation }
      : { ok: false, status: null, generation: null };
    appendEvent(root, { label, type: "PAIR", ...report.pair });

    // The decision is asked for even when the pair is unproven, so its refusal is observed.
    const context = haltContext({
      directory,
      label,
      clockMs: command.clockMs,
      latch,
      processFence,
      authority: acquired.authority,
    });
    const decision = await applyRiskDecision(context, riskInputAt(command.risk, command.clockMs));
    report.risk = {
      durableStatus: decision.durableStatus,
      runtimeDisposition: decision.runtimeDisposition,
      systemAllowRiskIncrease: decision.systemAllowRiskIncrease,
      reasonCodes: decision.reasonCodes,
    };
    appendEvent(root, { label, type: "RISK", ...report.risk });

    report.place = null;
    if (decision.systemAllowRiskIncrease) {
      const sent = await placeSpyOrder(root, label, context);
      report.place = {
        outcome: sent.outcome,
        callbackCount: sent.callbackCount,
        reasonCodes: sent.reasonCodes,
      };
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  process.on("exit", (code) => {
    appendEvent(root, {
      label,
      type: "EXIT",
      code,
      latchBlocked: latch.blocked,
      latchReasonCodes: [...latch.reasonCodes],
      processFenceTripped: processFence.tripped,
    });
  });
  if (command.guard === "FATAL_GUARD") {
    installFatalProcessGuard(latch, processFence);
  } else {
    // Negative control: the anti-pattern the guard exists to prevent.
    process.on("uncaughtException", () => {
      appendEvent(root, { label, type: "IGNORED" });
    });
    process.on("unhandledRejection", () => {
      appendEvent(root, { label, type: "IGNORED" });
    });
  }

  const acquired = await acquireRuntimeLease({
    directory,
    scopeKey: SCOPE_KEY,
    ownerId: `owner-${label}`,
    processInstanceId: createProcessInstanceId(),
    latch,
    clock: fixedLeaseClock(BigInt(command.clockMs)),
  });
  if (acquired.authority === null) {
    throw new Error("PHASE2_WORKER_LEASE_BLOCKED");
  }
  const context = haltContext({
    directory,
    label,
    clockMs: command.clockMs,
    latch,
    processFence,
    authority: acquired.authority,
  });
  const initialized = await initializeDurableHalt(context, {
    startingEquityUsd: "100",
    highWaterEquityUsd: "100",
  });
  if (initialized.durableStatus !== "RUNNING") {
    throw new Error("PHASE2_WORKER_HALT_INIT_FAILED");
  }

  let tick = 0;
  let inFlight = false;
  let faultedAt: number | null = null;
  const placeNext = async () => {
    inFlight = true;
    const decision = await applyRiskDecision(context, riskInputAt("CLEAN", command.clockMs));
    let outcome = "NOT_ATTEMPTED";
    if (decision.systemAllowRiskIncrease) {
      outcome = (await placeSpyOrder(root, label, context)).outcome;
    }
    appendEvent(root, {
      label,
      type: "ATTEMPT",
      systemAllowRiskIncrease: decision.systemAllowRiskIncrease,
      outcome,
    });
    inFlight = false;
  };
  const timer = setInterval(() => {
    tick += 1;
    if (inFlight) {
      return;
    }
    if (faultedAt === null && tick >= command.faultTick) {
      faultedAt = tick;
      appendEvent(root, { label, type: "FAULT_INJECTED" });
      // Trading that would continue after the fault if nothing stopped the process.
      setImmediate(() => {
        void placeNext();
      });
      if (command.fault === "THROW") {
        throw new Error("PHASE2_INJECTED_FAULT");
      }
      void Promise.reject(new Error("PHASE2_INJECTED_FAULT"));
      return;
    }
    if (faultedAt !== null) {
      if (tick - faultedAt >= TICKS_AFTER_FAULT) {
        clearInterval(timer);
        process.exit(0);
      }
      return;
    }
    void placeNext();
  }, TICK_MS);
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2-fatal-worker requires a JSON command argument\n");
  process.exit(2);
}
const parsed = JSON.parse(argvCommand) as Phase2WorkerCommand;
void run(parsed).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
