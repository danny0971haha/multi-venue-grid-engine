import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";

import type { CoordinationPathIdentity } from "./coordination-claim.js";
import {
  COORDINATION_IN_PROGRESS_GRACE_MS,
  confirmPathIdentity,
  formatCoordinationClaim,
  probeCoordinationPath,
  readPathInode,
  unlinkIfMatchingIdentity,
  unlinkIfSameInode,
  unlinkIfStillStaleSameInode,
} from "./coordination-claim.js";

export { COORDINATION_IN_PROGRESS_GRACE_MS };

export const COORDINATION_CAPABILITY = "HOST_LOCAL_FILESYSTEM_ONLY" as const;
export const DISTRIBUTED_FENCING_PROVEN = false;

export const HOST_LOCAL_COORDINATION_MODE = "HOST_LOCAL_FILESYSTEM_ONLY" as const;

export const COORDINATION_LOCK_FILE_NAME = "llock";
export const COORDINATION_RECOVER_NAME = "llock.recover";
export const COORDINATION_RECOVER2_NAME = "llock.recover2";

const LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_DEADLINE_MS = 15_000;

export type CoordinationGuard = {
  capability: typeof COORDINATION_CAPABILITY;
  release(): Promise<void>;
};

export type CoordinationAcquireResult =
  | { ok: true; guard: CoordinationGuard }
  | { ok: false; reasonCodes: string[] };

export type CoordinationFaultWindow =
  | "AFTER_LLOCK_EXCL_CREATE"
  | "AFTER_LLOCK_METADATA_WRITE"
  | "AFTER_RECOVER_EXCL_CREATE"
  | "AFTER_RECOVER_IDENTITY"
  | "AFTER_STALE_LLOCK_UNLINK";

export type CoordinationFaultHook = {
  window: CoordinationFaultWindow;
  action: "NOTIFY_AND_WAIT" | "NOTIFY_AND_WAIT_RESUME";
  readyFilePath: string;
  resumeFilePath?: string;
};

let coordinationFaultHookForTests: CoordinationFaultHook | null = null;

export function setCoordinationFaultHookForTests(hook: CoordinationFaultHook | null): void {
  coordinationFaultHookForTests = hook;
}

export function isHostLocalCoordinationMode(mode: string | undefined): boolean {
  return mode === undefined || mode === HOST_LOCAL_COORDINATION_MODE;
}

export async function acquireHostLocalCoordinationGuard(
  directory: string,
  deadlineMs: number = DEFAULT_LOCK_DEADLINE_MS,
): Promise<CoordinationAcquireResult> {
  const lockPath = path.join(directory, COORDINATION_LOCK_FILE_NAME);
  const deadline = Date.now() + deadlineMs;

  while (Date.now() <= deadline) {
    const created = await exclusiveCreate(lockPath);
    if (created.ok) {
      try {
        await applyCoordinationFaultHookForTests("AFTER_LLOCK_EXCL_CREATE");
      } catch {
        await abandonCreatedClaim(lockPath, created.handle, null);
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
      }
      const written = await writeClaimRecord(created.handle, lockPath);
      if (!written.ok) {
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
      }
      try {
        await applyCoordinationFaultHookForTests("AFTER_LLOCK_METADATA_WRITE");
      } catch {
        await abandonCreatedClaim(lockPath, created.handle, written.identity);
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
      }
      const confirmed = await confirmPathIdentity(lockPath, written.identity);
      if (!confirmed) {
        await created.handle.close();
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN"] };
      }
      if (await hasBlockingRecoverer(directory)) {
        await unlinkIfMatchingIdentity(lockPath, written.identity);
        await created.handle.close();
        await delay(LOCK_RETRY_MS);
        continue;
      }
      const stillOurs = await confirmPathIdentity(lockPath, written.identity);
      if (!stillOurs) {
        await created.handle.close();
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN"] };
      }
      return {
        ok: true,
        guard: {
          capability: COORDINATION_CAPABILITY,
          release: async () => {
            await releaseOwnedLock(lockPath, created.handle, written.identity);
          },
        },
      };
    }
    if (created.code !== "EEXIST") {
      return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
    }
    const liveness = await probeCoordinationPath(lockPath);
    if (liveness === "LIVE" || liveness === "ABSENT") {
      await delay(LOCK_RETRY_MS);
      continue;
    }
    if (liveness === "UNCERTAIN") {
      return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN"] };
    }
    const recovered = await recoverStaleLock(directory, lockPath);
    if (recovered === "UNCERTAIN") {
      return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN"] };
    }
    await delay(LOCK_RETRY_MS);
  }

  return { ok: false, reasonCodes: ["COORDINATION_LOCK_TIMEOUT"] };
}

