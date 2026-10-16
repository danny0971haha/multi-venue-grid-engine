import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FATAL_EXIT_CODE } from "../../src/execution/index.js";
import type {
  Phase3ERestartReport,
  Phase3EWorkerCommand,
} from "../fixtures/phase3e-fatal-worker.js";
import { FileBackedVenue, readEvents, type VenueEvent } from "../fixtures/phase3e-venue.js";

const WORKER_PATH = fileURLToPath(new URL("../fixtures/phase3e-fatal-worker.ts", import.meta.url));
const T0 = 1_000_000;
const AFTER_LEASE_EXPIRY = T0 + 31_000;
const CHILD_TIMEOUT_MS = 20_000;

type ChildOutcome = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

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

function command(
  root: string,
  overrides: Partial<Phase3EWorkerCommand> & Pick<Phase3EWorkerCommand, "mode" | "label">,
): Phase3EWorkerCommand {
  return {
    root,
    clockMs: String(T0),
    guard: "FATAL_GUARD",
    fault: "THROW",
    faultTick: 4,
    readyPath: null,
    sequenceBase: 0,
    ...overrides,
  };
}

function spawnWorker(cmd: Phase3EWorkerCommand): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", WORKER_PATH, JSON.stringify(cmd)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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

async function runWorker(cmd: Phase3EWorkerCommand): Promise<ChildOutcome> {
  const child = spawnWorker(cmd);
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

// Starts a worker that hangs at a known point, then kills it with SIGKILL once it has
// written its ready file. The kill gives the process no chance to run any handler.
async function killAtReadyPoint(cmd: Phase3EWorkerCommand): Promise<ChildOutcome> {
  assert.ok(cmd.readyPath !== null);
  const child = spawnWorker(cmd);
  try {
    const exit = exitOf(child);
    const streams = Promise.all([collect(child.stdout), collect(child.stderr)]);
    await waitForPath(cmd.readyPath, CHILD_TIMEOUT_MS);
    assert.ok(child.pid !== undefined);
    process.kill(child.pid, "SIGKILL");
    const [{ exitCode, signal }, [stdout, stderr]] = await Promise.all([exit, streams]);
    return { exitCode, signal, stdout, stderr };
  } finally {
    forceKill(child);
  }
}

async function restart(
  root: string,
  label: string,
  clockMs: number,
  sequenceBase = 100,
): Promise<{ outcome: ChildOutcome; report: Phase3ERestartReport }> {
  const outcome = await runWorker(
    command(root, { mode: "RESTART", label, clockMs: String(clockMs), sequenceBase }),
  );
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  return { outcome, report: JSON.parse(outcome.stdout) as Phase3ERestartReport };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "phase3e-fatal-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function venueDirectory(root: string): string {
  return path.join(root, "venue");
}

function eventsOf(root: string, label: string): VenueEvent[] {
  return readEvents(venueDirectory(root)).filter((event) => event.label === label);
}

function types(events: VenueEvent[]): string[] {
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
      "TEST_FILE=test/execution/p3-fatal.test.ts",
      `TEST_NAME=${fields.name}`,
      "PROCESS_ISOLATION=YES",
      `FAULT_INJECTION_METHOD=${fields.method}`,
      `EXPECTED_FINAL_STATE=${fields.expected}`,
      `OBSERVED_FINAL_STATE=${fields.observed}`,
      `EXIT_CODE=${String(fields.exitCode)}`,
    ].join(" "),
  );
}

