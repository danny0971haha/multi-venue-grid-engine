import { constants as fsConstants } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";

export const COORDINATION_IN_PROGRESS_GRACE_MS = 400;

const PID_PATTERN = /^[1-9][0-9]{0,15}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^(0|[1-9][0-9]{0,12})$/;
const DECIMAL_ID_PATTERN = /^(0|[1-9][0-9]{0,38})$/;

export type CoordinationClaimLiveness = "ABSENT" | "LIVE" | "STALE" | "UNCERTAIN";

export type ParsedCoordinationClaim =
  | { kind: "EMPTY" }
  | {
      kind: "WELL_FORMED";
      pidText: string;
      pid: number;
      token: string | null;
      createdAt: string | null;
      claimedDev: bigint | null;
      claimedIno: bigint | null;
    }
  | { kind: "MALFORMED" };

export type CoordinationPathIdentity = {
  pid: string;
  token: string;
  dev: bigint;
  ino: bigint;
};

export function formatCoordinationClaim(fields: {
  pid: number;
  token: string;
  createdAt: string;
  dev: bigint;
  ino: bigint;
}): string {
  return `${fields.pid.toString(10)}\n${fields.token}\n${fields.createdAt}\n${fields.dev.toString(10)}\n${fields.ino.toString(10)}\n`;
}

export function parseCoordinationClaim(raw: string): ParsedCoordinationClaim {
  if (raw.trim().length === 0) {
    return { kind: "EMPTY" };
  }
  const lines = raw.split("\n");
  const pidText = (lines[0] ?? "").trim();
  if (pidText.length === 0) {
    return { kind: "MALFORMED" };
  }
  if (!PID_PATTERN.test(pidText)) {
    return { kind: "MALFORMED" };
  }
  const tokenLine = lines[1];
  let token: string | null = null;
  if (tokenLine !== undefined && tokenLine.trim().length > 0) {
    const trimmedToken = tokenLine.trim();
    if (!TOKEN_PATTERN.test(trimmedToken)) {
      return { kind: "MALFORMED" };
    }
    token = trimmedToken;
  }
  const createdLine = lines[2];
  let createdAt: string | null = null;
  if (createdLine !== undefined && createdLine.trim().length > 0) {
    const trimmedCreated = createdLine.trim();
    if (!TIMESTAMP_PATTERN.test(trimmedCreated)) {
      return { kind: "MALFORMED" };
    }
    createdAt = trimmedCreated;
  }
  const devLine = lines[3];
  const inoLine = lines[4];
  let claimedDev: bigint | null = null;
  let claimedIno: bigint | null = null;
  if (devLine !== undefined && devLine.trim().length > 0) {
    const trimmedDev = devLine.trim();
    if (!DECIMAL_ID_PATTERN.test(trimmedDev)) {
      return { kind: "MALFORMED" };
    }
    claimedDev = BigInt(trimmedDev);
  }
  if (inoLine !== undefined && inoLine.trim().length > 0) {
    const trimmedIno = inoLine.trim();
    if (!DECIMAL_ID_PATTERN.test(trimmedIno)) {
      return { kind: "MALFORMED" };
    }
    claimedIno = BigInt(trimmedIno);
  }
  return {
    kind: "WELL_FORMED",
    pidText,
    pid: Number.parseInt(pidText, 10),
    token,
    createdAt,
    claimedDev,
    claimedIno,
  };
}

export function classifyCoordinationClaim(
  parsed: ParsedCoordinationClaim,
  stats: { mtimeMs: number; dev: bigint; ino: bigint },
  nowMs: number,
): CoordinationClaimLiveness {
  if (parsed.kind === "MALFORMED") {
    return "UNCERTAIN";
  }
  if (parsed.kind === "EMPTY") {
    return emptyClaimAgeLiveness(stats.mtimeMs, nowMs);
  }
  if (parsed.claimedDev !== null && parsed.claimedDev !== stats.dev) {
    return "UNCERTAIN";
  }
  if (parsed.claimedIno !== null && parsed.claimedIno !== stats.ino) {
    return "UNCERTAIN";
  }
  const alive = isProcessAlive(parsed.pid);
  if (alive === "UNCERTAIN") {
    return "UNCERTAIN";
  }
  return alive ? "LIVE" : "STALE";
}

