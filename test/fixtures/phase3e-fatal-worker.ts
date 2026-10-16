import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createLeaseMutationFence,
  ExecutionCoordinator,
  type IntentRegistry,
  installFatalProcessGuard,
  openDurableExecutionState,
  recoverInterruptedIntents,
  runRestartGate,
  type SubmitResult,
} from "../../src/execution/index.js";
import {
  acquireRuntimeLease,
  createProcessInstanceId,
  fixedLeaseClock,
  setLeasePreCallbackHookForTests,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  buildIntent,
  flatExposure,
  grant,
  riskSource,
  runningHaltAuthority,
  SCOPE_KEY,
} from "../execution/helpers.js";
import { appendEvent, FileBackedVenue } from "./phase3e-venue.js";

// FATAL_LOOP: submits one order per idle tick, then injects a fatal fault while idle.
// PRE_TRANSPORT_KILL: hangs after the PREPARED intent is durable, before the venue call.
// IN_TRANSPORT_KILL: hangs after the venue accepted the order, before the response returns.
// RESTART: recovers, runs the restart gate and the continuation gate, and reports what it saw
// on stdout.
// DOUBLE_INSTALL: installs the fatal guard twice and reports the second outcome.
export type Phase3EWorkerCommand = {
  mode: "FATAL_LOOP" | "PRE_TRANSPORT_KILL" | "IN_TRANSPORT_KILL" | "RESTART" | "DOUBLE_INSTALL";
  root: string;
  label: string;
  clockMs: string;
  guard: "FATAL_GUARD" | "LOG_AND_IGNORE";
  fault: "THROW" | "REJECT";
  faultTick: number;
  readyPath: string | null;
  sequenceBase: number;
};

export type Phase3ERestartReport = {
  lease: { disposition: string; reasonCodes: string[]; generation: string | null };
  open?: { ok: boolean; reasonCodes: string[] };
  statusesBefore?: Record<string, string>;
  recovery?: { ok: boolean; reasonCodes: string[]; items: Array<{ from: string; to: string }> };
  statusesAfterRecovery?: Record<string, string>;
  unknownReservationsBeforeGate?: number;
  preGateSubmit?: SubmitSummary;
  gate?: { allowRiskIncrease: boolean; reasonCodes: string[]; recordedExecutions: string[] };
  continuation?: { action: string; allowRiskIncrease: boolean; reasonCodes: string[] };
  postGateSubmit?: SubmitSummary;
  finalStatuses?: Record<string, string>;
  latchBlocked?: boolean;
};

type SubmitSummary = { disposition: string; status: string | null; reasonCodes: string[] };

const TICK_MS = 15;
const TICKS_AFTER_FAULT = 6;

function statuses(registry: IntentRegistry): Record<string, string> {
  return Object.fromEntries(
    registry.list().map((record) => [record.intent.logicalLevelId, record.status]),
  );
}

function summarize(result: SubmitResult): SubmitSummary {
  return {
    disposition: result.disposition,
    status: result.record?.status ?? null,
    reasonCodes: result.reasonCodes,
  };
}