describe("Phase 3E fatal process errors (F-01, F-02)", () => {
  for (const [id, fault, reasonCode] of [
    ["F-01", "THROW", "FATAL_UNCAUGHT_EXCEPTION"],
    ["F-02", "REJECT", "FATAL_UNHANDLED_REJECTION"],
  ] as const) {
    const name = `${id} ${fault === "THROW" ? "uncaught exception" : "unhandled rejection"} while trading fences writes and terminates with no later place`;
    test(name, async (t) => {
      await withRoot(async (root) => {
        const outcome = await runWorker(
          command(root, { mode: "FATAL_LOOP", label: "run1", fault }),
        );

        assert.equal(outcome.exitCode, FATAL_EXIT_CODE);
        assert.equal(outcome.signal, null);
        assert.match(outcome.stderr, new RegExp(`"reasonCode":"${reasonCode}"`));
        // Only the reason code is reported; the error itself never reaches the output.
        assert.doesNotMatch(outcome.stderr, /PHASE3E_INJECTED_FAULT/);

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
        });

        evidence(t, {
          id,
          name,
          method: `child FATAL_LOOP injects ${fault} while idle, with a place queued right behind it`,
          expected: `exit ${FATAL_EXIT_CODE}, latch blocked ${reasonCode}, no PLACE after fault`,
          observed: `exit ${String(outcome.exitCode)}, latch ${reasonCode}, after-fault events ${after.join("|")}`,
          exitCode: outcome.exitCode,
        });
      });
    });
  }

  for (const fault of ["THROW", "REJECT"] as const) {
    const name = `negative control: a log-and-ignore handler keeps trading after ${fault}`;
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

  test("a second guard install in one process is refused", async () => {
    await withRoot(async (root) => {
      const outcome = await runWorker(command(root, { mode: "DOUBLE_INSTALL", label: "double" }));
      assert.equal(outcome.exitCode, 0, outcome.stderr);
      assert.deepEqual(JSON.parse(outcome.stdout), { second: "FATAL_GUARD_ALREADY_INSTALLED" });
    });
  });
});

