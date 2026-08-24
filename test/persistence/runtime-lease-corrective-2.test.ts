import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, open, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  COORDINATION_CAPABILITY,
  COORDINATION_IN_PROGRESS_GRACE_MS,
  COORDINATION_LOCK_FILE_NAME,
  COORDINATION_RECOVER_NAME,
  DISTRIBUTED_FENCING_PROVEN,
  acquireHostLocalCoordinationGuard,
  setCoordinationFaultHookForTests,
} from "../../src/persistence/lease-coordination.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  acquireRuntimeLease,
  fixedLeaseClock,
  resetLeaseProcessStateForTests,
} from "../../src/persistence/runtime-lease.js";
import type {
  CoordinationWorkerCommand,
  CoordinationWorkerResult,
} from "../fixtures/phase2c-coordination-crash-worker.js";
import type { CoordinationFaultWindow } from "../../src/persistence/lease-coordination.js";

const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
const NOW_MS = 1_000_000n;
const WORKER_PATH = fileURLToPath(
  new URL("../fixtures/phase2c-coordination-crash-worker.ts", import.meta.url),
);

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  setCoordinationFaultHookForTests(null);
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr2-"));
  try {
    await run(directory);
  } finally {
    setCoordinationFaultHookForTests(null);
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function spawnTs(command: CoordinationWorkerCommand): ChildProcess {
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
      await access(filePath);
      return;
    } catch {
      await delay(15);
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function seedStaleEmptyLock(directory: string): Promise<string> {
  const lockPath = path.join(directory, COORDINATION_LOCK_FILE_NAME);
  const handle = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  await handle.close();
  const pastSeconds = Math.floor((Date.now() - COORDINATION_IN_PROGRESS_GRACE_MS - 500) / 1000);
  await utimes(lockPath, pastSeconds, pastSeconds);
  return lockPath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function crashChildAtWindow(args: {
  directory: string;
  window: CoordinationFaultWindow;
  seedStaleLock?: boolean;
}): Promise<void> {
  if (args.seedStaleLock === true) {
    await seedStaleEmptyLock(args.directory);
  }
  const readyFilePath = path.join(args.directory, `ready-${args.window}.flag`);
  const child = spawnTs({
    directory: args.directory,
    mode: "acquire-guard",
    window: args.window,
    action: "NOTIFY_AND_WAIT",
    readyFilePath,
  });
  try {
    await waitForPath(readyFilePath, 15_000);
    assert.ok(child.pid !== undefined);
    if (child.exitCode !== null || child.signalCode !== null) {
      const stderr = await collectStream(child.stderr).catch(() => "");
      throw new Error(
        `child exited before SIGKILL code=${String(child.exitCode)} stderr=${stderr}`,
      );
    }
    const killed = child.kill("SIGKILL");
    assert.equal(killed, true);
    await waitForExit(child, 5_000);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    forceKill(child);
  }
}

async function runGuardWorker(
  command: CoordinationWorkerCommand,
  timeoutMs = 20_000,
): Promise<CoordinationWorkerResult> {
  const child = spawnTs(command);
  try {
    const [stdout, stderr] = await Promise.all([
      collectStream(child.stdout),
      collectStream(child.stderr),
      waitForExit(child, timeoutMs),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(`guard worker exited ${String(child.exitCode)}: ${stderr} stdout=${stdout}`);
    }
    const raw =
      command.resultPath === undefined ? stdout : await readFile(command.resultPath, "utf8");
    return JSON.parse(raw) as CoordinationWorkerResult;
  } finally {
    forceKill(child);
  }
}

describe("Phase 2C corrective 2", { concurrency: 1 }, () => {
  test("P2C-C2-01 SIGKILL after llock exclusive create; fresh process acquires exactly one guard", async () => {
    await withTempDir(async (directory) => {
      await crashChildAtWindow({ directory, window: "AFTER_LLOCK_EXCL_CREATE" });
      const lockPath = path.join(directory, COORDINATION_LOCK_FILE_NAME);
      assert.equal(await pathExists(lockPath), true);
      const leftover = await readFile(lockPath, "utf8");
      assert.equal(leftover.trim().length, 0);

      const fresh = await runGuardWorker({
        directory,
        mode: "acquire-guard",
        resultPath: path.join(directory, "fresh-01.json"),
      });
      assert.equal(fresh.ok, true);
      assert.equal(fresh.callbackCount, 1);
      assert.equal(fresh.allowRiskIncrease, false);
      assert.equal(fresh.coordinationCapability, COORDINATION_CAPABILITY);
      assert.equal(fresh.distributedFencingProven, false);
      assert.equal(DISTRIBUTED_FENCING_PROVEN, false);
    });
  });

  test("P2C-C2-02 delayed original creator gets no guard and performs no callback", async () => {
    await withTempDir(async (directory) => {
      const readyFilePath = path.join(directory, "ready-delayed.flag");
      const resumeFilePath = path.join(directory, "resume-delayed.flag");
      const delayedResultPath = path.join(directory, "delayed.json");
      const delayed = spawnTs({
        directory,
        mode: "acquire-guard",
        window: "AFTER_LLOCK_EXCL_CREATE",
        action: "NOTIFY_AND_WAIT_RESUME",
        readyFilePath,
        resumeFilePath,
        resultPath: delayedResultPath,
      });
      try {
        await waitForPath(readyFilePath, 15_000);
        const reclaim = await runGuardWorker({
          directory,
          mode: "acquire-guard",
          resultPath: path.join(directory, "reclaim.json"),
        });
        assert.equal(reclaim.ok, true);
        assert.equal(reclaim.callbackCount, 1);
        assert.equal(reclaim.allowRiskIncrease, false);

        await writeFile(resumeFilePath, "resume\n", { encoding: "utf8" });
        await waitForExit(delayed, 15_000);
        const delayedResult = JSON.parse(
          await readFile(delayedResultPath, "utf8"),
        ) as CoordinationWorkerResult;
        assert.equal(delayedResult.ok, false);
        assert.equal(delayedResult.callbackCount, 0);
        assert.equal(delayedResult.allowRiskIncrease, false);
      } finally {
        forceKill(delayed);
      }
    });
  });

  test("P2C-C2-03 SIGKILL after metadata write before path identity; fresh process recovers", async () => {
    await withTempDir(async (directory) => {
      await crashChildAtWindow({ directory, window: "AFTER_LLOCK_METADATA_WRITE" });
      const lockPath = path.join(directory, COORDINATION_LOCK_FILE_NAME);
      const leftover = await readFile(lockPath, "utf8");
      assert.ok(leftover.trim().length > 0);

      const fresh = await runGuardWorker({
        directory,
        mode: "acquire-guard",
        resultPath: path.join(directory, "fresh-03.json"),
      });
      assert.equal(fresh.ok, true);
      assert.equal(fresh.callbackCount, 1);
      assert.equal(fresh.allowRiskIncrease, false);
    });
  });

  test("P2C-C2-04 SIGKILL immediately after llock.recover create; fresh recoverer recovers", async () => {
    await withTempDir(async (directory) => {
      await crashChildAtWindow({
        directory,
        window: "AFTER_RECOVER_EXCL_CREATE",
        seedStaleLock: true,
      });
      const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
      assert.equal(await pathExists(recoverPath), true);
      const leftover = await readFile(recoverPath, "utf8");
      assert.equal(leftover.trim().length, 0);

      const fresh = await runGuardWorker({
        directory,
        mode: "acquire-guard",
        resultPath: path.join(directory, "fresh-04.json"),
      });
      assert.equal(fresh.ok, true);
      assert.equal(fresh.callbackCount, 1);
      assert.equal(fresh.allowRiskIncrease, false);
    });
  });

  test("P2C-C2-05 SIGKILL after stale llock unlink before recover cleanup; fresh process acquires", async () => {
    await withTempDir(async (directory) => {
      await crashChildAtWindow({
        directory,
        window: "AFTER_STALE_LLOCK_UNLINK",
        seedStaleLock: true,
      });
      const lockPath = path.join(directory, COORDINATION_LOCK_FILE_NAME);
      const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
      assert.equal(await pathExists(lockPath), false);
      assert.equal(await pathExists(recoverPath), true);

      const fresh = await runGuardWorker({
        directory,
        mode: "acquire-guard",
        resultPath: path.join(directory, "fresh-05.json"),
      });
      assert.equal(fresh.ok, true);
      assert.equal(fresh.callbackCount, 1);
      assert.equal(fresh.allowRiskIncrease, false);
    });
  });

  test("P2C-C2-06 live recoverer remains protected and cannot be stolen", async () => {
    await withTempDir(async (directory) => {
      await seedStaleEmptyLock(directory);
      const readyFilePath = path.join(directory, "ready-live-recover.flag");
      const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
      const holder = spawnTs({
        directory,
        mode: "acquire-guard",
        window: "AFTER_RECOVER_IDENTITY",
        action: "NOTIFY_AND_WAIT",
        readyFilePath,
      });
      try {
        await waitForPath(readyFilePath, 15_000);
        const held = await readFile(recoverPath, "utf8");
        assert.ok(held.trim().length > 0);
        assert.ok(holder.pid !== undefined);
        assert.match(held.split("\n")[0] ?? "", /^[1-9][0-9]{0,15}$/);

        const stolen = await acquireHostLocalCoordinationGuard(directory, 800);
        assert.equal(stolen.ok, false);
        if (stolen.ok) {
          assert.fail("live recoverer was stolen");
        }
        assert.ok(
          stolen.reasonCodes.includes("COORDINATION_LOCK_TIMEOUT") ||
            stolen.reasonCodes.includes("COORDINATION_LOCK_HELD"),
        );
        assert.equal(await readFile(recoverPath, "utf8"), held);
      } finally {
        forceKill(holder);
      }
    });
  });

  test("P2C-C2-07 replaced recovery file is never unlinked by an older recoverer", async () => {
    await withTempDir(async (directory) => {
      await seedStaleEmptyLock(directory);
      const readyFilePath = path.join(directory, "ready-replace-recover.flag");
      const resumeFilePath = path.join(directory, "resume-replace-recover.flag");
      const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
      const older = spawnTs({
        directory,
        mode: "acquire-guard",
        window: "AFTER_RECOVER_IDENTITY",
        action: "NOTIFY_AND_WAIT_RESUME",
        readyFilePath,
        resumeFilePath,
        resultPath: path.join(directory, "older-recover.json"),
        deadlineMs: 2_500,
      });
      try {
        await waitForPath(readyFilePath, 15_000);
        await unlink(recoverPath);
        const replacement = `${process.pid.toString(10)}\n${"ab".repeat(32)}\n`;
        await writeFile(recoverPath, replacement, { encoding: "utf8", mode: 0o600 });
        await writeFile(resumeFilePath, "resume\n", { encoding: "utf8" });
        await waitForExit(older, 15_000);
        const remaining = await readFile(recoverPath, "utf8");
        assert.equal(remaining, replacement);
      } finally {
        forceKill(older);
      }
    });
  });

  test("P2C-C2-08 malformed recovery metadata fails closed and performs no lease write", async () => {
    await withTempDir(async (directory) => {
      await seedStaleEmptyLock(directory);
      const recoverPath = path.join(directory, COORDINATION_RECOVER_NAME);
      await writeFile(recoverPath, "not-a-pid\n", { encoding: "utf8", mode: 0o600 });
      const result = await acquireRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerA",
        processInstanceId: "procA",
        latch: new RuntimePersistenceLatch(),
        clock: fixedLeaseClock(NOW_MS),
      });
      assert.notEqual(result.disposition, "ACQUIRED");
      assert.equal(result.allowRiskIncrease, false);
      assert.equal(result.authority, null);
      assert.ok(result.reasonCodes.includes("COORDINATION_LOCK_UNCERTAIN"));
      assert.equal(await pathExists(path.join(directory, "runtime-lease.json")), false);
      assert.equal(await pathExists(path.join(directory, "runtime-lease.json.bak")), false);
    });
  });

  test("P2C-C2-09 two fresh children after recovery yield exactly one successful guard", async () => {
    await withTempDir(async (directory) => {
      await seedStaleEmptyLock(directory);
      const workers = [0, 1].map((index) => {
        const resultPath = path.join(directory, `race-${String(index)}.json`);
        return {
          resultPath,
          child: spawnTs({
            directory,
            mode: "acquire-guard",
            resultPath,
            holdGuard: true,
            deadlineMs: 8_000,
          }),
        };
      });
      try {
        await Promise.race(workers.map((worker) => waitForPath(worker.resultPath, 20_000)));
        await delay(1_500);
        const typed: CoordinationWorkerResult[] = [];
        for (const worker of workers) {
          if (await pathExists(worker.resultPath)) {
            typed.push(JSON.parse(await readFile(worker.resultPath, "utf8")));
          }
        }
        const successes = typed.filter((result) => result.ok);
        assert.equal(successes.length, 1);
        assert.equal(successes[0]?.callbackCount, 1);
        assert.equal(
          typed.every((result) => result.allowRiskIncrease === false),
          true,
        );
        assert.equal(typed.filter((result) => result.callbackCount === 1).length, 1);
      } finally {
        for (const worker of workers) {
          forceKill(worker.child);
        }
      }
    });
  });

  test("P2C-C2-10 all prior Phase 2C, 2C-L, and 2C-C1 tests remain unchanged", async () => {
    const phase2c = await readFile(
      path.join(process.cwd(), "test/persistence/runtime-lease.test.ts"),
      "utf8",
    );
    const corrective1 = await readFile(
      path.join(process.cwd(), "test/persistence/runtime-lease-corrective-1.test.ts"),
      "utf8",
    );
    for (let index = 1; index <= 30; index += 1) {
      const id = `2C-L${String(index).padStart(2, "0")}`;
      assert.ok(phase2c.includes(id), `missing ${id}`);
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
      assert.ok(phase2c.includes(parent), `missing ${parent}`);
    }
    for (let index = 1; index <= 24; index += 1) {
      const id = `2C-C1-${String(index).padStart(2, "0")}`;
      assert.ok(corrective1.includes(id), `missing ${id}`);
    }
    assert.ok(phase2c.includes('assert.equal(oldMutation.outcome, "NOT_SENT")'));
    assert.ok(phase2c.includes("assert.equal(oldCalls, 0)"));
    assert.ok(phase2c.includes("assert.equal(total, 219)"));
    assert.ok(corrective1.includes("assert.equal(oldCalls, 0)"));
  });
});
