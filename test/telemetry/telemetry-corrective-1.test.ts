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

// Secret-shaped values are assembled at runtime so no literal credential shape is tracked, and
// assertion labels carry only the shape name so a failure never echoes the value.
type SecretShape = { name: string; value: string };
// These fit the source and run identity character sets.
const IDENTIFIER_SHAPED_SECRETS: SecretShape[] = [
  { name: "github-token", value: `gh${"p_"}${"A1".repeat(18)}` },
  { name: "aws-access-key", value: `AK${"IA"}${"ABCDEFGHIJKLMNOP"}` },
  { name: "slack-token", value: `xo${"xb-"}${"1".repeat(24)}` },
];
// These carry whitespace, which the free-form scope key parts accept.
const FREE_TEXT_SECRETS: SecretShape[] = [
  {
    name: "private-key-block",
    value: `-----BEGIN ${"PRIVATE"} KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----`,
  },
  { name: "bearer-header", value: `Bearer ${"abcdefghijklmnop0123456789"}` },
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

      for (const { name, value } of IDENTIFIER_SHAPED_SECRETS) {
        for (const [label, source] of [
          [`source=${name}`, value],
          [`source=engine:${name}`, `engine:${value}`],
        ] as const) {
          assertFailed(
            await log.append(bootEvent({ source })),
            "TELEMETRY_SECRET_PROHIBITED",
            label,
          );
        }
      }
      // Shapes with whitespace never fit the source character set.
      for (const { name, value } of FREE_TEXT_SECRETS) {
        assertFailed(
          await log.append(bootEvent({ source: value })),
          "TELEMETRY_EVENT_INVALID",
          `source=${name}`,
        );
      }

      const after = await readFile(telemetryEventsPath(directory));
      assert.ok(after.equals(before), "event log bytes changed");
      for (const { name, value } of [...IDENTIFIER_SHAPED_SECRETS, ...FREE_TEXT_SECRETS]) {
        assert.equal(after.includes(value), false, name);
      }
      // Rejection is a caller error, not a writer fault.
      assert.equal(log.failed, false);
      assert.equal((await log.append(bootEvent({ source: "engine:grid" }))).ok, true);
    });
  });

  test("P2-T05-M1 a secret-shaped run or experiment identity is rejected before any manifest byte is written", async () => {
    for (const field of ["runId", "experimentId"] as const) {
      for (const { name, value } of IDENTIFIER_SHAPED_SECRETS) {
        for (const [label, identity] of [
          [`${field}=${name}`, value],
          [`${field}=run-${name}`, `run-${value}`],
        ] as const) {
          await withTelemetryDir(async (directory) => {
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
      for (const { name, value } of [...IDENTIFIER_SHAPED_SECRETS, ...FREE_TEXT_SECRETS]) {
        await withTelemetryDir(async (directory) => {
          const label = `scopeKey part ${index}=${name}`;
          assertFailed(
            await writeRunManifest(
              directory,
              manifestInput({ scopeKey: withScopePart(index, value) }),
            ),
            "MANIFEST_SECRET_PROHIBITED",
            label,
          );
          assert.deepEqual(await readdir(directory), [], label);
        });
      }
    }
  });

  test("P2-T05-M3 a stored manifest carrying a secret-shaped identity fails to load and blocks the event log", async () => {
    const tamper: Array<[string, (text: string) => string]> = [
      ...IDENTIFIER_SHAPED_SECRETS.map(({ name, value }): [string, (text: string) => string] => [
        `runId=${name}`,
        (text) => text.replace('"runId":"run-0001"', `"runId":${JSON.stringify(value)}`),
      ]),
      ...FREE_TEXT_SECRETS.map(({ name, value }): [string, (text: string) => string] => [
        `scopeKey part 0=${name}`,
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
