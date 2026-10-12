import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import type { RuntimeMode } from "../../src/bootstrap/runtimeMode.js";
import { V01_EXPERIMENT_CONFIG } from "../../src/domain/config.js";
import {
  executeHardHalt,
  HaltProcessFence,
  inspectHaltContinuation,
} from "../../src/halt/index.js";
import { canonicalSerialize } from "../../src/persistence/canonical-json.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type { TelemetryAppendResult } from "../../src/telemetry/index.js";
import {
  GENESIS_EVENT_SHA256,
  gateRiskIncreaseOnEvidence,
  loadRunManifest,
  openTelemetryLog,
  parseTelemetryEventBytes,
  runManifestPath,
  setTelemetryFaultHookForTests,
  telemetryEventsPath,
  writeRunManifest,
} from "../../src/telemetry/index.js";
import { RISK_NOW, seedHaltContext, withTempDir } from "../halt/helpers.js";
import {
  bootEvent,
  COMMIT_SHA,
  manifestInput,
  RECORDED_AT,
  startRun,
  withTelemetryDir,
} from "./helpers.js";

const ALLOW = { allowRiskIncrease: true, reasonCodes: [] };

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertFailed(
  result: { ok: boolean; reasonCodes?: readonly string[] },
  code: string,
): void {
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasonCodes, [code, "TELEMETRY_EVIDENCE_UNAVAILABLE"]);
}

async function snapshotFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.set(entry.name, sha256(await readFile(path.join(directory, entry.name))));
    }
  }
  return files;
}

describe("Phase 2F run manifest", () => {
  test("records the frozen envelope, commit SHA, spec version and scope at mode 0600", async () => {
    await withTelemetryDir(async (directory) => {
      const written = await writeRunManifest(directory, manifestInput());
      assert.ok(written.ok, JSON.stringify(written));
      const bytes = await readFile(runManifestPath(directory));
      assert.equal(written.manifestSha256, sha256(bytes));
      assert.deepEqual(written.manifest, {
        schemaVersion: 1,
        specVersion: "0.1.0",
        experimentId: "exp-phase2f",
        runId: "run-0001",
        commitSha: COMMIT_SHA,
        mode: "DRY_RUN",
        scopeKey: "canary-01/sim/BTC_USDC_PERP/grid-v0.1",
        venue: "sim",
        market: "BTC_USDC_PERP",
        envelope: V01_EXPERIMENT_CONFIG,
        startedAt: "2026-10-11T00:00:00.000Z",
      });
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), written.manifest);
      assert.equal((await stat(runManifestPath(directory))).mode & 0o777, 0o600);
      const loaded = await loadRunManifest(directory);
      assert.ok(loaded.ok);
      assert.equal(loaded.manifestSha256, written.manifestSha256);
    });
  });

  test("is written once and never rewritten, even with identical input", async () => {
    await withTelemetryDir(async (directory) => {
      assert.equal((await writeRunManifest(directory, manifestInput())).ok, true);
      const before = await readFile(runManifestPath(directory));
      assertFailed(await writeRunManifest(directory, manifestInput()), "MANIFEST_ALREADY_EXISTS");
      assertFailed(
        await writeRunManifest(directory, manifestInput({ runId: "run-0002" })),
        "MANIFEST_ALREADY_EXISTS",
      );
      assert.deepEqual(await readFile(runManifestPath(directory)), before);
    });
  });

  test("rejects invalid input before creating any file", async () => {
    const cases: Array<[Parameters<typeof manifestInput>[0], string]> = [
      [{ envelope: { ...V01_EXPERIMENT_CONFIG, leverage: "10" } }, "MANIFEST_ENVELOPE_MISMATCH"],
      [
        { envelope: { ...V01_EXPERIMENT_CONFIG, extra: "1" } as typeof V01_EXPERIMENT_CONFIG },
        "MANIFEST_ENVELOPE_MISMATCH",
      ],
      [{ commitSha: "HEAD" }, "MANIFEST_COMMIT_SHA_INVALID"],
      [{ commitSha: COMMIT_SHA.toUpperCase() }, "MANIFEST_COMMIT_SHA_INVALID"],
      [{ runId: "../escape" }, "MANIFEST_RUN_IDENTITY_INVALID"],
      [{ experimentId: "" }, "MANIFEST_RUN_IDENTITY_INVALID"],
      [{ scopeKey: "canary-01/sim" }, "MANIFEST_SCOPE_INVALID"],
      [{ mode: "PAPER" as RuntimeMode }, "MANIFEST_MODE_INVALID"],
      [{ startedAt: "2026-10-11" }, "MANIFEST_STARTED_AT_INVALID"],
    ];
    for (const [overrides, code] of cases) {
      await withTelemetryDir(async (directory) => {
        assertFailed(await writeRunManifest(directory, manifestInput(overrides)), code);
        assert.deepEqual(await readdir(directory), []);
      });
    }
  });

  test("a tampered or torn manifest fails closed and blocks the event log", async () => {
    const tamper: Array<[(text: string) => string, string]> = [
      [(text) => text.replace('"leverage":"5"', '"leverage":"6"'), "MANIFEST_ENVELOPE_MISMATCH"],
      [(text) => text.replace('"venue":"sim"', '"venue":"hl"'), "MANIFEST_MALFORMED"],
      [(text) => text.replace('{"commitSha"', '{"a":"1","commitSha"'), "MANIFEST_MALFORMED"],
      [(text) => `${JSON.stringify(JSON.parse(text), null, 2)}\n`, "MANIFEST_MALFORMED"],
      [(text) => text.slice(0, -1), "MANIFEST_MALFORMED"],
      [(text) => text.slice(0, 40), "MANIFEST_MALFORMED"],
    ];
    for (const [mutate, code] of tamper) {
      await withTelemetryDir(async (directory) => {
        assert.equal((await writeRunManifest(directory, manifestInput())).ok, true);
        const original = await readFile(runManifestPath(directory), "utf8");
        await writeFile(runManifestPath(directory), mutate(original));
        assertFailed(await loadRunManifest(directory), code);
        assert.equal((await openTelemetryLog(directory)).ok, false);
        assert.deepEqual(await readdir(directory), ["manifest.json"]);
      });
    }
  });
});

