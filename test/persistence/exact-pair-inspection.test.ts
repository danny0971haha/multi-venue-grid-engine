import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bootDryRun } from "../../src/bootstrap/runtimeMode.js";
import { canonicalSerializeToUtf8 } from "../../src/persistence/canonical-json.js";
import { buildDurableEnvelope } from "../../src/persistence/durable-envelope.js";
import {
  formatPairInspectionDiagnostic,
  inspectExactPair,
  REASON_CODE_CATALOG,
  sortReasonCodes,
} from "../../src/persistence/exact-pair-inspection.js";
import {
  FIXTURE_KIND,
  FIXTURE_PAYLOAD,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_SCOPE_KEY,
  FIXTURE_SECRET_LIKE,
  FULL_ENVELOPE_BYTES,
} from "../fixtures/phase2a-canonical-vector.js";

const STATE_NAME = "risk-state";

function fixtureFields() {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: FIXTURE_KIND,
    scopeKey: FIXTURE_SCOPE_KEY,
    storeGeneration: "1",
    previousEnvelopeSha256: null,
    payload: {
      levels: FIXTURE_PAYLOAD.levels,
      marker: FIXTURE_PAYLOAD.marker,
      notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
    },
  };
}

function sha256Utf8(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2a-pair-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeCopy(directory: string, fileName: string, bytes: Buffer): Promise<void> {
  await writeFile(path.join(directory, fileName), bytes);
}

function inspectOptions(
  directory: string,
  extra: {
    expectedGeneration?: string;
    expectedPreviousEnvelopeSha256?: string | null;
    expectedKind?: string;
    expectedScopeKey?: string;
  } = {},
) {
  return {
    directory,
    stateName: STATE_NAME,
    expectedKind: extra.expectedKind ?? FIXTURE_KIND,
    expectedScopeKey: extra.expectedScopeKey ?? FIXTURE_SCOPE_KEY,
    ...("expectedGeneration" in extra ? { expectedGeneration: extra.expectedGeneration } : {}),
    ...("expectedPreviousEnvelopeSha256" in extra
      ? { expectedPreviousEnvelopeSha256: extra.expectedPreviousEnvelopeSha256 }
      : {}),
  };
}

function buildGenerationTwo() {
  const first = buildDurableEnvelope(fixtureFields());
  return buildDurableEnvelope({
    ...fixtureFields(),
    storeGeneration: "2",
    previousEnvelopeSha256: first.envelope.envelopeSha256,
    payload: {
      levels: 10,
      marker: "phase2a-generation-two",
      notionalUsd: "100",
    },
  });
}

test("P2-D01 valid identical canonical pair is storage-proven and still blocks risk increase", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);

    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairStatus, "EXACT_PAIR");
    assert.equal(inspection.pairAuthorityProven, true);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.exactBytesEqual, true);
    assert.equal(inspection.lineageStatus, "PROVEN");
    assert.equal(inspection.generation, "1");
    assert.equal(inspection.envelopeSha256, built.envelope.envelopeSha256);
    assert.ok(inspection.reasonCodes.includes("EXACT_PAIR_PROVEN"));
    assert.equal(inspection.primary.status, "VALID");
    assert.equal(inspection.backup.status, "VALID");
    if (inspection.primary.status === "VALID") {
      assert.equal(inspection.primary.rawSha256, sha256Utf8(built.fullEnvelopeBytes));
    }
  });
});

test("P2-D02 primary missing / backup valid is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.pairStatus, "UNPROVEN");
    assert.equal(inspection.primary.status, "MISSING");
    assert.equal(inspection.backup.status, "VALID");
    assert.ok(inspection.reasonCodes.includes("PRIMARY_MISSING"));
  });
});

test("P2-D03 backup missing / primary valid is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.backup.status, "MISSING");
    assert.equal(inspection.primary.status, "VALID");
    assert.ok(inspection.reasonCodes.includes("BACKUP_MISSING"));
  });
});

