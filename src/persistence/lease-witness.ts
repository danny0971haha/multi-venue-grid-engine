import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { CanonicalJsonError, canonicalSerialize } from "./canonical-json.js";
import {
  isCanonicalGenerationString,
  isLowerHexSha256,
  sha256HexBytes,
} from "./durable-envelope.js";
import type { PairInspection } from "./exact-pair-inspection.js";

export const LEASE_WITNESS_FILE_NAME = "runtime-lease.witness.jsonl";
export const LEASE_WITNESS_SCHEMA_VERSION = 1;
export const GENESIS_WITNESS_SHA256 = "0".repeat(64);

export const HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION =
  "HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION" as const;

export type LeaseWitnessOperation = "INITIALIZE" | "HEARTBEAT" | "TAKEOVER" | "RELEASE";
export type LeaseWitnessLineStatus = "PREPARE" | "COMMIT";

export type LeaseWitnessLine = {
  schemaVersion: 1;
  scopeKey: string;
  operation: LeaseWitnessOperation;
  fencingGeneration: string;
  leaseStoreGeneration: string;
  targetEnvelopeSha256: string;
  ownerId: string;
  processInstanceId: string;
  status: LeaseWitnessLineStatus;
  previousWitnessSha256: string;
  witnessSha256: string;
  createdAt: string;
};

export type WitnessLoadSuccess = {
  ok: true;
  present: boolean;
  lines: LeaseWitnessLine[];
};

export type WitnessLoadFailure = {
  ok: false;
  reasonCodes: string[];
};

export type WitnessAppendSuccess = {
  ok: true;
  line: LeaseWitnessLine;
  idempotent: boolean;
};

export type WitnessAppendFailure = {
  ok: false;
  reasonCodes: string[];
};

export type WitnessDecision =
  | { kind: "ALLOW_INITIALIZE" }
  | { kind: "ALLOW_CONTINUE"; latest: LeaseWitnessLine }
  | {
      kind: "INCOMPLETE_FINALIZATION";
      prepare: LeaseWitnessLine;
      reasonCodes: string[];
    }
  | { kind: "PREPARE_UNMATCHED"; reasonCodes: string[] }
  | { kind: "ROLLBACK"; reasonCodes: string[] }
  | { kind: "MISSING"; reasonCodes: string[] }
  | { kind: "UNPROVEN"; reasonCodes: string[] };

export type WitnessFaultWindow =
  | "AFTER_PREPARE_FSYNC"
  | "BEFORE_COMMIT_WITNESS"
  | "AFTER_COMMIT_WITNESS";

export type WitnessFaultHook = {
  window: WitnessFaultWindow;
  action: "NOTIFY_AND_WAIT";
  readyFilePath: string;
};

const WITNESS_LINE_KEYS = [
  "createdAt",
  "fencingGeneration",
  "leaseStoreGeneration",
  "operation",
  "ownerId",
  "previousWitnessSha256",
  "processInstanceId",
  "schemaVersion",
  "scopeKey",
  "status",
  "targetEnvelopeSha256",
  "witnessSha256",
] as const;

const OPERATIONS = new Set<LeaseWitnessOperation>([
  "INITIALIZE",
  "HEARTBEAT",
  "TAKEOVER",
  "RELEASE",
]);
const LINE_STATUSES = new Set<LeaseWitnessLineStatus>(["PREPARE", "COMMIT"]);
const OWNER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const TIMESTAMP_PATTERN = /^(0|[1-9][0-9]{0,12})$/;
const SECRET_KEY_PATTERN =
  /secret|password|token|apikey|api[_-]?key|private[_-]?key|credential|authorization|bearer/i;
const FILE_MODE = 0o600;

let witnessFaultHookForTests: WitnessFaultHook | null = null;

export function setLeaseWitnessFaultHookForTests(hook: WitnessFaultHook | null): void {
  witnessFaultHookForTests = hook;
}

export function leaseWitnessPath(directory: string): string {
  return path.join(directory, LEASE_WITNESS_FILE_NAME);
}

