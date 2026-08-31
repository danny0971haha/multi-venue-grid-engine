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
import { parseHaltRecord } from "../../src/halt/record.js";
import { HALT_KIND, HALT_STATE_NAME } from "../../src/halt/types.js";

export type Phase2ECrashInspectResult = {
  pairStatus: string;
  pairAuthorityProven: boolean;
  allowRiskIncrease: false;
  generation: string | null;
  envelopeSha256: string | null;
  exactBytesEqual: boolean;
  primaryStatus: string;
  backupStatus: string;
  reasonCodes: string[];
  haltStatus: string | null;
  haltId: string | null;
  acknowledgedHaltId: string | null;
  resultingStatus: string | null;
  snapshotSourceId: string | null;
  snapshotObservedAt: string | null;
  snapshotLeaseGeneration: string | null;
};

export type Phase2ECrashTransitionCommand = {
  mode: "transition";
  directory: string;
  expectedScopeKey: string;
  expectedGeneration: string;
  expectedPredecessorEnvelopeSha256: string;
  payload: unknown;
  crashTarget: AtomicWriteTarget;
  crashHook: AtomicWriteHook;
  readyFilePath: string;
};

export type Phase2ECrashInspectCommand = {
  mode: "inspect";
  directory: string;
  expectedScopeKey: string;
};

export type Phase2ECrashCommand = Phase2ECrashTransitionCommand | Phase2ECrashInspectCommand;

async function handleCommand(command: Phase2ECrashCommand): Promise<void> {
  if (command.mode === "inspect") {
    const inspection = await inspectExactPair({
      directory: command.directory,
      stateName: HALT_STATE_NAME,
      expectedKind: HALT_KIND,
      expectedScopeKey: command.expectedScopeKey,
    });
    let haltStatus: string | null = null;
    let haltId: string | null = null;
    let acknowledgedHaltId: string | null = null;
    let resultingStatus: string | null = null;
    let snapshotSourceId: string | null = null;
    let snapshotObservedAt: string | null = null;
    let snapshotLeaseGeneration: string | null = null;
    if (inspection.primary.status === "VALID") {
      const parsed = parseHaltRecord(inspection.primary.envelope.payload);
      if (parsed.ok) {
        haltStatus = parsed.record.status;
        haltId = parsed.record.haltId;
        acknowledgedHaltId = parsed.record.acknowledgement?.acknowledgedHaltId ?? null;
        resultingStatus = parsed.record.acknowledgement?.resultingStatus ?? null;
        snapshotSourceId = parsed.record.acknowledgement?.snapshotSourceId ?? null;
        snapshotObservedAt = parsed.record.acknowledgement?.snapshotObservedAt ?? null;
        snapshotLeaseGeneration = parsed.record.acknowledgement?.snapshotLeaseGeneration ?? null;
      }
    }
    const result: Phase2ECrashInspectResult = {
      pairStatus: inspection.pairStatus,
      pairAuthorityProven: inspection.pairAuthorityProven,
      allowRiskIncrease: inspection.allowRiskIncrease,
      generation: inspection.generation,
      envelopeSha256: inspection.envelopeSha256,
      exactBytesEqual: inspection.exactBytesEqual,
      primaryStatus: inspection.primary.status,
      backupStatus: inspection.backup.status,
      reasonCodes: inspection.reasonCodes,
      haltStatus,
      haltId,
      acknowledgedHaltId,
      resultingStatus,
      snapshotSourceId,
      snapshotObservedAt,
      snapshotLeaseGeneration,
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
    stateName: HALT_STATE_NAME,
    expectedKind: HALT_KIND,
    expectedScopeKey: command.expectedScopeKey,
    expectedGeneration: command.expectedGeneration,
    expectedPredecessorEnvelopeSha256: command.expectedPredecessorEnvelopeSha256,
    payload: command.payload,
    latch,
  });
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2e-crash-worker requires a JSON command argument\n");
  process.exit(2);
}

void handleCommand(JSON.parse(argvCommand) as Phase2ECrashCommand)
  .then(() => {
    const parsed = JSON.parse(argvCommand) as Phase2ECrashCommand;
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
