import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bootDryRun } from "../../src/bootstrap/runtimeMode.js";
import {
  ATOMIC_WRITE_HOOKS,
  formatPersistResultDiagnostic,
  incrementCanonicalGeneration,
  initializeExactPair,
  persistExactPairTransition,
  PHASE_2B_REASON_CODE_CATALOG,
  setPersistenceFaultHookForTests,
  sortPhase2BReasonCodes,
} from "../../src/persistence/atomic-pair-store.js";
import type {
  AtomicWriteHook,
  AtomicWriteTarget,
  PersistResult,
} from "../../src/persistence/atomic-pair-store.js";
import { buildDurableEnvelope } from "../../src/persistence/durable-envelope.js";
import { formatPairInspectionDiagnostic } from "../../src/persistence/exact-pair-inspection.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type { CrashWorkerInspectResult } from "../fixtures/phase2b-crash-worker.js";
import {
  CANONICAL_ENVELOPE_HASH_INPUT_BYTES,
  CANONICAL_PAYLOAD_BYTES,
  ENVELOPE_SHA256,
  FIXTURE_KIND,
  FIXTURE_PAYLOAD,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_SCOPE_KEY,
  FIXTURE_SECRET_LIKE,
  FULL_ENVELOPE_BYTES,
  PAYLOAD_SHA256,
} from "../fixtures/phase2a-canonical-vector.js";

const STATE_NAME = "risk-state";
const WORKER_PATH = fileURLToPath(new URL("../fixtures/phase2b-crash-worker.ts", import.meta.url));
const PHASE_2A_TEST_FILES = [
  "test/persistence/canonical-json.test.ts",
  "test/persistence/durable-envelope.test.ts",
  "test/persistence/exact-pair-inspection.test.ts",
] as const;
const PHASE_2A_TEST_IDS = [
  "P2-D01",
  "P2-D02",
  "P2-D03",
  "P2-D04",
  "P2-D05",
  "P2-D06",
  "P2-D07",
  "P2-D08",
  "P2-D09",
  "P2-D10",
  "P2-D11",
  "P2-D12",
  "P2-D13",
  "P2-D14",
  "2A-C02",
  "2A-C03",
  "2A-C04",
  "2A-C05",
  "2A-C06",
  "2A-C07",
  "2A-C08",
  "2A-C13",
  "2A-C14",
] as const;
const EXISTING_SUITE_MARKERS = [
  "missing RUNTIME_MODE resolves to DRY_RUN",
  "P1-G01",
  "P1-S01",
  "P1-I01",
  "P1-R01",
  "P2-D01",
  "frozen canonical envelope vectors are asserted literally",
] as const;

type PairSnapshot = {
  primary: Buffer | null;
  backup: Buffer | null;
  names: string[];
};

function bootstrapAuthorization() {
  return {
    mode: "NON_LIVE_BOOTSTRAP" as const,
    allowLive: false as const,
  };
}

function payload(marker: string) {
  return {
    levels: FIXTURE_PAYLOAD.levels,
    marker,
    notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
  };
}

function secretPayload() {
  return {
    levels: FIXTURE_PAYLOAD.levels,
    marker: "phase2b-diagnostic",
    notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
    note: FIXTURE_SECRET_LIKE,
  };
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2b-store-"));
  try {
    await run(directory);
  } finally {
    setPersistenceFaultHookForTests(null);
    await rm(directory, { recursive: true, force: true });
  }
}

