import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { CanonicalJsonError, canonicalSerialize } from "./canonical-json.js";

export const SUPPORTED_SCHEMA_VERSION = 1;

const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const GENERATION_PATTERN = /^[1-9][0-9]{0,38}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const ENVELOPE_TOP_LEVEL_KEYS = new Set([
  "envelopeSha256",
  "kind",
  "payload",
  "payloadSha256",
  "previousEnvelopeSha256",
  "schemaVersion",
  "scopeKey",
  "storeGeneration",
]);

const ENVELOPE_REASON_ORDER = [
  "PAYLOAD_HASH_MISMATCH",
  "ENVELOPE_HASH_MISMATCH",
  "NON_CANONICAL_BYTES",
  "UNSUPPORTED_SCHEMA",
  "INVALID_GENERATION",
  "INVALID_PREVIOUS_HASH",
  "MALFORMED_JSON",
  "UNKNOWN_TOP_LEVEL_FIELD",
  "INVALID_KIND",
  "INVALID_SCOPE",
  "CANONICALIZATION_REJECTED",
  "DANGEROUS_OBJECT_KEY",
] as const;

export class EnvelopeValidationError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "EnvelopeValidationError";
    this.reasonCode = reasonCode;
  }
}

export type DurableEnvelope<T> = {
  schemaVersion: number;
  kind: string;
  scopeKey: string;
  storeGeneration: string;
  previousEnvelopeSha256: string | null;
  payloadSha256: string;
  payload: T;
  envelopeSha256: string;
};

export type DurableEnvelopeFields<T> = {
  schemaVersion: number;
  kind: string;
  scopeKey: string;
  storeGeneration: string;
  previousEnvelopeSha256: string | null;
  payload: T;
};

export type BuiltDurableEnvelope<T> = {
  envelope: DurableEnvelope<T>;
  payloadCanonicalBytes: Buffer;
  envelopeHashInputBytes: Buffer;
  fullEnvelopeBytes: Buffer;
};

export type EnvelopeParseSuccess<T> = {
  ok: true;
  envelope: DurableEnvelope<T>;
  canonicalBytes: Buffer;
};

export type EnvelopeParseFailure = {
  ok: false;
  reasonCodes: string[];
};

