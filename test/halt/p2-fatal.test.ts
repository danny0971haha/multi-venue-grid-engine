import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FATAL_EXIT_CODE } from "../../src/execution/index.js";
import { HALT_STATE_NAME } from "../../src/halt/index.js";
import type {
  Phase2RestartReport,
  Phase2WorkerCommand,
  Phase2WorkerEvent,
} from "../fixtures/phase2-fatal-worker.js";

const WORKER_PATH = fileURLToPath(new URL("../fixtures/phase2-fatal-worker.ts", import.meta.url));
// The worker appends one JSON line per event to this file under its root.
const EVENTS_FILE = "events.jsonl";
const T0 = 1_000_000;
const AFTER_LEASE_EXPIRY = T0 + 31_000;
const CHILD_TIMEOUT_MS = 20_000;

type ChildOutcome = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

function command(
  root: string,
  overrides: Partial<Phase2WorkerCommand> & Pick<Phase2WorkerCommand, "mode" | "label">,
): Phase2WorkerCommand {
  return {
    root,
    clockMs: String(T0),
    guard: "FATAL_GUARD",
    fault: "THROW",
    faultTick: 4,
    risk: "CLEAN",
    ...overrides,
  };
}

function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
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

function exitOf(child: ChildProcess): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      forceKill(child);
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit`));
    }, CHILD_TIMEOUT_MS);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal });
    });
  });
}

async function runWorker(cmd: Phase2WorkerCommand): Promise<ChildOutcome> {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER_PATH, JSON.stringify(cmd)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      exitOf(child),
    ]);
    return { ...exit, stdout, stderr };
  } finally {
    forceKill(child);
  }
}

async function restart(
  root: string,
  label: string,
  clockMs: number,
  risk: Phase2WorkerCommand["risk"] = "CLEAN",
): Promise<{ outcome: ChildOutcome; report: Phase2RestartReport }> {
  const outcome = await runWorker(
    command(root, { mode: "RESTART", label, clockMs: String(clockMs), risk }),
  );
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  return { outcome, report: JSON.parse(outcome.stdout) as Phase2RestartReport };
}

async function fatalRun(root: string): Promise<ChildOutcome> {
  const fatal = await runWorker(command(root, { mode: "FATAL_LOOP", label: "run1" }));
  assert.equal(fatal.exitCode, FATAL_EXIT_CODE, fatal.stderr);
  return fatal;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2-fatal-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function eventsOf(root: string, label: string): Phase2WorkerEvent[] {
  const file = path.join(root, EVENTS_FILE);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Phase2WorkerEvent)
    .filter((event) => event.label === label);
}

function types(events: Phase2WorkerEvent[]): string[] {
  return events.map((event) => event.type);
}

function evidence(
  t: { diagnostic: (message: string) => void },
  fields: {
    id: string;
    name: string;
    method: string;
    expected: string;
    observed: string;
    exitCode: number | null | string;
  },
): void {
  t.diagnostic(
    [
      `TEST_ID=${fields.id}`,
      "TEST_FILE=test/halt/p2-fatal.test.ts",
      `TEST_NAME=${fields.name}`,
      "PROCESS_ISOLATION=YES",
      `FAULT_INJECTION_METHOD=${fields.method}`,
      `EXPECTED_FINAL_STATE=${fields.expected}`,
      `OBSERVED_FINAL_STATE=${fields.observed}`,
      `EXIT_CODE=${String(fields.exitCode)}`,
    ].join(" "),
  );
}

describe("Phase 2 fatal process errors (F-01, F-02)", () => {
  for (const [id, fault, reasonCode] of [
    ["F-01", "THROW", "FATAL_UNCAUGHT_EXCEPTION"],
    ["F-02", "REJECT", "FATAL_UNHANDLED_REJECTION"],
  ] as const) {
    const name = `${id} ${fault === "THROW" ? "uncaught exception" : "unhandled rejection"} in the strategy loop trips both write fences and terminates with no later place`;
    test(name, async (t) => {
      await withRoot(async (root) => {
        const outcome = await runWorker(
          command(root, { mode: "FATAL_LOOP", label: "run1", fault }),
        );

        assert.equal(outcome.exitCode, FATAL_EXIT_CODE);
        assert.equal(outcome.signal, null);
        assert.match(outcome.stderr, new RegExp(`"reasonCode":"${reasonCode}"`));
        // Only the reason code is reported; the error itself never reaches the output.
        assert.doesNotMatch(outcome.stderr, /PHASE2_INJECTED_FAULT/);

        const events = eventsOf(root, "run1");
        const faultAt = events.findIndex((event) => event.type === "FAULT_INJECTED");
        assert.ok(faultAt > 0);
        const before = types(events.slice(0, faultAt));
        const after = types(events.slice(faultAt + 1));
        assert.ok(before.includes("PLACE"));
        assert.deepEqual(after, ["EXIT"]);
        assert.deepEqual(events.at(-1), {
          label: "run1",
          type: "EXIT",
          code: FATAL_EXIT_CODE,
          latchBlocked: true,
          latchReasonCodes: [reasonCode],
          processFenceTripped: true,
        });

        evidence(t, {
          id,
          name,
          method: `child FATAL_LOOP injects ${fault} while idle, with a risk-gated place queued right behind it`,
          expected: `exit ${FATAL_EXIT_CODE}, latch blocked ${reasonCode}, halt process fence tripped, no PLACE after fault`,
          observed: `exit ${String(outcome.exitCode)}, latch ${reasonCode}, fence tripped, after-fault events ${after.join("|")}`,
          exitCode: outcome.exitCode,
        });
      });
    });
  }

  for (const fault of ["THROW", "REJECT"] as const) {
    const name = `negative control: a log-and-ignore handler keeps placing after ${fault}`;
    test(name, async (t) => {
      await withRoot(async (root) => {
        const outcome = await runWorker(
          command(root, { mode: "FATAL_LOOP", label: "run1", fault, guard: "LOG_AND_IGNORE" }),
        );

        assert.equal(outcome.exitCode, 0, outcome.stderr);
        const events = eventsOf(root, "run1");
        const faultAt = events.findIndex((event) => event.type === "FAULT_INJECTED");
        assert.ok(faultAt > 0);
        const after = types(events.slice(faultAt + 1));
        // The control proves the harness would see a later place if the guard did not stop it.
        assert.ok(after.includes("IGNORED"));
        assert.ok(after.includes("PLACE"));
        assert.equal(events.at(-1)?.latchBlocked, false);
        assert.equal(events.at(-1)?.processFenceTripped, false);

        evidence(t, {
          id: `${fault === "THROW" ? "F-01" : "F-02"}-NC`,
          name,
          method: `child FATAL_LOOP injects ${fault} with a log-and-ignore handler instead of the guard`,
          expected: "exit 0, PLACE after fault (anti-pattern observed)",
          observed: `exit ${String(outcome.exitCode)}, after-fault events ${after.join("|")}`,
          exitCode: outcome.exitCode,
        });
      });
    });
  }
});

describe("Phase 2 supervisor restart after a fatal error (F-05)", () => {
  test("F-05 restart after a fatal exit needs the lease, the halt pair and a fresh risk decision before any place", async (t) => {
    await withRoot(async (root) => {
      const fatal = await fatalRun(root);

      // An immediate restart cannot take over the lease of the process that just died.
      const early = await restart(root, "early", T0 + 1000);
      assert.deepEqual(early.report, {
        lease: {
          disposition: "BLOCKED",
          reasonCodes: ["LEASE_BLOCKED", "LEASE_HELD_BY_OTHER", "LEASE_NOT_EXPIRED"],
          generation: null,
        },
      });
      assert.deepEqual(types(eventsOf(root, "early")), ["LEASE"]);

      const { outcome, report } = await restart(root, "restart1", AFTER_LEASE_EXPIRY);
      assert.deepEqual(report.lease, {
        disposition: "ACQUIRED",
        reasonCodes: ["LEASE_ACQUIRED", "EXACT_PAIR_PROVEN"],
        generation: "2",
      });
      // The fatal exit persisted no halt; the record is the one the dead process committed.
      assert.deepEqual(report.pair, { ok: true, status: "RUNNING", generation: "1" });
      assert.deepEqual(report.risk, {
        durableStatus: "RUNNING",
        runtimeDisposition: "RUNNING",
        systemAllowRiskIncrease: true,
        reasonCodes: ["DURABLE_HALT_RUNNING"],
      });
      assert.equal(report.place?.outcome, "SENT");
      assert.equal(report.place?.callbackCount, 1);
      const restartEvents = eventsOf(root, "restart1");
      assert.deepEqual(types(restartEvents), ["LEASE", "PAIR", "RISK", "PLACE"]);
      assert.equal(restartEvents.at(-1)?.leaseGeneration, "2");

      const name = "F-05 supervisor restart after fatal";
      evidence(t, {
        id: "F-05",
        name,
        method: "child exits 70 on an injected uncaught exception; restarts in fresh processes",
        expected:
          "early restart lease-blocked, no PLACE; takeover gen 2 proves pair RUNNING and risk CONTINUE before its one PLACE",
        observed: `early ${early.report.lease.disposition}; takeover gen ${report.lease.generation} events ${types(restartEvents).join("|")}`,
        exitCode: `${String(fatal.exitCode)} then ${String(early.outcome.exitCode)} then ${String(outcome.exitCode)}`,
      });
    });
  });

  test("F-05 a risk breach found at restart halts with no place, and a later restart stays halted", async (t) => {
    await withRoot(async (root) => {
      const fatal = await fatalRun(root);

      const breach = await restart(root, "restart1", AFTER_LEASE_EXPIRY, "DAILY_LOSS");
      assert.equal(breach.report.lease.generation, "2");
      assert.deepEqual(breach.report.pair, { ok: true, status: "RUNNING", generation: "1" });
      assert.equal(breach.report.risk?.durableStatus, "HALTED_FLAT");
      assert.equal(breach.report.risk?.systemAllowRiskIncrease, false);
      assert.equal(breach.report.place, null);
      assert.ok(!types(eventsOf(root, "restart1")).includes("PLACE"));

      // Clean input cannot restart trading over the durable halt.
      const later = await restart(root, "restart2", AFTER_LEASE_EXPIRY + 31_000);
      assert.equal(later.report.lease.generation, "3");
      assert.equal(later.report.pair?.status, "HALTED_FLAT");
      assert.equal(later.report.risk?.systemAllowRiskIncrease, false);
      assert.ok(later.report.risk?.reasonCodes.includes("CONTINUE_CANNOT_OVERRIDE_HALT"));
      assert.equal(later.report.place, null);
      assert.ok(!types(eventsOf(root, "restart2")).includes("PLACE"));

      const name = "F-05 risk breach at restart";
      evidence(t, {
        id: "F-05-BREACH",
        name,
        method:
          "child exits 70; the restart sees a daily-loss breach, then a later restart sees clean input",
        expected: "restart halts HALTED_FLAT with no PLACE; later restart stays fenced, no PLACE",
        observed: `restart ${breach.report.risk?.durableStatus}; later ${later.report.pair?.status} ${later.report.risk?.reasonCodes.join("|")}`,
        exitCode: `${String(fatal.exitCode)} then ${String(breach.outcome.exitCode)} then ${String(later.outcome.exitCode)}`,
      });
    });
  });

  test("F-05 a halt pair damaged during the downtime fails the restart closed with no place", async (t) => {
    await withRoot(async (root) => {
      const fatal = await fatalRun(root);
      const state = path.join(root, "state");
      await writeFile(path.join(state, `${HALT_STATE_NAME}.json`), "corrupt", "utf8");
      await writeFile(path.join(state, `${HALT_STATE_NAME}.json.bak`), "corrupt", "utf8");

      const { outcome, report } = await restart(root, "restart1", AFTER_LEASE_EXPIRY);
      assert.equal(report.lease.generation, "2");
      assert.deepEqual(report.pair, { ok: false, status: null, generation: null });
      assert.equal(report.risk?.runtimeDisposition, "FAIL_CLOSED");
      assert.equal(report.risk?.systemAllowRiskIncrease, false);
      assert.ok(report.risk?.reasonCodes.includes("HALT_PAIR_UNPROVEN"));
      assert.equal(report.place, null);
      assert.ok(!types(eventsOf(root, "restart1")).includes("PLACE"));

      const name = "F-05 halt pair damaged during downtime";
      evidence(t, {
        id: "F-05-PAIR",
        name,
        method: "child exits 70; both halt pair files are overwritten before the restart",
        expected: "restart risk decision FAIL_CLOSED HALT_PAIR_UNPROVEN, no PLACE",
        observed: `restart ${report.risk?.runtimeDisposition} ${report.risk?.reasonCodes.join("|")}`,
        exitCode: `${String(fatal.exitCode)} then ${String(outcome.exitCode)}`,
      });
    });
  });
});
