import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalSerialize } from "../persistence/canonical-json.js";
import {
  isCanonicalGenerationString,
  isLowerHexSha256,
  sha256HexBytes,
} from "../persistence/durable-envelope.js";
import {
  applyTelemetryFaultHook,
  decodeUtf8Fatal,
  fsyncDirectory,
  hasErrorCode,
  hasExactKeys,
  isIsoTimestamp,
  isPlainRecord,
  matchesSecretValuePattern,
  TELEMETRY_FILE_MODE,
  writeAllBytes,
} from "./io.js";
import { loadRunManifest, type RunManifest } from "./manifest.js";

export const TELEMETRY_EVENTS_FILE_NAME = "events.jsonl";
export const TELEMETRY_EVENT_SCHEMA_VERSION = 1 as const;
export const GENESIS_EVENT_SHA256 = "0".repeat(64);

export const TELEMETRY_EVENT_TYPES = [
  "BOOT",
  "SNAPSHOT",
  "INTENT_CREATED",
  "ORDER_SUBMIT",
  "ORDER_ACK",
  "ORDER_REJECT",
  "ORDER_CANCEL_REQUEST",
  "ORDER_CANCEL_CONFIRMED",
  "EXECUTION_OBSERVED",
  "PARTIAL_FILL",
  "FILL",
  "RECONCILIATION",
  "ORPHAN_ORDER",
  "RISK_DECISION",
  "REDUCTION_REQUEST",
  "REDUCTION_VERIFIED",
  "RISK_HALT",
  "RESTART",
  "LEASE_LOST",
  "FATAL_ERROR",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

// AUTHORITATIVE: observed from the exchange or durable engine state.
// INFERRED: derived by the engine without direct observation.
// SIMULATED: produced by the offline simulator (DRY_RUN only).
export type TelemetryProvenance = "AUTHORITATIVE" | "INFERRED" | "SIMULATED";

export type TelemetryEventLine = {
  schemaVersion: typeof TELEMETRY_EVENT_SCHEMA_VERSION;
  runId: string;
  manifestSha256: string;
  sequence: string;
  eventType: TelemetryEventType;
  provenance: TelemetryProvenance;
  source: string;
  recordedAt: string;
  payload: Record<string, unknown>;
  previousEventSha256: string;
  eventSha256: string;
};

export type TelemetryEventInput = {
  eventType: TelemetryEventType;
  provenance: TelemetryProvenance;
  source: string;
  payload: Record<string, unknown>;
};

export type TelemetryAppendResult =
  | { ok: true; line: TelemetryEventLine }
  | { ok: false; reasonCodes: string[] };

export type TelemetryOpenResult =
  | { ok: true; log: TelemetryLog }
  | { ok: false; reasonCodes: string[] };

const EVENT_LINE_KEYS = [
  "eventSha256",
  "eventType",
  "manifestSha256",
  "payload",
  "previousEventSha256",
  "provenance",
  "recordedAt",
  "runId",
  "schemaVersion",
  "sequence",
  "source",
] as const;

const EVENT_TYPES = new Set<string>(TELEMETRY_EVENT_TYPES);
const PROVENANCES = new Set<string>(["AUTHORITATIVE", "INFERRED", "SIMULATED"]);
const FILL_EVENT_TYPES = new Set<string>(["FILL", "PARTIAL_FILL"]);
const SOURCE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const MAX_EVENT_LINE_BYTES = 64 * 1024;
const PAYLOAD_LIMITS = {
  maxDepth: 8,
  maxNodes: 2_000,
  maxCollectionLength: 256,
  maxObjectProperties: 64,
  maxStringChars: 4_096,
  maxObjectKeyChars: 64,
};

const SECRET_KEY_PATTERN =
  /secret|password|passphrase|token|apikey|api[_-]?key|private[_-]?key|credential|authorization|bearer|mnemonic|seed[_-]?phrase/i;

export function telemetryEventsPath(directory: string): string {
  return path.join(directory, TELEMETRY_EVENTS_FILE_NAME);
}

/**
 * Opens the run's append-only event log. Requires a valid run manifest and a fully verified
 * existing chain; a torn tail or any tampering fails closed and is never repaired in place.
 */
export async function openTelemetryLog(
  directory: string,
  options: { clock?: () => string } = {},
): Promise<TelemetryOpenResult> {
  const manifest = await loadRunManifest(directory);
  if (!manifest.ok) {
    return manifest;
  }
  const filePath = telemetryEventsPath(directory);
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      return fail("TELEMETRY_IO_FAILURE");
    }
    try {
      const handle = await open(
        filePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        TELEMETRY_FILE_MODE,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(directory);
    } catch {
      return fail("TELEMETRY_IO_FAILURE");
    }
    bytes = Buffer.alloc(0);
  }
  const parsed = parseTelemetryEventBytes(bytes, manifest.manifest, manifest.manifestSha256);
  if (!parsed.ok) {
    return parsed;
  }
  const last = parsed.lines.at(-1);
  return {
    ok: true,
    log: new TelemetryLog({
      filePath,
      manifest: manifest.manifest,
      manifestSha256: manifest.manifestSha256,
      byteLength: bytes.length,
      lineCount: parsed.lines.length,
      lastEventSha256: last === undefined ? GENESIS_EVENT_SHA256 : last.eventSha256,
      clock: options.clock ?? (() => new Date().toISOString()),
    }),
  };
}