describe("Phase 2F fault matrix P2-T01..P2-T05", () => {
  test("P2-T01 unwritable or missing manifest directory permits no risk-increasing run", async () => {
    await withTelemetryDir(async (root) => {
      const locked = path.join(root, "locked");
      await mkdir(locked);
      await chmod(locked, 0o500);
      try {
        const written = await writeRunManifest(locked, manifestInput());
        assertFailed(written, "MANIFEST_IO_FAILURE");
        const opened = await openTelemetryLog(locked);
        assertFailed(opened, "MANIFEST_MISSING");
        const decision = gateRiskIncreaseOnEvidence(ALLOW, [written, opened]);
        assert.equal(decision.allowRiskIncrease, false);
        assert.ok(decision.reasonCodes.includes("MANIFEST_IO_FAILURE"));
        assert.deepEqual(await readdir(locked), []);
      } finally {
        await chmod(locked, 0o700);
      }

      const missing = path.join(root, "missing");
      const absent = await writeRunManifest(missing, manifestInput());
      assertFailed(absent, "MANIFEST_IO_FAILURE");
      assert.equal(gateRiskIncreaseOnEvidence(ALLOW, [absent]).allowRiskIncrease, false);
    });
  });

  test("P2-T02 manifest write failure before sync fails closed and leaves no manifest", async () => {
    await withTelemetryDir(async (directory) => {
      setTelemetryFaultHookForTests({ window: "MANIFEST_BEFORE_SYNC", action: "FAIL" });
      const written = await writeRunManifest(directory, manifestInput());
      setTelemetryFaultHookForTests(null);
      assertFailed(written, "MANIFEST_IO_FAILURE");
      assert.deepEqual(await readdir(directory), []);
      const opened = await openTelemetryLog(directory);
      assertFailed(opened, "MANIFEST_MISSING");
      assert.deepEqual(await readdir(directory), []);
      const decision = gateRiskIncreaseOnEvidence(ALLOW, [written]);
      assert.equal(decision.allowRiskIncrease, false);
      assert.deepEqual(decision.reasonCodes, [
        "MANIFEST_IO_FAILURE",
        "TELEMETRY_EVIDENCE_UNAVAILABLE",
      ]);
    });
  });

  for (const window of ["EVENT_BEFORE_WRITE", "EVENT_BEFORE_SYNC"] as const) {
    test(`P2-T03 append failure at ${window} blocks risk increase and poisons the writer`, async () => {
      await withTelemetryDir(async (directory) => {
        const log = await startRun(directory);
        assert.equal((await log.append(bootEvent())).ok, true);
        const before = await readFile(telemetryEventsPath(directory));

        setTelemetryFaultHookForTests({ window, action: "FAIL" });
        const failed = await log.append(bootEvent({ eventType: "INTENT_CREATED" }));
        setTelemetryFaultHookForTests(null);
        assertFailed(failed, "TELEMETRY_WRITER_FAILED");
        assert.equal(log.failed, true);

        const later = await log.append(bootEvent({ eventType: "ORDER_SUBMIT" }));
        assertFailed(later, "TELEMETRY_WRITER_FAILED");
        assert.equal(log.lineCount, 1);
        const after = await readFile(telemetryEventsPath(directory));
        if (window === "EVENT_BEFORE_WRITE") {
          assert.deepEqual(after, before);
        } else {
          // The unsynced line may be on disk; prior bytes stay an unchanged prefix either way.
          assert.deepEqual(after.subarray(0, before.length), before);
        }
        assert.equal(after.includes("ORDER_SUBMIT"), false);

        const decision = gateRiskIncreaseOnEvidence(ALLOW, [failed]);
        assert.equal(decision.allowRiskIncrease, false);
        assert.ok(decision.reasonCodes.includes("TELEMETRY_WRITER_FAILED"));
      });
    });
  }

  test("P2-T04 telemetry failure during halt does not clear halt authority", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      assert.equal(halted.durableStatus, "HALTED_FLAT");
      assert.equal(context.processFence.tripped, true);
      const haltFilesBefore = await snapshotFiles(directory);

      const telemetryDirectory = path.join(directory, "telemetry");
      await mkdir(telemetryDirectory);
      const log = await startRun(telemetryDirectory);
      setTelemetryFaultHookForTests({ window: "EVENT_BEFORE_WRITE", action: "FAIL" });
      const failed = await log.append(
        bootEvent({ eventType: "RISK_HALT", payload: { haltId: halted.haltId } }),
      );
      setTelemetryFaultHookForTests(null);
      assertFailed(failed, "TELEMETRY_WRITER_FAILED");

      assert.deepEqual(await snapshotFiles(directory), haltFilesBefore);
      assert.equal(context.processFence.tripped, true);
      const restarted: typeof context = {
        ...context,
        latch: new RuntimePersistenceLatch(),
        processFence: new HaltProcessFence(),
      };
      const inspected = await inspectHaltContinuation(restarted);
      assert.equal(inspected.durableStatus, "HALTED_FLAT");
      assert.equal(inspected.haltId, halted.haltId);
      assert.equal(inspected.allowRiskIncrease, false);
      assert.equal(gateRiskIncreaseOnEvidence(inspected, [failed]).allowRiskIncrease, false);

      // Healthy telemetry in a fresh writer cannot grant risk while the halt stands.
      const reopened = await openTelemetryLog(telemetryDirectory, { clock: () => RECORDED_AT });
      assert.ok(reopened.ok);
      const recorded = await reopened.log.append(
        bootEvent({ eventType: "RISK_HALT", payload: { haltId: halted.haltId } }),
      );
      assert.equal(recorded.ok, true);
      const decision = gateRiskIncreaseOnEvidence(inspected, [recorded]);
      assert.equal(decision.allowRiskIncrease, false);
      assert.deepEqual(decision.reasonCodes, inspected.reasonCodes);
      assert.deepEqual(await snapshotFiles(directory), haltFilesBefore);
    });
  });

  test("P2-T05 secret-like keys and values are rejected and no raw secret bytes are written", async () => {
    // Secret-shaped values are assembled at runtime so no literal credential shape is tracked.
    const secretValues = [
      `gh${"p_"}${"A1".repeat(18)}`,
      `AK${"IA"}${"ABCDEFGHIJKLMNOP"}`,
      `-----BEGIN ${"PRIVATE"} KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----`,
      `xo${"xb-"}${"1".repeat(24)}`,
      `Bearer ${"abcdefghijklmnop0123456789"}`,
    ];
    const secretKeys = [
      "apiSecret",
      "api_key",
      "Authorization",
      "privateKey",
      "password",
      "seedPhrase",
      "mnemonic",
    ];
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      assert.equal((await log.append(bootEvent())).ok, true);
      const before = await readFile(telemetryEventsPath(directory));

      const results: TelemetryAppendResult[] = [];
      for (const value of secretValues) {
        results.push(await log.append(bootEvent({ payload: { note: value } })));
        results.push(await log.append(bootEvent({ payload: { orders: [{ detail: [value] }] } })));
      }
      for (const key of secretKeys) {
        results.push(await log.append(bootEvent({ payload: { [key]: "v" } })));
        results.push(await log.append(bootEvent({ payload: { venue: { nested: { [key]: 1 } } } })));
      }
      for (const result of results) {
        assertFailed(result, "TELEMETRY_SECRET_PROHIBITED");
        assert.equal(gateRiskIncreaseOnEvidence(ALLOW, [result]).allowRiskIncrease, false);
      }

      const after = await readFile(telemetryEventsPath(directory));
      assert.deepEqual(after, before);
      for (const value of secretValues) {
        assert.equal(after.includes(value), false);
      }
      // Rejection is a caller error, not a writer fault.
      assert.equal(log.failed, false);
      assert.equal((await log.append(bootEvent({ payload: { orderId: "o-1" } }))).ok, true);
    });
  });
});

