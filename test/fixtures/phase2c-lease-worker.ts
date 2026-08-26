import { writeFileSync } from "node:fs";

import { setPersistenceFaultHookForTests } from "../../src/persistence/atomic-pair-store.js";
import { inspectExactPair } from "../../src/persistence/exact-pair-inspection.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type {
  AtomicWriteHook,
  AtomicWriteTarget,
} from "../../src/persistence/atomic-pair-store.js";
import type { LeaseAuthority } from "../../src/persistence/runtime-lease.js";
import {
  LEASE_KIND,
  LEASE_STATE_NAME,
  acquireRuntimeLease,
  fixedLeaseClock,
  heartbeatRuntimeLease,
  parseLeaseRecord,
  releaseRuntimeLease,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";

export type LeaseWorkerInspectResult = {
  pairStatus: string;
  pairAuthorityProven: boolean;
  allowRiskIncrease: false;
  fencingGeneration: string | null;
  storeGeneration: string | null;
  envelopeSha256: string | null;
  ownerId: string | null;
  processInstanceId: string | null;
  status: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  primaryStatus: string;
  backupStatus: string;
  reasonCodes: string[];
};

export type LeaseWorkerOpResult = {
  disposition: string;
  outcome?: string;
  ownerId: string | null;
  processInstanceId: string | null;
  generation: string | null;
  leaseStoreGeneration: string | null;
  leaseEnvelopeSha256: string | null;
  allowRiskIncrease: false;
  callbackCount?: number;
  reasonCodes: string[];
  latchBlocked: boolean;
  coordinationCapability: string;
  distributedFencingProven: false;
};

type BaseCommand = {
  directory: string;
  scopeKey: string;
  nowMs: string;
};

export type LeaseWorkerCommand =
  | (BaseCommand & {
      mode: "acquire";
      ownerId: string;
      processInstanceId: string;
      resultPath?: string;
      startFlagPath?: string;
      waitingPath?: string;
      coordinationMode?: string;
    })
  | (BaseCommand & {
      mode: "heartbeat" | "release";
      authority: LeaseAuthority;
      resultPath?: string;
    })
  | (BaseCommand & {
      mode: "mutate";
      authority: LeaseAuthority;
      resultPath?: string;
      throwInCallback?: boolean;
    })
  | (BaseCommand & {
      mode: "inspect";
    })
  | (BaseCommand & {
      mode: "acquire-and-hold";
      ownerId: string;
      processInstanceId: string;
      readyFilePath: string;
    })
  | (BaseCommand & {
      mode: "crash-acquire";
      ownerId: string;
      processInstanceId: string;
      crashTarget: AtomicWriteTarget;
      crashHook: AtomicWriteHook;
      readyFilePath: string;
    })
  | (BaseCommand & {
      mode: "crash-heartbeat";
      authority: LeaseAuthority;
      crashTarget: AtomicWriteTarget;
      crashHook: AtomicWriteHook;
      readyFilePath: string;
    })
  | (BaseCommand & {
      mode: "crash-takeover";
      ownerId: string;
      processInstanceId: string;
      crashTarget: AtomicWriteTarget;
      crashHook: AtomicWriteHook;
      readyFilePath: string;
    });

function writeResult(resultPath: string | undefined, result: LeaseWorkerOpResult): void {
  if (resultPath === undefined) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8" });
}

function waitForever(): Promise<never> {
  setInterval(() => {
    // Keep the event loop alive until SIGKILL.
  }, 60_000);
  return new Promise<never>(() => {
    // Parent sends SIGKILL.
  });
}

async function waitForPath(filePath: string): Promise<void> {
  const { access } = await import("node:fs/promises");
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw new Error(`start flag not observed: ${filePath}`);
}

async function handleCommand(command: LeaseWorkerCommand): Promise<void> {
  if (command.mode === "inspect") {
    const inspection = await inspectExactPair({
      directory: command.directory,
      stateName: LEASE_STATE_NAME,
      expectedKind: LEASE_KIND,
      expectedScopeKey: command.scopeKey,
    });
    let fencingGeneration: string | null = null;
    let ownerId: string | null = null;
    let processInstanceId: string | null = null;
    let status: string | null = null;
    let acquiredAt: string | null = null;
    let heartbeatAt: string | null = null;
    let expiresAt: string | null = null;
    if (inspection.primary.status === "VALID") {
      const parsed = parseLeaseRecord(inspection.primary.envelope.payload);
      if (parsed.ok) {
        fencingGeneration = parsed.record.generation;
        ownerId = parsed.record.ownerId;
        processInstanceId = parsed.record.processInstanceId;
        status = parsed.record.status;
        acquiredAt = parsed.record.acquiredAt;
        heartbeatAt = parsed.record.heartbeatAt;
        expiresAt = parsed.record.expiresAt;
      }
    }
    const result: LeaseWorkerInspectResult = {
      pairStatus: inspection.pairStatus,
      pairAuthorityProven: inspection.pairAuthorityProven,
      allowRiskIncrease: inspection.allowRiskIncrease,
      fencingGeneration: inspection.pairAuthorityProven ? fencingGeneration : null,
      storeGeneration: inspection.generation,
      envelopeSha256: inspection.envelopeSha256,
      ownerId: inspection.pairAuthorityProven ? ownerId : null,
      processInstanceId: inspection.pairAuthorityProven ? processInstanceId : null,
      status: inspection.pairAuthorityProven ? status : null,
      acquiredAt: inspection.pairAuthorityProven ? acquiredAt : null,
      heartbeatAt: inspection.pairAuthorityProven ? heartbeatAt : null,
      expiresAt: inspection.pairAuthorityProven ? expiresAt : null,
      primaryStatus: inspection.primary.status,
      backupStatus: inspection.backup.status,
      reasonCodes: inspection.reasonCodes,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const clock = fixedLeaseClock(command.nowMs);
  const latch = new RuntimePersistenceLatch();

  if (
    command.mode === "acquire" ||
    command.mode === "crash-acquire" ||
    command.mode === "crash-takeover"
  ) {
    if (command.mode === "acquire" && command.waitingPath !== undefined) {
      writeFileSync(command.waitingPath, "waiting\n", { encoding: "utf8" });
    }
    if (command.mode === "acquire" && command.startFlagPath !== undefined) {
      await waitForPath(command.startFlagPath);
    }
    if (command.mode === "crash-acquire" || command.mode === "crash-takeover") {
      setPersistenceFaultHookForTests({
        target: command.crashTarget,
        hook: command.crashHook,
        action: "NOTIFY_AND_WAIT",
        readyFilePath: command.readyFilePath,
      });
    }
    const result = await acquireRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey,
      ownerId: command.ownerId,
      processInstanceId: command.processInstanceId,
      latch,
      clock,
      ...(command.mode === "acquire" && command.coordinationMode !== undefined
        ? { coordinationMode: command.coordinationMode }
        : {}),
    });
    writeResult(command.mode === "acquire" ? command.resultPath : undefined, {
      disposition: result.disposition,
      ownerId: result.authority?.ownerId ?? null,
      processInstanceId: result.authority?.processInstanceId ?? null,
      generation: result.authority?.generation ?? null,
      leaseStoreGeneration: result.authority?.leaseStoreGeneration ?? null,
      leaseEnvelopeSha256: result.authority?.leaseEnvelopeSha256 ?? null,
      allowRiskIncrease: result.allowRiskIncrease,
      reasonCodes: result.reasonCodes,
      latchBlocked: result.latchState.blocked,
      coordinationCapability: result.coordinationCapability,
      distributedFencingProven: result.distributedFencingProven,
    });
    return;
  }

  if (command.mode === "acquire-and-hold") {
    const result = await acquireRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey,
      ownerId: command.ownerId,
      processInstanceId: command.processInstanceId,
      latch,
      clock,
    });
    writeFileSync(
      command.readyFilePath,
      `${JSON.stringify({
        disposition: result.disposition,
        generation: result.authority?.generation ?? null,
        allowRiskIncrease: result.allowRiskIncrease,
      })}\n`,
      { encoding: "utf8" },
    );
    if (result.disposition !== "ACQUIRED") {
      process.exit(3);
    }
    await waitForever();
    return;
  }

  if (command.mode === "heartbeat" || command.mode === "crash-heartbeat") {
    if (command.mode === "crash-heartbeat") {
      setPersistenceFaultHookForTests({
        target: command.crashTarget,
        hook: command.crashHook,
        action: "NOTIFY_AND_WAIT",
        readyFilePath: command.readyFilePath,
      });
    }
    const result = await heartbeatRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey,
      authority: command.authority,
      latch,
      clock,
    });
    writeResult(command.mode === "heartbeat" ? command.resultPath : undefined, {
      disposition: result.disposition,
      ownerId: result.authority?.ownerId ?? null,
      processInstanceId: result.authority?.processInstanceId ?? null,
      generation: result.authority?.generation ?? null,
      leaseStoreGeneration: result.authority?.leaseStoreGeneration ?? null,
      leaseEnvelopeSha256: result.authority?.leaseEnvelopeSha256 ?? null,
      allowRiskIncrease: result.allowRiskIncrease,
      reasonCodes: result.reasonCodes,
      latchBlocked: result.latchState.blocked,
      coordinationCapability: result.coordinationCapability,
      distributedFencingProven: result.distributedFencingProven,
    });
    return;
  }

  if (command.mode === "release") {
    const result = await releaseRuntimeLease({
      directory: command.directory,
      scopeKey: command.scopeKey,
      authority: command.authority,
      latch,
      clock,
    });
    writeResult(command.resultPath, {
      disposition: result.disposition,
      ownerId: result.authority?.ownerId ?? null,
      processInstanceId: result.authority?.processInstanceId ?? null,
      generation: result.authority?.generation ?? null,
      leaseStoreGeneration: result.authority?.leaseStoreGeneration ?? null,
      leaseEnvelopeSha256: result.authority?.leaseEnvelopeSha256 ?? null,
      allowRiskIncrease: result.allowRiskIncrease,
      reasonCodes: result.reasonCodes,
      latchBlocked: result.latchState.blocked,
      coordinationCapability: result.coordinationCapability,
      distributedFencingProven: result.distributedFencingProven,
    });
    return;
  }

  if (command.mode === "mutate") {
    const result = await runLeaseFencedMutation({
      directory: command.directory,
      scopeKey: command.scopeKey,
      authority: command.authority,
      latch,
      clock,
      mutation: () => {
        if (command.throwInCallback === true) {
          throw new Error("callback-throw");
        }
        return "mutated";
      },
    });
    writeResult(command.resultPath, {
      disposition: result.outcome,
      outcome: result.outcome,
      ownerId: command.authority.ownerId,
      processInstanceId: command.authority.processInstanceId,
      generation: command.authority.generation,
      leaseStoreGeneration: command.authority.leaseStoreGeneration,
      leaseEnvelopeSha256: command.authority.leaseEnvelopeSha256,
      allowRiskIncrease: result.allowRiskIncrease,
      callbackCount: result.callbackCount,
      reasonCodes: result.reasonCodes,
      latchBlocked: result.latchState.blocked,
      coordinationCapability: result.coordinationCapability,
      distributedFencingProven: result.distributedFencingProven,
    });
  }
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2c-lease-worker requires a JSON command argument\n");
  process.exit(2);
}

void handleCommand(JSON.parse(argvCommand) as LeaseWorkerCommand)
  .then(() => {
    const parsed = JSON.parse(argvCommand) as LeaseWorkerCommand;
    if (
      parsed.mode === "inspect" ||
      parsed.mode === "acquire" ||
      parsed.mode === "heartbeat" ||
      parsed.mode === "release" ||
      parsed.mode === "mutate"
    ) {
      process.exit(0);
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
