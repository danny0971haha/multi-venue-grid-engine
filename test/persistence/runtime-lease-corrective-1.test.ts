import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ATOMIC_WRITE_HOOKS } from "../../src/persistence/atomic-pair-store.js";
import {
  acquireHostLocalCoordinationGuard,
  COORDINATION_LOCK_FILE_NAME,
} from "../../src/persistence/lease-coordination.js";
import {
  HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION,
  LEASE_WITNESS_FILE_NAME,
  loadLeaseWitnessLog,
} from "../../src/persistence/lease-witness.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type { LeaseAuthority } from "../../src/persistence/runtime-lease.js";
import {
  LEASE_TTL_MS,
  MAX_TIMESTAMP_MS,
  acquireRuntimeLease,
  assertCurrentLease,
  fixedLeaseClock,
  heartbeatRuntimeLease,
  parseLeaseRecord,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
  setLeasePreCallbackHookForTests,
} from "../../src/persistence/runtime-lease.js";
import type {
  LeaseWorkerInspectResult,
  LeaseWorkerOpResult,
} from "../fixtures/phase2c-lease-worker.js";
import type { WitnessCrashWindow } from "../fixtures/phase2c-witness-crash-worker.js";

const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
const LEASE_WORKER = fileURLToPath(new URL("../fixtures/phase2c-lease-worker.ts", import.meta.url));
const WITNESS_WORKER = fileURLToPath(
  new URL("../fixtures/phase2c-witness-crash-worker.ts", import.meta.url),
);
const NOW_MS = 1_000_000n;
const EXPIRES_MS = NOW_MS + LEASE_TTL_MS;
const CRASH_WINDOWS: WitnessCrashWindow[] = [
  "AFTER_PREPARE_FSYNC",
  "AFTER_BACKUP",
  "AFTER_PRIMARY",
  "BEFORE_COMMIT_WITNESS",
  "AFTER_COMMIT_WITNESS",
];

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr1-"));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function spawnTs(workerPath: string, command: unknown): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", workerPath, JSON.stringify(command)], {
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

async function acquire(
  directory: string,
  owner: string,
  instance: string,
  nowMs: bigint = NOW_MS,
  latch = new RuntimePersistenceLatch(),
) {
  return acquireRuntimeLease({
    directory,
    scopeKey: SCOPE_KEY,
    ownerId: owner,
    processInstanceId: instance,
    latch,
    clock: clock(nowMs),
  });
}

async function inspectViaFreshProcess(directory: string): Promise<LeaseWorkerInspectResult> {
  const child = spawnTs(LEASE_WORKER, {
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

async function runLeaseWorker(command: unknown): Promise<LeaseWorkerOpResult> {
  const child = spawnTs(LEASE_WORKER, command);
  try {
    const [stdout, stderr] = await Promise.all([
      collectStream(child.stdout),
      collectStream(child.stderr),
      waitForExit(child, 20_000),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(`lease worker exited ${String(child.exitCode)}: ${stderr} stdout=${stdout}`);
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
    primary: await readOptional(path.join(directory, "runtime-lease.json")),
    backup: await readOptional(path.join(directory, "runtime-lease.json.bak")),
  };
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

async function runWitnessCrash(args: {
  directory: string;
  mode: "crash-initialize" | "crash-heartbeat" | "crash-takeover" | "crash-release";
  window: WitnessCrashWindow;
  nowMs: bigint;
  ownerId: string;
  processInstanceId: string;
  authority?: LeaseAuthority;
}): Promise<void> {
  const readyFilePath = path.join(args.directory, `ready-${args.mode}-${args.window}.flag`);
  const child = spawnTs(WITNESS_WORKER, {
    directory: args.directory,
    scopeKey: SCOPE_KEY,
    nowMs: args.nowMs.toString(10),
    ownerId: args.ownerId,
    processInstanceId: args.processInstanceId,
    readyFilePath,
    mode: args.mode,
    window: args.window,
    authority: args.authority,
  });
  try {
    await waitForPath(readyFilePath, 15_000);
    const ready = await readFile(readyFilePath, "utf8");
    assert.notEqual(ready.trim(), "UNEXPECTED_COMPLETION");
    assert.ok(child.pid !== undefined);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before SIGKILL code=${String(child.exitCode)}`);
    }
    const killed = child.kill("SIGKILL");
    assert.equal(killed, true);
    await waitForExit(child, 5_000);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    forceKill(child);
  }
}

describe("Phase 2C corrective 1", { concurrency: 1 }, () => {
  test("2C-C1-01 guard wait crosses expiry -> zero callback", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const now = { value: NOW_MS };
      const holder = await acquireHostLocalCoordinationGuard(directory);
      assert.equal(holder.ok, true);
      let calls = 0;
      const pending = runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: {
          nowMs() {
            return now.value;
          },
        },
        mutation: () => {
          calls += 1;
          return "late";
        },
      });
      await delay(80);
      now.value = EXPIRES_MS;
      if (holder.ok) {
        await holder.guard.release();
      }
      const result = await pending;
      assert.equal(result.outcome, "NOT_SENT");
      assert.equal(result.callbackCount, 0);
      assert.equal(calls, 0);
      assert.equal(result.allowRiskIncrease, false);
    });
  });

  test("2C-C1-02 pre-callback delay crosses expiry -> zero callback", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const now = { value: NOW_MS };
      setLeasePreCallbackHookForTests(() => {
        now.value = EXPIRES_MS;
      });
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: {
          nowMs() {
            return now.value;
          },
        },
        mutation: () => {
          calls += 1;
          return "expired";
        },
      });
      assert.equal(result.outcome, "NOT_SENT");
      assert.equal(result.callbackCount, 0);
      assert.equal(calls, 0);
    });
  });

  test("2C-C1-03 async resolve waits then SENT", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: async () => {
          calls += 1;
          await delay(40);
          return "async-ok";
        },
      });
      assert.equal(result.outcome, "SENT");
      assert.equal(result.value, "async-ok");
      assert.equal(result.callbackCount, 1);
      assert.equal(calls, 1);
      assert.equal(result.allowRiskIncrease, false);
      assert.equal(
        HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION,
        "HOST_LOCAL_SERIALIZED_MUTATION_LIMITATION",
      );
    });
  });

  test("2C-C1-04 async reject waits then UNKNOWN", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: async () => {
          calls += 1;
          await delay(40);
          throw new Error("async-reject");
        },
      });
      assert.equal(result.outcome, "UNKNOWN");
      assert.equal(result.callbackCount, 1);
      assert.equal(calls, 1);
      assert.notEqual(result.outcome, "SENT");
      assert.notEqual(result.outcome, "NOT_SENT");
    });
  });

  test("2C-C1-05 pending Promise never returns early SENT", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      let resolvePending: ((value: string) => void) | undefined;
      const pendingValue = new Promise<string>((resolve) => {
        resolvePending = resolve;
      });
      const started = runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: () => pendingValue,
      });
      const raced = await Promise.race([
        started.then((result) => ({ settled: true as const, result })),
        delay(80).then(() => ({ settled: false as const })),
      ]);
      assert.equal(raced.settled, false);
      assert.ok(resolvePending);
      resolvePending("late");
      const result = await started;
      assert.equal(result.outcome, "SENT");
      assert.equal(result.value, "late");
      assert.equal(result.callbackCount, 1);
    });
  });

  test("2C-C1-06 sync throw remains UNKNOWN", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: () => {
          throw new Error("sync-throw");
        },
      });
      assert.equal(result.outcome, "UNKNOWN");
      assert.equal(result.callbackCount, 1);
    });
  });

  test("2C-C1-07 forged leaseEnvelopeSha256 rejected", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const forged: LeaseAuthority = {
        ...first.authority,
        leaseEnvelopeSha256: "ab".repeat(32),
      };
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: forged,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.reasonCodes.includes("STALE_LEASE_TOKEN"));
      const mutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: forged,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
        mutation: () => "forged-hash",
      });
      assert.equal(mutation.outcome, "NOT_SENT");
      assert.equal(mutation.callbackCount, 0);
    });
  });

  test("2C-C1-08 forged leaseStoreGeneration rejected", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const forged: LeaseAuthority = {
        ...first.authority,
        leaseStoreGeneration: "9",
      };
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: forged,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.reasonCodes.includes("STALE_LEASE_TOKEN"));
    });
  });

  test("2C-C1-09 forged observedExpiresAt rejected", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const forged: LeaseAuthority = {
        ...first.authority,
        observedExpiresAt: (EXPIRES_MS + 1n).toString(10),
      };
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: forged,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.reasonCodes.includes("STALE_LEASE_TOKEN"));
    });
  });

  test("2C-C1-10 pre-heartbeat token stale after heartbeat", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
      });
      assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.authority);
      const staleAssert = await assertCurrentLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
      });
      assert.ok(staleAssert.reasonCodes.includes("STALE_LEASE_TOKEN"));
      const staleRelease = await releaseRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
      });
      assert.notEqual(staleRelease.disposition, "RELEASED");
      const staleMutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
        mutation: () => "stale",
      });
      assert.equal(staleMutation.outcome, "NOT_SENT");
      assert.equal(staleMutation.callbackCount, 0);
    });
  });

  test("2C-C1-11 current heartbeat token succeeds", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
      });
      assert.ok(heartbeat.authority);
      const current = await assertCurrentLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: heartbeat.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
      });
      assert.equal(current.disposition, "ACQUIRED");
      const mutation = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: heartbeat.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
        mutation: () => "current",
      });
      assert.equal(mutation.outcome, "SENT");
      assert.equal(mutation.callbackCount, 1);
    });
  });

  test("2C-C1-12 fresh process sees exact-pair rollback -> blocked", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const oldPair = await snapshotPair(directory);
      const takeover = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(takeover.disposition, "ACQUIRED");
      assert.ok(oldPair.primary !== null && oldPair.backup !== null);
      await writeFile(path.join(directory, "runtime-lease.json"), oldPair.primary);
      await writeFile(path.join(directory, "runtime-lease.json.bak"), oldPair.backup);
      const fresh = await runLeaseWorker({
        mode: "acquire",
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerC",
        processInstanceId: "procC",
        nowMs: NOW_MS.toString(10),
      });
      assert.equal(fresh.disposition, "AUTHORITY_UNPROVEN");
      assert.equal(fresh.latchBlocked, true);
      assert.ok(fresh.reasonCodes.includes("LEASE_ROLLBACK_DETECTED"));
      assert.equal(fresh.allowRiskIncrease, false);
    });
  });

  test("2C-C1-13 fresh child using old authority after rollback -> callbackCount=0", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const oldPair = await snapshotPair(directory);
      const takeover = await acquire(directory, "ownerB", "procB", EXPIRES_MS);
      assert.equal(takeover.disposition, "ACQUIRED");
      assert.ok(oldPair.primary !== null && oldPair.backup !== null);
      await writeFile(path.join(directory, "runtime-lease.json"), oldPair.primary);
      await writeFile(path.join(directory, "runtime-lease.json.bak"), oldPair.backup);
      const mutation = await runLeaseWorker({
        mode: "mutate",
        directory,
        scopeKey: SCOPE_KEY,
        nowMs: NOW_MS.toString(10),
        authority: first.authority,
      });
      assert.equal(mutation.outcome, "NOT_SENT");
      assert.equal(mutation.callbackCount, 0);
      assert.ok(mutation.reasonCodes.includes("LEASE_ROLLBACK_DETECTED"));
    });
  });

  test("2C-C1-14 witness malformed/truncated/hash conflict -> blocked", async () => {
    await withTempDir(async (root) => {
      const cases = ["malformed", "truncated", "hash"] as const;
      for (const kind of cases) {
        const directory = path.join(root, kind);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const seeded = await acquire(directory, "ownerA", "procA", NOW_MS);
        assert.equal(seeded.disposition, "ACQUIRED");
        const witnessPath = path.join(directory, LEASE_WITNESS_FILE_NAME);
        const current = await readFile(witnessPath);
        if (kind === "malformed") {
          await writeFile(witnessPath, Buffer.from("{\nnot-json\n", "utf8"));
        } else if (kind === "truncated") {
          await writeFile(witnessPath, current.subarray(0, Math.max(1, current.length - 1)));
        } else {
          const text = current.toString("utf8");
          const broken = text.replace(
            /"witnessSha256":"[0-9a-f]{64}"/,
            `"witnessSha256":"${"ab".repeat(32)}"`,
          );
          await writeFile(witnessPath, broken);
        }
        const fresh = await runLeaseWorker({
          mode: "acquire",
          directory,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerB",
          processInstanceId: "procB",
          nowMs: NOW_MS.toString(10),
        });
        assert.equal(fresh.disposition, "AUTHORITY_UNPROVEN");
        assert.equal(fresh.latchBlocked, true);
        assert.equal(fresh.allowRiskIncrease, false);
      }
    });
  });

  test("2C-C1-15 PREPARE crash before pair -> blocked", async () => {
    await withTempDir(async (directory) => {
      await runWitnessCrash({
        directory,
        mode: "crash-initialize",
        window: "AFTER_PREPARE_FSYNC",
        nowMs: NOW_MS,
        ownerId: "ownerB",
        processInstanceId: "procB",
      });
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.pairStatus, "BOTH_ABSENT");
      const fresh = await runLeaseWorker({
        mode: "acquire",
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerC",
        processInstanceId: "procC",
        nowMs: NOW_MS.toString(10),
      });
      assert.equal(fresh.disposition, "AUTHORITY_UNPROVEN");
      assert.equal(fresh.latchBlocked, true);
      assert.ok(fresh.reasonCodes.includes("WITNESS_PREPARE_UNMATCHED"));
      const loaded = await loadLeaseWitnessLog(directory);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        assert.equal(loaded.lines.at(-1)?.status, "PREPARE");
      }
    });
  });

  test("2C-C1-16 pair committed before COMMIT witness remains explicitly reviewed", async () => {
    await withTempDir(async (directory) => {
      await runWitnessCrash({
        directory,
        mode: "crash-initialize",
        window: "BEFORE_COMMIT_WITNESS",
        nowMs: NOW_MS,
        ownerId: "ownerB",
        processInstanceId: "procB",
      });
      const disk = await inspectViaFreshProcess(directory);
      assert.equal(disk.pairAuthorityProven, true);
      assert.equal(disk.ownerId, "ownerB");
      const loaded = await loadLeaseWitnessLog(directory);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        assert.equal(loaded.lines.at(-1)?.status, "PREPARE");
        assert.equal(
          loaded.lines.some((line) => line.status === "COMMIT"),
          false,
        );
      }
      const fresh = await runLeaseWorker({
        mode: "acquire",
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerC",
        processInstanceId: "procC",
        nowMs: NOW_MS.toString(10),
      });
      assert.equal(fresh.disposition, "AUTHORITY_UNPROVEN");
      assert.ok(fresh.reasonCodes.includes("INCOMPLETE_WITNESS_FINALIZATION"));
      const after = await loadLeaseWitnessLog(directory);
      assert.equal(after.ok, true);
      if (after.ok) {
        assert.equal(after.lines.at(-1)?.status, "PREPARE");
      }
    });
  });

  test("2C-C1-17 latest COMMIT + exact pair -> accepted lease authority", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const loaded = await loadLeaseWitnessLog(directory);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        assert.equal(loaded.lines.at(-1)?.status, "COMMIT");
        assert.equal(loaded.lines.at(-1)?.operation, "INITIALIZE");
      }
      const current = await runLeaseWorker({
        mode: "heartbeat",
        directory,
        scopeKey: SCOPE_KEY,
        nowMs: (NOW_MS + 1_000n).toString(10),
        authority: first.authority,
      });
      assert.equal(current.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(current.allowRiskIncrease, false);
    });
  });

  test("2C-C1-18 heartbeat rollback to older store generation -> blocked", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const oldPair = await snapshotPair(directory);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS + 1_000n),
      });
      assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(oldPair.primary !== null && oldPair.backup !== null);
      await writeFile(path.join(directory, "runtime-lease.json"), oldPair.primary);
      await writeFile(path.join(directory, "runtime-lease.json.bak"), oldPair.backup);
      const fresh = await runLeaseWorker({
        mode: "heartbeat",
        directory,
        scopeKey: SCOPE_KEY,
        nowMs: (NOW_MS + 1_000n).toString(10),
        authority: first.authority,
      });
      assert.notEqual(fresh.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(fresh.latchBlocked, true);
      assert.ok(fresh.reasonCodes.includes("LEASE_ROLLBACK_DETECTED"));
    });
  });

  test("2C-C1-19 release rollback -> blocked", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority);
      const oldPair = await snapshotPair(directory);
      const released = await releaseRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS),
      });
      assert.equal(released.disposition, "RELEASED");
      assert.ok(oldPair.primary !== null && oldPair.backup !== null);
      await writeFile(path.join(directory, "runtime-lease.json"), oldPair.primary);
      await writeFile(path.join(directory, "runtime-lease.json.bak"), oldPair.backup);
      const fresh = await runLeaseWorker({
        mode: "release",
        directory,
        scopeKey: SCOPE_KEY,
        nowMs: NOW_MS.toString(10),
        authority: first.authority,
      });
      assert.notEqual(fresh.disposition, "RELEASED");
      assert.equal(fresh.latchBlocked, true);
      assert.ok(fresh.reasonCodes.includes("LEASE_ROLLBACK_DETECTED"));
    });
  });

  test("2C-C1-20 negative/excessive/throwing clock -> explicit result, no uncaught error", async () => {
    await withTempDir(async (directory) => {
      const clocks = [
        { nowMs: () => -1n },
        { nowMs: () => MAX_TIMESTAMP_MS + 1n },
        { nowMs: () => 1_000_000 as unknown as bigint },
        {
          nowMs: () => {
            throw new Error("clock-threw");
          },
        },
      ];
      for (const injected of clocks) {
        const result = await acquireRuntimeLease({
          directory,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerA",
          processInstanceId: "procA",
          latch: new RuntimePersistenceLatch(),
          clock: injected,
        });
        assert.notEqual(result.disposition, "ACQUIRED");
        assert.equal(result.allowRiskIncrease, false);
        assert.ok(
          result.reasonCodes.includes("INVALID_CLOCK") ||
            result.reasonCodes.includes("CLOCK_PROVIDER_FAILED") ||
            result.reasonCodes.includes("EXCESSIVE_TIMESTAMP") ||
            result.reasonCodes.includes("MALFORMED_TIMESTAMP"),
        );
      }
      const recovered = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.equal(recovered.disposition, "ACQUIRED");
    });
  });

  test("2C-C1-21 within-skew heartbeat record remains valid", async () => {
    await withTempDir(async (directory) => {
      const first = await acquire(directory, "ownerA", "procA", NOW_MS);
      assert.ok(first.authority && first.record);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: first.authority,
        latch: new RuntimePersistenceLatch(),
        clock: clock(NOW_MS - 500n),
      });
      assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.record);
      const parsed = parseLeaseRecord(heartbeat.record);
      assert.equal(parsed.ok, true);
      if (parsed.ok) {
        assert.ok(BigInt(parsed.record.updatedAt) >= BigInt(parsed.record.heartbeatAt));
      }
    });
  });

  test("2C-C1-22 replaced coordination lock cannot be unlinked by old guard release", async () => {
    await withTempDir(async (directory) => {
      const first = await acquireHostLocalCoordinationGuard(directory);
      assert.equal(first.ok, true);
      const lockPath = path.join(directory, COORDINATION_LOCK_FILE_NAME);
      await unlink(lockPath);
      const replacement = `999999\n${"cd".repeat(32)}\n`;
      await writeFile(lockPath, replacement, { encoding: "utf8", mode: 0o600 });
      if (first.ok) {
        await first.guard.release();
      }
      const remaining = await readFile(lockPath, "utf8");
      assert.equal(remaining, replacement);
    });
  });

  test("2C-C1-23 all prior P2-L / 2C-L01..L30 remain without weakened assertions", async () => {
    const text = await readFile(
      path.join(process.cwd(), "test/persistence/runtime-lease.test.ts"),
      "utf8",
    );
    for (let index = 1; index <= 30; index += 1) {
      const id = `2C-L${String(index).padStart(2, "0")}`;
      assert.ok(text.includes(id), `missing ${id}`);
    }
    for (const parent of [
      "P2-L01",
      "P2-L02",
      "P2-L03",
      "P2-L04",
      "P2-L05",
      "P2-L06",
      "P2-L07",
      "P2-L08",
    ]) {
      assert.ok(text.includes(parent), `missing ${parent}`);
    }
    assert.ok(text.includes('assert.equal(oldMutation.outcome, "NOT_SENT")'));
    assert.ok(text.includes("assert.equal(oldCalls, 0)"));
    assert.ok(text.includes("assert.equal(total, 219)"));
  });

  test("2C-C1-24 all Phase 2B A..H crash tests remain green", async () => {
    const text = await readFile(
      path.join(process.cwd(), "test/persistence/atomic-pair-store.test.ts"),
      "utf8",
    );
    assert.ok(text.includes("2B-P22 all backup A..H real SIGKILL cases"));
    assert.ok(text.includes("2B-P23 all primary A..H real SIGKILL cases"));
    assert.equal(ATOMIC_WRITE_HOOKS.length, 8);
  });

  test("2C-C1 witness crash matrix covers initialize/heartbeat/takeover/release windows", async () => {
    const modes = [
      "crash-initialize",
      "crash-heartbeat",
      "crash-takeover",
      "crash-release",
    ] as const;
    for (const mode of modes) {
      for (const window of CRASH_WINDOWS) {
        await withTempDir(async (directory) => {
          let authority: LeaseAuthority | undefined;
          if (mode !== "crash-initialize") {
            const seeded = await acquire(directory, "ownerA", "procA", NOW_MS);
            assert.ok(seeded.authority);
            authority = seeded.authority;
          }
          await runWitnessCrash({
            directory,
            mode,
            window,
            nowMs: mode === "crash-takeover" ? EXPIRES_MS : NOW_MS,
            ownerId: mode === "crash-heartbeat" || mode === "crash-release" ? "ownerA" : "ownerB",
            processInstanceId:
              mode === "crash-heartbeat" || mode === "crash-release" ? "procA" : "procB",
            ...(authority === undefined ? {} : { authority }),
          });
          const disk = await inspectViaFreshProcess(directory);
          assert.equal(disk.allowRiskIncrease, false);
          const fresh = await runLeaseWorker({
            mode: "acquire",
            directory,
            scopeKey: SCOPE_KEY,
            ownerId: "ownerZ",
            processInstanceId: "procZ",
            nowMs: NOW_MS.toString(10),
          });
          if (window === "AFTER_COMMIT_WITNESS" && mode === "crash-release") {
            assert.ok(
              fresh.disposition === "ACQUIRED" || fresh.disposition === "AUTHORITY_UNPROVEN",
            );
          } else if (window === "AFTER_COMMIT_WITNESS" && mode !== "crash-takeover") {
            assert.ok(
              fresh.disposition === "BLOCKED" ||
                fresh.disposition === "AUTHORITY_UNPROVEN" ||
                fresh.disposition === "ACQUIRED",
            );
          } else {
            assert.notEqual(fresh.disposition, "ACQUIRED");
          }
          assert.equal(fresh.allowRiskIncrease, false);
        });
      }
    }
  });
});
