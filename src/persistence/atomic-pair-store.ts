import type { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import type { BuiltDurableEnvelope } from "./durable-envelope.js";
import {
  buildDurableEnvelope,
  isCanonicalGenerationString,
  parseAndValidateDurableEnvelope,
  SUPPORTED_SCHEMA_VERSION,
} from "./durable-envelope.js";
import type { PairInspection } from "./exact-pair-inspection.js";
import { inspectExactPair, REASON_CODE_CATALOG, sortReasonCodes } from "./exact-pair-inspection.js";
import type { LatchState, RuntimePersistenceLatch } from "./runtime-persistence-latch.js";

export const ATOMIC_WRITE_HOOKS = [
  "BEFORE_TEMP_OPEN",
  "AFTER_TEMP_OPEN",
  "AFTER_TEMP_WRITE",
  "AFTER_TEMP_FSYNC",
  "AFTER_TEMP_CLOSE",
  "AFTER_RENAME",
  "AFTER_DIR_FSYNC",
  "AFTER_TARGET_INSPECTION",
] as const;

export type AtomicWriteHook = (typeof ATOMIC_WRITE_HOOKS)[number];
export type AtomicWriteTarget = "BACKUP" | "PRIMARY";

export type PersistDisposition =
  | "REQUESTED_STATE_COMMITTED"
  | "PREDECESSOR_UNPROVEN"
  | "PARTIAL_COMMIT"
  | "FINAL_PAIR_UNPROVEN"
  | "IO_FAILURE";

export const PHASE_2B_REASON_CODE_CATALOG = [
  ...REASON_CODE_CATALOG,
  "REQUESTED_STATE_COMMITTED",
  "PREDECESSOR_UNPROVEN",
  "PARTIAL_COMMIT",
  "FINAL_PAIR_UNPROVEN",
  "IO_FAILURE",
  "UNSAFE_STATE_NAME",
  "BOOTSTRAP_AUTHORIZATION_INVALID",
  "AMBIGUOUS_INITIALIZATION",
  "INITIALIZATION_NOT_CLEAN",
  "STALE_EXPECTED_GENERATION",
  "STALE_PREDECESSOR_HASH",
  "COMPARE_AND_COMMIT_FAILED",
  "READBACK_MISMATCH",
  "DIR_FSYNC_FAILURE",
  "TARGET_FIELD_MISMATCH",
  "LATCH_ALREADY_BLOCKED",
  "UNSUPPORTED_DURABILITY_OPERATION",
  "GENERATION_OVERFLOW",
] as const;

export type Phase2BReasonCode = (typeof PHASE_2B_REASON_CODE_CATALOG)[number];

export type PersistResult<T> = {
  disposition: PersistDisposition;
  state: T | null;
  allowRiskIncrease: false;
  reasonCodes: string[];
  committedEnvelopeSha256: string | null;
  committedGeneration: string | null;
  inspection: PairInspection;
  latchState: LatchState;
};

export type BootstrapAuthorization = {
  mode: "NON_LIVE_BOOTSTRAP";
  allowLive: false;
};

export type InitializeExactPairRequest<T> = {
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
  payload: T;
  bootstrapAuthorization: BootstrapAuthorization;
  latch: RuntimePersistenceLatch;
};

export type PersistExactPairTransitionRequest<T> = {
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
  expectedGeneration: string;
  expectedPredecessorEnvelopeSha256: string;
  payload: T;
  latch: RuntimePersistenceLatch;
};

export type PersistenceFaultAction =
  | "FAIL"
  | "NOTIFY_AND_WAIT"
  | "FAIL_DIR_FSYNC"
  | "FAIL_READBACK";

export type PersistenceFaultHook = {
  target: AtomicWriteTarget;
  hook: AtomicWriteHook;
  action: PersistenceFaultAction;
  readyFilePath?: string;
};

const TEMP_CREATE_ATTEMPTS = 8;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

let testFaultHook: PersistenceFaultHook | null = null;

export function setPersistenceFaultHookForTests(hook: PersistenceFaultHook | null): void {
  testFaultHook = hook;
}

export function sortPhase2BReasonCodes(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map<string, number>(
    PHASE_2B_REASON_CODE_CATALOG.map((code, index) => [code, index]),
  );
  return unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
}

export function incrementCanonicalGeneration(
  generation: string,
):
  | { ok: true; generation: string }
  | { ok: false; reasonCode: "INVALID_GENERATION" | "GENERATION_OVERFLOW" } {
  if (!isCanonicalGenerationString(generation)) {
    return { ok: false, reasonCode: "INVALID_GENERATION" };
  }
  const next = (BigInt(generation) + 1n).toString(10);
  if (!isCanonicalGenerationString(next)) {
    return { ok: false, reasonCode: "GENERATION_OVERFLOW" };
  }
  return { ok: true, generation: next };
}

export function formatPersistResultDiagnostic<T>(result: PersistResult<T>): string {
  return JSON.stringify({
    disposition: result.disposition,
    allowRiskIncrease: result.allowRiskIncrease,
    reasonCodes: result.reasonCodes,
    committedEnvelopeSha256: result.committedEnvelopeSha256,
    committedGeneration: result.committedGeneration,
    latchState: result.latchState,
    inspection: {
      pairStatus: result.inspection.pairStatus,
      pairAuthorityProven: result.inspection.pairAuthorityProven,
      allowRiskIncrease: result.inspection.allowRiskIncrease,
      generation: result.inspection.generation,
      envelopeSha256: result.inspection.envelopeSha256,
      reasonCodes: result.inspection.reasonCodes,
    },
  });
}

export async function initializeExactPair<T>(
  request: InitializeExactPairRequest<T>,
): Promise<PersistResult<T>> {
  const directory = request.directory;
  const stateName = request.stateName;
  const expectedKind = request.expectedKind;
  const expectedScopeKey = request.expectedScopeKey;
  const payload = request.payload;
  const bootstrapAuthorization = request.bootstrapAuthorization;
  const latch = request.latch;

  const unsafe = validateStateName(stateName);
  if (unsafe !== null) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: [unsafe, "UNSUPPORTED_DURABILITY_OPERATION"],
    });
  }

  if (!isValidBootstrapAuthorization(bootstrapAuthorization)) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "PREDECESSOR_UNPROVEN",
      reasonCodes: ["BOOTSTRAP_AUTHORIZATION_INVALID", "AMBIGUOUS_INITIALIZATION"],
    });
  }

  try {
    await ensureRestrictiveDirectory(directory);
  } catch {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: ["IO_FAILURE"],
    });
  }

  const siblingEvidence = await collectSiblingEvidence(directory, stateName);
  const inspection = await inspectExactPair({
    directory,
    stateName,
    expectedKind,
    expectedScopeKey,
  });

  if (inspection.pairStatus !== "BOTH_ABSENT" || siblingEvidence.length > 0) {
    const reasonCodes = [
      "PREDECESSOR_UNPROVEN",
      "AMBIGUOUS_INITIALIZATION",
      "INITIALIZATION_NOT_CLEAN",
      ...inspection.reasonCodes,
      ...siblingEvidence,
    ];
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "PREDECESSOR_UNPROVEN",
      reasonCodes,
      inspection,
    });
  }

  let built: BuiltDurableEnvelope<T>;
  try {
    built = buildDurableEnvelope({
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      kind: expectedKind,
      scopeKey: expectedScopeKey,
      storeGeneration: "1",
      previousEnvelopeSha256: null,
      payload,
    });
  } catch {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: ["CANONICALIZATION_REJECTED"],
      inspection,
    });
  }

  return commitExactPairBytes({
    directory,
    stateName,
    expectedKind,
    expectedScopeKey,
    expectedGeneration: "1",
    latch,
    built,
  });
}

