import { writeFileSync } from "node:fs";

import { setPersistenceFaultHookForTests } from "../../src/persistence/atomic-pair-store.js";
import type {
  AtomicWriteHook,
  AtomicWriteTarget,
} from "../../src/persistence/atomic-pair-store.js";
import {
  LEASE_WITNESS_FILE_NAME,
  loadLeaseWitnessLog,
  setLeaseWitnessFaultHookForTests,
} from "../../src/persistence/lease-witness.js";
import type { WitnessFaultWindow } from "../../src/persistence/lease-witness.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type { LeaseAuthority } from "../../src/persistence/runtime-lease.js";
import {
  acquireRuntimeLease,
  fixedLeaseClock,
  heartbeatRuntimeLease,
  releaseRuntimeLease,
} from "../../src/persistence/runtime-lease.js";

export type WitnessCrashWindow =
  | "AFTER_PREPARE_FSYNC"
  | "AFTER_BACKUP"
  | "AFTER_PRIMARY"
  | "BEFORE_COMMIT_WITNESS"
  | "AFTER_COMMIT_WITNESS";

export type WitnessCrashCommand = {
  directory: string;
  scopeKey: string;
  nowMs: string;
  ownerId: string;
  processInstanceId: string;
  readyFilePath: string;
  mode: "crash-initialize" | "crash-heartbeat" | "crash-takeover" | "crash-release";
  window: WitnessCrashWindow;
  authority?: LeaseAuthority;
};

function installPairCrash(target: AtomicWriteTarget, readyFilePath: string): void {
  const hook: AtomicWriteHook = "AFTER_DIR_FSYNC";
  setPersistenceFaultHookForTests({
    target,
    hook,
    action: "NOTIFY_AND_WAIT",
    readyFilePath,
  });
}

function installWitnessCrash(window: WitnessFaultWindow, readyFilePath: string): void {
  setLeaseWitnessFaultHookForTests({
    window,
    action: "NOTIFY_AND_WAIT",
    readyFilePath,
  });
}

async function handleCommand(command: WitnessCrashCommand): Promise<void> {
  if (command.window === "AFTER_BACKUP") {
    installPairCrash("BACKUP", command.readyFilePath);
  } else if (command.window === "AFTER_PRIMARY") {
    installPairCrash("PRIMARY", command.readyFilePath);
  } else {
    installWitnessCrash(command.window, command.readyFilePath);
  }

  const clock = fixedLeaseClock(command.nowMs);
  const latch = new RuntimePersistenceLatch();
  if (command.mode === "crash-initialize" || command.mode === "crash-takeover") {
    await acquireRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey,
      ownerId: command.ownerId,
      processInstanceId: command.processInstanceId,
      latch,
      clock,
    });
    return;
  }
  if (command.authority === undefined) {
    throw new Error("witness crash worker requires authority for heartbeat/release");
  }
  if (command.mode === "crash-heartbeat") {
    await heartbeatRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey,
      authority: command.authority,
      latch,
      clock,
    });
    return;
  }
  await releaseRuntimeLease({
    directory: command.directory,
    scopeKey: command.scopeKey,
    authority: command.authority,
    latch,
    clock,
  });
}

export async function readWitnessSummary(directory: string): Promise<{
  fileName: string;
  ok: boolean;
  lineCount: number;
  lastStatus: string | null;
  lastOperation: string | null;
  reasonCodes: string[];
}> {
  const loaded = await loadLeaseWitnessLog(directory);
  if (!loaded.ok) {
    return {
      fileName: LEASE_WITNESS_FILE_NAME,
      ok: false,
      lineCount: 0,
      lastStatus: null,
      lastOperation: null,
      reasonCodes: loaded.reasonCodes,
    };
  }
  const last = loaded.lines.length === 0 ? null : loaded.lines[loaded.lines.length - 1];
  return {
    fileName: LEASE_WITNESS_FILE_NAME,
    ok: true,
    lineCount: loaded.lines.length,
    lastStatus: last?.status ?? null,
    lastOperation: last?.operation ?? null,
    reasonCodes: [],
  };
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2c-witness-crash-worker requires a JSON command argument\n");
  process.exit(2);
}

void handleCommand(JSON.parse(argvCommand) as WitnessCrashCommand)
  .then(() => {
    writeFileSync(
      (JSON.parse(argvCommand) as WitnessCrashCommand).readyFilePath,
      "UNEXPECTED_COMPLETION\n",
      { encoding: "utf8" },
    );
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
