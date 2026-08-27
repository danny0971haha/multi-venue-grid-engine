import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ATOMIC_WRITE_HOOKS } from "../../src/persistence/atomic-pair-store.js";
import type {
  AtomicWriteHook,
  AtomicWriteTarget,
} from "../../src/persistence/atomic-pair-store.js";
import { incrementCanonicalGeneration } from "../../src/persistence/atomic-pair-store.js";
import {
  buildDurableEnvelope,
  SUPPORTED_SCHEMA_VERSION,
} from "../../src/persistence/durable-envelope.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { makeHaltRecord } from "../../src/halt/record.js";
import { initializeHaltPair } from "../../src/halt/store.js";
import { HALT_KIND } from "../../src/halt/types.js";
import type { DurableHaltRecord } from "../../src/halt/types.js";
import type { Phase2ECrashInspectResult } from "../fixtures/phase2e-crash-worker.js";

const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
const EXPERIMENT_ID = "exp-phase2e";
const HALT_ISO = "1970-01-01T00:16:40.000Z";
const WORKER_PATH = fileURLToPath(new URL("../fixtures/phase2e-crash-worker.ts", import.meta.url));

type CrashKind = "RUNNING_TO_HALTING" | "HALTING_TO_HALTED_FLAT" | "HALTED_TO_RUNNING";

function runningRecord(): DurableHaltRecord {
  return makeHaltRecord({
    scopeKey: SCOPE_KEY,
    experimentId: EXPERIMENT_ID,
    haltId: null,
    haltReasons: [],
    status: "RUNNING",
    leaseGeneration: "1",
    leaseEnvelopeSha256: "aa".repeat(32),
    predecessorHaltId: null,
    predecessorStatus: null,
    incidentGeneration: "1",
    acknowledgement: null,
    unresolvedPossibleExposure: false,
    flatnessProven: false,
    snapshotFresh: false,
    snapshotObservedAt: null,
    startingEquityUsd: "100",
    highWaterEquityUsd: "100",
    lastRiskEvaluationAt: null,
    updatedAt: HALT_ISO,
  });
}

function haltingRecord(): DurableHaltRecord {
  return makeHaltRecord({
    ...runningRecord(),
    haltId: "h1",
    haltReasons: ["DAILY_LOSS"],
    status: "HALTING",
    predecessorHaltId: null,
    predecessorStatus: "RUNNING",
    incidentGeneration: "2",
    lastRiskEvaluationAt: "1000000",
  });
}

function haltedFlatRecord(): DurableHaltRecord {
  return makeHaltRecord({
    ...haltingRecord(),
    status: "HALTED_FLAT",
    flatnessProven: true,
    snapshotFresh: true,
    snapshotObservedAt: "1000000",
  });
}

function runningAfterAckRecord(
  predecessorGeneration: string,
  predecessorHash: string,
): DurableHaltRecord {
  const next = incrementCanonicalGeneration(predecessorGeneration);
  if (!next.ok) {
    throw new Error("generation overflow");
  }
  return makeHaltRecord({
    ...haltedFlatRecord(),
    haltId: null,
    haltReasons: [],
    status: "RUNNING",
    predecessorHaltId: "h1",
    predecessorStatus: "HALTED_FLAT",
    acknowledgement: {
      acknowledgedHaltId: "h1",
      predecessorStoreGeneration: predecessorGeneration,
      predecessorEnvelopeSha256: predecessorHash,
      newStoreGeneration: next.generation,
      priorLeaseGeneration: "1",
      currentLeaseGeneration: "1",
      resultingStatus: "RUNNING",
      snapshotSourceId: "engine-owned-snapshot",
      snapshotObservedAt: "1000000",
      snapshotLeaseGeneration: "1",
    },
    unresolvedPossibleExposure: false,
    flatnessProven: false,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function spawnWorker(command: unknown): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", WORKER_PATH, JSON.stringify(command)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function forceKill(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", reject);
  });
}