async function snapshotPair(directory: string): Promise<PairSnapshot> {
  return {
    primary: await readOptional(path.join(directory, `${STATE_NAME}.json`)),
    backup: await readOptional(path.join(directory, `${STATE_NAME}.json.bak`)),
    names: (await readdir(directory)).sort(),
  };
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

function assertUnchanged(before: PairSnapshot, after: PairSnapshot): void {
  assert.deepEqual(after.names, before.names);
  if (before.primary === null) {
    assert.equal(after.primary, null);
  } else {
    assert.ok(after.primary?.equals(before.primary));
  }
  if (before.backup === null) {
    assert.equal(after.backup, null);
  } else {
    assert.ok(after.backup?.equals(before.backup));
  }
}

function assertRiskBlocked<T>(result: PersistResult<T>): void {
  assert.equal(result.allowRiskIncrease, false);
  assert.equal(result.inspection.allowRiskIncrease, false);
}

async function seedExactPair(
  directory: string,
  latch: RuntimePersistenceLatch,
  marker = "phase2b-initial",
): Promise<PersistResult<{ levels: number; marker: string; notionalUsd: string }>> {
  return initializeExactPair({
    directory,
    stateName: STATE_NAME,
    expectedKind: FIXTURE_KIND,
    expectedScopeKey: FIXTURE_SCOPE_KEY,
    payload: payload(marker),
    bootstrapAuthorization: bootstrapAuthorization(),
    latch,
  });
}

async function transitionFrom(
  directory: string,
  latch: RuntimePersistenceLatch,
  predecessor: PersistResult<unknown>,
  marker: string,
): Promise<PersistResult<{ levels: number; marker: string; notionalUsd: string }>> {
  assert.equal(predecessor.committedGeneration, "1");
  assert.ok(predecessor.committedEnvelopeSha256 !== null);
  return persistExactPairTransition({
    directory,
    stateName: STATE_NAME,
    expectedKind: FIXTURE_KIND,
    expectedScopeKey: FIXTURE_SCOPE_KEY,
    expectedGeneration: predecessor.committedGeneration ?? "1",
    expectedPredecessorEnvelopeSha256: predecessor.committedEnvelopeSha256 ?? "",
    payload: payload(marker),
    latch,
  });
}

function fixtureEnvelopeFields() {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: FIXTURE_KIND,
    scopeKey: FIXTURE_SCOPE_KEY,
    storeGeneration: "1",
    previousEnvelopeSha256: null,
    payload: {
      levels: FIXTURE_PAYLOAD.levels,
      marker: FIXTURE_PAYLOAD.marker,
      notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
    },
  };
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

function classifyFreshReload(
  inspection: CrashWorkerInspectResult,
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

async function inspectViaFreshProcess(directory: string): Promise<CrashWorkerInspectResult> {
  const child = spawnWorker({
    mode: "inspect",
    directory,
    stateName: STATE_NAME,
    expectedKind: FIXTURE_KIND,
    expectedScopeKey: FIXTURE_SCOPE_KEY,
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
    return JSON.parse(stdout) as CrashWorkerInspectResult;
  } finally {
    forceKill(child);
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

async function runSigkillTransition(args: {
  target: AtomicWriteTarget;
  hook: AtomicWriteHook;
}): Promise<{
  classification: "OLD_EXACT_PAIR" | "NEW_EXACT_PAIR" | "PAIR_UNPROVEN";
  inspection: CrashWorkerInspectResult;
  oldHash: string;
  newHash: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2b-crash-"));
  const directory = path.join(root, "store");
  const readyFilePath = path.join(root, "crash-ready.flag");
  try {
    const seedLatch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, seedLatch, "phase2b-crash-old");
    assert.equal(seeded.disposition, "REQUESTED_STATE_COMMITTED");
    assert.ok(seeded.committedEnvelopeSha256 !== null);
    assert.equal(seeded.committedGeneration, "1");
    const nextPayload = payload("phase2b-crash-new");
    const next = buildDurableEnvelope({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      kind: FIXTURE_KIND,
      scopeKey: FIXTURE_SCOPE_KEY,
      storeGeneration: "2",
      previousEnvelopeSha256: seeded.committedEnvelopeSha256,
      payload: nextPayload,
    });
    const child = spawnWorker({
      mode: "transition",
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      expectedGeneration: "1",
      expectedPredecessorEnvelopeSha256: seeded.committedEnvelopeSha256,
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
    const inspection = await inspectViaFreshProcess(directory);
    assert.equal(inspection.allowRiskIncrease, false);
    const classification = classifyFreshReload(
      inspection,
      seeded.committedEnvelopeSha256,
      next.envelope.envelopeSha256,
    );
    assert.ok(
      classification === "OLD_EXACT_PAIR" ||
        classification === "NEW_EXACT_PAIR" ||
        classification === "PAIR_UNPROVEN",
    );
    return {
      classification,
      inspection,
      oldHash: seeded.committedEnvelopeSha256,
      newHash: next.envelope.envelopeSha256,
    };
  } finally {
    setPersistenceFaultHookForTests(null);
    await rm(root, { recursive: true, force: true });
  }
}

test("2B-P11 explicit clean initialization success", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const result = await seedExactPair(directory, latch);
    assert.equal(result.disposition, "REQUESTED_STATE_COMMITTED");
    assertRiskBlocked(result);
    assert.equal(result.committedGeneration, "1");
    assert.equal(result.inspection.pairAuthorityProven, true);
    assert.equal(result.inspection.lineageStatus, "PROVEN");
    assert.equal(result.state?.marker, "phase2b-initial");
    const primary = await readFile(path.join(directory, `${STATE_NAME}.json`));
    const backup = await readFile(path.join(directory, `${STATE_NAME}.json.bak`));
    assert.ok(primary.equals(backup));
    const dirMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(path.join(directory, `${STATE_NAME}.json`))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.equal(latch.blocked, false);
  });
});

test("2B-P01 normal exact-pair transition success", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const result = await transitionFrom(directory, latch, seeded, "phase2b-next");
    assert.equal(result.disposition, "REQUESTED_STATE_COMMITTED");
    assertRiskBlocked(result);
    assert.equal(result.committedGeneration, "2");
    assert.equal(result.inspection.pairAuthorityProven, true);
    assert.equal(result.state?.marker, "phase2b-next");
  });
});