export async function persistExactPairTransition<T>(
  request: PersistExactPairTransitionRequest<T>,
): Promise<PersistResult<T>> {
  const directory = request.directory;
  const stateName = request.stateName;
  const expectedKind = request.expectedKind;
  const expectedScopeKey = request.expectedScopeKey;
  const expectedGeneration = request.expectedGeneration;
  const expectedPredecessorEnvelopeSha256 = request.expectedPredecessorEnvelopeSha256;
  const payload = request.payload;
  const latch = request.latch;

  const unsafe = validateStateName(stateName);
  if (unsafe !== null) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: [unsafe, "UNSUPPORTED_DURABILITY_OPERATION"],
    });
  }

  try {
    await ensureRestrictiveDirectory(directory);
  } catch {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: ["IO_FAILURE"],
    });
  }

  const firstInspection = await inspectExactPair({
    directory,
    stateName,
    expectedKind,
    expectedScopeKey,
    expectedGeneration,
  });

  if (!firstInspection.pairAuthorityProven) {
    const reasonCodes = ["PREDECESSOR_UNPROVEN", ...firstInspection.reasonCodes];
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "PREDECESSOR_UNPROVEN",
      reasonCodes,
      inspection: firstInspection,
    });
  }

  if (firstInspection.generation !== expectedGeneration) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "PREDECESSOR_UNPROVEN",
      reasonCodes: ["PREDECESSOR_UNPROVEN", "STALE_EXPECTED_GENERATION", "LINEAGE_MISMATCH"],
      inspection: firstInspection,
    });
  }

  if (firstInspection.envelopeSha256 !== expectedPredecessorEnvelopeSha256) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "PREDECESSOR_UNPROVEN",
      reasonCodes: ["PREDECESSOR_UNPROVEN", "STALE_PREDECESSOR_HASH"],
      inspection: firstInspection,
    });
  }

  const nextGeneration = incrementCanonicalGeneration(expectedGeneration);
  if (!nextGeneration.ok) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: [nextGeneration.reasonCode, "UNSUPPORTED_DURABILITY_OPERATION"],
      inspection: firstInspection,
    });
  }

  let built: BuiltDurableEnvelope<T>;
  try {
    built = buildDurableEnvelope({
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      kind: expectedKind,
      scopeKey: expectedScopeKey,
      storeGeneration: nextGeneration.generation,
      previousEnvelopeSha256: expectedPredecessorEnvelopeSha256,
      payload,
    });
  } catch {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "IO_FAILURE",
      reasonCodes: ["CANONICALIZATION_REJECTED"],
      inspection: firstInspection,
    });
  }

  const compareInspection = await inspectExactPair({
    directory,
    stateName,
    expectedKind,
    expectedScopeKey,
    expectedGeneration,
  });
  if (
    !compareInspection.pairAuthorityProven ||
    compareInspection.generation !== expectedGeneration ||
    compareInspection.envelopeSha256 !== expectedPredecessorEnvelopeSha256
  ) {
    return failClosed({
      latch,
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
      disposition: "PREDECESSOR_UNPROVEN",
      reasonCodes: [
        "PREDECESSOR_UNPROVEN",
        "COMPARE_AND_COMMIT_FAILED",
        ...compareInspection.reasonCodes,
      ],
      inspection: compareInspection,
    });
  }

  return commitExactPairBytes({
    directory,
    stateName,
    expectedKind,
    expectedScopeKey,
    expectedGeneration: nextGeneration.generation,
    latch,
    built,
  });
}

