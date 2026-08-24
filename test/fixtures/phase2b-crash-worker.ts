import { inspectExactPair } from "../../src/persistence/exact-pair-inspection.js";
import {
  persistExactPairTransition,
  setPersistenceFaultHookForTests,
} from "../../src/persistence/atomic-pair-store.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type {
  AtomicWriteHook,
  AtomicWriteTarget,
} from "../../src/persistence/atomic-pair-store.js";

export type CrashWorkerInspectResult = {
  pairStatus: string;
  pairAuthorityProven: boolean;
  allowRiskIncrease: false;
  generation: string | null;
  envelopeSha256: string | null;
  exactBytesEqual: boolean;
  primaryStatus: string;
  backupStatus: string;
  reasonCodes: string[];
};

export type CrashWorkerTransitionCommand = {
  mode: "transition";
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
  expectedGeneration: string;
  expectedPredecessorEnvelopeSha256: string;
  payload: unknown;
  crashTarget: AtomicWriteTarget;
  crashHook: AtomicWriteHook;
  readyFilePath: string;
};

export type CrashWorkerInspectCommand = {
  mode: "inspect";
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
};

export type CrashWorkerCommand = CrashWorkerTransitionCommand | CrashWorkerInspectCommand;

async function handleCommand(command: CrashWorkerCommand): Promise<void> {
  if (command.mode === "inspect") {
    const inspection = await inspectExactPair({
      directory: command.directory,
      stateName: command.stateName,
      expectedKind: command.expectedKind,
      expectedScopeKey: command.expectedScopeKey,
    });
    const result: CrashWorkerInspectResult = {
      pairStatus: inspection.pairStatus,
      pairAuthorityProven: inspection.pairAuthorityProven,
      allowRiskIncrease: inspection.allowRiskIncrease,
      generation: inspection.generation,
      envelopeSha256: inspection.envelopeSha256,
      exactBytesEqual: inspection.exactBytesEqual,
      primaryStatus: inspection.primary.status,
      backupStatus: inspection.backup.status,
      reasonCodes: inspection.reasonCodes,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  setPersistenceFaultHookForTests({
    target: command.crashTarget,
    hook: command.crashHook,
    action: "NOTIFY_AND_WAIT",
    readyFilePath: command.readyFilePath,
  });
  const latch = new RuntimePersistenceLatch();
  await persistExactPairTransition({
    directory: command.directory,
    stateName: command.stateName,
    expectedKind: command.expectedKind,
    expectedScopeKey: command.expectedScopeKey,
    expectedGeneration: command.expectedGeneration,
    expectedPredecessorEnvelopeSha256: command.expectedPredecessorEnvelopeSha256,
    payload: command.payload,
    latch,
  });
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2b-crash-worker requires a JSON command argument\n");
  process.exit(2);
}

void handleCommand(JSON.parse(argvCommand) as CrashWorkerCommand)
  .then(() => {
    const parsed = JSON.parse(argvCommand) as CrashWorkerCommand;
    if (parsed.mode === "inspect") {
      process.exit(0);
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