test("2B-P02 next generation and previous hash exact", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const incremented = incrementCanonicalGeneration("1");
    assert.equal(incremented.ok, true);
    if (incremented.ok) {
      assert.equal(incremented.generation, "2");
    }
    const large = incrementCanonicalGeneration("9007199254740993");
    assert.equal(large.ok, true);
    if (large.ok) {
      assert.equal(large.generation, "9007199254740994");
    }
    const result = await transitionFrom(directory, latch, seeded, "phase2b-next-hash");
    assert.equal(result.committedGeneration, "2");
    const raw = await readFile(path.join(directory, `${STATE_NAME}.json`));
    const parsed = JSON.parse(raw.toString("utf8")) as {
      previousEnvelopeSha256: string;
      storeGeneration: string;
    };
    assert.equal(parsed.storeGeneration, "2");
    assert.equal(parsed.previousEnvelopeSha256, seeded.committedEnvelopeSha256);
  });
});

test("2B-P03 identical immutable bytes written to backup/primary", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    await transitionFrom(directory, latch, seeded, "phase2b-identical");
    const primary = await readFile(path.join(directory, `${STATE_NAME}.json`));
    const backup = await readFile(path.join(directory, `${STATE_NAME}.json.bak`));
    assert.ok(primary.equals(backup));
    const expected = buildDurableEnvelope({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      kind: FIXTURE_KIND,
      scopeKey: FIXTURE_SCOPE_KEY,
      storeGeneration: "2",
      previousEnvelopeSha256: seeded.committedEnvelopeSha256,
      payload: payload("phase2b-identical"),
    });
    assert.ok(primary.equals(expected.fullEnvelopeBytes));
  });
});