type BuiltPairBytes<T> = ReturnType<typeof buildDurableEnvelope<T>>;

async function commitExactPairBytes<T>(args: {
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
  expectedGeneration: string;
  latch: RuntimePersistenceLatch;
  built: BuiltPairBytes<T>;
}): Promise<PersistResult<T>> {
  const requestedBytes = args.built.fullEnvelopeBytes;
  const backup = await atomicCommitTarget({
    directory: args.directory,
    stateName: args.stateName,
    target: "BACKUP",
    requestedBytes,
    expectedKind: args.expectedKind,
    expectedScopeKey: args.expectedScopeKey,
    expectedGeneration: args.expectedGeneration,
    expectedPreviousEnvelopeSha256: args.built.envelope.previousEnvelopeSha256,
    expectedEnvelopeSha256: args.built.envelope.envelopeSha256,
    expectedPayloadSha256: args.built.envelope.payloadSha256,
  });

  if (!backup.ok) {
    const disposition = backup.visibleMutation ? "PARTIAL_COMMIT" : "IO_FAILURE";
    return failClosed({
      latch: args.latch,
      directory: args.directory,
      stateName: args.stateName,
      expectedKind: args.expectedKind,
      expectedScopeKey: args.expectedScopeKey,
      disposition,
      reasonCodes: [disposition, ...backup.reasonCodes],
    });
  }

  const primary = await atomicCommitTarget({
    directory: args.directory,
    stateName: args.stateName,
    target: "PRIMARY",
    requestedBytes,
    expectedKind: args.expectedKind,
    expectedScopeKey: args.expectedScopeKey,
    expectedGeneration: args.expectedGeneration,
    expectedPreviousEnvelopeSha256: args.built.envelope.previousEnvelopeSha256,
    expectedEnvelopeSha256: args.built.envelope.envelopeSha256,
    expectedPayloadSha256: args.built.envelope.payloadSha256,
  });

  if (!primary.ok) {
    return failClosed({
      latch: args.latch,
      directory: args.directory,
      stateName: args.stateName,
      expectedKind: args.expectedKind,
      expectedScopeKey: args.expectedScopeKey,
      disposition: "PARTIAL_COMMIT",
      reasonCodes: ["PARTIAL_COMMIT", ...primary.reasonCodes],
    });
  }

  const inspection = await inspectExactPair({
    directory: args.directory,
    stateName: args.stateName,
    expectedKind: args.expectedKind,
    expectedScopeKey: args.expectedScopeKey,
    expectedGeneration: args.expectedGeneration,
  });

  const bytesMatch = await exactRequestedPairOnDisk(args.directory, args.stateName, requestedBytes);
  if (
    !inspection.pairAuthorityProven ||
    !bytesMatch ||
    inspection.envelopeSha256 !== args.built.envelope.envelopeSha256 ||
    inspection.generation !== args.expectedGeneration
  ) {
    return failClosed({
      latch: args.latch,
      directory: args.directory,
      stateName: args.stateName,
      expectedKind: args.expectedKind,
      expectedScopeKey: args.expectedScopeKey,
      disposition: "FINAL_PAIR_UNPROVEN",
      reasonCodes: ["FINAL_PAIR_UNPROVEN", ...inspection.reasonCodes],
      inspection,
    });
  }

  return succeed({
    latch: args.latch,
    inspection,
    state: args.built.envelope.payload,
    committedEnvelopeSha256: args.built.envelope.envelopeSha256,
    committedGeneration: args.built.envelope.storeGeneration,
  });
}

