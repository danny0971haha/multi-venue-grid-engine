import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import * as eventLogModule from "../../src/telemetry/event-log.js";
import type { RunManifest, TelemetryEventInput } from "../../src/telemetry/index.js";
import * as telemetryModule from "../../src/telemetry/index.js";
import {
  GENESIS_EVENT_SHA256,
  gateRiskIncreaseOnEvidence,
  loadRunManifest,
  openTelemetryLog,
  TelemetryLog,
  telemetryEventsPath,
} from "../../src/telemetry/index.js";
import { bootEvent, RECORDED_AT, startRun, withTelemetryDir } from "./helpers.js";

const ALLOW = { allowRiskIncrease: true, reasonCodes: [] };
const SIMULATED_FILL = bootEvent({ eventType: "FILL", provenance: "SIMULATED" });

// Everything a writer would otherwise take on trust from whoever constructed it.
type WriterState = {
  filePath: string;
  manifest: RunManifest;
  manifestSha256: string;
  byteLength: number;
  lineCount: number;
  lastEventSha256: string;
  clock: () => string;
};

// The class as an untyped caller sees it.
const AnyArgsLog = TelemetryLog as unknown as new (...args: unknown[]) => TelemetryLog;

// A subclass cannot reach the key either; its default constructor only forwards what it is given.
class ForgedLog extends AnyArgsLog {}

const CONSTRUCTION_PATHS: Array<[string, (opened: TelemetryLog, args: unknown[]) => unknown]> = [
  ["exported class", (_opened, args) => new AnyArgsLog(...args)],
  ["opened writer's constructor", (opened, args) => Reflect.construct(opened.constructor, args)],
  ["subclass", (_opened, args) => new ForgedLog(...args)],
  ["foreign new.target", (_opened, args) => Reflect.construct(TelemetryLog, args, Object)],
];

// The pre-corrective state-only form, and key forms with keys a caller can mint itself.
function argumentShapes(state: WriterState): Array<[string, unknown[]]> {
  return [
    ["state only", [state]],
    ["fresh symbol key", [Symbol("TelemetryLog.open"), state]],
    ["registered symbol key", [Symbol.for("TelemetryLog.open"), state]],
    ["undefined key", [undefined, state]],
  ];
}

// Runs one outside construction attempt. Should a writer ever come back, it is used the way a
// caller would before the refusal is asserted, so a regression reports the line it let through
// rather than only a missing exception.
async function assertRefused(
  construct: () => unknown,
  probe: TelemetryEventInput,
  label: string,
): Promise<void> {
  let writer: unknown = null;
  let error: unknown = null;
  try {
    writer = construct();
  } catch (caught) {
    error = caught;
  }
  if (writer !== null) {
    const appended = await TelemetryLog.prototype.append.call(writer as TelemetryLog, probe);
    assert.equal(
      appended.ok,
      false,
      `${label}: a writer not created by openTelemetryLog appended ${probe.provenance} ${probe.eventType}`,
    );
  }
  assert.ok(error instanceof TypeError, `${label}: construction was not refused`);
  assert.match(error.message, /openTelemetryLog/, label);
}

async function assertEveryPathRefused(
  opened: TelemetryLog,
  state: WriterState,
  probe: TelemetryEventInput,
  label: string,
): Promise<void> {
  for (const [pathLabel, construct] of CONSTRUCTION_PATHS) {
    for (const [shapeLabel, args] of argumentShapes(state)) {
      await assertRefused(
        () => construct(opened, args),
        probe,
        `${label} / ${pathLabel} / ${shapeLabel}`,
      );
    }
  }
}

async function assertReopens(directory: string, lineCount: number, label: string): Promise<void> {
  const reopened = await openTelemetryLog(directory);
  assert.ok(reopened.ok, `${label}: ${reopened.ok ? "" : reopened.reasonCodes.join(",")}`);
  assert.equal(reopened.log.lineCount, lineCount, label);
}

async function assertUnchanged(directory: string, before: Buffer, label: string): Promise<void> {
  assert.ok((await readFile(telemetryEventsPath(directory))).equals(before), label);
}