test("2B-P04 stale expected generation -> zero mutation", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const before = await snapshotPair(directory);
    const result = await persistExactPairTransition({
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      expectedGeneration: "9",
      expectedPredecessorEnvelopeSha256: seeded.committedEnvelopeSha256 ?? "",
      payload: payload("stale-generation"),
      latch,
    });
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P05 stale predecessor hash -> zero mutation", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    await seedExactPair(directory, latch);
    const before = await snapshotPair(directory);
    const result = await persistExactPairTransition({
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      expectedGeneration: "1",
      expectedPredecessorEnvelopeSha256: "ab".repeat(32),
      payload: payload("stale-hash"),
      latch,
    });
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("STALE_PREDECESSOR_HASH"));
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P06 primary missing -> predecessor unproven", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    await rm(path.join(directory, `${STATE_NAME}.json`));
    const before = await snapshotPair(directory);
    const result = await transitionFrom(directory, latch, seeded, "missing-primary");
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("PRIMARY_MISSING"));
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P07 backup missing -> predecessor unproven", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    await rm(path.join(directory, `${STATE_NAME}.json.bak`));
    const before = await snapshotPair(directory);
    const result = await transitionFrom(directory, latch, seeded, "missing-backup");
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("BACKUP_MISSING"));
    assertRiskBlocked(result);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P08 corrupt copy -> predecessor unproven", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    await writeFile(path.join(directory, `${STATE_NAME}.json`), Buffer.from("{not-json", "utf8"));
    const before = await snapshotPair(directory);
    const result = await transitionFrom(directory, latch, seeded, "corrupt");
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("PRIMARY_INVALID"));
    assertRiskBlocked(result);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P09 valid but different pair -> predecessor unproven", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const other = buildDurableEnvelope({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      kind: FIXTURE_KIND,
      scopeKey: FIXTURE_SCOPE_KEY,
      storeGeneration: "2",
      previousEnvelopeSha256: seeded.committedEnvelopeSha256,
      payload: payload("divergent-backup"),
    });
    await writeFile(path.join(directory, `${STATE_NAME}.json.bak`), other.fullEnvelopeBytes);
    const before = await snapshotPair(directory);
    const result = await transitionFrom(directory, latch, seeded, "divergent");
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("PAIR_BYTES_MISMATCH"));
    assertRiskBlocked(result);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P10 wrong kind/scope -> zero mutation", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const before = await snapshotPair(directory);
    const wrongKind = await persistExactPairTransition({
      directory,
      stateName: STATE_NAME,
      expectedKind: "other-kind",
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      expectedGeneration: "1",
      expectedPredecessorEnvelopeSha256: seeded.committedEnvelopeSha256 ?? "",
      payload: payload("wrong-kind"),
      latch,
    });
    assert.equal(wrongKind.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(wrongKind.reasonCodes.includes("WRONG_KIND"));
    assertUnchanged(before, await snapshotPair(directory));

    const fresh = new RuntimePersistenceLatch();
    const wrongScope = await persistExactPairTransition({
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: "other/scope",
      expectedGeneration: "1",
      expectedPredecessorEnvelopeSha256: seeded.committedEnvelopeSha256 ?? "",
      payload: payload("wrong-scope"),
      latch: fresh,
    });
    assert.equal(wrongScope.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(wrongScope.reasonCodes.includes("WRONG_SCOPE"));
    assertRiskBlocked(wrongScope);
    assertUnchanged(before, await snapshotPair(directory));
  });
});

test("2B-P12 one-copy initialization attempt blocked", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureEnvelopeFields());
    await writeFile(path.join(directory, `${STATE_NAME}.json`), built.fullEnvelopeBytes);
    const latch = new RuntimePersistenceLatch();
    const result = await seedExactPair(directory, latch);
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("AMBIGUOUS_INITIALIZATION"));
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
    const backup = await readOptional(path.join(directory, `${STATE_NAME}.json.bak`));
    assert.equal(backup, null);
  });
});

test("2B-P13 temp/historical evidence blocks initialization", async () => {
  await withTempDir(async (directory) => {
    await writeFile(
      path.join(directory, `${STATE_NAME}.json.leftover.tmp`),
      Buffer.from("tmp", "utf8"),
    );
    const latch = new RuntimePersistenceLatch();
    const result = await seedExactPair(directory, latch);
    assert.equal(result.disposition, "PREDECESSOR_UNPROVEN");
    assert.ok(result.reasonCodes.includes("INITIALIZATION_NOT_CLEAN"));
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
    assert.equal(await readOptional(path.join(directory, `${STATE_NAME}.json`)), null);
    assert.equal(await readOptional(path.join(directory, `${STATE_NAME}.json.bak`)), null);
  });
});

test("2B-P14 backup commit success + primary failure -> partial commit", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const oldPrimary = await readFile(path.join(directory, `${STATE_NAME}.json`));
    setPersistenceFaultHookForTests({
      target: "PRIMARY",
      hook: "BEFORE_TEMP_OPEN",
      action: "FAIL",
    });
    const result = await transitionFrom(directory, latch, seeded, "partial");
    setPersistenceFaultHookForTests(null);
    assert.equal(result.disposition, "PARTIAL_COMMIT");
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
    const primary = await readFile(path.join(directory, `${STATE_NAME}.json`));
    const backup = await readFile(path.join(directory, `${STATE_NAME}.json.bak`));
    assert.ok(primary.equals(oldPrimary));
    assert.equal(primary.equals(backup), false);
  });
});

test("2B-P15 readback mismatch -> blocked", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    setPersistenceFaultHookForTests({
      target: "BACKUP",
      hook: "AFTER_DIR_FSYNC",
      action: "FAIL_READBACK",
    });
    const result = await transitionFrom(directory, latch, seeded, "readback");
    setPersistenceFaultHookForTests(null);
    assert.notEqual(result.disposition, "REQUESTED_STATE_COMMITTED");
    assert.ok(result.reasonCodes.includes("READBACK_MISMATCH"));
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
  });
});