async function recoverStaleLock(
  directory: string,
  lockPath: string,
): Promise<"RECOVERED" | "RETRY" | "UNCERTAIN"> {
  const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
  const created = await exclusiveCreate(recoverPath);
  if (!created.ok) {
    if (created.code !== "EEXIST") {
      return "UNCERTAIN";
    }
    return reclaimOrWaitForRecover(directory, recoverPath);
  }

  try {
    await applyCoordinationFaultHookForTests("AFTER_RECOVER_EXCL_CREATE");
  } catch {
    await abandonCreatedClaim(recoverPath, created.handle, null);
    return "UNCERTAIN";
  }

  const written = await writeClaimRecord(created.handle, recoverPath);
  if (!written.ok) {
    return "UNCERTAIN";
  }
  const confirmed = await confirmPathIdentity(recoverPath, written.identity);
  if (!confirmed) {
    await created.handle.close();
    return "RETRY";
  }

  try {
    await applyCoordinationFaultHookForTests("AFTER_RECOVER_IDENTITY");
  } catch {
    await abandonCreatedClaim(recoverPath, created.handle, written.identity);
    return "UNCERTAIN";
  }

  const stillOwned = await confirmPathIdentity(recoverPath, written.identity);
  if (!stillOwned) {
    await created.handle.close();
    return "RETRY";
  }

  const liveness = await probeCoordinationPath(lockPath);
  if (liveness === "LIVE" || liveness === "ABSENT") {
    await unlinkIfMatchingIdentity(recoverPath, written.identity);
    await created.handle.close();
    return "RETRY";
  }
  if (liveness === "UNCERTAIN") {
    await unlinkIfMatchingIdentity(recoverPath, written.identity);
    await created.handle.close();
    return "UNCERTAIN";
  }

  const staleInode = await readPathInode(lockPath);
  if (staleInode === null) {
    await unlinkIfMatchingIdentity(recoverPath, written.identity);
    await created.handle.close();
    return "RETRY";
  }

  const recoverStillOurs = await confirmPathIdentity(recoverPath, written.identity);
  if (!recoverStillOurs) {
    await created.handle.close();
    return "RETRY";
  }

  const unlinked = await unlinkIfStillStaleSameInode(lockPath, staleInode);
  if (!unlinked && (await probeCoordinationPath(lockPath)) === "UNCERTAIN") {
    await unlinkIfMatchingIdentity(recoverPath, written.identity);
    await created.handle.close();
    return "UNCERTAIN";
  }

  try {
    await applyCoordinationFaultHookForTests("AFTER_STALE_LLOCK_UNLINK");
  } catch {
    await abandonCreatedClaim(recoverPath, created.handle, written.identity);
    return "UNCERTAIN";
  }

  await unlinkIfMatchingIdentity(recoverPath, written.identity);
  await created.handle.close();
  return "RECOVERED";
}

async function reclaimOrWaitForRecover(
  directory: string,
  recoverPath: string,
): Promise<"RETRY" | "UNCERTAIN"> {
  const liveness = await probeCoordinationPath(recoverPath);
  if (liveness === "LIVE" || liveness === "ABSENT") {
    return "RETRY";
  }
  if (liveness === "UNCERTAIN") {
    return "UNCERTAIN";
  }
  const reclaimed = await reclaimStaleRecover(directory, recoverPath);
  return reclaimed === "UNCERTAIN" ? "UNCERTAIN" : "RETRY";
}

async function reclaimStaleRecover(
  directory: string,
  recoverPath: string,
): Promise<"RECLAIMED" | "RETRY" | "UNCERTAIN"> {
  const recover2Path = path.join(directory, COORDINATION_RECOVER2_NAME);
  const created = await exclusiveCreate(recover2Path);
  if (!created.ok) {
    if (created.code !== "EEXIST") {
      return "UNCERTAIN";
    }
    const recover2Liveness = await probeCoordinationPath(recover2Path);
    if (recover2Liveness === "LIVE" || recover2Liveness === "ABSENT") {
      return "RETRY";
    }
    if (recover2Liveness === "UNCERTAIN") {
      return "UNCERTAIN";
    }
    const recover2Inode = await readPathInode(recover2Path);
    if (recover2Inode === null) {
      return "RETRY";
    }
    await unlinkIfStillStaleSameInode(recover2Path, recover2Inode);
    return "RETRY";
  }

  const written = await writeClaimRecord(created.handle, recover2Path);
  if (!written.ok) {
    return "UNCERTAIN";
  }
  const confirmed = await confirmPathIdentity(recover2Path, written.identity);
  if (!confirmed) {
    await created.handle.close();
    return "RETRY";
  }

  const recoverLiveness = await probeCoordinationPath(recoverPath);
  if (recoverLiveness === "LIVE" || recoverLiveness === "ABSENT") {
    await unlinkIfMatchingIdentity(recover2Path, written.identity);
    await created.handle.close();
    return "RETRY";
  }
  if (recoverLiveness === "UNCERTAIN") {
    await unlinkIfMatchingIdentity(recover2Path, written.identity);
    await created.handle.close();
    return "UNCERTAIN";
  }

  const recoverInode = await readPathInode(recoverPath);
  if (recoverInode === null) {
    await unlinkIfMatchingIdentity(recover2Path, written.identity);
    await created.handle.close();
    return "RETRY";
  }
  const recover2StillOurs = await confirmPathIdentity(recover2Path, written.identity);
  if (!recover2StillOurs) {
    await created.handle.close();
    return "RETRY";
  }
  await unlinkIfStillStaleSameInode(recoverPath, recoverInode);
  await unlinkIfMatchingIdentity(recover2Path, written.identity);
  await created.handle.close();
  return "RECLAIMED";
}