type TargetCommitResult =
  | { ok: true; visibleMutation: true }
  | { ok: false; visibleMutation: boolean; reasonCodes: string[] };

async function atomicCommitTarget(args: {
  directory: string;
  stateName: string;
  target: AtomicWriteTarget;
  requestedBytes: Buffer;
  expectedKind: string;
  expectedScopeKey: string;
  expectedGeneration: string;
  expectedPreviousEnvelopeSha256: string | null;
  expectedEnvelopeSha256: string;
  expectedPayloadSha256: string;
}): Promise<TargetCommitResult> {
  const targetPath = targetFilePath(args.directory, args.stateName, args.target);
  let visibleMutation = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await applyFaultHook(args.target, "BEFORE_TEMP_OPEN");

    const tempPath = await exclusiveCreateTemp(args.directory, args.stateName, args.target);
    handle = tempPath.handle;
    await chmod(tempPath.path, FILE_MODE);
    await applyFaultHook(args.target, "AFTER_TEMP_OPEN");

    await writeAllBytes(handle, args.requestedBytes);
    await applyFaultHook(args.target, "AFTER_TEMP_WRITE");

    await handle.sync();
    await applyFaultHook(args.target, "AFTER_TEMP_FSYNC");

    await handle.close();
    handle = undefined;
    await applyFaultHook(args.target, "AFTER_TEMP_CLOSE");

    await rename(tempPath.path, targetPath);
    visibleMutation = true;
    await chmod(targetPath, FILE_MODE);
    await applyFaultHook(args.target, "AFTER_RENAME");

    const dirFsync = await fsyncParentDirectory(args.directory, args.target);
    if (!dirFsync.ok) {
      return { ok: false, visibleMutation, reasonCodes: ["DIR_FSYNC_FAILURE", "IO_FAILURE"] };
    }
    await applyFaultHook(args.target, "AFTER_DIR_FSYNC");

    const readback = await readFile(targetPath);
    if (shouldFailReadback(args.target) || !readback.equals(args.requestedBytes)) {
      return { ok: false, visibleMutation, reasonCodes: ["READBACK_MISMATCH"] };
    }

    const parsed = parseAndValidateDurableEnvelope(readback);
    if (!parsed.ok) {
      return {
        ok: false,
        visibleMutation,
        reasonCodes: ["READBACK_MISMATCH", ...parsed.reasonCodes],
      };
    }
    if (
      parsed.envelope.kind !== args.expectedKind ||
      parsed.envelope.scopeKey !== args.expectedScopeKey ||
      parsed.envelope.storeGeneration !== args.expectedGeneration ||
      parsed.envelope.previousEnvelopeSha256 !== args.expectedPreviousEnvelopeSha256 ||
      parsed.envelope.payloadSha256 !== args.expectedPayloadSha256 ||
      parsed.envelope.envelopeSha256 !== args.expectedEnvelopeSha256
    ) {
      return { ok: false, visibleMutation, reasonCodes: ["TARGET_FIELD_MISMATCH"] };
    }

    await applyFaultHook(args.target, "AFTER_TARGET_INSPECTION");
    return { ok: true, visibleMutation: true };
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve disk evidence. Close failure does not authorize cleanup.
      }
    }
    return {
      ok: false,
      visibleMutation,
      reasonCodes: faultReasonCodes(error),
    };
  }
}