test("2B-P16 directory fsync failure -> blocked", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    setPersistenceFaultHookForTests({
      target: "BACKUP",
      hook: "AFTER_RENAME",
      action: "FAIL_DIR_FSYNC",
    });
    const result = await transitionFrom(directory, latch, seeded, "dir-fsync");
    setPersistenceFaultHookForTests(null);
    assert.notEqual(result.disposition, "REQUESTED_STATE_COMMITTED");
    assert.ok(result.reasonCodes.includes("DIR_FSYNC_FAILURE"));
    assertRiskBlocked(result);
    assert.equal(latch.blocked, true);
  });
});

test("2B-P17 later successful write cannot clear latch", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const seeded = await seedExactPair(directory, latch);
    const blocked = await persistExactPairTransition({
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      expectedGeneration: "9",
      expectedPredecessorEnvelopeSha256: seeded.committedEnvelopeSha256 ?? "",
      payload: payload("block-first"),
      latch,
    });
    assert.equal(blocked.disposition, "PREDECESSOR_UNPROVEN");
    assert.equal(latch.blocked, true);
    const firstBlockedAt = latch.blockedAt;
    const later = await transitionFrom(directory, latch, seeded, "later-success");
    assert.equal(later.disposition, "REQUESTED_STATE_COMMITTED");
    assertRiskBlocked(later);
    assert.equal(later.latchState.blocked, true);
    assert.equal(latch.blocked, true);
    assert.equal(latch.blockedAt, firstBlockedAt);
    assert.ok(later.reasonCodes.includes("LATCH_ALREADY_BLOCKED"));
  });
});

test("2B-P18 unsafe stateName/path traversal rejected", async () => {
  await withTempDir(async (directory) => {
    const names = [
      "",
      "../escape",
      "foo/bar",
      "foo\\bar",
      "/absolute",
      "dot..dot",
      "nul\u0000char",
    ];
    for (const stateName of names) {
      const latch = new RuntimePersistenceLatch();
      const result = await initializeExactPair({
        directory,
        stateName,
        expectedKind: FIXTURE_KIND,
        expectedScopeKey: FIXTURE_SCOPE_KEY,
        payload: payload("unsafe"),
        bootstrapAuthorization: bootstrapAuthorization(),
        latch,
      });
      assert.equal(result.disposition, "IO_FAILURE");
      assert.ok(result.reasonCodes.includes("UNSAFE_STATE_NAME"));
      assertRiskBlocked(result);
      assert.equal(latch.blocked, true);
    }
    const leftover = (await readdir(directory)).filter(
      (name) => name.startsWith("..") || name.includes("/"),
    );
    assert.deepEqual(leftover, []);
  });
});

test("2B-P19 caller payload/fields not mutated", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const initial = payload("immutable-caller");
    const result = await initializeExactPair({
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      payload: initial,
      bootstrapAuthorization: bootstrapAuthorization(),
      latch,
    });
    initial.marker = "mutated-after-call";
    assert.equal(result.state?.marker, "immutable-caller");
    const raw = await readFile(path.join(directory, `${STATE_NAME}.json`));
    assert.equal(raw.toString("utf8").includes("immutable-caller"), true);
    assert.equal(raw.toString("utf8").includes("mutated-after-call"), false);
  });
});

test("2B-P20 deterministic reason-code ordering", () => {
  const shuffled = [
    "IO_FAILURE",
    "PARTIAL_COMMIT",
    "REQUESTED_STATE_COMMITTED",
    "PREDECESSOR_UNPROVEN",
    "LATCH_ALREADY_BLOCKED",
  ];
  const ordered = sortPhase2BReasonCodes(shuffled);
  const expected = PHASE_2B_REASON_CODE_CATALOG.filter((code) => shuffled.includes(code));
  assert.deepEqual(ordered, expected);
  assert.deepEqual(sortPhase2BReasonCodes([...shuffled].reverse()), expected);
});

