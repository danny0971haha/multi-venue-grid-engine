import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const COORDINATION_CAPABILITY = "HOST_LOCAL_FILESYSTEM_ONLY" as const;
export const DISTRIBUTED_FENCING_PROVEN = false;

export const HOST_LOCAL_COORDINATION_MODE = "HOST_LOCAL_FILESYSTEM_ONLY" as const;

export const COORDINATION_LOCK_FILE_NAME = "llock";
export const COORDINATION_RECOVER_NAME = "llock.recover";

const LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_DEADLINE_MS = 15_000;
const PID_PATTERN = /^[1-9][0-9]{0,15}$/;

export type CoordinationGuard = {
  capability: typeof COORDINATION_CAPABILITY;
  release(): Promise<void>;
};

export type CoordinationAcquireResult =
  | { ok: true; guard: CoordinationGuard }
  | { ok: false; reasonCodes: string[] };

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
    try {
      const handle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const guardToken = randomBytes(32).toString("hex");
      try {
        await handle.writeFile(`${process.pid.toString(10)}\n${guardToken}\n`);
      } catch {
        await handle.close();
        await unlinkQuiet(lockPath);
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
      }
      let identity: { token: string; dev: bigint; ino: bigint };
      try {
        const created = await handle.stat();
        identity = {
          token: guardToken,
          dev: BigInt(created.dev),
          ino: BigInt(created.ino),
        };
      } catch {
        await handle.close();
        await unlinkQuiet(lockPath);
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
      }
      return {
        ok: true,
        guard: {
          capability: COORDINATION_CAPABILITY,
          release: async () => {
            await releaseOwnedLock(lockPath, handle, identity);
          },
        },
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        return { ok: false, reasonCodes: ["COORDINATION_LOCK_UNCERTAIN", "IO_FAILURE"] };
      }
      const liveness = await probeHolder(lockPath);
      if (liveness === "LIVE") {
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
  }

  return { ok: false, reasonCodes: ["COORDINATION_LOCK_TIMEOUT"] };
}

type Liveness = "LIVE" | "STALE" | "UNCERTAIN";

async function probeHolder(lockPath: string): Promise<Liveness> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return "LIVE";
    }
    return "UNCERTAIN";
  }
  const pidText = lockPidText(raw);
  if (pidText === "") {
    return "LIVE";
  }
  if (!PID_PATTERN.test(pidText)) {
    return "UNCERTAIN";
  }
  const alive = isProcessAlive(Number.parseInt(pidText, 10));
  if (alive === "UNCERTAIN") {
    return "UNCERTAIN";
  }
  return alive ? "LIVE" : "STALE";
}

function isProcessAlive(pid: number): boolean | "UNCERTAIN" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }
    if (hasErrorCode(error, "EPERM")) {
      return true;
    }
    return "UNCERTAIN";
  }
}

async function recoverStaleLock(
  directory: string,
  lockPath: string,
): Promise<"RECOVERED" | "RETRY" | "UNCERTAIN"> {
  const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
  try {
    const handle = await open(
      recoverPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.close();
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return "RETRY";
    }
    return "UNCERTAIN";
  }

  const liveness = await probeHolder(lockPath);
  if (liveness === "LIVE") {
    await unlinkQuiet(recoverPath);
    return "RETRY";
  }
  if (liveness === "UNCERTAIN") {
    await unlinkQuiet(recoverPath);
    return "UNCERTAIN";
  }

  await unlinkQuiet(lockPath);
  await unlinkQuiet(recoverPath);
  return "RECOVERED";
}

async function releaseOwnedLock(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  identity: { token: string; dev: bigint; ino: bigint },
): Promise<void> {
  try {
    const current = await stat(lockPath);
    const raw = await readFile(lockPath);
    const sameInode = BigInt(current.dev) === identity.dev && BigInt(current.ino) === identity.ino;
    const sameToken = lockTokenText(raw) === identity.token;
    await handle.close();
    if (sameInode && sameToken) {
      await unlinkQuiet(lockPath);
    }
  } catch {
    try {
      await handle.close();
    } catch {
      // Handle already closed or unusable; never unlink a replaced lock.
    }
  }
}

function lockPidText(raw: string): string {
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine.trim();
}

function lockTokenText(raw: Buffer | string): string | null {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const tokenLine = text.split("\n")[1];
  if (tokenLine === undefined) {
    return null;
  }
  const token = tokenLine.trim();
  return token.length === 0 ? null : token;
}

async function unlinkQuiet(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
