import { writeFileSync } from "node:fs";

import type { CoordinationFaultWindow } from "../../src/persistence/lease-coordination.js";
import {
  acquireHostLocalCoordinationGuard,
  setCoordinationFaultHookForTests,
} from "../../src/persistence/lease-coordination.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { acquireRuntimeLease, fixedLeaseClock } from "../../src/persistence/runtime-lease.js";

export type CoordinationWorkerResult = {
  ok: boolean;
  callbackCount: number;
  allowRiskIncrease: false;
  reasonCodes: string[];
  disposition: string | null;
  coordinationCapability: string | null;
  distributedFencingProven: false;
};

export type CoordinationWorkerCommand = {
  directory: string;
  mode: "acquire-guard" | "acquire-lease";
  resultPath?: string;
  readyFilePath?: string;
  resumeFilePath?: string;
  window?: CoordinationFaultWindow;
  action?: "NOTIFY_AND_WAIT" | "NOTIFY_AND_WAIT_RESUME";
  holdGuard?: boolean;
  deadlineMs?: number;
  scopeKey?: string;
  ownerId?: string;
  processInstanceId?: string;
  nowMs?: string;
};

function writeResult(resultPath: string | undefined, result: CoordinationWorkerResult): void {
  const payload = `${JSON.stringify(result)}\n`;
  if (resultPath === undefined) {
    process.stdout.write(payload);
    return;
  }
  writeFileSync(resultPath, payload, { encoding: "utf8" });
}

function waitForever(): Promise<never> {
  setInterval(() => {
    // Keep the event loop alive until SIGKILL or parent teardown.
  }, 60_000);
  return new Promise<never>(() => {
    // Parent sends SIGKILL or writes a resume path elsewhere.
  });
}

async function handleCommand(command: CoordinationWorkerCommand): Promise<void> {
  if (command.window !== undefined && command.readyFilePath !== undefined) {
    setCoordinationFaultHookForTests({
      window: command.window,
      action: command.action ?? "NOTIFY_AND_WAIT",
      readyFilePath: command.readyFilePath,
      ...(command.resumeFilePath === undefined ? {} : { resumeFilePath: command.resumeFilePath }),
    });
  }

  if (command.mode === "acquire-lease") {
    const latch = new RuntimePersistenceLatch();
    const result = await acquireRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey ?? "canary-01/sim/BTC_USDC_PERP/grid-v0.1",
      ownerId: command.ownerId ?? "ownerZ",
      processInstanceId: command.processInstanceId ?? "procZ",
      latch,
      clock: fixedLeaseClock(command.nowMs ?? "1000000"),
    });
    writeResult(command.resultPath, {
      ok: result.disposition === "ACQUIRED",
      callbackCount: result.disposition === "ACQUIRED" ? 1 : 0,
      allowRiskIncrease: result.allowRiskIncrease,
      reasonCodes: result.reasonCodes,
      disposition: result.disposition,
      coordinationCapability: result.coordinationCapability,
      distributedFencingProven: result.distributedFencingProven,
    });
    return;
  }

  const acquired = await acquireHostLocalCoordinationGuard(command.directory, command.deadlineMs);
  if (!acquired.ok) {
    writeResult(command.resultPath, {
      ok: false,
      callbackCount: 0,
      allowRiskIncrease: false,
      reasonCodes: acquired.reasonCodes,
      disposition: null,
      coordinationCapability: null,
      distributedFencingProven: false,
    });
    return;
  }

  writeResult(command.resultPath, {
    ok: true,
    callbackCount: 1,
    allowRiskIncrease: false,
    reasonCodes: [],
    disposition: null,
    coordinationCapability: acquired.guard.capability,
    distributedFencingProven: false,
  });
  if (command.holdGuard === true) {
    await waitForever();
  }
  await acquired.guard.release();
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2c-coordination-crash-worker requires a JSON command argument\n");
  process.exit(2);
}

void handleCommand(JSON.parse(argvCommand) as CoordinationWorkerCommand)
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