describe("Gate 2 re-review RC3: only the validated open path creates a telemetry writer (RISK_PERSISTENCE_CONTRACT §23/§24)", () => {
  test("G2-RC3-1 a DRY_RUN copy of a LIVE manifest with the real hash cannot become a writer", async () => {
    await withTelemetryDir(async (directory) => {
      const opened = await startRun(directory, { mode: "LIVE" });
      const durable = await loadRunManifest(directory);
      assert.ok(durable.ok);
      const before = await readFile(telemetryEventsPath(directory));
      assert.equal(before.length, 0);

      const forged: WriterState = {
        filePath: telemetryEventsPath(directory),
        manifest: { ...durable.manifest, mode: "DRY_RUN" },
        manifestSha256: durable.manifestSha256,
        byteLength: 0,
        lineCount: 0,
        lastEventSha256: GENESIS_EVENT_SHA256,
        clock: () => RECORDED_AT,
      };
      await assertEveryPathRefused(opened, forged, SIMULATED_FILL, "DRY_RUN copy");
      await assertUnchanged(directory, before, "DRY_RUN copy");
      await assertReopens(directory, 0, "DRY_RUN copy");

      // The genuine writer still applies the durable LIVE mode, and the gate still denies.
      const rejected = await opened.append(SIMULATED_FILL);
      assert.ok(!rejected.ok);
      assert.deepEqual(rejected.reasonCodes, [
        "TELEMETRY_SIMULATED_OUTSIDE_DRY_RUN",
        "TELEMETRY_EVIDENCE_UNAVAILABLE",
      ]);
      assert.equal(gateRiskIncreaseOnEvidence(ALLOW, [rejected]).allowRiskIncrease, false);
      assert.equal((await opened.append(bootEvent())).ok, true);
      await assertReopens(directory, 1, "after genuine append");
    });
  });

  test("G2-RC3-2 forged identity or chain position, or even truthful state, cannot become a writer", async () => {
    await withTelemetryDir(async (directory) => {
      const opened = await startRun(directory, { mode: "LIVE" });
      const first = await opened.append(bootEvent());
      assert.ok(first.ok);
      const durable = await loadRunManifest(directory);
      assert.ok(durable.ok);
      const before = await readFile(telemetryEventsPath(directory));

      const truthful: WriterState = {
        filePath: telemetryEventsPath(directory),
        manifest: durable.manifest,
        manifestSha256: durable.manifestSha256,
        byteLength: before.length,
        lineCount: 1,
        lastEventSha256: first.line.eventSha256,
        clock: () => RECORDED_AT,
      };
      const variants: Array<[string, WriterState]> = [
        ["foreign runId", { ...truthful, manifest: { ...durable.manifest, runId: "run-9999" } }],
        ["foreign manifest hash", { ...truthful, manifestSha256: "f".repeat(64) }],
        ["rewound chain", { ...truthful, lineCount: 0, lastEventSha256: GENESIS_EVENT_SHA256 }],
        ["wrong previous event hash", { ...truthful, lastEventSha256: "a".repeat(64) }],
        ["truthful state", truthful],
      ];
      for (const [label, state] of variants) {
        await assertEveryPathRefused(opened, state, bootEvent(), label);
        await assertUnchanged(directory, before, label);
        await assertReopens(directory, 1, label);
      }

      const second = await opened.append(bootEvent());
      assert.ok(second.ok);
      assert.equal(second.line.sequence, "2");
      await assertReopens(directory, 2, "after genuine append");
    });
  });

  test("G2-RC3-3 the open key is not reachable from the modules, the class or a writer", async () => {
    await withTelemetryDir(async (directory) => {
      const opened = await startRun(directory);
      assert.ok(opened instanceof TelemetryLog);
      assert.equal(opened.constructor, TelemetryLog);
      const holders: Array<[string, object]> = [
        ["class", TelemetryLog],
        ["prototype", TelemetryLog.prototype],
        ["writer", opened],
      ];
      for (const [label, holder] of holders) {
        assert.deepEqual(Object.getOwnPropertySymbols(holder), [], label);
      }
      for (const [label, exports] of [
        ["event-log", eventLogModule],
        ["telemetry index", telemetryModule],
      ] as const) {
        for (const [name, value] of Object.entries(exports)) {
          assert.notEqual(typeof value, "symbol", `${label} export ${name}`);
        }
      }
    });
  });

  test("G2-RC3-4 an object that only borrows the prototype cannot append or expose state", async () => {
    await withTelemetryDir(async (directory) => {
      await startRun(directory, { mode: "LIVE" });
      const before = await readFile(telemetryEventsPath(directory));

      const shell = Object.create(TelemetryLog.prototype) as TelemetryLog;
      assert.throws(() => shell.append(SIMULATED_FILL), TypeError);
      assert.throws(() => shell.manifest, TypeError);
      assert.throws(() => shell.lineCount, TypeError);

      await assertUnchanged(directory, before, "prototype shell");
      await assertReopens(directory, 0, "prototype shell");
    });
  });
});