export async function loadLeaseWitnessLog(
  directory: string,
): Promise<WitnessLoadSuccess | WitnessLoadFailure> {
  let bytes: Buffer;
  try {
    bytes = await readFile(leaseWitnessPath(directory));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { ok: true, present: false, lines: [] };
    }
    return { ok: false, reasonCodes: ["WITNESS_IO_FAILURE", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  return parseWitnessBytes(bytes);
}

export function parseWitnessBytes(bytes: Buffer): WitnessLoadSuccess | WitnessLoadFailure {
  if (bytes.length === 0) {
    return { ok: true, present: true, lines: [] };
  }
  const text = decodeUtf8Fatal(bytes);
  if (text === null) {
    return { ok: false, reasonCodes: ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  if (!text.endsWith("\n")) {
    return { ok: false, reasonCodes: ["WITNESS_TRUNCATED", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  const rawLines = text.slice(0, -1).split("\n");
  const lines: LeaseWitnessLine[] = [];
  let expectedPrevious = GENESIS_WITNESS_SHA256;
  const identities = new Map<string, string>();
  for (const rawLine of rawLines) {
    const parsed = parseWitnessLine(rawLine, expectedPrevious);
    if (!parsed.ok) {
      return { ok: false, reasonCodes: parsed.reasonCodes };
    }
    const identity = witnessIdentityKey(parsed.line);
    const existingHash = identities.get(identity);
    if (existingHash !== undefined && existingHash !== parsed.line.witnessSha256) {
      return {
        ok: false,
        reasonCodes: ["WITNESS_DUPLICATE_CONFLICT", "LEASE_AUTHORITY_UNPROVEN"],
      };
    }
    identities.set(identity, parsed.line.witnessSha256);
    lines.push(parsed.line);
    expectedPrevious = parsed.line.witnessSha256;
  }
  return { ok: true, present: true, lines };
}

export function evaluateLeaseWitness(args: {
  log: WitnessLoadSuccess;
  inspection: PairInspection;
  fencingGeneration: string | null;
}): WitnessDecision {
  const latest = args.log.lines.length === 0 ? null : args.log.lines[args.log.lines.length - 1];
  if (latest === undefined) {
    return { kind: "UNPROVEN", reasonCodes: ["LEASE_AUTHORITY_UNPROVEN"] };
  }
  if (latest === null) {
    if (args.inspection.pairStatus === "BOTH_ABSENT") {
      return { kind: "ALLOW_INITIALIZE" };
    }
    return {
      kind: "MISSING",
      reasonCodes: ["WITNESS_MISSING", "LEASE_AUTHORITY_UNPROVEN"],
    };
  }

  const pairStoreGeneration = args.inspection.generation;
  const pairEnvelope = args.inspection.envelopeSha256;
  const pairProven = args.inspection.pairAuthorityProven;

  if (isOlderThanWitnessed(args.fencingGeneration, latest.fencingGeneration)) {
    return {
      kind: "ROLLBACK",
      reasonCodes: ["LEASE_ROLLBACK_DETECTED", "LEASE_AUTHORITY_UNPROVEN"],
    };
  }
  if (isOlderThanWitnessed(pairStoreGeneration, latest.leaseStoreGeneration)) {
    return {
      kind: "ROLLBACK",
      reasonCodes: ["LEASE_ROLLBACK_DETECTED", "LEASE_AUTHORITY_UNPROVEN"],
    };
  }

  if (latest.status === "PREPARE") {
    if (
      pairProven &&
      pairEnvelope === latest.targetEnvelopeSha256 &&
      pairStoreGeneration === latest.leaseStoreGeneration &&
      args.fencingGeneration === latest.fencingGeneration
    ) {
      return {
        kind: "INCOMPLETE_FINALIZATION",
        prepare: latest,
        reasonCodes: ["INCOMPLETE_WITNESS_FINALIZATION", "LEASE_AUTHORITY_UNPROVEN"],
      };
    }
    return {
      kind: "PREPARE_UNMATCHED",
      reasonCodes: ["WITNESS_PREPARE_UNMATCHED", "LEASE_AUTHORITY_UNPROVEN"],
    };
  }

  if (!pairProven || pairEnvelope === null || pairStoreGeneration === null) {
    return {
      kind: "UNPROVEN",
      reasonCodes: ["LEASE_AUTHORITY_UNPROVEN", "WITNESS_MISSING"],
    };
  }
  if (
    pairEnvelope === latest.targetEnvelopeSha256 &&
    pairStoreGeneration === latest.leaseStoreGeneration &&
    args.fencingGeneration === latest.fencingGeneration
  ) {
    return { kind: "ALLOW_CONTINUE", latest };
  }
  return {
    kind: "UNPROVEN",
    reasonCodes: ["LEASE_RECORD_DIVERGED", "LEASE_AUTHORITY_UNPROVEN"],
  };
}

export function buildWitnessLine(fields: {
  scopeKey: string;
  operation: LeaseWitnessOperation;
  fencingGeneration: string;
  leaseStoreGeneration: string;
  targetEnvelopeSha256: string;
  ownerId: string;
  processInstanceId: string;
  status: LeaseWitnessLineStatus;
  previousWitnessSha256: string;
  createdAt: string;
}): { ok: true; line: LeaseWitnessLine; bytes: Buffer } | { ok: false; reasonCodes: string[] } {
  const unsigned = {
    schemaVersion: LEASE_WITNESS_SCHEMA_VERSION,
    scopeKey: fields.scopeKey,
    operation: fields.operation,
    fencingGeneration: fields.fencingGeneration,
    leaseStoreGeneration: fields.leaseStoreGeneration,
    targetEnvelopeSha256: fields.targetEnvelopeSha256,
    ownerId: fields.ownerId,
    processInstanceId: fields.processInstanceId,
    status: fields.status,
    previousWitnessSha256: fields.previousWitnessSha256,
    createdAt: fields.createdAt,
  };
  const fieldError = validateUnsignedWitness(unsigned);
  if (fieldError !== null) {
    return { ok: false, reasonCodes: fieldError };
  }
  let hashInput: Buffer;
  try {
    hashInput = canonicalSerialize(unsigned);
  } catch (error) {
    return { ok: false, reasonCodes: [canonicalFailureCode(error), "WITNESS_MALFORMED"] };
  }
  const line: LeaseWitnessLine = {
    ...unsigned,
    schemaVersion: 1,
    witnessSha256: sha256HexBytes(hashInput),
  };
  try {
    const body = canonicalSerialize(line);
    return { ok: true, line, bytes: Buffer.concat([body, Buffer.from("\n", "utf8")]) };
  } catch (error) {
    return { ok: false, reasonCodes: [canonicalFailureCode(error), "WITNESS_MALFORMED"] };
  }
}

export async function appendLeaseWitnessLine(request: {
  directory: string;
  scopeKey: string;
  operation: LeaseWitnessOperation;
  fencingGeneration: string;
  leaseStoreGeneration: string;
  targetEnvelopeSha256: string;
  ownerId: string;
  processInstanceId: string;
  status: LeaseWitnessLineStatus;
  createdAt: string;
}): Promise<WitnessAppendSuccess | WitnessAppendFailure> {
  const loaded = await loadLeaseWitnessLog(request.directory);
  if (!loaded.ok) {
    return loaded;
  }
  const lastLine = loaded.lines.length === 0 ? undefined : loaded.lines[loaded.lines.length - 1];
  const previousWitnessSha256 =
    lastLine === undefined ? GENESIS_WITNESS_SHA256 : lastLine.witnessSha256;
  const built = buildWitnessLine({
    scopeKey: request.scopeKey,
    operation: request.operation,
    fencingGeneration: request.fencingGeneration,
    leaseStoreGeneration: request.leaseStoreGeneration,
    targetEnvelopeSha256: request.targetEnvelopeSha256,
    ownerId: request.ownerId,
    processInstanceId: request.processInstanceId,
    status: request.status,
    previousWitnessSha256,
    createdAt: request.createdAt,
  });
  if (!built.ok) {
    return built;
  }
  if (lastLine !== undefined) {
    const last = lastLine;
    const lastBuilt = buildWitnessLine({
      scopeKey: last.scopeKey,
      operation: last.operation,
      fencingGeneration: last.fencingGeneration,
      leaseStoreGeneration: last.leaseStoreGeneration,
      targetEnvelopeSha256: last.targetEnvelopeSha256,
      ownerId: last.ownerId,
      processInstanceId: last.processInstanceId,
      status: last.status,
      previousWitnessSha256: last.previousWitnessSha256,
      createdAt: last.createdAt,
    });
    if (lastBuilt.ok && lastBuilt.bytes.equals(built.bytes)) {
      return { ok: true, line: last, idempotent: true };
    }
  }
  const identity = witnessIdentityKey(built.line);
  for (const existing of loaded.lines) {
    if (
      witnessIdentityKey(existing) === identity &&
      existing.witnessSha256 !== built.line.witnessSha256
    ) {
      return {
        ok: false,
        reasonCodes: ["WITNESS_DUPLICATE_CONFLICT", "LEASE_AUTHORITY_UNPROVEN"],
      };
    }
  }
  try {
    const handle = await open(
      leaseWitnessPath(request.directory),
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY,
      FILE_MODE,
    );
    try {
      await writeAllBytes(handle, built.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const dirHandle = await open(request.directory, fsConstants.O_RDONLY);
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    return { ok: false, reasonCodes: ["WITNESS_IO_FAILURE", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  return { ok: true, line: built.line, idempotent: false };
}

export async function applyWitnessFaultHookForTests(window: WitnessFaultWindow): Promise<void> {
  const configured = witnessFaultHookForTests;
  if (configured === null || configured.window !== window) {
    return;
  }
  const readyFilePath = configured.readyFilePath;
  if (typeof readyFilePath !== "string" || readyFilePath.length === 0) {
    throw new Error("WITNESS_FAULT_HOOK_MISSING_READY_PATH");
  }
  writeFileSync(readyFilePath, `${window}\n`, { encoding: "utf8" });
  if (typeof process.send === "function") {
    process.send({ type: "WITNESS_HOOK_REACHED", window });
  }
  setInterval(() => {
    // Keep the event loop alive until the parent sends SIGKILL.
  }, 60_000);
  await new Promise<never>(() => {
    // Parent sends SIGKILL.
  });
}

export async function seedWitnessCommitForTests(request: {
  directory: string;
  scopeKey: string;
  operation: LeaseWitnessOperation;
  fencingGeneration: string;
  leaseStoreGeneration: string;
  targetEnvelopeSha256: string;
  ownerId: string;
  processInstanceId: string;
  createdAt: string;
}): Promise<LeaseWitnessLine> {
  const appended = await appendLeaseWitnessLine({
    ...request,
    status: "COMMIT",
  });
  if (!appended.ok) {
    throw new Error(`seedWitnessCommitForTests failed: ${appended.reasonCodes.join(",")}`);
  }
  return appended.line;
}

function parseWitnessLine(
  rawLine: string,
  expectedPrevious: string,
): { ok: true; line: LeaseWitnessLine } | { ok: false; reasonCodes: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return { ok: false, reasonCodes: ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reasonCodes: ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some((key) => SECRET_KEY_PATTERN.test(key))) {
    return { ok: false, reasonCodes: ["WITNESS_SECRET_PROHIBITED", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  if (
    keys.length !== WITNESS_LINE_KEYS.length ||
    keys.some((key, index) => key !== WITNESS_LINE_KEYS[index])
  ) {
    return { ok: false, reasonCodes: ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  const unsigned = {
    schemaVersion: record.schemaVersion,
    scopeKey: record.scopeKey,
    operation: record.operation,
    fencingGeneration: record.fencingGeneration,
    leaseStoreGeneration: record.leaseStoreGeneration,
    targetEnvelopeSha256: record.targetEnvelopeSha256,
    ownerId: record.ownerId,
    processInstanceId: record.processInstanceId,
    status: record.status,
    previousWitnessSha256: record.previousWitnessSha256,
    createdAt: record.createdAt,
  };
  const fieldError = validateUnsignedWitness(unsigned);
  if (fieldError !== null) {
    return { ok: false, reasonCodes: fieldError };
  }
  if (unsigned.previousWitnessSha256 !== expectedPrevious) {
    return { ok: false, reasonCodes: ["WITNESS_HASH_CONFLICT", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  let hashInput: Buffer;
  try {
    hashInput = canonicalSerialize(unsigned);
  } catch (error) {
    return { ok: false, reasonCodes: [canonicalFailureCode(error), "WITNESS_MALFORMED"] };
  }
  const expectedHash = sha256HexBytes(hashInput);
  if (typeof record.witnessSha256 !== "string" || record.witnessSha256 !== expectedHash) {
    return { ok: false, reasonCodes: ["WITNESS_HASH_CONFLICT", "LEASE_AUTHORITY_UNPROVEN"] };
  }
  const line: LeaseWitnessLine = {
    schemaVersion: 1,
    scopeKey: unsigned.scopeKey as string,
    operation: unsigned.operation as LeaseWitnessOperation,
    fencingGeneration: unsigned.fencingGeneration as string,
    leaseStoreGeneration: unsigned.leaseStoreGeneration as string,
    targetEnvelopeSha256: unsigned.targetEnvelopeSha256 as string,
    ownerId: unsigned.ownerId as string,
    processInstanceId: unsigned.processInstanceId as string,
    status: unsigned.status as LeaseWitnessLineStatus,
    previousWitnessSha256: unsigned.previousWitnessSha256 as string,
    witnessSha256: expectedHash,
    createdAt: unsigned.createdAt as string,
  };
  try {
    const canonicalBytes = canonicalSerialize(line);
    if (canonicalBytes.toString("utf8") !== rawLine) {
      return { ok: false, reasonCodes: ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"] };
    }
  } catch (error) {
    return { ok: false, reasonCodes: [canonicalFailureCode(error), "WITNESS_MALFORMED"] };
  }
  return { ok: true, line };
}

function validateUnsignedWitness(value: {
  schemaVersion: unknown;
  scopeKey: unknown;
  operation: unknown;
  fencingGeneration: unknown;
  leaseStoreGeneration: unknown;
  targetEnvelopeSha256: unknown;
  ownerId: unknown;
  processInstanceId: unknown;
  status: unknown;
  previousWitnessSha256: unknown;
  createdAt: unknown;
}): string[] | null {
  if (value.schemaVersion !== LEASE_WITNESS_SCHEMA_VERSION) {
    return ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"];
  }
  if (typeof value.scopeKey !== "string" || !SCOPE_PATTERN.test(value.scopeKey)) {
    return ["WITNESS_MALFORMED", "SCOPE_MISMATCH"];
  }
  if (
    typeof value.operation !== "string" ||
    !OPERATIONS.has(value.operation as LeaseWitnessOperation)
  ) {
    return ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"];
  }
  if (
    typeof value.status !== "string" ||
    !LINE_STATUSES.has(value.status as LeaseWitnessLineStatus)
  ) {
    return ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"];
  }
  if (
    typeof value.fencingGeneration !== "string" ||
    !isCanonicalGenerationString(value.fencingGeneration)
  ) {
    return ["WITNESS_MALFORMED", "LEASE_GENERATION_MISMATCH"];
  }
  if (
    typeof value.leaseStoreGeneration !== "string" ||
    !isCanonicalGenerationString(value.leaseStoreGeneration)
  ) {
    return ["WITNESS_MALFORMED", "LEASE_GENERATION_MISMATCH"];
  }
  if (
    typeof value.targetEnvelopeSha256 !== "string" ||
    !isLowerHexSha256(value.targetEnvelopeSha256)
  ) {
    return ["WITNESS_MALFORMED", "LEASE_AUTHORITY_UNPROVEN"];
  }
  if (typeof value.ownerId !== "string" || !OWNER_ID_PATTERN.test(value.ownerId)) {
    return ["WITNESS_MALFORMED", "INVALID_OWNER_ID"];
  }
  if (
    typeof value.processInstanceId !== "string" ||
    !OWNER_ID_PATTERN.test(value.processInstanceId)
  ) {
    return ["WITNESS_MALFORMED", "INVALID_PROCESS_INSTANCE_ID"];
  }
  if (
    typeof value.previousWitnessSha256 !== "string" ||
    !isLowerHexSha256(value.previousWitnessSha256)
  ) {
    return ["WITNESS_HASH_CONFLICT", "LEASE_AUTHORITY_UNPROVEN"];
  }
  if (typeof value.createdAt !== "string" || !TIMESTAMP_PATTERN.test(value.createdAt)) {
    return ["WITNESS_MALFORMED", "MALFORMED_TIMESTAMP"];
  }
  return null;
}

function witnessIdentityKey(line: LeaseWitnessLine): string {
  return [
    line.scopeKey,
    line.operation,
    line.fencingGeneration,
    line.leaseStoreGeneration,
    line.status,
  ].join("\0");
}

function isOlderThanWitnessed(actual: string | null, witnessed: string): boolean {
  if (actual === null) {
    return false;
  }
  try {
    return BigInt(actual) < BigInt(witnessed);
  } catch {
    return true;
  }
}

async function writeAllBytes(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) {
      throw new Error("WITNESS_ZERO_BYTE_WRITE");
    }
    offset += result.bytesWritten;
  }
}

function decodeUtf8Fatal(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function canonicalFailureCode(error: unknown): string {
  if (error instanceof CanonicalJsonError && error.reasonCode === "DANGEROUS_OBJECT_KEY") {
    return "DANGEROUS_OBJECT_KEY";
  }
  return "CANONICALIZATION_REJECTED";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