describe("Phase 2F event log", () => {
  test("hash-chains lines with sequence, provenance and manifest binding", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      const appended = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          log.append(bootEvent({ eventType: "SNAPSHOT", payload: { index } })),
        ),
      );
      const bytes = await readFile(telemetryEventsPath(directory));
      const parsed = parseTelemetryEventBytes(bytes, log.manifest, log.manifestSha256);
      assert.ok(parsed.ok);
      assert.equal(parsed.lines.length, 10);
      let previous = GENESIS_EVENT_SHA256;
      parsed.lines.forEach((line, index) => {
        const result = appended[index];
        assert.ok(result?.ok);
        assert.deepEqual(line, result.line);
        assert.equal(line.sequence, String(index + 1));
        assert.deepEqual(line.payload, { index });
        assert.equal(line.provenance, "AUTHORITATIVE");
        assert.equal(line.runId, "run-0001");
        assert.equal(line.manifestSha256, log.manifestSha256);
        assert.equal(line.recordedAt, RECORDED_AT);
        assert.equal(line.previousEventSha256, previous);
        previous = line.eventSha256;
      });
      assert.equal((await stat(telemetryEventsPath(directory))).mode & 0o777, 0o600);

      const reopened = await openTelemetryLog(directory, { clock: () => RECORDED_AT });
      assert.ok(reopened.ok);
      assert.equal(reopened.log.lineCount, 10);
      const next = await reopened.log.append(bootEvent({ eventType: "RESTART" }));
      assert.ok(next.ok);
      assert.equal(next.line.sequence, "11");
      assert.equal(next.line.previousEventSha256, previous);
    });
  });

  test("an INFERRED fill is prohibited; SIMULATED is allowed only in DRY_RUN", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      for (const eventType of ["FILL", "PARTIAL_FILL"] as const) {
        assertFailed(
          await log.append(bootEvent({ eventType, provenance: "INFERRED" })),
          "TELEMETRY_INFERRED_FILL_PROHIBITED",
        );
        assert.equal((await log.append(bootEvent({ eventType }))).ok, true);
      }
      const inferred = await log.append(
        bootEvent({ eventType: "RECONCILIATION", provenance: "INFERRED" }),
      );
      assert.ok(inferred.ok);
      assert.equal(inferred.line.provenance, "INFERRED");
      assert.equal(
        (await log.append(bootEvent({ eventType: "FILL", provenance: "SIMULATED" }))).ok,
        true,
      );
      assert.equal(log.lineCount, 4);
      assert.equal(log.failed, false);
    });
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory, { mode: "LIVE" });
      assertFailed(
        await log.append(bootEvent({ provenance: "SIMULATED" })),
        "TELEMETRY_SIMULATED_OUTSIDE_DRY_RUN",
      );
      assert.equal(log.lineCount, 0);
    });
  });

  test("invalid events are rejected without writing or poisoning the writer", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      let deep: Record<string, unknown> = { leaf: "x" };
      for (let depth = 0; depth < 10; depth += 1) {
        deep = { deep };
      }
      const cases: Array<[Parameters<typeof bootEvent>[0], string]> = [
        [{ eventType: "TRADE" as "BOOT" }, "TELEMETRY_EVENT_INVALID"],
        [{ provenance: "GUESSED" as "INFERRED" }, "TELEMETRY_EVENT_INVALID"],
        [{ source: "bad source" }, "TELEMETRY_EVENT_INVALID"],
        [{ payload: [] as unknown as Record<string, unknown> }, "TELEMETRY_EVENT_INVALID"],
        [{ payload: new Map() as unknown as Record<string, unknown> }, "TELEMETRY_EVENT_INVALID"],
        [{ payload: { price: 1.5 } }, "TELEMETRY_PAYLOAD_REJECTED"],
        [{ payload: { blob: "x".repeat(5_000) } }, "TELEMETRY_PAYLOAD_REJECTED"],
        [{ payload: deep }, "TELEMETRY_PAYLOAD_REJECTED"],
      ];
      for (const [overrides, code] of cases) {
        assertFailed(await log.append(bootEvent(overrides)), code);
      }
      const badClock = await openTelemetryLog(directory, { clock: () => "yesterday" });
      assert.ok(badClock.ok);
      assertFailed(await badClock.log.append(bootEvent()), "TELEMETRY_CLOCK_INVALID");
      assert.equal(log.failed, false);
      assert.equal((await readFile(telemetryEventsPath(directory))).length, 0);
    });
  });

  test("a torn tail reopens as TELEMETRY_TRUNCATED and is never repaired", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      assert.equal((await log.append(bootEvent())).ok, true);
      const second = await log.append(bootEvent({ eventType: "SNAPSHOT" }));
      assert.ok(second.ok);
      const full = await readFile(telemetryEventsPath(directory));
      const firstLineEnd = full.indexOf("\n") + 1;
      const torn = full.subarray(0, firstLineEnd + 30);
      await writeFile(telemetryEventsPath(directory), torn);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        assertFailed(await openTelemetryLog(directory), "TELEMETRY_TRUNCATED");
        assert.deepEqual(await readFile(telemetryEventsPath(directory)), torn);
      }
      assert.equal(
        gateRiskIncreaseOnEvidence(ALLOW, [await openTelemetryLog(directory)]).allowRiskIncrease,
        false,
      );
    });
  });

  test("tampering, reordering, deletion and foreign-run lines fail the chain", async () => {
    await withTelemetryDir(async (root) => {
      const runA = path.join(root, "a");
      const runB = path.join(root, "b");
      await mkdir(runA);
      await mkdir(runB);
      const log = await startRun(runA);
      for (const index of [1, 2, 3]) {
        assert.equal((await log.append(bootEvent({ payload: { index } }))).ok, true);
      }
      await startRun(runB, { runId: "run-0002" });
      const original = await readFile(telemetryEventsPath(runA), "utf8");
      const lines = original.slice(0, -1).split("\n");
      const [l1, l2, l3] = lines;
      assert.ok(l1 !== undefined && l2 !== undefined && l3 !== undefined);

      // A forged middle line with a self-consistent hash breaks only the link to its successor.
      const { eventSha256: _dropped, ...unsigned } = JSON.parse(l2) as Record<string, unknown>;
      const forgedUnsigned = { ...unsigned, payload: { index: 9 } };
      const forged = canonicalSerialize({
        ...forgedUnsigned,
        eventSha256: sha256(canonicalSerialize(forgedUnsigned)),
      }).toString("utf8");

      const variants = [
        `${[l1, forged, l3].join("\n")}\n`,
        original.replace('"index":2', '"index":9'),
        `${[l1, l3, l2].join("\n")}\n`,
        `${[l1, l3].join("\n")}\n`,
        `${[l2, l3].join("\n")}\n`,
        `${original}${l3}\n`,
        original.replace('"provenance":"AUTHORITATIVE"', '"provenance":"INFERRED"'),
        `${original.slice(0, -1)} \n`,
        Buffer.from([0xff, 0x0a]).toString("latin1"),
      ];
      for (const variant of variants) {
        await writeFile(telemetryEventsPath(runA), variant, "latin1");
        assertFailed(await openTelemetryLog(runA), "TELEMETRY_MALFORMED");
      }

      await writeFile(telemetryEventsPath(runB), original);
      assertFailed(await openTelemetryLog(runB), "TELEMETRY_MALFORMED");
    });
  });

  test("an external write while open poisons the writer", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      assert.equal((await log.append(bootEvent())).ok, true);
      await appendFile(telemetryEventsPath(directory), "{}\n");
      assertFailed(await log.append(bootEvent()), "TELEMETRY_EXTERNAL_MODIFICATION");
      assert.equal(log.failed, true);
      assertFailed(await log.append(bootEvent()), "TELEMETRY_EXTERNAL_MODIFICATION");
    });
  });

  test("the event log cannot be opened without a manifest", async () => {
    await withTelemetryDir(async (directory) => {
      assertFailed(await openTelemetryLog(directory), "MANIFEST_MISSING");
      assert.deepEqual(await readdir(directory), []);
    });
  });
});

describe("Phase 2F evidence gate", () => {
  test("evidence can only deny; it never grants risk on its own", () => {
    const ok = { ok: true } as const;
    const bad = { ok: false, reasonCodes: ["X", "TELEMETRY_EVIDENCE_UNAVAILABLE"] } as const;
    assert.deepEqual(gateRiskIncreaseOnEvidence(ALLOW, [ok, ok]), {
      allowRiskIncrease: true,
      reasonCodes: [],
    });
    assert.deepEqual(gateRiskIncreaseOnEvidence(ALLOW, []), {
      allowRiskIncrease: false,
      reasonCodes: ["TELEMETRY_EVIDENCE_NOT_SUPPLIED"],
    });
    assert.deepEqual(
      gateRiskIncreaseOnEvidence({ allowRiskIncrease: false, reasonCodes: ["LEASE_LOST"] }, [ok]),
      { allowRiskIncrease: false, reasonCodes: ["LEASE_LOST"] },
    );
    assert.deepEqual(gateRiskIncreaseOnEvidence(ALLOW, [ok, bad, bad]), {
      allowRiskIncrease: false,
      reasonCodes: ["X", "TELEMETRY_EVIDENCE_UNAVAILABLE"],
    });
  });
});