describe("Phase 3E process death around the send (F-03, F-04)", () => {
  test("F-03 kill after the intent is durable but before transport restarts as UNKNOWN and blocks risk", async (t) => {
    await withRoot(async (root) => {
      const killed = await killAtReadyPoint(
        command(root, {
          mode: "PRE_TRANSPORT_KILL",
          label: "run1",
          readyPath: path.join(root, "ready"),
        }),
      );
      assert.equal(killed.signal, "SIGKILL");
      const killedEvents = types(eventsOf(root, "run1"));
      assert.ok(!killedEvents.includes("PLACE"));
      assert.ok(!killedEvents.includes("EXIT"));

      const first = await restart(root, "restart1", AFTER_LEASE_EXPIRY);
      const report = first.report;
      assert.deepEqual(report.lease, {
        disposition: "ACQUIRED",
        reasonCodes: ["LEASE_ACQUIRED", "EXACT_PAIR_PROVEN"],
        generation: "2",
      });
      assert.deepEqual(report.open, { ok: true, reasonCodes: [] });
      assert.deepEqual(report.statusesBefore, { B1: "PREPARED" });
      assert.deepEqual(report.recovery, {
        ok: true,
        reasonCodes: [],
        items: [{ from: "PREPARED", to: "UNKNOWN" }],
      });
      assert.deepEqual(report.statusesAfterRecovery, { B1: "UNKNOWN" });
      assert.equal(report.unknownReservationsBeforeGate, 1);
      assert.deepEqual(report.preGateSubmit, {
        disposition: "REFUSED",
        status: null,
        reasonCodes: ["UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE"],
      });
      assert.equal(report.gate?.allowRiskIncrease, false);
      assert.ok(report.gate?.reasonCodes.includes("UNRESOLVED_INTENT"));
      assert.deepEqual(report.postGateSubmit, {
        disposition: "REFUSED",
        status: null,
        reasonCodes: ["UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE"],
      });
      assert.deepEqual(report.finalStatuses, { B1: "UNKNOWN" });
      assert.equal(report.latchBlocked, false);
      const restartEvents = types(eventsOf(root, "restart1"));
      assert.ok(restartEvents.includes("LOOKUP"));
      assert.ok(!restartEvents.includes("PLACE"));
      const venue = await FileBackedVenue.open(venueDirectory(root), "parent");
      assert.deepEqual(await venue.openOrders(), []);

      // The UNKNOWN itself is durable: a later process loads it without recovering again.
      const second = await restart(root, "restart2", AFTER_LEASE_EXPIRY + 31_000, 200);
      assert.equal(second.report.lease.generation, "3");
      assert.deepEqual(second.report.statusesBefore, { B1: "UNKNOWN" });
      assert.deepEqual(second.report.recovery?.items, []);
      assert.equal(second.report.gate?.allowRiskIncrease, false);
      assert.equal(second.report.postGateSubmit?.disposition, "REFUSED");
      assert.ok(!types(eventsOf(root, "restart2")).includes("PLACE"));

      const name = "F-03 kill after intent persisted, before transport";
      evidence(t, {
        id: "F-03",
        name,
        method:
          "SIGKILL of a child hanging in the lease pre-callback hook after PREPARED is durable",
        expected: "restart: PREPARED->UNKNOWN durable, reserved, risk increase refused, no PLACE",
        observed: `restart: ${JSON.stringify(report.finalStatuses)}, gate ${report.gate?.reasonCodes.join("|")}, second restart ${JSON.stringify(second.report.statusesBefore)}`,
        exitCode: `SIGKILL then ${String(first.outcome.exitCode)}`,
      });
    });
  });

  test("F-04 kill after the venue accepted but before the response restarts UNKNOWN then links without resend", async (t) => {
    await withRoot(async (root) => {
      const killed = await killAtReadyPoint(
        command(root, {
          mode: "IN_TRANSPORT_KILL",
          label: "run1",
          readyPath: path.join(root, "ready"),
        }),
      );
      assert.equal(killed.signal, "SIGKILL");
      const killedEvents = eventsOf(root, "run1");
      const sent = killedEvents.filter((event) => event.type === "PLACE");
      assert.equal(sent.length, 1);
      assert.ok(!types(killedEvents).includes("EXIT"));
      const clientOrderId = sent[0]?.clientOrderId;

      const { outcome, report } = await restart(root, "restart1", AFTER_LEASE_EXPIRY);
      assert.equal(report.lease.disposition, "ACQUIRED");
      assert.deepEqual(report.statusesBefore, { B1: "PREPARED" });
      assert.deepEqual(report.recovery?.items, [{ from: "PREPARED", to: "UNKNOWN" }]);
      // Before the gate the possible order is reserved as exposure and blocks new risk.
      assert.equal(report.unknownReservationsBeforeGate, 1);
      assert.deepEqual(report.preGateSubmit?.reasonCodes, [
        "UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE",
      ]);
      assert.deepEqual(report.gate, {
        allowRiskIncrease: true,
        reasonCodes: [],
        recordedExecutions: [],
      });
      assert.deepEqual(report.postGateSubmit, {
        disposition: "RECORDED",
        status: "LINKED",
        reasonCodes: ["VENUE_ACK"],
      });
      assert.deepEqual(report.finalStatuses, { B1: "LINKED", R2: "LINKED" });

      const venue = await FileBackedVenue.open(venueDirectory(root), "parent");
      const open = await venue.openOrders();
      assert.equal(open.filter((order) => order.clientOrderId === clientOrderId).length, 1);
      assert.equal(open.length, 2);
      const restartTypes = types(eventsOf(root, "restart1"));
      const firstPlace = restartTypes.indexOf("PLACE");
      assert.equal(restartTypes.filter((type) => type === "PLACE").length, 1);
      for (const required of ["LOOKUP", "LIST", "EXECUTIONS"]) {
        const at = restartTypes.indexOf(required);
        assert.ok(at >= 0 && at < firstPlace, `${required} before the first restart PLACE`);
      }
      const restartPlaces = eventsOf(root, "restart1").filter((event) => event.type === "PLACE");
      assert.notEqual(restartPlaces[0]?.clientOrderId, clientOrderId);

      const name = "F-04 kill after transport, before response";
      evidence(t, {
        id: "F-04",
        name,
        method: "SIGKILL of a child hanging inside placeOrder after the venue stored the order",
        expected: "restart: UNKNOWN reserved, lookup links B1, no resend, gate then allows",
        observed: `restart: ${JSON.stringify(report.finalStatuses)}, venue orders for B1 ${String(open.filter((order) => order.clientOrderId === clientOrderId).length)}`,
        exitCode: `SIGKILL then ${String(outcome.exitCode)}`,
      });
    });
  });
});

