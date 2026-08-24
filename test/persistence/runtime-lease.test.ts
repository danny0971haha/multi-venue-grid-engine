import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { bootDryRun } from "../../src/bootstrap/runtimeMode.js";
import {
  ATOMIC_WRITE_HOOKS,
  persistExactPairTransition,
} from "../../src/persistence/atomic-pair-store.js";
import {
  buildDurableEnvelope,
  SUPPORTED_SCHEMA_VERSION,
} from "../../src/persistence/durable-envelope.js";
import {
  COORDINATION_CAPABILITY,
  DISTRIBUTED_FENCING_PROVEN,
} from "../../src/persistence/lease-coordination.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type {
  AtomicWriteHook,
  AtomicWriteTarget,
} from "../../src/persistence/atomic-pair-store.js";
import type { LeaseAuthority, RuntimeLeaseRecord } from "../../src/persistence/runtime-lease.js";
import { seedWitnessCommitForTests } from "../../src/persistence/lease-witness.js";
import {
  LEASE_KIND,
  LEASE_STATE_NAME,
  LEASE_TTL_MS,
  acquireRuntimeLease,
  assertCurrentLease,
  createProcessInstanceId,
  fixedLeaseClock,
  heartbeatRuntimeLease,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
  setLeasePreCallbackHookForTests,
} from "../../src/persistence/runtime-lease.js";
import type {
  LeaseWorkerInspectResult,
  LeaseWorkerOpResult,
} from "../fixtures/phase2c-lease-worker.js";

const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
const WORKER_PATH = fileURLToPath(new URL("../fixtures/phase2c-lease-worker.ts", import.meta.url));
const NOW_MS = 1_000_000n;
const EXPIRES_MS = NOW_MS + LEASE_TTL_MS;
const BEFORE_EXPIRY_MS = EXPIRES_MS - 1n;
const HIGH_GENERATION = "9007199254740993";
const HIGH_GENERATION_NEXT = "9007199254740994";

