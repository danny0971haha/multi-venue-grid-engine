import assert from "node:assert/strict";

import type { CrashWorkerInspectResult } from "./phase2b-crash-worker.js";

export type CrashReloadClassification = "OLD_EXACT_PAIR" | "NEW_EXACT_PAIR" | "PAIR_UNPROVEN";

export type ExpectedExactPair = {
  generation: string;
  envelopeSha256: string;
  fullEnvelopeBytes: Buffer;
};

export type CrashReloadEvidence = {
  inspection: CrashWorkerInspectResult;
  primary: Buffer | null;
  backup: Buffer | null;
};

// TEST_FAULT_MATRIX §7.1 allows exactly three fresh-reload outcomes. PAIR_UNPROVEN must carry no
// pair authority, and an authoritative result must be the exact old or exact new pair on disk; an
// authoritative pair that is neither fails instead of being labelled unproven.
export function classifyCrashReload(
  evidence: CrashReloadEvidence,
  old: ExpectedExactPair,
  next: ExpectedExactPair,
): CrashReloadClassification {
  const { inspection } = evidence;
  assert.equal(inspection.allowRiskIncrease, false);
  if (inspection.pairAuthorityProven === false) {
    return "PAIR_UNPROVEN";
  }
  assert.equal(inspection.pairAuthorityProven, true, "pair authority must be a boolean");
  for (const [classification, expected] of [
    ["OLD_EXACT_PAIR", old],
    ["NEW_EXACT_PAIR", next],
  ] as const) {
    if (inspection.envelopeSha256 === expected.envelopeSha256) {
      assert.equal(inspection.generation, expected.generation, classification);
      assert.equal(inspection.exactBytesEqual, true, classification);
      assert.ok(
        evidence.primary?.equals(expected.fullEnvelopeBytes) === true,
        `${classification} primary bytes`,
      );
      assert.ok(
        evidence.backup?.equals(expected.fullEnvelopeBytes) === true,
        `${classification} backup bytes`,
      );
      return classification;
    }
  }
  assert.fail(
    `authoritative pair is neither the old nor the new exact pair: generation=${String(inspection.generation)} envelopeSha256=${String(inspection.envelopeSha256)}`,
  );
}
