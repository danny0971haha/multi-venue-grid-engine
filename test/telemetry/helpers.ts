import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { V01_EXPERIMENT_CONFIG } from "../../src/domain/config.js";
import type {
  RunManifestInput,
  TelemetryEventInput,
  TelemetryLog,
} from "../../src/telemetry/index.js";
import {
  openTelemetryLog,
  setTelemetryFaultHookForTests,
  writeRunManifest,
} from "../../src/telemetry/index.js";

export const TELEMETRY_SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
export const STARTED_AT = "2026-10-11T00:00:00.000Z";
export const RECORDED_AT = "2026-10-11T00:00:01.000Z";

export function manifestInput(overrides: Partial<RunManifestInput> = {}): RunManifestInput {
  return {
    experimentId: "exp-phase2f",
    runId: "run-0001",
    commitSha: COMMIT_SHA,
    mode: "DRY_RUN",
    scopeKey: TELEMETRY_SCOPE_KEY,
    envelope: { ...V01_EXPERIMENT_CONFIG },
    startedAt: STARTED_AT,
    ...overrides,
  };
}

export function bootEvent(overrides: Partial<TelemetryEventInput> = {}): TelemetryEventInput {
  return {
    eventType: "BOOT",
    provenance: "AUTHORITATIVE",
    source: "engine",
    payload: { phase: "2F" },
    ...overrides,
  };
}

export async function withTelemetryDir(run: (directory: string) => Promise<void>): Promise<void> {
  setTelemetryFaultHookForTests(null);
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2f-telemetry-"));
  try {
    await run(directory);
  } finally {
    setTelemetryFaultHookForTests(null);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function startRun(
  directory: string,
  overrides: Partial<RunManifestInput> = {},
): Promise<TelemetryLog> {
  const written = await writeRunManifest(directory, manifestInput(overrides));
  assert.equal(written.ok, true, JSON.stringify(written));
  const opened = await openTelemetryLog(directory, { clock: () => RECORDED_AT });
  assert.ok(opened.ok, JSON.stringify(opened));
  return opened.log;
}