async function exclusiveCreateTemp(
  directory: string,
  stateName: string,
  target: AtomicWriteTarget,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
    const fileName = `${stateName}.json.${target}.${randomBytes(16).toString("hex")}.tmp`;
    const tempPath = path.join(directory, fileName);
    try {
      const handle = await open(
        tempPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        FILE_MODE,
      );
      return { path: tempPath, handle };
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
  throw new PersistOpError(["IO_FAILURE"], "exclusive temp create exhausted");
}

async function writeAllBytes(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) {
      throw new PersistOpError(["IO_FAILURE"], "zero-byte write");
    }
    offset += result.bytesWritten;
  }
}

async function fsyncParentDirectory(
  directory: string,
  target: AtomicWriteTarget,
): Promise<{ ok: boolean }> {
  if (shouldFailDirFsync(target)) {
    return { ok: false };
  }
  const dirHandle = await open(directory, fsConstants.O_RDONLY);
  try {
    await dirHandle.sync();
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    await dirHandle.close();
  }
}

async function applyFaultHook(target: AtomicWriteTarget, hook: AtomicWriteHook): Promise<void> {
  const configured = testFaultHook;
  if (configured === null || configured.target !== target || configured.hook !== hook) {
    return;
  }
  if (configured.action === "NOTIFY_AND_WAIT") {
    const readyFilePath = configured.readyFilePath;
    if (typeof readyFilePath !== "string" || readyFilePath.length === 0) {
      throw new PersistOpError(["UNSUPPORTED_DURABILITY_OPERATION"], "missing crash ready path");
    }
    writeFileSync(readyFilePath, `${target}:${hook}\n`, { encoding: "utf8" });
    if (typeof process.send === "function") {
      process.send({ type: "HOOK_REACHED", target, hook });
    }
    setInterval(() => {
      // Keep the event loop alive until the parent sends SIGKILL.
    }, 60_000);
    await new Promise<never>(() => {
      // Wait for the parent to SIGKILL this process.
    });
  }
  if (configured.action === "FAIL") {
    throw new PersistOpError(["IO_FAILURE"], `${target}:${hook}`);
  }
  if (configured.action === "FAIL_DIR_FSYNC" && hook === "AFTER_RENAME") {
    // Consumed by fsyncParentDirectory via shouldFailDirFsync.
    return;
  }
}

function shouldFailDirFsync(target: AtomicWriteTarget): boolean {
  return testFaultHook?.target === target && testFaultHook.action === "FAIL_DIR_FSYNC";
}

function shouldFailReadback(target: AtomicWriteTarget): boolean {
  return testFaultHook?.target === target && testFaultHook.action === "FAIL_READBACK";
}

function faultReasonCodes(error: unknown): string[] {
  if (error instanceof PersistOpError) {
    return error.reasonCodes;
  }
  return ["IO_FAILURE"];
}

class PersistOpError extends Error {
  readonly reasonCodes: string[];

  constructor(reasonCodes: string[], message: string) {
    super(message);
    this.name = "PersistOpError";
    this.reasonCodes = reasonCodes;
  }
}

function validateStateName(stateName: string): string | null {
  if (stateName.length === 0) {
    return "UNSAFE_STATE_NAME";
  }
  if (stateName.includes("/") || stateName.includes("\\") || stateName.includes("..")) {
    return "UNSAFE_STATE_NAME";
  }
  if (path.isAbsolute(stateName)) {
    return "UNSAFE_STATE_NAME";
  }
  for (let index = 0; index < stateName.length; index += 1) {
    const code = stateName.charCodeAt(index);
    if (code < 32 || code === 127) {
      return "UNSAFE_STATE_NAME";
    }
  }
  return null;
}