test("P2-D04 primary corrupt / backup valid is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, Buffer.from("{not-json", "utf8"));
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.primary.status, "INVALID");
    assert.equal(inspection.backup.status, "VALID");
    assert.ok(inspection.reasonCodes.includes("PRIMARY_INVALID"));
  });
});

test("P2-D05 backup corrupt / primary valid is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, Buffer.from("{not-json", "utf8"));
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.primary.status, "VALID");
    assert.equal(inspection.backup.status, "INVALID");
    assert.ok(inspection.reasonCodes.includes("BACKUP_INVALID"));
  });
});

test("P2-D06 both corrupt is unproven", async () => {
  await withTempDir(async (directory) => {
    await writeCopy(directory, `${STATE_NAME}.json`, Buffer.from("{primary", "utf8"));
    await writeCopy(directory, `${STATE_NAME}.json.bak`, Buffer.from("{backup", "utf8"));
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.primary.status, "INVALID");
    assert.equal(inspection.backup.status, "INVALID");
    assert.ok(inspection.reasonCodes.includes("PRIMARY_INVALID"));
    assert.ok(inspection.reasonCodes.includes("BACKUP_INVALID"));
  });
});

test("P2-D07 both valid but bytes differ is unproven", async () => {
  await withTempDir(async (directory) => {
    const left = buildDurableEnvelope(fixtureFields());
    const right = buildDurableEnvelope({
      ...fixtureFields(),
      payload: {
        levels: 11,
        marker: FIXTURE_PAYLOAD.marker,
        notionalUsd: "100",
      },
    });
    await writeCopy(directory, `${STATE_NAME}.json`, left.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, right.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.exactBytesEqual, false);
    assert.equal(inspection.generation, null);
    assert.equal(inspection.primary.status, "VALID");
    assert.equal(inspection.backup.status, "VALID");
    assert.ok(inspection.reasonCodes.includes("PAIR_BYTES_MISMATCH"));
    assert.ok(inspection.reasonCodes.includes("PAIR_ENVELOPE_HASH_MISMATCH"));
  });
});

test("P2-D08 backup one generation ahead is unproven and does not select newer", async () => {
  await withTempDir(async (directory) => {
    const first = buildDurableEnvelope(fixtureFields());
    const second = buildGenerationTwo();
    await writeCopy(directory, `${STATE_NAME}.json`, first.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, second.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.generation, null);
    assert.equal(inspection.envelopeSha256, null);
    assert.ok(inspection.reasonCodes.includes("PAIR_GENERATION_MISMATCH"));
    assert.equal(inspection.primary.status, "VALID");
    assert.equal(inspection.backup.status, "VALID");
    if (inspection.primary.status === "VALID" && inspection.backup.status === "VALID") {
      assert.equal(inspection.primary.envelope.storeGeneration, "1");
      assert.equal(inspection.backup.envelope.storeGeneration, "2");
    }
  });
});

test("P2-D09 primary one generation ahead is unproven", async () => {
  await withTempDir(async (directory) => {
    const first = buildDurableEnvelope(fixtureFields());
    const second = buildGenerationTwo();
    await writeCopy(directory, `${STATE_NAME}.json`, second.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, first.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.generation, null);
    assert.ok(inspection.reasonCodes.includes("PAIR_GENERATION_MISMATCH"));
  });
});

test("P2-D10 unexpected generation is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    const inspection = await inspectExactPair(
      inspectOptions(directory, { expectedGeneration: "2" }),
    );
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.lineageStatus, "MISMATCH");
    assert.equal(inspection.allowRiskIncrease, false);
    assert.ok(inspection.reasonCodes.includes("LINEAGE_MISMATCH"));
  });
});

