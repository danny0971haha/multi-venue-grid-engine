import type { Buffer } from "node:buffer";
import { constants as fsConstants, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";

export const TELEMETRY_FILE_MODE = 0o600;

export type TelemetryFaultWindow =
  | "MANIFEST_BEFORE_SYNC"
  | "EVENT_BEFORE_WRITE"
  | "EVENT_BEFORE_SYNC";

export type TelemetryFaultHook =
  | { window: TelemetryFaultWindow; action: "FAIL" }
  | { window: TelemetryFaultWindow; action: "NOTIFY_AND_WAIT"; readyFilePath: string };

let telemetryFaultHookForTests: TelemetryFaultHook | null = null;

export function setTelemetryFaultHookForTests(hook: TelemetryFaultHook | null): void {
  telemetryFaultHookForTests = hook;
}

export async function applyTelemetryFaultHook(window: TelemetryFaultWindow): Promise<void> {
  const configured = telemetryFaultHookForTests;
  if (configured === null || configured.window !== window) {
    return;
  }
  if (configured.action === "FAIL") {
    throw new Error(`TELEMETRY_FAULT_INJECTED:${window}`);
  }
  writeFileSync(configured.readyFilePath, `${window}\n`, { encoding: "utf8" });
  setInterval(() => {
    // Keep the event loop alive until the parent sends SIGKILL.
  }, 60_000);
  await new Promise<never>(() => {
    // Parent sends SIGKILL.
  });
}

export async function writeAllBytes(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) {
      throw new Error("TELEMETRY_ZERO_BYTE_WRITE");
    }
    offset += result.bytesWritten;
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function decodeUtf8Fatal(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

// Value patterns catch well-known credential shapes only. A bare 0x-prefixed 64-hex signing key
// is indistinguishable from a transaction hash, so adapters must never hand signing material to
// telemetry in the first place.
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
];

export function matchesSecretValuePattern(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}
