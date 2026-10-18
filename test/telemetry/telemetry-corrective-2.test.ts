import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import type { RunManifest, TelemetryLog } from "../../src/telemetry/index.js";
import {
  gateRiskIncreaseOnEvidence,
  loadRunManifest,
  openTelemetryLog,
  telemetryEventsPath,
} from "../../src/telemetry/index.js";
import { bootEvent, startRun, withTelemetryDir } from "./helpers.js";

const ALLOW = { allowRiskIncrease: true, reasonCodes: [] };

// A frozen or accessor-only exposure may reject the write outright; either way the attempt must
// leave the log's durable state untouched.
function attempt(mutate: () => void): void {
  try {
    mutate();
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }
}

// Bypasses the declared readonly modifiers, as any untyped caller could.
function writable(log: TelemetryLog): { manifest: RunManifest; manifestSha256: string } {
  return log as unknown as { manifest: RunManifest; manifestSha256: string };
}

function assertFailed(
  result: { ok: boolean; reasonCodes?: readonly string[] },
  code: string,
  label: string,
): void {
  assert.equal(result.ok, false, label);
  assert.deepEqual(result.reasonCodes, [code, "TELEMETRY_EVIDENCE_UNAVAILABLE"], label);
  assert.equal(
    gateRiskIncreaseOnEvidence(ALLOW, [result as { ok: false; reasonCodes: string[] }])
      .allowRiskIncrease,
    false,
    label,
  );
}

async function assertReopens(directory: string, lineCount: number, label: string): Promise<void> {
  const reopened = await openTelemetryLog(directory);
  assert.ok(reopened.ok, `${label}: ${reopened.ok ? "" : reopened.reasonCodes.join(",")}`);
  assert.equal(reopened.log.lineCount, lineCount, label);
}

const MODE_MUTATIONS: Array<[string, (log: TelemetryLog, mode: RunManifest["mode"]) => void]> = [
  [
    "property",
    (log, mode) => {
      log.manifest.mode = mode;
    },
  ],
  [
    "replacement",
    (log, mode) => {
      writable(log).manifest = { ...log.manifest, mode };
    },
  ],
];

describe("Gate 2 corrective C6: event construction uses private validated manifest state (RISK_PERSISTENCE_CONTRACT §23/§24)", () => {
  test("C6-1 changing the exposed mode of a LIVE log does not admit a SIMULATED event", async () => {
    for (const [label, mutate] of MODE_MUTATIONS) {
      await withTelemetryDir(async (directory) => {
        const log = await startRun(directory, { mode: "LIVE" });
        assert.equal((await log.append(bootEvent())).ok, true, label);
        const before = await readFile(telemetryEventsPath(directory));

        attempt(() => mutate(log, "DRY_RUN"));
        assert.equal(log.manifest.mode, "LIVE", label);
        for (const eventType of ["FILL", "PARTIAL_FILL", "BOOT"] as const) {
          assertFailed(
            await log.append(bootEvent({ eventType, provenance: "SIMULATED" })),
            "TELEMETRY_SIMULATED_OUTSIDE_DRY_RUN",
            `${label} ${eventType}`,
          );
        }

        assert.ok((await readFile(telemetryEventsPath(directory))).equals(before), label);
        assert.equal(log.failed, false, label);
        assert.equal((await log.append(bootEvent())).ok, true, label);
        await assertReopens(directory, 2, label);
      });
    }
  });

  test("C6-2 changing the exposed mode of a DRY_RUN log does not revoke SIMULATED eligibility", async () => {
    for (const [label, mutate] of MODE_MUTATIONS) {
      await withTelemetryDir(async (directory) => {
        const log = await startRun(directory);
        attempt(() => mutate(log, "LIVE"));
        assert.equal(log.manifest.mode, "DRY_RUN", label);
        const appended = await log.append(
          bootEvent({ eventType: "FILL", provenance: "SIMULATED" }),
        );
        assert.equal(appended.ok, true, label);
        await assertReopens(directory, 1, label);
      });
    }
  });

  test("C6-3 changing exposed identity fields leaves written lines and the exposed manifest on the durable run", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      assert.equal((await log.append(bootEvent())).ok, true);
      const durable = await loadRunManifest(directory);
      assert.ok(durable.ok);

      const exposed = log.manifest;
      attempt(() => {
        exposed.runId = "run-9999";
      });
      attempt(() => {
        exposed.experimentId = "exp-other";
      });
      attempt(() => {
        exposed.commitSha = "f".repeat(40);
      });
      attempt(() => {
        exposed.scopeKey = "canary-02/sim/ETH_USDC_PERP/grid-v0.1";
      });
      attempt(() => {
        exposed.venue = "other";
      });
      attempt(() => {
        exposed.market = "ETH_USDC_PERP";
      });
      attempt(() => {
        exposed.startedAt = "2026-10-12T00:00:00.000Z";
      });
      attempt(() => {
        exposed.envelope.maxPlannedGrossNotionalUsd = "1000000";
      });
      attempt(() => {
        writable(log).manifest = { ...durable.manifest, runId: "run-9999" };
      });
      attempt(() => {
        writable(log).manifestSha256 = "f".repeat(64);
      });

      assert.deepEqual(log.manifest, durable.manifest);
      assert.equal(log.manifestSha256, durable.manifestSha256);
      const appended = await log.append(bootEvent());
      assert.ok(appended.ok, appended.ok ? "" : appended.reasonCodes.join(","));
      assert.equal(appended.line.runId, durable.manifest.runId);
      assert.equal(appended.line.manifestSha256, durable.manifestSha256);
      assert.equal(appended.line.sequence, "2");
      await assertReopens(directory, 2, "after identity mutation");
    });
  });
});
