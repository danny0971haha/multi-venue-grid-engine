import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  gateRiskIncreaseOnEvidence,
  loadRunManifest,
  openTelemetryLog,
  runManifestPath,
  telemetryEventsPath,
  writeRunManifest,
} from "../../src/telemetry/index.js";
import {
  bootEvent,
  manifestInput,
  startRun,
  TELEMETRY_SCOPE_KEY,
  withTelemetryDir,
} from "./helpers.js";

const ALLOW = { allowRiskIncrease: true, reasonCodes: [] };

// Secret-shaped values are assembled at runtime so no literal credential shape is tracked.
// These fit the source and run identity character sets.
const IDENTIFIER_SHAPED_SECRETS = [
  `gh${"p_"}${"A1".repeat(18)}`,
  `AK${"IA"}${"ABCDEFGHIJKLMNOP"}`,
  `xo${"xb-"}${"1".repeat(24)}`,
];
// These carry whitespace, which the free-form scope key parts accept.
const FREE_TEXT_SECRETS = [
  `-----BEGIN ${"PRIVATE"} KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----`,
  `Bearer ${"abcdefghijklmnop0123456789"}`,
];

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

function withScopePart(index: number, value: string): string {
  const parts = TELEMETRY_SCOPE_KEY.split("/");
  parts[index] = value;
  return parts.join("/");
}

describe("Gate 2 corrective C5: secret policy on every persisted telemetry string (P2-T05)", () => {
  test("P2-T05-S1 a secret-shaped event source is rejected and none of its bytes are written", async () => {
    await withTelemetryDir(async (directory) => {
      const log = await startRun(directory);
      assert.equal((await log.append(bootEvent())).ok, true);
      const before = await readFile(telemetryEventsPath(directory));

      for (const value of IDENTIFIER_SHAPED_SECRETS) {
        for (const source of [value, `engine:${value}`]) {
          assertFailed(
            await log.append(bootEvent({ source })),
            "TELEMETRY_SECRET_PROHIBITED",
            source,
          );
        }
      }
      // Shapes with whitespace never fit the source character set.
      for (const source of FREE_TEXT_SECRETS) {
        assertFailed(await log.append(bootEvent({ source })), "TELEMETRY_EVENT_INVALID", source);
      }

      const after = await readFile(telemetryEventsPath(directory));
      assert.deepEqual(after, before);
      for (const value of [...IDENTIFIER_SHAPED_SECRETS, ...FREE_TEXT_SECRETS]) {
        assert.equal(after.includes(value), false);
      }
      // Rejection is a caller error, not a writer fault.
      assert.equal(log.failed, false);
      assert.equal((await log.append(bootEvent({ source: "engine:grid" }))).ok, true);
    });
  });

  test("P2-T05-M1 a secret-shaped run or experiment identity is rejected before any manifest byte is written", async () => {
    for (const field of ["runId", "experimentId"] as const) {
      for (const value of IDENTIFIER_SHAPED_SECRETS) {
        for (const identity of [value, `run-${value}`]) {
          await withTelemetryDir(async (directory) => {
            const label = `${field}=${identity}`;
            assertFailed(
              await writeRunManifest(directory, manifestInput({ [field]: identity })),
              "MANIFEST_SECRET_PROHIBITED",
              label,
            );
            assert.deepEqual(await readdir(directory), [], label);
          });
        }
      }
    }
  });

  test("P2-T05-M2 a secret-shaped scope key part is rejected before any manifest byte is written", async () => {
    for (let index = 0; index < 4; index += 1) {
      for (const value of [...IDENTIFIER_SHAPED_SECRETS, ...FREE_TEXT_SECRETS]) {
        await withTelemetryDir(async (directory) => {
          const scopeKey = withScopePart(index, value);
          assertFailed(
            await writeRunManifest(directory, manifestInput({ scopeKey })),
            "MANIFEST_SECRET_PROHIBITED",
            scopeKey,
          );
          assert.deepEqual(await readdir(directory), [], scopeKey);
        });
      }
    }
  });

  test("P2-T05-M3 a stored manifest carrying a secret-shaped identity fails to load and blocks the event log", async () => {
    const tamper: Array<[string, (text: string) => string]> = [
      ...IDENTIFIER_SHAPED_SECRETS.map((value): [string, (text: string) => string] => [
        `runId=${value}`,
        (text) => text.replace('"runId":"run-0001"', `"runId":${JSON.stringify(value)}`),
      ]),
      ...FREE_TEXT_SECRETS.map((value): [string, (text: string) => string] => [
        `scopeKey account=${value}`,
        (text) =>
          text.replace(
            JSON.stringify(TELEMETRY_SCOPE_KEY),
            JSON.stringify(withScopePart(0, value)),
          ),
      ]),
    ];
    for (const [label, mutate] of tamper) {
      await withTelemetryDir(async (directory) => {
        assert.equal((await writeRunManifest(directory, manifestInput())).ok, true, label);
        const original = await readFile(runManifestPath(directory), "utf8");
        const mutated = mutate(original);
        assert.notEqual(mutated, original, label);
        await writeFile(runManifestPath(directory), mutated);
        assertFailed(await loadRunManifest(directory), "MANIFEST_SECRET_PROHIBITED", label);
        assertFailed(await openTelemetryLog(directory), "MANIFEST_SECRET_PROHIBITED", label);
        assert.deepEqual(await readdir(directory), ["manifest.json"], label);
      });
    }
  });
});
