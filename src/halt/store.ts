import {
  initializeExactPair,
  persistExactPairTransition,
} from "../persistence/atomic-pair-store.js";
import type { PersistResult } from "../persistence/atomic-pair-store.js";
import type { PairInspection } from "../persistence/exact-pair-inspection.js";
import { inspectExactPair } from "../persistence/exact-pair-inspection.js";
import type { RuntimePersistenceLatch } from "../persistence/runtime-persistence-latch.js";
import { parseHaltRecord } from "./record.js";
import type { DurableHaltRecord } from "./types.js";
import { HALT_KIND, HALT_STATE_NAME } from "./types.js";

export type HaltPairAuthority =
  | {
      ok: true;
      record: DurableHaltRecord;
      inspection: PairInspection;
      generation: string;
      envelopeSha256: string;
    }
  | {
      ok: false;
      inspection: PairInspection;
      reasonCodes: string[];
    };

export async function inspectHaltPair(args: {
  directory: string;
  scopeKey: string;
}): Promise<PairInspection> {
  return inspectExactPair({
    directory: args.directory,
    stateName: HALT_STATE_NAME,
    expectedKind: HALT_KIND,
    expectedScopeKey: args.scopeKey,
  });
}

export async function loadHaltAuthority(args: {
  directory: string;
  scopeKey: string;
}): Promise<HaltPairAuthority> {
  const inspection = await inspectHaltPair(args);
  if (
    !inspection.pairAuthorityProven ||
    inspection.generation === null ||
    inspection.envelopeSha256 === null
  ) {
    return {
      ok: false,
      inspection,
      reasonCodes: ["HALT_PAIR_UNPROVEN", "PREDECESSOR_UNPROVEN", ...inspection.reasonCodes],
    };
  }
  if (inspection.primary.status !== "VALID") {
    return {
      ok: false,
      inspection,
      reasonCodes: ["HALT_PAIR_UNPROVEN", "INVALID_HALT_RECORD", ...inspection.reasonCodes],
    };
  }
  const parsed = parseHaltRecord(inspection.primary.envelope.payload);
  if (!parsed.ok) {
    return {
      ok: false,
      inspection,
      reasonCodes: ["HALT_PAIR_UNPROVEN", ...parsed.reasonCodes],
    };
  }
  if (parsed.record.scopeKey !== args.scopeKey) {
    return {
      ok: false,
      inspection,
      reasonCodes: ["HALT_PAIR_UNPROVEN", "INVALID_HALT_RECORD"],
    };
  }
  return {
    ok: true,
    record: parsed.record,
    inspection,
    generation: inspection.generation,
    envelopeSha256: inspection.envelopeSha256,
  };
}

export async function initializeHaltPair(args: {
  directory: string;
  scopeKey: string;
  payload: DurableHaltRecord;
  latch: RuntimePersistenceLatch;
}): Promise<PersistResult<DurableHaltRecord>> {
  return initializeExactPair({
    directory: args.directory,
    stateName: HALT_STATE_NAME,
    expectedKind: HALT_KIND,
    expectedScopeKey: args.scopeKey,
    payload: args.payload,
    bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
    latch: args.latch,
  });
}

export async function persistHaltTransition(args: {
  directory: string;
  scopeKey: string;
  expectedGeneration: string;
  expectedPredecessorEnvelopeSha256: string;
  payload: DurableHaltRecord;
  latch: RuntimePersistenceLatch;
}): Promise<PersistResult<DurableHaltRecord>> {
  return persistExactPairTransition({
    directory: args.directory,
    stateName: HALT_STATE_NAME,
    expectedKind: HALT_KIND,
    expectedScopeKey: args.scopeKey,
    expectedGeneration: args.expectedGeneration,
    expectedPredecessorEnvelopeSha256: args.expectedPredecessorEnvelopeSha256,
    payload: args.payload,
    latch: args.latch,
  });
}