const PRIOR_TEST_FILES = [
  "test/bootstrap/runtimeMode.test.ts",
  "test/math/decimal.test.ts",
  "test/domain/ids-config.test.ts",
  "test/strategy/geometry.test.ts",
  "test/simulator/p1-state.test.ts",
  "test/simulator/p1-identity.test.ts",
  "test/simulator/p1-restart.test.ts",
  "test/simulator/p1-corrective.test.ts",
  "test/simulator/p1-corrective-2.test.ts",
  "test/simulator/p1-corrective-3.test.ts",
  "test/simulator/p1-corrective-4.test.ts",
  "test/simulator/p1-corrective-5.test.ts",
  "test/persistence/canonical-json.test.ts",
  "test/persistence/durable-envelope.test.ts",
  "test/persistence/exact-pair-inspection.test.ts",
  "test/persistence/atomic-pair-store.test.ts",
] as const;

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2c-lease-"));
  try {
    await run(directory);
  } finally {
    setLeasePreCallbackHookForTests(null);
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

function clock(nowMs: bigint = NOW_MS) {
  return fixedLeaseClock(nowMs);
}

async function acquire(
  directory: string,
  owner: string,
  instance: string,
  nowMs: bigint = NOW_MS,
  latch = new RuntimePersistenceLatch(),
  coordinationMode?: string,
) {
  return acquireRuntimeLease({
    directory,
    scopeKey: SCOPE_KEY,
    ownerId: owner,
    processInstanceId: instance,
    latch,
    clock: clock(nowMs),
    ...(coordinationMode === undefined ? {} : { coordinationMode }),
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await readFile(filePath);
      return;
    } catch {
      await delay(15);
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function inspectViaFreshProcess(directory: string): Promise<LeaseWorkerInspectResult> {
  const child = spawnWorker({
    mode: "inspect",
    directory,
    scopeKey: SCOPE_KEY,
    nowMs: NOW_MS.toString(10),
  });
  try {
    const [stdout, stderr] = await Promise.all([
      collectStream(child.stdout),
      collectStream(child.stderr),
      waitForExit(child, 15_000),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(`fresh inspect exited ${String(child.exitCode)}: ${stderr}`);
    }
    return JSON.parse(stdout) as LeaseWorkerInspectResult;
  } finally {
    forceKill(child);
  }
}

async function runWorkerCommand(command: unknown): Promise<LeaseWorkerOpResult> {
  const child = spawnWorker(command);
  try {
    const [stdout, stderr] = await Promise.all([
      collectStream(child.stdout),
      collectStream(child.stderr),
      waitForExit(child, 20_000),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(`worker exited ${String(child.exitCode)}: ${stderr} stdout=${stdout}`);
    }
    return JSON.parse(stdout) as LeaseWorkerOpResult;
  } finally {
    forceKill(child);
  }
}

async function snapshotPair(
  directory: string,
): Promise<{ primary: Buffer | null; backup: Buffer | null }> {
  return {
    primary: await readOptional(path.join(directory, `${LEASE_STATE_NAME}.json`)),
    backup: await readOptional(path.join(directory, `${LEASE_STATE_NAME}.json.bak`)),
  };
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

function makeRecord(
  overrides: Partial<RuntimeLeaseRecord> & Pick<RuntimeLeaseRecord, "generation" | "status">,
): RuntimeLeaseRecord {
  const acquiredAt = overrides.acquiredAt ?? NOW_MS.toString(10);
  const heartbeatAt = overrides.heartbeatAt ?? acquiredAt;
  return {
    schemaVersion: 1,
    scopeKey: overrides.scopeKey ?? SCOPE_KEY,
    ownerId: overrides.ownerId ?? "ownerA",
    processInstanceId: overrides.processInstanceId ?? "procA",
    generation: overrides.generation,
    status: overrides.status,
    acquiredAt,
    heartbeatAt,
    expiresAt: overrides.expiresAt ?? (BigInt(heartbeatAt) + LEASE_TTL_MS).toString(10),
    updatedAt: overrides.updatedAt ?? heartbeatAt,
  };
}

async function writeExactLeasePair(
  directory: string,
  record: RuntimeLeaseRecord,
  storeGeneration = "1",
  previousEnvelopeSha256: string | null = null,
): Promise<ReturnType<typeof buildDurableEnvelope<RuntimeLeaseRecord>>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const built = buildDurableEnvelope({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    kind: LEASE_KIND,
    scopeKey: record.scopeKey,
    storeGeneration,
    previousEnvelopeSha256,
    payload: record,
  });
  const primary = path.join(directory, `${LEASE_STATE_NAME}.json`);
  await writeFile(primary, built.fullEnvelopeBytes, { mode: 0o600 });
  await writeFile(`${primary}.bak`, built.fullEnvelopeBytes, { mode: 0o600 });
  await seedWitnessCommitForTests({
    directory,
    scopeKey: record.scopeKey,
    operation: record.status === "RELEASED" ? "RELEASE" : "INITIALIZE",
    fencingGeneration: record.generation,
    leaseStoreGeneration: storeGeneration,
    targetEnvelopeSha256: built.envelope.envelopeSha256,
    ownerId: record.ownerId,
    processInstanceId: record.processInstanceId,
    createdAt: NOW_MS.toString(10),
  });
  return built;
}

describe("Phase 2C runtime lease", { concurrency: 1 }, () => {
  test("P2-L01 / 2C-L01 first owner acquires clean scope with generation 1", async () => {
    await withTempDir(async (directory) => {
      const result = await acquire(directory, "ownerA", "procA");
      assert.equal(result.disposition, "ACQUIRED");
      assert.equal(result.allowRiskIncrease, false);
      assert.equal(result.authority?.generation, "1");
      assert.equal(result.authority?.ownerId, "ownerA");
      assert.equal(result.authority?.processInstanceId, "procA");
      assert.equal(result.authority?.scopeKey, SCOPE_KEY);
      assert.equal(result.record?.status, "ACTIVE");
      assert.equal(result.distributedFencingProven, false);
      assert.equal(result.coordinationCapability, COORDINATION_CAPABILITY);
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.pairAuthorityProven, true);
      assert.equal(disk.fencingGeneration, "1");
      assert.equal(disk.ownerId, "ownerA");
      assert.equal(disk.allowRiskIncrease, false);
    });
  });

  test("P2-L02 / 2C-L02 two real child processes: exactly one ACQUIRED", async () => {
    await withTempDir(async (directory) => {
      const startFlagPath = path.join(directory, "start.flag");
      const workers = ["ownerA", "ownerB"].map((ownerId) => {
        const waitingPath = path.join(directory, `${ownerId}.waiting`);
        const resultPath = path.join(directory, `${ownerId}.json`);
        const child = spawnWorker({
          mode: "acquire",
          directory,
          scopeKey: SCOPE_KEY,
          ownerId,
          processInstanceId: `${ownerId}Proc`,
          nowMs: NOW_MS.toString(10),
          startFlagPath,
          waitingPath,
          resultPath,
        });
        return { ownerId, waitingPath, resultPath, child };
      });
      try {
        await Promise.all(workers.map((worker) => waitForPath(worker.waitingPath, 15_000)));
        await writeFile(startFlagPath, "go\n");
        await Promise.all(workers.map((worker) => waitForExit(worker.child, 20_000)));
        const results = await Promise.all(
          workers.map(
            async (worker) =>
              JSON.parse(await readFile(worker.resultPath, "utf8")) as LeaseWorkerOpResult,
          ),
        );
        const acquired = results.filter((result) => result.disposition === "ACQUIRED");
        const blocked = results.filter((result) => result.disposition === "BLOCKED");
        assert.equal(acquired.length, 1);
        assert.equal(blocked.length, 1);
        assert.ok(results.every((result) => result.allowRiskIncrease === false));
        const disk = await inspectViaFreshProcess(directory);
        assert.equal(disk.pairAuthorityProven, true);
        assert.equal(disk.ownerId, acquired[0]?.ownerId ?? null);
        assert.equal(disk.fencingGeneration, "1");
      } finally {
        for (const worker of workers) {
          forceKill(worker.child);
        }
      }
    });
  });

  test("2C-L03 32 real concurrent contenders: exactly one current owner", async () => {
    await withTempDir(async (directory) => {
      const startFlagPath = path.join(directory, "start.flag");
      const workers = Array.from({ length: 32 }, (_, index) => {
        const ownerId = `owner${String(index + 1).padStart(2, "0")}`;
        return {
          ownerId,
          waitingPath: path.join(directory, `${ownerId}.waiting`),
          resultPath: path.join(directory, `${ownerId}.json`),
          child: spawnWorker({
            mode: "acquire",
            directory,
            scopeKey: SCOPE_KEY,
            ownerId,
            processInstanceId: `${ownerId}Proc`,
            nowMs: NOW_MS.toString(10),
            startFlagPath,
            waitingPath: path.join(directory, `${ownerId}.waiting`),
            resultPath: path.join(directory, `${ownerId}.json`),
          }),
        };
      });
      try {
        await Promise.all(workers.map((worker) => waitForPath(worker.waitingPath, 20_000)));
        await writeFile(startFlagPath, "go\n");
        await Promise.all(workers.map((worker) => waitForExit(worker.child, 30_000)));
        const results = await Promise.all(
          workers.map(
            async (worker) =>
              JSON.parse(await readFile(worker.resultPath, "utf8")) as LeaseWorkerOpResult,
          ),
        );
        const acquired = results.filter((result) => result.disposition === "ACQUIRED");
        assert.equal(acquired.length, 1);
        assert.equal(results.length - acquired.length, 31);
        assert.ok(results.every((result) => result.allowRiskIncrease === false));
        const disk = await inspectViaFreshProcess(directory);
        assert.equal(disk.pairAuthorityProven, true);
        assert.equal(disk.ownerId, acquired[0]?.ownerId ?? null);
        assert.equal(disk.fencingGeneration, "1");
      } finally {
        for (const worker of workers) {
          forceKill(worker.child);
        }
      }
    });
  });

  test("P2-L02 / 2C-L04 unexpired current lease blocks second owner", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA");
      assert.equal(first.disposition, "ACQUIRED");
      const second = await acquire(directory, "ownerB", "procB");
      assert.equal(second.disposition, "BLOCKED");
      assert.equal(second.authority, null);
      assert.equal(second.allowRiskIncrease, false);
      assert.ok(second.reasonCodes.includes("LEASE_HELD_BY_OTHER"));
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.ownerId, "ownerA");
      assert.equal(disk.fencingGeneration, "1");
    });
  });

  test("2C-L05 expiry minus 1ms blocked; exact expiry allows takeover", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.equal(first.disposition, "ACQUIRED");
      const before = await acquire(directory, "ownerB", "procB", BEFORE_EXPIRY_MS);
      assert.equal(before.disposition, "BLOCKED");
      assert.ok(before.reasonCodes.includes("LEASE_NOT_EXPIRED"));
      const atExpiry = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(atExpiry.disposition, "ACQUIRED");
      assert.equal(atExpiry.authority?.generation, "2");
      assert.equal(atExpiry.authority?.ownerId, "ownerB");
    });
  });

  test("P2-L03 / 2C-L06 expired takeover increments generation by 1", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.equal(first.authority?.generation, "1");
      const next = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(next.disposition, "ACQUIRED");
      assert.equal(next.authority?.generation, "2");
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.fencingGeneration, "2");
      assert.equal(disk.ownerId, "ownerB");
    });
  });

  test("2C-L07 generation above Number.MAX_SAFE_INTEGER increments exactly", async () => {
    await withTempDir(async (directory) => {
      await writeExactLeasePair(
        directory,
        makeRecord({ generation: HIGH_GENERATION, status: "RELEASED" }),
      );
      const result = await acquire(directory, "ownerB", "procB", NOW_MS);
      assert.equal(result.disposition, "ACQUIRED");
      assert.equal(result.authority?.generation, HIGH_GENERATION_NEXT);
      assert.notEqual(result.authority?.generation, String(Number(HIGH_GENERATION) + 1));
    });
  });

  test("2C-L08 old owner heartbeat after takeover is rejected and does not rewrite disk", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const second = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(second.disposition, "ACQUIRED");
      const before = await snapshotPair(directory);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(heartbeat.allowRiskIncrease, false);
      const after = await snapshotPair(directory);
      assert.ok(before.primary !== null && after.primary !== null);
      assert.ok(before.primary.equals(after.primary));
      assert.ok(before.backup !== null && after.backup !== null);
      assert.ok(before.backup.equals(after.backup));
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.ownerId, "ownerB");
    });
  });

  test("P2-L04 / 2C-L09 old owner mutation is NOT_SENT with callback count 0", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const second = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.ok(second.authority);
      let oldCalls = 0;
      const oldMutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
        mutation: () => {
          oldCalls += 1;
          return "old";
        },
      });
      assert.equal(oldMutation.outcome, "NOT_SENT");
      assert.equal(oldMutation.callbackCount, 0);
      assert.equal(oldCalls, 0);
      assert.equal(oldMutation.allowRiskIncrease, false);
      const thrown = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: second.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
        mutation: () => {
          throw new Error("callback-throw");
        },
      });
      assert.equal(thrown.outcome, "UNKNOWN");
      assert.equal(thrown.callbackCount, 1);
      assert.notEqual(thrown.outcome, "NOT_SENT");
    });
  });

  test("2C-L10 generation replaced between preflight and callback: callback count 0", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const replacement = buildDurableEnvelope({
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        kind: LEASE_KIND,
        scopeKey: SCOPE_KEY,
        storeGeneration: "2",
        previousEnvelopeSha256: first.authority.leaseEnvelopeSha256,
        payload: makeRecord({
          ownerId: "ownerZ",
          processInstanceId: "procZ",
          generation: "2",
          status: "ACTIVE",
        }),
      });
      setLeasePreCallbackHookForTests(() => {
        const primary = path.join(directory, `${LEASE_STATE_NAME}.json`);
        writeFileSync(primary, replacement.fullEnvelopeBytes);
        writeFileSync(`${primary}.bak`, replacement.fullEnvelopeBytes);
      });
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      });
      setLeasePreCallbackHookForTests(null);
      assert.equal(result.outcome, "NOT_SENT");
      assert.equal(result.callbackCount, 0);
      assert.equal(calls, 0);
    });
  });

  test("P2-L06 / 2C-L11 lease lost mid-sequence: later mutations NOT_SENT", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      let calls = 0;
      const firstMutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: () => {
          calls += 1;
          return "one";
        },
      });
      assert.equal(firstMutation.outcome, "SENT");
      assert.equal(firstMutation.allowRiskIncrease, false);
      const takeover = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(takeover.disposition, "ACQUIRED");
      const second = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
        mutation: () => {
          calls += 1;
          return "two";
        },
      });
      const third = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
        mutation: () => {
          calls += 1;
          return "three";
        },
      });
      assert.equal(second.outcome, "NOT_SENT");
      assert.equal(third.outcome, "NOT_SENT");
      assert.equal(second.callbackCount, 0);
      assert.equal(third.callbackCount, 0);
      assert.equal(calls, 1);
    });
  });

  test("P2-L07 / 2C-L12 stale owner rewrite of old lease record cannot restore authority", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const oldPair = await snapshotPair(directory);
      assert.ok(oldPair.primary !== null && oldPair.backup !== null);
      const takeover = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(takeover.disposition, "ACQUIRED");
      const primary = path.join(directory, `${LEASE_STATE_NAME}.json`);
      await writeFile(primary, oldPair.primary);
      await writeFile(`${primary}.bak`, oldPair.backup);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      let calls = 0;
      const mutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(EXPIRES_MS),
        mutation: () => {
          calls += 1;
          return "restored";
        },
      });
      assert.equal(mutation.outcome, "NOT_SENT");
      assert.equal(calls, 0);
    });
  });

  test("2C-L13 forged ownerId / processInstanceId / generation tokens are rejected", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const forged: LeaseAuthority[] = [
        { ...first.authority, ownerId: "forgedOwner" },
        { ...first.authority, processInstanceId: "forgedProc" },
        { ...first.authority, generation: "9" },
      ];
      for (const authority of forged) {
        const heartbeat = await heartbeatRuntimeLease({
          directory,
          scopeKey: SCOPE_KEY,
          authority,
          latch: new RuntimePersistenceLatch(),
          clock: clock(NOW_MS),
        });
        assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
        const mutation = await runLeaseFencedMutation({
          directory,
          scopeKey: SCOPE_KEY,
          authority,
          latch: new RuntimePersistenceLatch(),
          clock: clock(NOW_MS),
          mutation: () => "forged",
        });
        assert.equal(mutation.outcome, "NOT_SENT");
        assert.equal(mutation.callbackCount, 0);
      }
    });
  });

  test("P2-L05 / 2C-L14 missing/corrupt/conflicting/ahead pair is unproven and blocks latch", async () => {
    await withTempDir(async (root) => {
      const cases = ["missing", "corrupt", "conflicting", "ahead"] as const;
      for (const kind of cases) {
        const directory = path.join(root, kind);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const seeded = await writeExactLeasePair(
          directory,
          makeRecord({ generation: "1", status: "ACTIVE" }),
        );
        const primary = path.join(directory, `${LEASE_STATE_NAME}.json`);
        if (kind === "missing") {
          await rm(primary);
        } else if (kind === "corrupt") {
          await writeFile(primary, Buffer.from("{not-json", "utf8"));
        } else if (kind === "conflicting") {
          const other = buildDurableEnvelope({
            schemaVersion: SUPPORTED_SCHEMA_VERSION,
            kind: LEASE_KIND,
            scopeKey: SCOPE_KEY,
            storeGeneration: "1",
            previousEnvelopeSha256: null,
            payload: makeRecord({ generation: "1", status: "ACTIVE", ownerId: "ownerX" }),
          });
          await writeFile(primary, other.fullEnvelopeBytes);
        } else {
          const ahead = buildDurableEnvelope({
            schemaVersion: SUPPORTED_SCHEMA_VERSION,
            kind: LEASE_KIND,
            scopeKey: SCOPE_KEY,
            storeGeneration: "2",
            previousEnvelopeSha256: seeded.envelope.envelopeSha256,
            payload: makeRecord({ generation: "2", status: "ACTIVE" }),
          });
          await writeFile(`${primary}.bak`, ahead.fullEnvelopeBytes);
        }
        const latch = new RuntimePersistenceLatch();
        const result = await acquire(directory, "ownerB", "procB", NOW_MS, latch);
        assert.equal(result.disposition, "AUTHORITY_UNPROVEN");
        assert.equal(result.allowRiskIncrease, false);
        assert.equal(latch.blocked, true);
      }
    });
  });

  test("2C-L15 already-blocked latch fails acquire, heartbeat, and mutation", async () => {
    await withTempDir(async (directory) => {
      const seeded = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(seeded.authority);
      const latch = new RuntimePersistenceLatch();
      latch.block(["INJECTED_BLOCK"]);
      const acquireResult = await acquire(directory, "ownerB", "procB", NOW_MS, latch);
      assert.notEqual(acquireResult.disposition, "ACQUIRED");
      assert.ok(acquireResult.reasonCodes.includes("LATCH_ALREADY_BLOCKED"));
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: seeded.authority,
        latch,
        clock: clock(NOW_MS),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      const mutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: seeded.authority,
        latch,
        clock: clock(NOW_MS),
        mutation: () => "blocked",
      });
      assert.equal(mutation.outcome, "NOT_SENT");
      assert.equal(mutation.callbackCount, 0);
    });
  });

  test("2C-L16 later successful exact-pair write cannot clear blocked latch", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority && first.record);
      const latch = new RuntimePersistenceLatch();
      latch.block(["INJECTED_BLOCK"]);
      const next = makeRecord({
        ...first.record,
        heartbeatAt: (NOW_MS + 1n).toString(10),
        expiresAt: (NOW_MS + 1n + LEASE_TTL_MS).toString(10),
        updatedAt: (NOW_MS + 1n).toString(10),
        generation: first.record.generation,
        status: "ACTIVE",
      });
      const persist = await persistExactPairTransition({
        directory,
        stateName: LEASE_STATE_NAME,
        expectedKind: LEASE_KIND,
        expectedScopeKey: SCOPE_KEY,
        expectedGeneration: first.authority.leaseStoreGeneration,
        expectedPredecessorEnvelopeSha256: first.authority.leaseEnvelopeSha256,
        payload: next,
        latch,
      });
      assert.equal(persist.disposition, "REQUESTED_STATE_COMMITTED");
      assert.equal(latch.blocked, true);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch,
        clock: clock(NOW_MS + 1n),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(latch.blocked, true);
      const mutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch,
        clock: clock(NOW_MS + 1n),
        mutation: () => "cleared",
      });
      assert.equal(mutation.outcome, "NOT_SENT");
      assert.equal(latch.blocked, true);
    });
  });

  test("2C-L17 heartbeat keeps owner/generation/acquiredAt and updates only allowed fields", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority && first.record);
      const later = NOW_MS + 5_000n;
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(later),
      });
      assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(heartbeat.record?.ownerId, "ownerA");
      assert.equal(heartbeat.record?.processInstanceId, "procA");
      assert.equal(heartbeat.record?.generation, "1");
      assert.equal(heartbeat.record?.acquiredAt, first.record.acquiredAt);
      assert.equal(heartbeat.record?.heartbeatAt, later.toString(10));
      assert.equal(heartbeat.record?.expiresAt, (later + LEASE_TTL_MS).toString(10));
      assert.equal(heartbeat.authority?.leaseStoreGeneration, "2");
      assert.equal(heartbeat.allowRiskIncrease, false);
    });
  });

  test("2C-L18 clock regression beyond tolerance fails closed", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS - 1_001n),
      });
      assert.equal(heartbeat.disposition, "AUTHORITY_UNPROVEN");
      assert.ok(heartbeat.reasonCodes.includes("CLOCK_REGRESSION"));
      assert.equal(heartbeat.latchState.blocked, true);
      assert.equal(heartbeat.allowRiskIncrease, false);
    });
  });

  test("2C-L19 malformed/future/excessive timestamps fail closed", async () => {
    await withTempDir(async (root) => {
      const malformed = path.join(root, "malformed");
      await writeExactLeasePair(
        malformed,
        makeRecord({ generation: "1", status: "ACTIVE", heartbeatAt: "01", expiresAt: "30001" }),
      );
      const malformedResult = await acquire(malformed, "ownerB", "procB", NOW_MS);
      assert.equal(malformedResult.disposition, "AUTHORITY_UNPROVEN");
      assert.ok(malformedResult.reasonCodes.includes("MALFORMED_TIMESTAMP"));
      assert.equal(malformedResult.latchState.blocked, true);

      const future = path.join(root, "future");
      await writeExactLeasePair(
        future,
        makeRecord({
          generation: "1",
          status: "ACTIVE",
          acquiredAt: "9000000000000",
          heartbeatAt: "9000000000000",
        }),
      );
      const futureResult = await acquire(future, "ownerB", "procB", NOW_MS);
      assert.equal(futureResult.disposition, "AUTHORITY_UNPROVEN");
      assert.ok(
        futureResult.reasonCodes.includes("FUTURE_TIMESTAMP") ||
          futureResult.reasonCodes.includes("CLOCK_REGRESSION"),
      );

      const excessive = path.join(root, "excessive");
      await writeExactLeasePair(
        excessive,
        makeRecord({
          generation: "1",
          status: "ACTIVE",
          acquiredAt: "10000000000000",
          heartbeatAt: "10000000000000",
          expiresAt: "10000000030000",
          updatedAt: "10000000000000",
        }),
      );
      const excessiveResult = await acquire(excessive, "ownerB", "procB", NOW_MS);
      assert.equal(excessiveResult.disposition, "AUTHORITY_UNPROVEN");
      assert.ok(excessiveResult.reasonCodes.includes("EXCESSIVE_TIMESTAMP"));
    });
  });

  test("2C-L20 SIGKILL active owner: pre-expiry blocked; post-expiry generation +1", async () => {
    await withTempDir(async (directory) => {
      const readyFilePath = path.join(directory, "owner-ready.flag");
      const owner = spawnWorker({
        mode: "acquire-and-hold",
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerA",
        processInstanceId: "procA",
        nowMs: NOW_MS.toString(10),
        readyFilePath,
      });
      try {
        await waitForPath(readyFilePath, 15_000);
        const ready = JSON.parse(await readFile(readyFilePath, "utf8")) as { disposition: string };
        assert.equal(ready.disposition, "ACQUIRED");
        const preExpiry = await runWorkerCommand({
          mode: "acquire",
          directory,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerB",
          processInstanceId: "procB",
          nowMs: BEFORE_EXPIRY_MS.toString(10),
        });
        assert.equal(preExpiry.disposition, "BLOCKED");
        assert.ok(owner.pid !== undefined);
        const killed = owner.kill("SIGKILL");
        assert.equal(killed, true);
        await waitForExit(owner, 5_000);
        assert.equal(owner.signalCode, "SIGKILL");
        const stillBlocked = await runWorkerCommand({
          mode: "acquire",
          directory,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerC",
          processInstanceId: "procC",
          nowMs: BEFORE_EXPIRY_MS.toString(10),
        });
        assert.equal(stillBlocked.disposition, "BLOCKED");
        const takeover = await runWorkerCommand({
          mode: "acquire",
          directory,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerD",
          processInstanceId: "procD",
          nowMs: EXPIRES_MS.toString(10),
        });
        assert.equal(takeover.disposition, "ACQUIRED");
        assert.equal(takeover.generation, "2");
        const disk = await inspectViaFreshProcess(directory);
        assert.equal(disk.ownerId, "ownerD");
        assert.equal(disk.fencingGeneration, "2");
      } finally {
        forceKill(owner);
      }
    });
  });

  async function runLeaseCrash(args: {
    mode: "crash-acquire" | "crash-heartbeat" | "crash-takeover";
    target: AtomicWriteTarget;
    hook: AtomicWriteHook;
  }): Promise<LeaseWorkerInspectResult> {
    resetLeaseProcessStateForTests();
    const root = await mkdtemp(path.join(os.tmpdir(), "phase2c-crash-"));
    const directory = path.join(root, "store");
    const readyFilePath = path.join(root, "crash-ready.flag");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let authority: LeaseAuthority | undefined;
    if (args.mode !== "crash-acquire") {
      const seeded = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(seeded.authority);
      authority = seeded.authority;
    }
    const child = spawnWorker({
      mode: args.mode,
      directory,
      scopeKey: SCOPE_KEY,
      ownerId: args.mode === "crash-heartbeat" ? "ownerA" : "ownerB",
      processInstanceId: args.mode === "crash-heartbeat" ? "procA" : "procB",
      authority,
      nowMs: args.mode === "crash-takeover" ? EXPIRES_MS.toString(10) : NOW_MS.toString(10),
      crashTarget: args.target,
      crashHook: args.hook,
      readyFilePath,
    });
    try {
      try {
        await waitForPath(readyFilePath, 15_000);
      } catch (error) {
        const stderr = await Promise.race([collectStream(child.stderr), delay(100).then(() => "")]);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} exit=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${stderr}`,
        );
      }
      assert.ok(child.pid !== undefined);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`child exited before SIGKILL code=${String(child.exitCode)}`);
      }
      const killed = child.kill("SIGKILL");
      assert.equal(killed, true);
      await waitForExit(child, 5_000);
      assert.equal(child.signalCode, "SIGKILL");
      return await inspectViaFreshProcess(directory);
    } finally {
      forceKill(child);
      await rm(root, { recursive: true, force: true });
    }
  }

  function classifyAcquireCrash(
    inspection: LeaseWorkerInspectResult,
  ): "CLEAN_ABSENT" | "EXACT_LEASE" | "UNPROVEN" {
    if (inspection.pairStatus === "BOTH_ABSENT") {
      return "CLEAN_ABSENT";
    }
    if (inspection.pairAuthorityProven && inspection.ownerId !== null) {
      return "EXACT_LEASE";
    }
    return "UNPROVEN";
  }

  test("2C-L21 crash during initial acquisition: absent / exact / unproven; never two owners", async () => {
    for (const target of ["BACKUP", "PRIMARY"] as const) {
      for (const hook of ATOMIC_WRITE_HOOKS) {
        const inspection = await runLeaseCrash({ mode: "crash-acquire", target, hook });
        const classification = classifyAcquireCrash(inspection);
        assert.ok(
          classification === "CLEAN_ABSENT" ||
            classification === "EXACT_LEASE" ||
            classification === "UNPROVEN",
        );
        assert.equal(inspection.allowRiskIncrease, false);
        if (inspection.pairAuthorityProven) {
          assert.ok(inspection.ownerId === "ownerB");
          assert.equal(inspection.fencingGeneration, "1");
        }
      }
    }
  });

  test("2C-L22 crash during heartbeat: old exact / new exact / unproven", async () => {
    for (const target of ["BACKUP", "PRIMARY"] as const) {
      for (const hook of ATOMIC_WRITE_HOOKS) {
        const inspection = await runLeaseCrash({ mode: "crash-heartbeat", target, hook });
        if (inspection.pairAuthorityProven) {
          assert.equal(inspection.ownerId, "ownerA");
          assert.equal(inspection.fencingGeneration, "1");
        } else {
          assert.equal(inspection.pairAuthorityProven, false);
        }
        assert.equal(inspection.allowRiskIncrease, false);
      }
    }
  });

  test("2C-L23 crash during takeover: old owner / new owner / unproven; never both", async () => {
    for (const target of ["BACKUP", "PRIMARY"] as const) {
      for (const hook of ATOMIC_WRITE_HOOKS) {
        const inspection = await runLeaseCrash({ mode: "crash-takeover", target, hook });
        if (inspection.pairAuthorityProven) {
          assert.ok(inspection.ownerId === "ownerA" || inspection.ownerId === "ownerB");
          if (inspection.ownerId === "ownerA") {
            assert.equal(inspection.fencingGeneration, "1");
          } else {
            assert.equal(inspection.fencingGeneration, "2");
          }
        }
        assert.equal(inspection.allowRiskIncrease, false);
      }
    }
  });

  test("2C-L24 release fences old token and next acquire uses higher generation", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const released = await releaseRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.equal(released.disposition, "RELEASED");
      const mutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: () => "after-release",
      });
      assert.equal(mutation.outcome, "NOT_SENT");
      const next = await acquire(directory, "ownerB", "procB", NOW_MS);
      assert.equal(next.disposition, "ACQUIRED");
      assert.equal(next.authority?.generation, "2");
    });
  });

  test("2C-L25 stale release cannot overwrite new owner", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const released = await releaseRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.equal(released.disposition, "RELEASED");
      const next = await acquire(directory, "ownerB", "procB", NOW_MS);
      assert.equal(next.authority?.ownerId, "ownerB");
      const before = await snapshotPair(directory);
      const stale = await releaseRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.notEqual(stale.disposition, "RELEASED");
      const after = await snapshotPair(directory);
      assert.ok(before.primary !== null && after.primary !== null);
      assert.ok(before.primary.equals(after.primary));
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.ownerId, "ownerB");
      assert.equal(disk.fencingGeneration, "2");
    });
  });

  test("2C-L26 HOST_LOCAL_FILESYSTEM_ONLY cannot claim distributed proof", async () => {
    await withTempDir(async (directory) => {
      const result = await acquire(
        directory,
        "ownerA",
        "procA",
        NOW_MS,
        new RuntimePersistenceLatch(),
        "SHARED_MULTI_HOST",
      );
      assert.equal(result.disposition, "DISTRIBUTED_FENCING_UNPROVEN");
      assert.equal(result.distributedFencingProven, DISTRIBUTED_FENCING_PROVEN);
      assert.equal(result.distributedFencingProven, false);
      assert.equal(result.coordinationCapability, COORDINATION_CAPABILITY);
      assert.ok(result.reasonCodes.includes("DISTRIBUTED_FENCING_UNPROVEN"));
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.pairStatus, "BOTH_ABSENT");
    });
  });

  test("P2-L08 / 2C-L27 same-process repeated assertions are deterministic", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const once = await assertCurrentLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      const twice = await assertCurrentLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.equal(once.disposition, twice.disposition);
      assert.equal(once.authority?.generation, twice.authority?.generation);
      assert.equal(once.authority?.leaseEnvelopeSha256, twice.authority?.leaseEnvelopeSha256);
      assert.equal(once.allowRiskIncrease, false);
      assert.equal(twice.allowRiskIncrease, false);
      const forgedMutation = await runWorkerCommand({
        mode: "mutate",
        directory,
        scopeKey: SCOPE_KEY,
        nowMs: NOW_MS.toString(10),
        authority: {
          ...first.authority,
          ownerId: "freshProcOwner",
          processInstanceId: createProcessInstanceId(),
          generation: "1",
        },
      });
      assert.equal(forgedMutation.outcome, "NOT_SENT");
      assert.equal(forgedMutation.callbackCount, 0);
    });
  });

  test("2C-L28 all 219 prior tests remain present", async () => {
    let total = 0;
    for (const relative of PRIOR_TEST_FILES) {
      const text = await readFile(path.join(process.cwd(), relative), "utf8");
      const matches = text.match(/^test\(/gm);
      total += matches?.length ?? 0;
    }
    assert.equal(total, 219);
  });

  test("2C-L29 Phase 2B backup A..H / primary A..H SIGKILL cases remain present", async () => {
    const text = await readFile(
      path.join(process.cwd(), "test/persistence/atomic-pair-store.test.ts"),
      "utf8",
    );
    assert.ok(text.includes("2B-P22 all backup A..H real SIGKILL cases"));
    assert.ok(text.includes("2B-P23 all primary A..H real SIGKILL cases"));
    assert.equal(ATOMIC_WRITE_HOOKS.length, 8);
  });

  test("2C-L30 dry-run remains liveExchangeWrites=false", () => {
    const dryRun = bootDryRun();
    assert.equal(dryRun.liveExchangeWrites, false);
  });
});