test("P2-D11 previous hash / expected lineage mismatch is unproven", async () => {
  await withTempDir(async (directory) => {
    const second = buildGenerationTwo();
    await writeCopy(directory, `${STATE_NAME}.json`, second.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, second.fullEnvelopeBytes);
    const inspection = await inspectExactPair(
      inspectOptions(directory, {
        expectedGeneration: "2",
        expectedPreviousEnvelopeSha256: "b".repeat(64),
      }),
    );
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.lineageStatus, "MISMATCH");
    assert.ok(inspection.reasonCodes.includes("LINEAGE_MISMATCH"));
  });
});

test("P2-D12 wrong scope or kind is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    const wrongKind = await inspectExactPair(
      inspectOptions(directory, { expectedKind: "other-state" }),
    );
    assert.equal(wrongKind.pairAuthorityProven, false);
    assert.equal(wrongKind.primary.status, "VALID");
    assert.ok(wrongKind.reasonCodes.includes("WRONG_KIND"));

    const wrongScope = await inspectExactPair(
      inspectOptions(directory, { expectedScopeKey: "acct/other/market/grid" }),
    );
    assert.equal(wrongScope.pairAuthorityProven, false);
    assert.ok(wrongScope.reasonCodes.includes("WRONG_SCOPE"));
  });
});

test("P2-D13 legacy / unknown schema is unproven", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    const parsed = JSON.parse(built.fullEnvelopeBytes.toString("utf8")) as Record<string, unknown>;
    parsed.schemaVersion = 99;
    const legacy = Buffer.from(canonicalSerializeToUtf8(parsed), "utf8");
    await writeCopy(directory, `${STATE_NAME}.json`, legacy);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, legacy);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.primary.status, "INVALID");
    assert.equal(inspection.backup.status, "INVALID");
    assert.ok(inspection.reasonCodes.includes("UNSUPPORTED_SCHEMA"));
  });
});

test("P2-D14 leftover temp file is non-authoritative and exact old pair remains inspectable", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    await writeCopy(
      directory,
      `${STATE_NAME}.json.tmp`,
      Buffer.from(`{"secret":"${FIXTURE_SECRET_LIKE}"}`, "utf8"),
    );
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, true);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.pairStatus, "EXACT_PAIR");
    assert.ok(inspection.reasonCodes.includes("EXACT_PAIR_PROVEN"));
    assert.ok(inspection.reasonCodes.includes("TEMP_FILE_NON_AUTHORITATIVE"));
  });
});

test("BOTH_ABSENT is an explicit uninitialized disposition", async () => {
  await withTempDir(async (directory) => {
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairStatus, "BOTH_ABSENT");
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.allowRiskIncrease, false);
    assert.ok(inspection.reasonCodes.includes("BOTH_ABSENT"));
  });
});

test("2A-C15 semantically equal but byte-different pair is unproven", async () => {
  await withTempDir(async (directory) => {
    const canonical = Buffer.from(FULL_ENVELOPE_BYTES, "utf8");
    const spaced = Buffer.from(FULL_ENVELOPE_BYTES.replace(":", ": "), "utf8");
    await writeCopy(directory, `${STATE_NAME}.json`, canonical);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, spaced);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.exactBytesEqual, false);
    assert.equal(inspection.backup.status, "INVALID");
    assert.ok(inspection.reasonCodes.includes("NON_CANONICAL_BYTES"));
  });
});

test("2A-C16 inspection performs zero writes and preserves bytes/mtimes", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    const primaryPath = path.join(directory, `${STATE_NAME}.json`);
    const backupPath = path.join(directory, `${STATE_NAME}.json.bak`);
    await writeCopy(directory, `${STATE_NAME}.json`, built.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    const frozen = new Date("2026-01-02T03:04:05.000Z");
    await utimes(primaryPath, frozen, frozen);
    await utimes(backupPath, frozen, frozen);

    const beforePrimary = await stat(primaryPath);
    const beforeBackup = await stat(backupPath);
    const beforePrimaryBytes = await readFile(primaryPath);
    const beforeBackupBytes = await readFile(backupPath);

    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, true);

    const afterPrimary = await stat(primaryPath);
    const afterBackup = await stat(backupPath);
    assert.equal(afterPrimary.mtimeMs, beforePrimary.mtimeMs);
    assert.equal(afterBackup.mtimeMs, beforeBackup.mtimeMs);
    assert.equal(afterPrimary.size, beforePrimary.size);
    assert.equal(afterBackup.size, beforeBackup.size);
    assert.deepEqual(await readFile(primaryPath), beforePrimaryBytes);
    assert.deepEqual(await readFile(backupPath), beforeBackupBytes);
  });
});

