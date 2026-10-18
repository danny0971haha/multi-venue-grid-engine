import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { EXPERIMENT_SPEC_VERSION, type RuntimeMode } from "../bootstrap/runtimeMode.js";
import { V01_EXPERIMENT_CONFIG } from "../domain/config.js";
import { parseScopeKey } from "../domain/ids.js";
import type { ExperimentConfig } from "../domain/types.js";
import { canonicalSerialize } from "../persistence/canonical-json.js";
import { sha256HexBytes } from "../persistence/durable-envelope.js";
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

export const RUN_MANIFEST_FILE_NAME = "manifest.json";
export const RUN_MANIFEST_SCHEMA_VERSION = 1;

// The manifest is evidence that a run used the frozen envelope (RISK_PERSISTENCE_CONTRACT §24).
// It is written exactly once, exclusively, before any event and is never rewritten: a restart
// loads it, and a run with different values needs a new spec version and a new run directory.
export type RunManifest = {
  schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  specVersion: typeof EXPERIMENT_SPEC_VERSION;
  experimentId: string;
  runId: string;
  commitSha: string;
  mode: RuntimeMode;
  scopeKey: string;
  venue: string;
  market: string;
  envelope: ExperimentConfig;
  startedAt: string;
};

export type RunManifestInput = {
  experimentId: string;
  runId: string;
  commitSha: string;
  mode: RuntimeMode;
  scopeKey: string;
  envelope: ExperimentConfig;
  startedAt: string;
};

export type ManifestSuccess = {
  ok: true;
  manifest: RunManifest;
  manifestSha256: string;
};

export type ManifestFailure = { ok: false; reasonCodes: string[] };

const MANIFEST_KEYS = [
  "commitSha",
  "envelope",
  "experimentId",
  "market",
  "mode",
  "runId",
  "schemaVersion",
  "scopeKey",
  "specVersion",
  "startedAt",
  "venue",
] as const;

const RUN_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_MANIFEST_BYTES = 8 * 1024;
const FROZEN_ENVELOPE_BYTES = canonicalSerialize(V01_EXPERIMENT_CONFIG);

export function runManifestPath(directory: string): string {
  return path.join(directory, RUN_MANIFEST_FILE_NAME);
}

export async function writeRunManifest(
  directory: string,
  input: RunManifestInput,
): Promise<ManifestSuccess | ManifestFailure> {
  const built = buildManifest(input);
  if (!built.ok) {
    return built;
  }
  const bytes = Buffer.concat([canonicalSerialize(built.manifest), Buffer.from("\n")]);
  const filePath = runManifestPath(directory);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      TELEMETRY_FILE_MODE,
    );
  } catch (error) {
    return fail(hasErrorCode(error, "EEXIST") ? "MANIFEST_ALREADY_EXISTS" : "MANIFEST_IO_FAILURE");
  }
  try {
    try {
      await writeAllBytes(handle, bytes);
      await applyTelemetryFaultHook("MANIFEST_BEFORE_SYNC");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(directory);
  } catch {
    // Best-effort removal of the uncommitted manifest. If removal also fails, any bytes left
    // behind still have to pass loadRunManifest; a torn manifest fails every later open.
    await unlink(filePath).catch(() => undefined);
    return fail("MANIFEST_IO_FAILURE");
  }
  const readBack = await loadRunManifest(directory);
  if (!readBack.ok) {
    return readBack;
  }
  if (readBack.manifestSha256 !== sha256HexBytes(bytes)) {
    return fail("MANIFEST_READBACK_MISMATCH");
  }
  return readBack;
}

export async function loadRunManifest(
  directory: string,
): Promise<ManifestSuccess | ManifestFailure> {
  let bytes: Buffer;
  try {
    bytes = await readFile(runManifestPath(directory));
  } catch (error) {
    return fail(hasErrorCode(error, "ENOENT") ? "MANIFEST_MISSING" : "MANIFEST_IO_FAILURE");
  }
  if (bytes.length > MAX_MANIFEST_BYTES) {
    return fail("MANIFEST_MALFORMED");
  }
  const text = decodeUtf8Fatal(bytes);
  if (text === null || !text.endsWith("\n")) {
    return fail("MANIFEST_MALFORMED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    return fail("MANIFEST_MALFORMED");
  }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, MANIFEST_KEYS)) {
    return fail("MANIFEST_MALFORMED");
  }
  const rebuilt = buildManifest({
    experimentId: parsed.experimentId as string,
    runId: parsed.runId as string,
    commitSha: parsed.commitSha as string,
    mode: parsed.mode as RuntimeMode,
    scopeKey: parsed.scopeKey as string,
    envelope: parsed.envelope as ExperimentConfig,
    startedAt: parsed.startedAt as string,
  });
  if (!rebuilt.ok) {
    return rebuilt;
  }
  // Every stored field must equal its rebuilt value, byte for byte.
  if (!bytes.equals(canonicalManifestBytes(rebuilt.manifest))) {
    return fail("MANIFEST_MALFORMED");
  }
  return { ok: true, manifest: rebuilt.manifest, manifestSha256: sha256HexBytes(bytes) };
}

function buildManifest(
  input: RunManifestInput,
): { ok: true; manifest: RunManifest } | ManifestFailure {
  if (
    typeof input.experimentId !== "string" ||
    !RUN_IDENTITY_PATTERN.test(input.experimentId) ||
    typeof input.runId !== "string" ||
    !RUN_IDENTITY_PATTERN.test(input.runId)
  ) {
    return fail("MANIFEST_RUN_IDENTITY_INVALID");
  }
  if (typeof input.commitSha !== "string" || !COMMIT_SHA_PATTERN.test(input.commitSha)) {
    return fail("MANIFEST_COMMIT_SHA_INVALID");
  }
  if (input.mode !== "DRY_RUN" && input.mode !== "LIVE") {
    return fail("MANIFEST_MODE_INVALID");
  }
  if (!isIsoTimestamp(input.startedAt)) {
    return fail("MANIFEST_STARTED_AT_INVALID");
  }
  let scope: ReturnType<typeof parseScopeKey>;
  try {
    scope = parseScopeKey(input.scopeKey);
  } catch {
    return fail("MANIFEST_SCOPE_INVALID");
  }
  let envelopeBytes: Buffer;
  try {
    envelopeBytes = canonicalSerialize(input.envelope);
  } catch {
    return fail("MANIFEST_ENVELOPE_MISMATCH");
  }
  if (!envelopeBytes.equals(FROZEN_ENVELOPE_BYTES)) {
    return fail("MANIFEST_ENVELOPE_MISMATCH");
  }
  const manifest: RunManifest = {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    specVersion: EXPERIMENT_SPEC_VERSION,
    experimentId: input.experimentId,
    runId: input.runId,
    commitSha: input.commitSha,
    mode: input.mode,
    scopeKey: input.scopeKey,
    venue: scope.venue,
    market: scope.market,
    envelope: { ...V01_EXPERIMENT_CONFIG },
    startedAt: input.startedAt,
  };
  // Shared by write and load, so a secret-shaped identity is neither written nor trusted.
  for (const value of Object.values(manifest)) {
    if (typeof value === "string" && matchesSecretValuePattern(value)) {
      return fail("MANIFEST_SECRET_PROHIBITED");
    }
  }
  return { ok: true, manifest };
}

function canonicalManifestBytes(manifest: RunManifest): Buffer {
  return Buffer.concat([canonicalSerialize(manifest), Buffer.from("\n")]);
}

function fail(code: string): ManifestFailure {
  return { ok: false, reasonCodes: [code, "TELEMETRY_EVIDENCE_UNAVAILABLE"] };
}