export function sha256HexBytes(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isCanonicalGenerationString(value: string): boolean {
  return GENERATION_PATTERN.test(value);
}

export function isLowerHexSha256(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

export function buildDurableEnvelope<T>(fields: DurableEnvelopeFields<T>): BuiltDurableEnvelope<T> {
  const reasonCode = validateEnvelopeFields(fields);
  if (reasonCode !== null) {
    throw new EnvelopeValidationError(reasonCode);
  }

  const payloadCanonicalBytes = canonicalSerialize(fields.payload);
  const payloadSha256 = sha256HexBytes(payloadCanonicalBytes);
  const envelopeHashInput = {
    schemaVersion: fields.schemaVersion,
    kind: fields.kind,
    scopeKey: fields.scopeKey,
    storeGeneration: fields.storeGeneration,
    previousEnvelopeSha256: fields.previousEnvelopeSha256,
    payloadSha256,
    payload: fields.payload,
  };
  const envelopeHashInputBytes = canonicalSerialize(envelopeHashInput);
  const envelopeSha256 = sha256HexBytes(envelopeHashInputBytes);
  const payload = JSON.parse(payloadCanonicalBytes.toString("utf8")) as T;
  const envelope: DurableEnvelope<T> = {
    schemaVersion: fields.schemaVersion,
    kind: fields.kind,
    scopeKey: fields.scopeKey,
    storeGeneration: fields.storeGeneration,
    previousEnvelopeSha256: fields.previousEnvelopeSha256,
    payloadSha256,
    payload,
    envelopeSha256,
  };
  return {
    envelope,
    payloadCanonicalBytes,
    envelopeHashInputBytes,
    fullEnvelopeBytes: canonicalSerialize(envelope),
  };
}

export function parseAndValidateDurableEnvelope(
  rawBytes: Buffer | Uint8Array,
): EnvelopeParseSuccess<unknown> | EnvelopeParseFailure {
  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const reasonCodes: string[] = [];
  const text = decodeUtf8Fatal(bytes);
  if (text === null) {
    return fail(["MALFORMED_JSON"]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(["MALFORMED_JSON"]);
  }

  if (!isPlainRecord(parsed)) {
    return fail(["MALFORMED_JSON"]);
  }

  const keys = Object.keys(parsed);
  if (keys.some((key) => !ENVELOPE_TOP_LEVEL_KEYS.has(key))) {
    reasonCodes.push("UNKNOWN_TOP_LEVEL_FIELD");
  }
  if (keys.some((key) => key === "__proto__" || key === "prototype" || key === "constructor")) {
    reasonCodes.push("DANGEROUS_OBJECT_KEY");
  }

  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    reasonCodes.push("UNSUPPORTED_SCHEMA");
  }
  if (typeof parsed.kind !== "string" || !KIND_PATTERN.test(parsed.kind)) {
    reasonCodes.push("INVALID_KIND");
  }
  if (typeof parsed.scopeKey !== "string" || !SCOPE_PATTERN.test(parsed.scopeKey)) {
    reasonCodes.push("INVALID_SCOPE");
  }
  if (typeof parsed.storeGeneration !== "string" || !GENERATION_PATTERN.test(parsed.storeGeneration)) {
    reasonCodes.push("INVALID_GENERATION");
  }
  if (!previousHashMatchesGeneration(parsed.storeGeneration, parsed.previousEnvelopeSha256)) {
    reasonCodes.push("INVALID_PREVIOUS_HASH");
  }
  if (typeof parsed.payloadSha256 !== "string" || !SHA256_HEX_PATTERN.test(parsed.payloadSha256)) {
    reasonCodes.push("PAYLOAD_HASH_MISMATCH");
  }
  if (typeof parsed.envelopeSha256 !== "string" || !SHA256_HEX_PATTERN.test(parsed.envelopeSha256)) {
    reasonCodes.push("ENVELOPE_HASH_MISMATCH");
  }
  if (!Object.hasOwn(parsed, "payload")) {
    reasonCodes.push("MALFORMED_JSON");
  }

  let payloadCanonicalBytes: Buffer | null = null;
  try {
    payloadCanonicalBytes = canonicalSerialize(parsed.payload);
  } catch (error) {
    reasonCodes.push(canonicalFailureCode(error));
  }

  if (payloadCanonicalBytes !== null && typeof parsed.payloadSha256 === "string") {
    if (sha256HexBytes(payloadCanonicalBytes) !== parsed.payloadSha256) {
      reasonCodes.push("PAYLOAD_HASH_MISMATCH");
    }
  }

  if (payloadCanonicalBytes !== null) {
    try {
      const envelopeHashInputBytes = canonicalSerialize({
        schemaVersion: parsed.schemaVersion,
        kind: parsed.kind,
        scopeKey: parsed.scopeKey,
        storeGeneration: parsed.storeGeneration,
        previousEnvelopeSha256: parsed.previousEnvelopeSha256,
        payloadSha256: parsed.payloadSha256,
        payload: parsed.payload,
      });
      if (
        typeof parsed.envelopeSha256 === "string" &&
        sha256HexBytes(envelopeHashInputBytes) !== parsed.envelopeSha256
      ) {
        reasonCodes.push("ENVELOPE_HASH_MISMATCH");
      }
    } catch (error) {
      reasonCodes.push(canonicalFailureCode(error));
    }
  }

  try {
    const canonicalBytes = canonicalSerialize(parsed);
    if (!canonicalBytes.equals(bytes)) {
      reasonCodes.push("NON_CANONICAL_BYTES");
    }
  } catch (error) {
    reasonCodes.push(canonicalFailureCode(error));
  }

  const ordered = uniqueOrdered(reasonCodes, ENVELOPE_REASON_ORDER);
  if (ordered.length > 0) {
    return fail(ordered);
  }

  if (
    parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION ||
    typeof parsed.kind !== "string" ||
    typeof parsed.scopeKey !== "string" ||
    typeof parsed.storeGeneration !== "string" ||
    typeof parsed.payloadSha256 !== "string" ||
    typeof parsed.envelopeSha256 !== "string" ||
    payloadCanonicalBytes === null
  ) {
    return fail(["MALFORMED_JSON"]);
  }

  return {
    ok: true,
    envelope: {
      schemaVersion: parsed.schemaVersion,
      kind: parsed.kind,
      scopeKey: parsed.scopeKey,
      storeGeneration: parsed.storeGeneration,
      previousEnvelopeSha256:
        parsed.previousEnvelopeSha256 === null ? null : String(parsed.previousEnvelopeSha256),
      payloadSha256: parsed.payloadSha256,
      payload: JSON.parse(payloadCanonicalBytes.toString("utf8")),
      envelopeSha256: parsed.envelopeSha256,
    },
    canonicalBytes: bytes,
  };
}

function validateEnvelopeFields<T>(fields: DurableEnvelopeFields<T>): string | null {
  if (fields.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return "UNSUPPORTED_SCHEMA";
  }
  if (!KIND_PATTERN.test(fields.kind)) {
    return "INVALID_KIND";
  }
  if (!SCOPE_PATTERN.test(fields.scopeKey)) {
    return "INVALID_SCOPE";
  }
  if (!GENERATION_PATTERN.test(fields.storeGeneration)) {
    return "INVALID_GENERATION";
  }
  if (!previousHashMatchesGeneration(fields.storeGeneration, fields.previousEnvelopeSha256)) {
    return "INVALID_PREVIOUS_HASH";
  }
  return null;
}

function previousHashMatchesGeneration(
  storeGeneration: unknown,
  previousEnvelopeSha256: unknown,
): boolean {
  if (typeof storeGeneration !== "string" || !GENERATION_PATTERN.test(storeGeneration)) {
    return previousEnvelopeSha256 === null || typeof previousEnvelopeSha256 === "string";
  }
  if (storeGeneration === "1") {
    return previousEnvelopeSha256 === null;
  }
  return typeof previousEnvelopeSha256 === "string" && SHA256_HEX_PATTERN.test(previousEnvelopeSha256);
}

function decodeUtf8Fatal(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalFailureCode(error: unknown): string {
  if (error instanceof CanonicalJsonError && error.reasonCode === "DANGEROUS_OBJECT_KEY") {
    return "DANGEROUS_OBJECT_KEY";
  }
  return "CANONICALIZATION_REJECTED";
}

function uniqueOrdered(codes: readonly string[], order: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map(order.map((code, index) => [code, index]));
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

function fail(reasonCodes: string[]): EnvelopeParseFailure {
  return { ok: false, reasonCodes };
}