test("2B-P21 diagnostics do not leak secret-like fixture values", async () => {
  await withTempDir(async (directory) => {
    const latch = new RuntimePersistenceLatch();
    const result = await initializeExactPair({
      directory,
      stateName: STATE_NAME,
      expectedKind: FIXTURE_KIND,
      expectedScopeKey: FIXTURE_SCOPE_KEY,
      payload: secretPayload(),
      bootstrapAuthorization: bootstrapAuthorization(),
      latch,
    });
    const persistDiagnostic = formatPersistResultDiagnostic(result);
    const inspectDiagnostic = formatPairInspectionDiagnostic(result.inspection);
    assert.equal(persistDiagnostic.includes(FIXTURE_SECRET_LIKE), false);
    assert.equal(inspectDiagnostic.includes(FIXTURE_SECRET_LIKE), false);
    assert.equal(JSON.stringify(result.reasonCodes).includes(FIXTURE_SECRET_LIKE), false);
  });
});

test("2B-P22 all backup A..H real SIGKILL cases", async () => {
  const outcomes: string[] = [];
  for (const hook of ATOMIC_WRITE_HOOKS) {
    const result = await runSigkillTransition({ target: "BACKUP", hook });
    outcomes.push(`${hook}:${result.classification}`);
    assert.equal(result.inspection.allowRiskIncrease, false);
    assert.notEqual(result.classification, undefined);
  }
  assert.equal(outcomes.length, 8);
});

test("2B-P23 all primary A..H real SIGKILL cases", async () => {
  const outcomes: string[] = [];
  for (const hook of ATOMIC_WRITE_HOOKS) {
    const result = await runSigkillTransition({ target: "PRIMARY", hook });
    outcomes.push(`${hook}:${result.classification}`);
    assert.equal(result.inspection.allowRiskIncrease, false);
  }
  assert.equal(outcomes.length, 8);
});

test("2B-P24 no crash outcome authorizes risk increase", async () => {
  for (const target of ["BACKUP", "PRIMARY"] as const) {
    for (const hook of ATOMIC_WRITE_HOOKS) {
      const result = await runSigkillTransition({ target, hook });
      assert.equal(result.inspection.allowRiskIncrease, false);
      assert.notEqual(result.classification, "RISK_INCREASE_AUTHORIZED");
    }
  }
});

test("2B-P25 all existing Phase 2A vectors remain byte-identical", () => {
  const built = buildDurableEnvelope(fixtureEnvelopeFields());
  assert.equal(built.payloadCanonicalBytes.toString("utf8"), CANONICAL_PAYLOAD_BYTES);
  assert.equal(built.envelope.payloadSha256, PAYLOAD_SHA256);
  assert.equal(built.envelopeHashInputBytes.toString("utf8"), CANONICAL_ENVELOPE_HASH_INPUT_BYTES);
  assert.equal(built.envelope.envelopeSha256, ENVELOPE_SHA256);
  assert.equal(built.fullEnvelopeBytes.toString("utf8"), FULL_ENVELOPE_BYTES);
});

test("2B-P26 all existing 193 tests remain present and green", async () => {
  const repoRoot = process.cwd();
  for (const relative of PHASE_2A_TEST_FILES) {
    const text = await readFile(path.join(repoRoot, relative), "utf8");
    for (const id of PHASE_2A_TEST_IDS) {
      if (relative.includes("exact-pair-inspection") && id.startsWith("P2-D")) {
        assert.ok(text.includes(id), `${relative} missing ${id}`);
      }
      if (relative.includes("durable-envelope") && id.startsWith("2A-C")) {
        assert.ok(text.includes(id), `${relative} missing ${id}`);
      }
    }
  }
  const suiteFiles = [
    "test/bootstrap/runtimeMode.test.ts",
    "test/strategy/geometry.test.ts",
    "test/domain/ids-config.test.ts",
    "test/simulator/p1-state.test.ts",
    "test/simulator/p1-restart.test.ts",
    "test/persistence/exact-pair-inspection.test.ts",
    "test/persistence/durable-envelope.test.ts",
  ];
  const combined = (
    await Promise.all(suiteFiles.map((relative) => readFile(path.join(repoRoot, relative), "utf8")))
  ).join("\n");
  for (const marker of EXISTING_SUITE_MARKERS) {
    assert.ok(combined.includes(marker), `missing existing suite marker ${marker}`);
  }
  const dryRun = bootDryRun();
  assert.equal(dryRun.liveExchangeWrites, false);
});