describe("Phase 3E supervisor restart after a fatal error (F-05)", () => {
  test("F-05 restart after a fatal exit needs the lease and the full gate before any risk increase", async (t) => {
    await withRoot(async (root) => {
      const fatal = await runWorker(command(root, { mode: "FATAL_LOOP", label: "run1" }));
      assert.equal(fatal.exitCode, FATAL_EXIT_CODE);

      // An immediate restart cannot take over the lease of the process that just died.
      const early = await runWorker(
        command(root, { mode: "RESTART", label: "early", clockMs: String(T0 + 1000) }),
      );
      assert.equal(early.exitCode, 0, early.stderr);
      const earlyReport = JSON.parse(early.stdout) as Phase3ERestartReport;
      assert.deepEqual(earlyReport.lease, {
        disposition: "BLOCKED",
        reasonCodes: ["LEASE_BLOCKED", "LEASE_HELD_BY_OTHER", "LEASE_NOT_EXPIRED"],
        generation: null,
      });
      assert.equal(earlyReport.open, undefined);
      assert.deepEqual(types(eventsOf(root, "early")), ["EXIT"]);

      // While nothing runs, the first grid order fills on the venue.
      const venue = await FileBackedVenue.open(venueDirectory(root), "parent");
      const placedBefore = (await venue.openOrders()).length;
      venue.fill("sim-order-1", "0.01", "100");

      const { outcome, report } = await restart(root, "restart1", AFTER_LEASE_EXPIRY);
      assert.equal(report.lease.generation, "2");
      assert.deepEqual(report.recovery?.items, []);
      assert.equal(report.statusesBefore?.B1, "LINKED");
      assert.deepEqual(report.preGateSubmit, {
        disposition: "REFUSED",
        status: null,
        reasonCodes: ["OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE"],
      });
      assert.deepEqual(report.gate, {
        allowRiskIncrease: true,
        reasonCodes: [],
        recordedExecutions: ["sim-exec-1"],
      });
      assert.equal(report.finalStatuses?.B1, "FILLED");
      assert.deepEqual(report.postGateSubmit, {
        disposition: "RECORDED",
        status: "LINKED",
        reasonCodes: ["VENUE_ACK"],
      });
      const restartTypes = types(eventsOf(root, "restart1"));
      const firstPlace = restartTypes.indexOf("PLACE");
      assert.ok(firstPlace > restartTypes.indexOf("LIST"));
      assert.ok(firstPlace > restartTypes.indexOf("EXECUTIONS"));
      assert.ok(restartTypes.indexOf("LIST") >= 0 && restartTypes.indexOf("EXECUTIONS") >= 0);
      // The fill closed B1 and the one post-gate order R2 opened, so the count is unchanged.
      const after = await FileBackedVenue.open(venueDirectory(root), "parent");
      assert.equal((await after.openOrders()).length, placedBefore);

      const name = "F-05 supervisor restart after fatal";
      evidence(t, {
        id: "F-05",
        name,
        method: "child exits 70 on an injected uncaught exception; restarts in fresh processes",
        expected: "early restart lease-blocked; takeover scans and replays before the first PLACE",
        observed: `early ${earlyReport.lease.disposition}; takeover gate ${String(report.gate?.allowRiskIncrease)} executions ${report.gate?.recordedExecutions.join("|")} B1 ${report.finalStatuses?.B1}`,
        exitCode: `${String(fatal.exitCode)} then ${String(outcome.exitCode)}`,
      });
    });
  });

  test("F-05 an unowned order that appeared during the downtime blocks the restart", async (t) => {
    await withRoot(async (root) => {
      const fatal = await runWorker(command(root, { mode: "FATAL_LOOP", label: "run1" }));
      assert.equal(fatal.exitCode, FATAL_EXIT_CODE);

      const venue = await FileBackedVenue.open(venueDirectory(root), "parent");
      venue.addForeignOrder({
        clientOrderId: "manual-1",
        side: "SELL",
        price: "120",
        quantity: "0.01",
      });

      const { outcome, report } = await restart(root, "restart1", AFTER_LEASE_EXPIRY);
      assert.equal(report.gate?.allowRiskIncrease, false);
      assert.ok(report.gate?.reasonCodes.includes("UNOWNED_OPEN_ORDER"));
      assert.deepEqual(report.postGateSubmit, {
        disposition: "REFUSED",
        status: null,
        reasonCodes: ["OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE"],
      });
      assert.ok(!types(eventsOf(root, "restart1")).includes("PLACE"));

      const name = "F-05 unowned order during downtime";
      evidence(t, {
        id: "F-05-UNOWNED",
        name,
        method: "child exits 70; a foreign order is added to the venue before the restart",
        expected: "gate blocked UNOWNED_OPEN_ORDER, post-gate submit refused, no PLACE",
        observed: `gate ${report.gate?.reasonCodes.join("|")}, post ${report.postGateSubmit?.disposition}`,
        exitCode: `${String(fatal.exitCode)} then ${String(outcome.exitCode)}`,
      });
    });
  });
});
