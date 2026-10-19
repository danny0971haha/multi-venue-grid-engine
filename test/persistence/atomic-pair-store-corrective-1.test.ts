import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildDurableEnvelope } from "../../src/persistence/durable-envelope.js";
import type { ExpectedExactPair } from "../fixtures/phase2b-crash-classifier.js";
import { classifyCrashReload } from "../fixtures/phase2b-crash-classifier.js";
import type { CrashWorkerInspectResult } from "../fixtures/phase2b-crash-worker.js";
import {
  FIXTURE_KIND,
  FIXTURE_PAYLOAD,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_SCOPE_KEY,
} from "../fixtures/phase2a-canonical-vector.js";

function envelope(storeGeneration: string, previousEnvelopeSha256: string | null, marker: string) {
  return buildDurableEnvelope({
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: FIXTURE_KIND,
    scopeKey: FIXTURE_SCOPE_KEY,
    storeGeneration,
    previousEnvelopeSha256,
    payload: {
      levels: FIXTURE_PAYLOAD.levels,
      marker,
      notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
    },
  });
}

function expected(built: ReturnType<typeof envelope>): ExpectedExactPair {
  return {
    generation: built.envelope.storeGeneration,
    envelopeSha256: built.envelope.envelopeSha256,
    fullEnvelopeBytes: built.fullEnvelopeBytes,
  };
}

const OLD = envelope("1", null, "phase2b-crash-old");
const NEW = envelope("2", OLD.envelope.envelopeSha256, "phase2b-crash-new");
// A complete, valid pair that is neither the old nor the new state: the fourth outcome that
// TEST_FAULT_MATRIX §7.1 forbids.
const FOURTH = envelope("2", OLD.envelope.envelopeSha256, "phase2b-crash-fourth");

function authoritative(built: ReturnType<typeof envelope>): CrashWorkerInspectResult {
  return {
    pairStatus: "EXACT_PAIR",
    pairAuthorityProven: true,
    allowRiskIncrease: false,
    generation: built.envelope.storeGeneration,
    envelopeSha256: built.envelope.envelopeSha256,
    exactBytesEqual: true,
    primaryStatus: "VALID",
    backupStatus: "VALID",
    reasonCodes: [],
  };
}

function unproven(): CrashWorkerInspectResult {
  return {
    pairStatus: "UNPROVEN",
    pairAuthorityProven: false,
    allowRiskIncrease: false,
    generation: null,
    envelopeSha256: null,
    exactBytesEqual: false,
    primaryStatus: "VALID",
    backupStatus: "VALID",
    reasonCodes: ["PAIR_MISMATCH"],
  };
}

function classify(
  inspection: CrashWorkerInspectResult,
  primary: Buffer | null,
  backup: Buffer | null,
) {
  return classifyCrashReload({ inspection, primary, backup }, expected(OLD), expected(NEW));
}

describe("Gate 2 corrective C9: normal crash classifier authority", () => {
  test("C9-1 an authoritative pair that is neither old nor new fails instead of PAIR_UNPROVEN", () => {
    const bytes = FOURTH.fullEnvelopeBytes;
    assert.throws(() => classify(authoritative(FOURTH), bytes, bytes), assert.AssertionError);
  });

  test("C9-2 an authoritative old or new hash must match its generation and exact bytes", () => {
    const newBytes = NEW.fullEnvelopeBytes;
    const oldBytes = OLD.fullEnvelopeBytes;
    const cases: Array<[string, CrashWorkerInspectResult, Buffer | null, Buffer | null]> = [
      ["new hash, old generation", { ...authoritative(NEW), generation: "1" }, newBytes, newBytes],
      [
        "new hash, copies differ",
        { ...authoritative(NEW), exactBytesEqual: false },
        newBytes,
        newBytes,
      ],
      ["new hash, backup holds old bytes", authoritative(NEW), newBytes, oldBytes],
      ["new hash, primary holds old bytes", authoritative(NEW), oldBytes, newBytes],
      ["old hash, primary missing", authoritative(OLD), null, oldBytes],
      ["old hash, backup holds new bytes", authoritative(OLD), oldBytes, newBytes],
    ];
    for (const [label, inspection, primary, backup] of cases) {
      assert.throws(() => classify(inspection, primary, backup), assert.AssertionError, label);
    }
  });

  test("C9-3 PAIR_UNPROVEN requires pairAuthorityProven to be exactly false", () => {
    const missing = { ...unproven() } as Partial<CrashWorkerInspectResult>;
    delete missing.pairAuthorityProven;
    const bytes = OLD.fullEnvelopeBytes;
    assert.throws(
      () => classify(missing as CrashWorkerInspectResult, bytes, bytes),
      assert.AssertionError,
    );
  });

  test("C9-4 the three allowed outcomes still classify exactly", () => {
    const oldBytes = OLD.fullEnvelopeBytes;
    const newBytes = NEW.fullEnvelopeBytes;
    assert.equal(classify(authoritative(OLD), oldBytes, oldBytes), "OLD_EXACT_PAIR");
    assert.equal(classify(authoritative(NEW), newBytes, newBytes), "NEW_EXACT_PAIR");
    assert.equal(classify(unproven(), newBytes, oldBytes), "PAIR_UNPROVEN");
    assert.equal(classify(unproven(), oldBytes, newBytes), "PAIR_UNPROVEN");
  });
});