export function parseTelemetryEventBytes(
  bytes: Buffer,
  manifest: RunManifest,
  manifestSha256: string,
): { ok: true; lines: TelemetryEventLine[] } | { ok: false; reasonCodes: string[] } {
  if (bytes.length === 0) {
    return { ok: true, lines: [] };
  }
  const text = decodeUtf8Fatal(bytes);
  if (text === null) {
    return fail("TELEMETRY_MALFORMED");
  }
  if (!text.endsWith("\n")) {
    return fail("TELEMETRY_TRUNCATED");
  }
  const lines: TelemetryEventLine[] = [];
  let previous = GENESIS_EVENT_SHA256;
  for (const rawLine of text.slice(0, -1).split("\n")) {
    const line = parseEventLine(rawLine);
    if (
      line === null ||
      line.runId !== manifest.runId ||
      line.manifestSha256 !== manifestSha256 ||
      line.sequence !== String(lines.length + 1) ||
      line.previousEventSha256 !== previous ||
      provenanceViolation(line, manifest) !== null
    ) {
      return fail("TELEMETRY_MALFORMED");
    }
    lines.push(line);
    previous = line.eventSha256;
  }
  return { ok: true, lines };
}

export class TelemetryLog {
  readonly manifest: RunManifest;
  readonly manifestSha256: string;
  readonly #filePath: string;
  readonly #clock: () => string;
  #byteLength: number;
  #lineCount: number;
  #lastEventSha256: string;
  #failedReason: string | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(state: {
    filePath: string;
    manifest: RunManifest;
    manifestSha256: string;
    byteLength: number;
    lineCount: number;
    lastEventSha256: string;
    clock: () => string;
  }) {
    this.#filePath = state.filePath;
    this.manifest = state.manifest;
    this.manifestSha256 = state.manifestSha256;
    this.#byteLength = state.byteLength;
    this.#lineCount = state.lineCount;
    this.#lastEventSha256 = state.lastEventSha256;
    this.#clock = state.clock;
  }

  get failed(): boolean {
    return this.#failedReason !== null;
  }

  get lineCount(): number {
    return this.#lineCount;
  }

  /** Appends are serialized; a failed write poisons the writer for the rest of the process. */
  append(event: TelemetryEventInput): Promise<TelemetryAppendResult> {
    const result = this.#tail.then(() => this.#appendNow(event));
    this.#tail = result;
    return result;
  }

  async #appendNow(event: TelemetryEventInput): Promise<TelemetryAppendResult> {
    if (this.#failedReason !== null) {
      return fail(this.#failedReason);
    }
    const built = this.#buildLine(event);
    if (!built.ok) {
      return built;
    }
    try {
      const handle = await open(this.#filePath, fsConstants.O_APPEND | fsConstants.O_WRONLY);
      try {
        if ((await handle.stat()).size !== this.#byteLength) {
          this.#failedReason = "TELEMETRY_EXTERNAL_MODIFICATION";
          return fail(this.#failedReason);
        }
        await applyTelemetryFaultHook("EVENT_BEFORE_WRITE");
        await writeAllBytes(handle, built.bytes);
        await applyTelemetryFaultHook("EVENT_BEFORE_SYNC");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      this.#failedReason = "TELEMETRY_WRITER_FAILED";
      return fail(this.#failedReason);
    }
    this.#byteLength += built.bytes.length;
    this.#lineCount += 1;
    this.#lastEventSha256 = built.line.eventSha256;
    return { ok: true, line: built.line };
  }

  #buildLine(
    event: TelemetryEventInput,
  ): { ok: true; line: TelemetryEventLine; bytes: Buffer } | { ok: false; reasonCodes: string[] } {
    if (!EVENT_TYPES.has(event.eventType) || !PROVENANCES.has(event.provenance)) {
      return fail("TELEMETRY_EVENT_INVALID");
    }
    if (typeof event.source !== "string" || !SOURCE_PATTERN.test(event.source)) {
      return fail("TELEMETRY_EVENT_INVALID");
    }
    if (!isPlainRecord(event.payload)) {
      return fail("TELEMETRY_EVENT_INVALID");
    }
    let payloadText: string;
    try {
      payloadText = canonicalSerialize(event.payload, PAYLOAD_LIMITS).toString("utf8");
    } catch {
      return fail("TELEMETRY_PAYLOAD_REJECTED");
    }
    // Work on a detached JSON copy so later caller mutation cannot change what was hashed.
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    if (containsSecret(payload, payloadText)) {
      return fail("TELEMETRY_SECRET_PROHIBITED");
    }
    const recordedAt = this.#clock();
    if (!isIsoTimestamp(recordedAt)) {
      return fail("TELEMETRY_CLOCK_INVALID");
    }
    const unsigned = {
      schemaVersion: TELEMETRY_EVENT_SCHEMA_VERSION,
      runId: this.manifest.runId,
      manifestSha256: this.manifestSha256,
      sequence: String(this.#lineCount + 1),
      eventType: event.eventType,
      provenance: event.provenance,
      source: event.source,
      recordedAt,
      payload,
      previousEventSha256: this.#lastEventSha256,
    };
    const line: TelemetryEventLine = {
      ...unsigned,
      eventSha256: sha256HexBytes(canonicalSerialize(unsigned)),
    };
    const violation = provenanceViolation(line, this.manifest);
    if (violation !== null) {
      return fail(violation);
    }
    const bytes = Buffer.concat([canonicalSerialize(line), Buffer.from("\n")]);
    // The whole line is checked, so source and every other persisted string share the payload
    // policy rather than only the payload.
    if (matchesSecretValuePattern(bytes.toString("utf8"))) {
      return fail("TELEMETRY_SECRET_PROHIBITED");
    }
    if (bytes.length > MAX_EVENT_LINE_BYTES) {
      return fail("TELEMETRY_PAYLOAD_REJECTED");
    }
    return { ok: true, line, bytes };
  }
}

function parseEventLine(rawLine: string): TelemetryEventLine | null {
  if (Buffer.byteLength(rawLine) + 1 > MAX_EVENT_LINE_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, EVENT_LINE_KEYS)) {
    return null;
  }
  const { eventSha256, ...unsigned } = value;
  if (
    unsigned.schemaVersion !== TELEMETRY_EVENT_SCHEMA_VERSION ||
    typeof unsigned.sequence !== "string" ||
    !isCanonicalGenerationString(unsigned.sequence) ||
    typeof unsigned.eventType !== "string" ||
    !EVENT_TYPES.has(unsigned.eventType) ||
    typeof unsigned.provenance !== "string" ||
    !PROVENANCES.has(unsigned.provenance) ||
    typeof unsigned.source !== "string" ||
    !SOURCE_PATTERN.test(unsigned.source) ||
    !isIsoTimestamp(unsigned.recordedAt) ||
    !isPlainRecord(unsigned.payload) ||
    typeof unsigned.previousEventSha256 !== "string" ||
    !isLowerHexSha256(unsigned.previousEventSha256) ||
    typeof eventSha256 !== "string" ||
    !isLowerHexSha256(eventSha256)
  ) {
    return null;
  }
  try {
    if (sha256HexBytes(canonicalSerialize(unsigned)) !== eventSha256) {
      return null;
    }
    if (canonicalSerialize(value).toString("utf8") !== rawLine) {
      return null;
    }
  } catch {
    return null;
  }
  return value as TelemetryEventLine;
}

function provenanceViolation(line: TelemetryEventLine, manifest: RunManifest): string | null {
  // Open-order disappearance or any other inference is never a fill.
  if (FILL_EVENT_TYPES.has(line.eventType) && line.provenance === "INFERRED") {
    return "TELEMETRY_INFERRED_FILL_PROHIBITED";
  }
  if (line.provenance === "SIMULATED" && manifest.mode !== "DRY_RUN") {
    return "TELEMETRY_SIMULATED_OUTSIDE_DRY_RUN";
  }
  return null;
}

function containsSecret(payload: unknown, payloadText: string): boolean {
  if (matchesSecretValuePattern(payloadText)) {
    return true;
  }
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          return true;
        }
        pending.push(child);
      }
    }
  }
  return false;
}

function fail(code: string): { ok: false; reasonCodes: string[] } {
  return { ok: false, reasonCodes: [code, "TELEMETRY_EVIDENCE_UNAVAILABLE"] };
}