function isValidBootstrapAuthorization(value: BootstrapAuthorization): boolean {
  return value.mode === "NON_LIVE_BOOTSTRAP" && value.allowLive === false;
}

async function ensureRestrictiveDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(directory, DIRECTORY_MODE);
}

async function collectSiblingEvidence(directory: string, stateName: string): Promise<string[]> {
  try {
    const names = await readdir(directory);
    const prefix = `${stateName}.json`;
    const suspicious = names.filter((name) => name === prefix || name.startsWith(`${prefix}`));
    if (suspicious.length === 0) {
      return [];
    }
    return suspicious.some((name) => name.endsWith(".tmp"))
      ? ["TEMP_FILE_NON_AUTHORITATIVE", "INITIALIZATION_NOT_CLEAN"]
      : ["INITIALIZATION_NOT_CLEAN"];
  } catch {
    return ["IO_FAILURE"];
  }
}

function targetFilePath(directory: string, stateName: string, target: AtomicWriteTarget): string {
  const primary = path.join(directory, `${stateName}.json`);
  return target === "PRIMARY" ? primary : `${primary}.bak`;
}

async function exactRequestedPairOnDisk(
  directory: string,
  stateName: string,
  requestedBytes: Buffer,
): Promise<boolean> {
  try {
    const primary = await readFile(targetFilePath(directory, stateName, "PRIMARY"));
    const backup = await readFile(targetFilePath(directory, stateName, "BACKUP"));
    return primary.equals(requestedBytes) && backup.equals(requestedBytes);
  } catch {
    return false;
  }
}

function unusableInspection(reasonCodes: string[]): PairInspection {
  return {
    pairStatus: "UNPROVEN",
    primary: { status: "MISSING" },
    backup: { status: "MISSING" },
    exactBytesEqual: false,
    pairAuthorityProven: false,
    lineageStatus: "UNVERIFIED",
    generation: null,
    envelopeSha256: null,
    reasonCodes: sortReasonCodes(reasonCodes),
    allowRiskIncrease: false,
  };
}

async function readInspectionOrFallback(
  directory: string,
  stateName: string,
  expectedKind: string,
  expectedScopeKey: string,
  fallbackCodes: string[],
): Promise<PairInspection> {
  if (validateStateName(stateName) !== null) {
    return unusableInspection(fallbackCodes);
  }
  try {
    return await inspectExactPair({
      directory,
      stateName,
      expectedKind,
      expectedScopeKey,
    });
  } catch {
    return unusableInspection(fallbackCodes);
  }
}

async function failClosed<T>(args: {
  latch: RuntimePersistenceLatch;
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
  disposition: Exclude<PersistDisposition, "REQUESTED_STATE_COMMITTED">;
  reasonCodes: string[];
  inspection?: PairInspection;
}): Promise<PersistResult<T>> {
  const alreadyBlocked = args.latch.blocked;
  const reasonCodes = sortPhase2BReasonCodes([
    ...args.reasonCodes,
    ...(alreadyBlocked ? ["LATCH_ALREADY_BLOCKED"] : []),
  ]);
  args.latch.block(reasonCodes);
  const inspection =
    args.inspection ??
    (await readInspectionOrFallback(
      args.directory,
      args.stateName,
      args.expectedKind,
      args.expectedScopeKey,
      reasonCodes,
    ));
  return {
    disposition: args.disposition,
    state: null,
    allowRiskIncrease: false,
    reasonCodes,
    committedEnvelopeSha256: null,
    committedGeneration: null,
    inspection,
    latchState: args.latch.snapshot(),
  };
}

function succeed<T>(args: {
  latch: RuntimePersistenceLatch;
  inspection: PairInspection;
  state: T;
  committedEnvelopeSha256: string;
  committedGeneration: string;
}): PersistResult<T> {
  const alreadyBlocked = args.latch.blocked;
  const reasonCodes = sortPhase2BReasonCodes([
    "REQUESTED_STATE_COMMITTED",
    ...args.inspection.reasonCodes,
    ...(alreadyBlocked ? ["LATCH_ALREADY_BLOCKED"] : []),
  ]);
  return {
    disposition: "REQUESTED_STATE_COMMITTED",
    state: args.state,
    allowRiskIncrease: false,
    reasonCodes,
    committedEnvelopeSha256: args.committedEnvelopeSha256,
    committedGeneration: args.committedGeneration,
    inspection: args.inspection,
    latchState: args.latch.snapshot(),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