export async function probeCoordinationPath(
  targetPath: string,
): Promise<CoordinationClaimLiveness> {
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return "ABSENT";
    }
    return "UNCERTAIN";
  }
  let stats: { mtimeMs: number; dev: bigint; ino: bigint };
  try {
    const current = await stat(targetPath);
    stats = {
      mtimeMs: current.mtimeMs,
      dev: BigInt(current.dev),
      ino: BigInt(current.ino),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return "ABSENT";
    }
    return "UNCERTAIN";
  }
  return classifyCoordinationClaim(parseCoordinationClaim(raw), stats, Date.now());
}

export async function confirmPathIdentity(
  targetPath: string,
  identity: CoordinationPathIdentity,
): Promise<boolean> {
  try {
    const current = await stat(targetPath);
    if (BigInt(current.dev) !== identity.dev || BigInt(current.ino) !== identity.ino) {
      return false;
    }
    const parsed = parseCoordinationClaim(await readFile(targetPath, "utf8"));
    if (parsed.kind !== "WELL_FORMED") {
      return false;
    }
    return parsed.pidText === identity.pid && parsed.token === identity.token;
  } catch {
    return false;
  }
}

export async function unlinkIfSameInode(
  targetPath: string,
  expected: { dev: bigint; ino: bigint },
): Promise<boolean> {
  try {
    const current = await stat(targetPath);
    if (BigInt(current.dev) !== expected.dev || BigInt(current.ino) !== expected.ino) {
      return false;
    }
    await unlink(targetPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function unlinkIfMatchingIdentity(
  targetPath: string,
  identity: { token: string | null; dev: bigint; ino: bigint },
): Promise<boolean> {
  try {
    const current = await stat(targetPath);
    if (BigInt(current.dev) !== identity.dev || BigInt(current.ino) !== identity.ino) {
      return false;
    }
    const parsed = parseCoordinationClaim(await readFile(targetPath, "utf8"));
    if (identity.token === null) {
      if (parsed.kind !== "EMPTY") {
        return false;
      }
    } else if (parsed.kind !== "WELL_FORMED" || parsed.token !== identity.token) {
      return false;
    }
    await unlink(targetPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function unlinkIfStillStaleSameInode(
  targetPath: string,
  expected: { dev: bigint; ino: bigint },
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(targetPath, fsConstants.O_RDONLY);
    const fdStat = await handle.stat();
    if (BigInt(fdStat.dev) !== expected.dev || BigInt(fdStat.ino) !== expected.ino) {
      return false;
    }
    const raw = await readFile(targetPath, "utf8");
    const pathStat = await stat(targetPath);
    if (BigInt(pathStat.dev) !== expected.dev || BigInt(pathStat.ino) !== expected.ino) {
      return false;
    }
    const liveness = classifyCoordinationClaim(
      parseCoordinationClaim(raw),
      {
        mtimeMs: pathStat.mtimeMs,
        dev: BigInt(pathStat.dev),
        ino: BigInt(pathStat.ino),
      },
      Date.now(),
    );
    if (liveness !== "STALE") {
      return false;
    }
    const recheck = await stat(targetPath);
    if (BigInt(recheck.dev) !== expected.dev || BigInt(recheck.ino) !== expected.ino) {
      return false;
    }
    await unlink(targetPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    return false;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Handle already closed or unusable; never unlink a replaced path here.
      }
    }
  }
}

export async function readPathInode(
  targetPath: string,
): Promise<{ dev: bigint; ino: bigint } | null> {
  try {
    const current = await stat(targetPath);
    return { dev: BigInt(current.dev), ino: BigInt(current.ino) };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function emptyClaimAgeLiveness(mtimeMs: number, nowMs: number): CoordinationClaimLiveness {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) {
    return "UNCERTAIN";
  }
  const ageMs = nowMs - Math.trunc(mtimeMs);
  if (ageMs < COORDINATION_IN_PROGRESS_GRACE_MS) {
    return "LIVE";
  }
  return "STALE";
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

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