function hangForever(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function run(command: Phase3EWorkerCommand): Promise<void> {
  const venueDirectory = path.join(command.root, "venue");
  const latch = new RuntimePersistenceLatch();
  if (command.mode === "DOUBLE_INSTALL") {
    installFatalProcessGuard(latch);
    try {
      installFatalProcessGuard(new RuntimePersistenceLatch());
      process.stdout.write(`${JSON.stringify({ second: "INSTALLED" })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ second: (error as Error).message })}\n`);
    }
    return;
  }
  process.on("exit", (code) => {
    appendEvent(venueDirectory, {
      label: command.label,
      type: "EXIT",
      code,
      latchBlocked: latch.blocked,
      latchReasonCodes: [...latch.reasonCodes],
    });
  });
  if (command.guard === "FATAL_GUARD") {
    installFatalProcessGuard(latch);
  } else {
    // Negative control: the anti-pattern the guard exists to prevent.
    process.on("uncaughtException", () => {
      appendEvent(venueDirectory, { label: command.label, type: "IGNORED" });
    });
    process.on("unhandledRejection", () => {
      appendEvent(venueDirectory, { label: command.label, type: "IGNORED" });
    });
  }

  const clock = fixedLeaseClock(BigInt(command.clockMs));
  const leaseDirectory = path.join(command.root, "lease");
  const executionDirectory = path.join(command.root, "execution");
  mkdirSync(leaseDirectory, { recursive: true });
  mkdirSync(executionDirectory, { recursive: true });
  const acquired = await acquireRuntimeLease({
    directory: leaseDirectory,
    scopeKey: SCOPE_KEY,
    ownerId: `owner-${command.label}`,
    processInstanceId: createProcessInstanceId(),
    latch,
    clock,
  });
  const report: Phase3ERestartReport = {
    lease: {
      disposition: acquired.disposition,
      reasonCodes: acquired.reasonCodes,
      generation: acquired.authority?.generation ?? null,
    },
  };
  const authority = acquired.authority;
  if (acquired.disposition !== "ACQUIRED" || authority === null) {
    // Without the lease this process touches neither the journal nor the venue.
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const durable = await openDurableExecutionState({
    directory: executionDirectory,
    scopeKey: SCOPE_KEY,
    latch,
  });
  report.open = { ok: durable.ok, reasonCodes: durable.ok ? [] : durable.reasonCodes };
  if (!durable.ok) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  report.statusesBefore = statuses(durable.registry);
  const recovery = await recoverInterruptedIntents(durable.registry, durable.journal);
  report.recovery = {
    ok: recovery.ok,
    reasonCodes: recovery.reasonCodes,
    items: recovery.items.map((item) => ({ from: item.from, to: item.to })),
  };
  report.statusesAfterRecovery = statuses(durable.registry);
  if (!recovery.ok) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const venue = await FileBackedVenue.open(venueDirectory, command.label, {
    hangAfterAcceptPath: command.mode === "IN_TRANSPORT_KILL" ? command.readyPath : null,
  });
  const coordinator = new ExecutionCoordinator({
    config: {
      experimentId: "exp-1",
      runId: "run-1",
      scopeKey: SCOPE_KEY,
      writeBudgetPerCycle: 100,
    },
    registry: durable.registry,
    venue,
    fence: createLeaseMutationFence({
      directory: leaseDirectory,
      scopeKey: SCOPE_KEY,
      authority,
      latch,
      clock,
    }),
    journal: durable.journal,
    exposure: flatExposure(),
    checkpoints: durable.checkpoints,
    executionCursor: durable.executionCursor,
    riskInputs: riskSource(),
    haltAuthority: runningHaltAuthority(),
  });
  const intentFor = (n: number, prefix: string) =>
    buildIntent({
      sequence: String(command.sequenceBase + n),
      logicalLevelId: `${prefix}${n}`,
      leaseGeneration: authority.generation,
    });

  if (command.mode === "RESTART") {
    report.unknownReservationsBeforeGate =
      coordinator.exposureReservation().unknownReservations.length;
    report.preGateSubmit = summarize(await coordinator.submit(intentFor(1, "R")));
    const gate = await runRestartGate(coordinator, "epoch-1");
    report.gate = {
      allowRiskIncrease: gate.allowRiskIncrease,
      reasonCodes: gate.reasonCodes,
      recordedExecutions: gate.replay.recorded,
    };
    const continuation = await coordinator.evaluateContinuation("epoch-1");
    report.continuation = {
      action: continuation.action,
      allowRiskIncrease: continuation.allowRiskIncrease,
      reasonCodes: continuation.reasonCodes,
    };
    // Attempted regardless of both gates, so a refusal is observed rather than assumed.
    report.postGateSubmit = summarize(await coordinator.submit(intentFor(2, "R")));
    report.finalStatuses = statuses(durable.registry);
    report.latchBlocked = latch.blocked;
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const gate = await runRestartGate(coordinator, "epoch-1");
  if (!gate.allowRiskIncrease) {
    throw new Error("PHASE3E_WORKER_GATE_BLOCKED");
  }
  if (command.mode === "PRE_TRANSPORT_KILL") {
    await grant(coordinator);
    setLeasePreCallbackHookForTests(() => {
      writeFileSync(command.readyPath as string, "prepared\n");
      hangForever();
    });
    await coordinator.submit(intentFor(1, "B"));
    return;
  }
  if (command.mode === "IN_TRANSPORT_KILL") {
    await grant(coordinator);
    await coordinator.submit(intentFor(1, "B"));
    return;
  }

  let tick = 0;
  let placed = 0;
  let inFlight = false;
  let faultedAt: number | null = null;
  const submitNext = async () => {
    inFlight = true;
    placed += 1;
    // A denied gate leaves the submit to be refused and recorded like any other outcome.
    await coordinator.evaluateContinuation("epoch-1");
    const result = await coordinator.submit(intentFor(placed, "B"));
    appendEvent(venueDirectory, {
      label: command.label,
      type: "SUBMIT",
      level: `B${placed}`,
      ...summarize(result),
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
      appendEvent(venueDirectory, { label: command.label, type: "FAULT_INJECTED" });
      // Trading that would continue after the fault if nothing stopped the process.
      setImmediate(() => {
        void submitNext();
      });
      if (command.fault === "THROW") {
        throw new Error("PHASE3E_INJECTED_FAULT");
      }
      void Promise.reject(new Error("PHASE3E_INJECTED_FAULT"));
      return;
    }
    if (faultedAt !== null) {
      if (tick - faultedAt >= TICKS_AFTER_FAULT) {
        clearInterval(timer);
        process.exit(0);
      }
      return;
    }
    void submitNext();
  }, TICK_MS);
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase3e-fatal-worker requires a JSON command argument\n");
  process.exit(2);
}
const parsed = JSON.parse(argvCommand) as Phase3EWorkerCommand;
void run(parsed).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