test("2A-C17 reason-code ordering is deterministic", async () => {
  await withTempDir(async (directory) => {
    await writeCopy(directory, `${STATE_NAME}.json`, Buffer.from("{primary", "utf8"));
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.deepEqual(inspection.reasonCodes, sortReasonCodes(inspection.reasonCodes));
    const catalogIndex = new Map<string, number>(
      REASON_CODE_CATALOG.map((code, index) => [code, index]),
    );
    for (let index = 1; index < inspection.reasonCodes.length; index += 1) {
      const previous = inspection.reasonCodes[index - 1];
      const current = inspection.reasonCodes[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      const previousRank = catalogIndex.get(previous) ?? Number.MAX_SAFE_INTEGER;
      const currentRank = catalogIndex.get(current) ?? Number.MAX_SAFE_INTEGER;
      assert.ok(previousRank <= currentRank);
    }
  });
});

test("2A-C18 diagnostics do not leak fixture secret-like strings", async () => {
  await withTempDir(async (directory) => {
    await writeCopy(
      directory,
      `${STATE_NAME}.json`,
      Buffer.from(`{"marker":"${FIXTURE_SECRET_LIKE}","broken":true}`, "utf8"),
    );
    await writeCopy(
      directory,
      `${STATE_NAME}.json.bak`,
      Buffer.from(`{"marker":"${FIXTURE_SECRET_LIKE}"}`, "utf8"),
    );
    const inspection = await inspectExactPair(inspectOptions(directory));
    const diagnostic = formatPairInspectionDiagnostic(inspection);
    assert.equal(diagnostic.includes(FIXTURE_SECRET_LIKE), false);
    assert.equal(JSON.stringify(inspection.reasonCodes).includes(FIXTURE_SECRET_LIKE), false);
    assert.equal(inspection.primary.status === "VALID", false);
    assert.equal(inspection.backup.status === "VALID", false);
  });
});

test("primary IO failure is classified without dropping backup inspection", async () => {
  await withTempDir(async (directory) => {
    const built = buildDurableEnvelope(fixtureFields());
    await mkdir(path.join(directory, `${STATE_NAME}.json`));
    await writeCopy(directory, `${STATE_NAME}.json.bak`, built.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, false);
    assert.equal(inspection.primary.status, "IO_FAILURE");
    assert.equal(inspection.backup.status, "VALID");
    assert.ok(inspection.reasonCodes.includes("PRIMARY_IO_FAILURE"));
  });
});

test("generation greater than 1 without expected anchor is storage-proven and lineage unverified", async () => {
  await withTempDir(async (directory) => {
    const second = buildGenerationTwo();
    await writeCopy(directory, `${STATE_NAME}.json`, second.fullEnvelopeBytes);
    await writeCopy(directory, `${STATE_NAME}.json.bak`, second.fullEnvelopeBytes);
    const inspection = await inspectExactPair(inspectOptions(directory));
    assert.equal(inspection.pairAuthorityProven, true);
    assert.equal(inspection.lineageStatus, "UNVERIFIED");
    assert.equal(inspection.allowRiskIncrease, false);
    assert.equal(inspection.generation, "2");
  });
});

test("2A-C20 dry-run remains liveExchangeWrites=false", () => {
  const report = bootDryRun();
  assert.equal(report.liveExchangeWrites, false);
});