async function inspectViaFreshProcess(directory: string): Promise<Phase2ECrashInspectResult> {
  const child = spawnWorker({
    mode: "inspect",
    directory,
    expectedScopeKey: SCOPE_KEY,
  });
  try {
    const [stdout, stderr] = await Promise.all([
      collectStream(child.stdout),
      collectStream(child.stderr),
      waitForExit(child, 10_000),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(`fresh inspect exited ${String(child.exitCode)}: ${stderr}`);
    }
    return JSON.parse(stdout) as Phase2ECrashInspectResult;
  } finally {
    forceKill(child);
  }
}

function classify(
  inspection: Phase2ECrashInspectResult,
  oldHash: string,
  newHash: string,
): "OLD_EXACT_PAIR" | "NEW_EXACT_PAIR" | "PAIR_UNPROVEN" {
  if (inspection.pairAuthorityProven && inspection.envelopeSha256 === oldHash) {
    return "OLD_EXACT_PAIR";
  }
  if (inspection.pairAuthorityProven && inspection.envelopeSha256 === newHash) {
    return "NEW_EXACT_PAIR";
  }
  return "PAIR_UNPROVEN";
}

function assertAllowedOutcome(
  kind: CrashKind,
  classification: "OLD_EXACT_PAIR" | "NEW_EXACT_PAIR" | "PAIR_UNPROVEN",
  inspection: Phase2ECrashInspectResult,
  oldHaltId: string | null,
): void {
  assert.equal(inspection.allowRiskIncrease, false);
  assert.ok(
    classification === "OLD_EXACT_PAIR" ||
      classification === "NEW_EXACT_PAIR" ||
      classification === "PAIR_UNPROVEN",
  );
  if (classification === "PAIR_UNPROVEN") {
    assert.equal(inspection.pairAuthorityProven, false);
    return;
  }
  if (kind === "RUNNING_TO_HALTING" && classification === "NEW_EXACT_PAIR") {
    assert.equal(inspection.haltStatus, "HALTING");
    assert.equal(inspection.haltId, "h1");
  }
  if (kind === "HALTING_TO_HALTED_FLAT" && classification === "NEW_EXACT_PAIR") {
    assert.equal(inspection.haltStatus, "HALTED_FLAT");
    assert.equal(inspection.haltId, "h1");
  }
  if (kind === "HALTED_TO_RUNNING" && classification === "OLD_EXACT_PAIR") {
    assert.equal(inspection.haltStatus, "HALTED_FLAT");
    assert.equal(inspection.haltId, oldHaltId);
  }
  if (kind === "HALTED_TO_RUNNING" && classification === "NEW_EXACT_PAIR") {
    assert.equal(inspection.haltStatus, "RUNNING");
    assert.equal(inspection.acknowledgedHaltId, "h1");
    assert.equal(inspection.resultingStatus, "RUNNING");
    assert.equal(inspection.snapshotSourceId, "engine-owned-snapshot");
    assert.equal(inspection.snapshotObservedAt, "1000000");
    assert.equal(inspection.snapshotLeaseGeneration, "1");
  }
}

async function seedPair(
  directory: string,
  payload: DurableHaltRecord,
): Promise<{ generation: string; envelopeSha256: string }> {
  const latch = new RuntimePersistenceLatch();
  const result = await initializeHaltPair({
    directory,
    scopeKey: SCOPE_KEY,
    payload,
    latch,
  });
  assert.equal(result.disposition, "REQUESTED_STATE_COMMITTED");
  assert.ok(result.committedGeneration !== null);
  assert.ok(result.committedEnvelopeSha256 !== null);
  return {
    generation: result.committedGeneration,
    envelopeSha256: result.committedEnvelopeSha256,
  };
}

function nextBytes(payload: DurableHaltRecord, generation: string, previousHash: string) {
  const nextGeneration = incrementCanonicalGeneration(generation);
  if (!nextGeneration.ok) {
    throw new Error("generation overflow");
  }
  return buildDurableEnvelope({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    kind: HALT_KIND,
    scopeKey: SCOPE_KEY,
    storeGeneration: nextGeneration.generation,
    previousEnvelopeSha256: previousHash,
    payload,
  });
}

async function runCrash(args: {
  kind: CrashKind;
  target: AtomicWriteTarget;
  hook: AtomicWriteHook;
}): Promise<{
  classification: "OLD_EXACT_PAIR" | "NEW_EXACT_PAIR" | "PAIR_UNPROVEN";
  inspection: Phase2ECrashInspectResult;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2e-crash-"));
  const directory = path.join(root, "store");
  const readyFilePath = path.join(root, "crash-ready.flag");
  try {
    let initial: DurableHaltRecord;
    let nextPayload: DurableHaltRecord;
    if (args.kind === "RUNNING_TO_HALTING") {
      initial = runningRecord();
      nextPayload = haltingRecord();
    } else if (args.kind === "HALTING_TO_HALTED_FLAT") {
      initial = haltingRecord();
      nextPayload = haltedFlatRecord();
    } else {
      initial = haltedFlatRecord();
      nextPayload = runningRecord();
    }
    const seeded = await seedPair(directory, initial);
    if (args.kind === "HALTED_TO_RUNNING") {
      nextPayload = runningAfterAckRecord(seeded.generation, seeded.envelopeSha256);
    }
    const next = nextBytes(nextPayload, seeded.generation, seeded.envelopeSha256);
    const child = spawnWorker({
      mode: "transition",
      directory,
      expectedScopeKey: SCOPE_KEY,
      expectedGeneration: seeded.generation,
      expectedPredecessorEnvelopeSha256: seeded.envelopeSha256,
      payload: nextPayload,
      crashTarget: args.target,
      crashHook: args.hook,
      readyFilePath,
    });
    const stderrPromise = collectStream(child.stderr);
    const stdoutPromise = collectStream(child.stdout);
    try {
      try {
        await waitForPath(readyFilePath, 15_000);
      } catch (error) {
        const stderr = await Promise.race([stderrPromise, delay(100).then(() => "")]);
        const stdout = await Promise.race([stdoutPromise, delay(100).then(() => "")]);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} exit=${String(child.exitCode)} signal=${String(child.signalCode)} stdout=${stdout} stderr=${stderr}`,
        );
      }
      assert.ok(child.pid !== undefined);
      if (child.exitCode !== null || child.signalCode !== null) {
        const stderr = await stderrPromise;
        throw new Error(
          `child exited before SIGKILL code=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${stderr}`,
        );
      }
      const killed = child.kill("SIGKILL");
      assert.equal(killed, true);
      await waitForExit(child, 5_000);
      assert.equal(child.signalCode, "SIGKILL");
    } finally {
      forceKill(child);
    }
    const callerMemoryAcked = args.kind === "HALTED_TO_RUNNING";
    const inspection = await inspectViaFreshProcess(directory);
    const classification = classify(
      inspection,
      seeded.envelopeSha256,
      next.envelope.envelopeSha256,
    );
    assertAllowedOutcome(args.kind, classification, inspection, "h1");
    if (args.kind === "HALTED_TO_RUNNING" && classification !== "NEW_EXACT_PAIR") {
      assert.notEqual(inspection.haltStatus, "RUNNING");
      assert.equal(callerMemoryAcked && inspection.haltStatus === "RUNNING", false);
    }
    return { classification, inspection };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Phase 2E halt/ACK real process-crash matrix", { concurrency: 1 }, () => {
  test("P2E-CRASH RUNNING->HALTING backup A..H", async () => {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runCrash({ kind: "RUNNING_TO_HALTING", target: "BACKUP", hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
    }
  });

  test("P2E-CRASH RUNNING->HALTING primary A..H", async () => {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runCrash({ kind: "RUNNING_TO_HALTING", target: "PRIMARY", hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
    }
  });

  test("P2E-CRASH HALTING->HALTED_FLAT backup A..H", async () => {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runCrash({ kind: "HALTING_TO_HALTED_FLAT", target: "BACKUP", hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
    }
  });

  test("P2E-CRASH HALTING->HALTED_FLAT primary A..H", async () => {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runCrash({ kind: "HALTING_TO_HALTED_FLAT", target: "PRIMARY", hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
    }
  });

  test("P2E-CRASH HALTED_FLAT->RUNNING ACK backup A..H", async () => {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runCrash({ kind: "HALTED_TO_RUNNING", target: "BACKUP", hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
    }
  });

  test("P2E-CRASH HALTED_FLAT->RUNNING ACK primary A..H", async () => {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runCrash({ kind: "HALTED_TO_RUNNING", target: "PRIMARY", hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
    }
  });

  test("P2E-C1-17 real parent-delivered SIGKILL during corrected ACK windows", async () => {
    for (const target of ["BACKUP", "PRIMARY"] as const) {
      for (const hook of ATOMIC_WRITE_HOOKS) {
        const result = await runCrash({ kind: "HALTED_TO_RUNNING", target, hook });
        assert.ok(
          result.classification === "OLD_EXACT_PAIR" ||
            result.classification === "NEW_EXACT_PAIR" ||
            result.classification === "PAIR_UNPROVEN",
        );
        if (result.classification === "NEW_EXACT_PAIR") {
          assert.equal(result.inspection.haltStatus, "RUNNING");
          assert.equal(result.inspection.acknowledgedHaltId, "h1");
          assert.equal(result.inspection.snapshotSourceId, "engine-owned-snapshot");
          assert.equal(result.inspection.snapshotLeaseGeneration, "1");
        }
        if (result.classification === "OLD_EXACT_PAIR") {
          assert.equal(result.inspection.haltStatus, "HALTED_FLAT");
        }
        if (result.classification === "PAIR_UNPROVEN") {
          assert.equal(result.inspection.pairAuthorityProven, false);
        }
        assert.equal(result.inspection.allowRiskIncrease, false);
      }
    }
  });
});
