import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadRunManifest,
  parseTelemetryEventBytes,
  telemetryEventsPath,
  writeRunManifest,
} from "../../src/telemetry/index.js";
import type {
  Phase2FWorkerCommand,
  Phase2FWorkerResult,
} from "../fixtures/phase2f-telemetry-worker.js";
import { bootEvent, manifestInput, withTelemetryDir } from "./helpers.js";

const WORKER_PATH = fileURLToPath(
  new URL("../fixtures/phase2f-telemetry-worker.ts", import.meta.url),
);

function spawnWorker(command: Phase2FWorkerCommand): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", WORKER_PATH, JSON.stringify(command)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      text += chunk;
    });
    stream?.on("end", () => resolve(text));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("worker did not exit")), timeoutMs);
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function runWorker(command: Phase2FWorkerCommand): Promise<Phase2FWorkerResult> {
  const child = spawnWorker(command);
  const [stdout, stderr] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    waitForExit(child, 20_000),
  ]);
  assert.equal(child.exitCode, 0, stderr);
  return JSON.parse(stdout) as Phase2FWorkerResult;
}

async function crashWorker(command: Required<Phase2FWorkerCommand>): Promise<void> {
  const child = spawnWorker(command);
  const stderr = collect(child.stderr);
  try {
    await waitForPath(command.crash.readyFilePath, 20_000);
    if (child.exitCode !== null) {
      assert.fail(`worker exited before SIGKILL: ${await stderr}`);
    }
    assert.equal(child.kill("SIGKILL"), true);
    await waitForExit(child, 5_000);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function verifiedLines(directory: string) {
  const manifest = await loadRunManifest(directory);
  assert.ok(manifest.ok);
  const bytes = await readFile(telemetryEventsPath(directory));
  const parsed = parseTelemetryEventBytes(bytes, manifest.manifest, manifest.manifestSha256);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return { bytes, lines: parsed.lines };
}

describe("Phase 2F P2-T06 process restart", () => {
  test("P2-T06 restarts and SIGKILL keep the log append-only with prior lines unchanged", async () => {
    await withTelemetryDir(async (directory) => {
      assert.equal((await writeRunManifest(directory, manifestInput())).ok, true);

      const first = await runWorker({
        directory,
        events: [bootEvent(), bootEvent({ eventType: "SNAPSHOT", payload: { position: "0" } })],
      });
      assert.deepEqual(first, { ok: true, lineCount: 2, reasonCodes: [] });
      const afterFirst = await verifiedLines(directory);

      const second = await runWorker({ directory, events: [bootEvent({ eventType: "RESTART" })] });
      assert.deepEqual(second, { ok: true, lineCount: 3, reasonCodes: [] });
      const afterSecond = await verifiedLines(directory);
      assert.deepEqual(afterSecond.bytes.subarray(0, afterFirst.bytes.length), afterFirst.bytes);
      assert.equal(afterSecond.lines[2]?.sequence, "3");
      assert.equal(afterSecond.lines[2]?.previousEventSha256, afterFirst.lines[1]?.eventSha256);

      // Killed before the write: nothing reaches the log.
      await crashWorker({
        directory,
        events: [bootEvent({ eventType: "ORDER_SUBMIT" })],
        crash: { window: "EVENT_BEFORE_WRITE", readyFilePath: path.join(directory, "w.ready") },
      });
      const afterWriteCrash = await verifiedLines(directory);
      assert.deepEqual(afterWriteCrash.bytes, afterSecond.bytes);

      // Killed after the write but before fsync: the whole line may survive; prior bytes never change.
      await crashWorker({
        directory,
        events: [bootEvent({ eventType: "ORDER_SUBMIT" })],
        crash: { window: "EVENT_BEFORE_SYNC", readyFilePath: path.join(directory, "s.ready") },
      });
      const afterSyncCrash = await verifiedLines(directory);
      assert.deepEqual(
        afterSyncCrash.bytes.subarray(0, afterSecond.bytes.length),
        afterSecond.bytes,
      );
      assert.ok(afterSyncCrash.lines.length === 3 || afterSyncCrash.lines.length === 4);

      const resumed = await runWorker({ directory, events: [bootEvent({ eventType: "RESTART" })] });
      assert.equal(resumed.ok, true);
      const final = await verifiedLines(directory);
      assert.deepEqual(final.bytes.subarray(0, afterSyncCrash.bytes.length), afterSyncCrash.bytes);
      assert.equal(final.lines.length, afterSyncCrash.lines.length + 1);
      assert.equal(final.lines.at(-1)?.eventType, "RESTART");
    });
  });
});