async function exclusiveCreate(
  targetPath: string,
): Promise<
  | { ok: true; handle: Awaited<ReturnType<typeof open>> }
  | { ok: false; code: "EEXIST" | "UNCERTAIN" }
> {
  try {
    const handle = await open(
      targetPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    return { ok: true, handle };
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return { ok: false, code: "EEXIST" };
    }
    return { ok: false, code: "UNCERTAIN" };
  }
}

async function writeClaimRecord(
  handle: Awaited<ReturnType<typeof open>>,
  targetPath: string,
): Promise<{ ok: true; identity: CoordinationPathIdentity } | { ok: false }> {
  const token = randomBytes(32).toString("hex");
  try {
    const created = await handle.stat();
    const identity: CoordinationPathIdentity = {
      pid: process.pid.toString(10),
      token,
      dev: BigInt(created.dev),
      ino: BigInt(created.ino),
    };
    const record = formatCoordinationClaim({
      pid: process.pid,
      token,
      createdAt: Date.now().toString(10),
      dev: identity.dev,
      ino: identity.ino,
    });
    await handle.writeFile(record);
    await handle.sync();
    return { ok: true, identity };
  } catch {
    await abandonCreatedClaim(targetPath, handle, null);
    return { ok: false };
  }
}

async function abandonCreatedClaim(
  targetPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  identity: CoordinationPathIdentity | null,
): Promise<void> {
  try {
    const handleStat = await handle.stat();
    const handleIdentity = {
      token: identity?.token ?? null,
      dev: BigInt(handleStat.dev),
      ino: BigInt(handleStat.ino),
    };
    await handle.close();
    if (identity !== null) {
      await unlinkIfMatchingIdentity(targetPath, identity);
      return;
    }
    await unlinkIfSameInode(targetPath, handleIdentity);
  } catch {
    try {
      await handle.close();
    } catch {
      // Handle already closed or unusable; never unlink a replaced path.
    }
  }
}

async function releaseOwnedLock(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  identity: CoordinationPathIdentity,
): Promise<void> {
  try {
    const current = await stat(lockPath);
    const sameInode = BigInt(current.dev) === identity.dev && BigInt(current.ino) === identity.ino;
    const stillOurs = sameInode ? await confirmPathIdentity(lockPath, identity) : false;
    await handle.close();
    if (stillOurs) {
      await unlinkIfMatchingIdentity(lockPath, identity);
    }
  } catch {
    try {
      await handle.close();
    } catch {
      // Handle already closed or unusable; never unlink a replaced lock.
    }
  }
}

async function hasBlockingRecoverer(directory: string): Promise<boolean> {
  const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
  const liveness = await probeCoordinationPath(recoverPath);
  return liveness === "LIVE" || liveness === "UNCERTAIN";
}

export async function applyCoordinationFaultHookForTests(
  window: CoordinationFaultWindow,
): Promise<void> {
  const configured = coordinationFaultHookForTests;
  if (configured === null || configured.window !== window) {
    return;
  }
  const readyFilePath = configured.readyFilePath;
  if (typeof readyFilePath !== "string" || readyFilePath.length === 0) {
    throw new Error("COORDINATION_FAULT_HOOK_MISSING_READY_PATH");
  }
  writeFileSync(readyFilePath, `${window}\n`, { encoding: "utf8" });
  try {
    if (typeof process.send === "function") {
      process.send({ type: "COORDINATION_HOOK_REACHED", window });
    }
  } catch {
    // IPC is optional for parent notification; the ready file is authoritative.
  }
  if (configured.action === "NOTIFY_AND_WAIT_RESUME") {
    const resumeFilePath = configured.resumeFilePath;
    if (typeof resumeFilePath !== "string" || resumeFilePath.length === 0) {
      throw new Error("COORDINATION_FAULT_HOOK_MISSING_RESUME_PATH");
    }
    await waitForResumePath(resumeFilePath);
    return;
  }
  setInterval(() => {
    // Keep the event loop alive until the parent sends SIGKILL.
  }, 60_000);
  await new Promise<never>(() => {
    // Parent sends SIGKILL.
  });
}

async function waitForResumePath(filePath: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error("COORDINATION_FAULT_HOOK_RESUME_TIMEOUT");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
