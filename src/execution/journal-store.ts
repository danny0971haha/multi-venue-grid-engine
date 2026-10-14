import type { ScopeKey } from "../domain/ids.js";
import {
  initializeExactPair,
  persistExactPairTransition,
} from "../persistence/atomic-pair-store.js";
import type { PersistResult } from "../persistence/atomic-pair-store.js";
import { inspectExactPair } from "../persistence/exact-pair-inspection.js";
import type { RuntimePersistenceLatch } from "../persistence/runtime-persistence-latch.js";
import { isValidCursor } from "./coordinator.js";
import {
  IntentRegistry,
  IntentRegistryError,
  type IntentRegistryState,
} from "./intent-registry.js";
import type { ExecutionCheckpointStore, ExecutionCursor, IntentJournal } from "./ports.js";

export const INTENT_JOURNAL_KIND = "intent-journal";
export const INTENT_JOURNAL_STATE_NAME = "intent-journal";
export const EXECUTION_CHECKPOINT_KIND = "execution-checkpoint";
export const EXECUTION_CHECKPOINT_STATE_NAME = "execution-checkpoint";
export const EXECUTION_CHECKPOINT_SCHEMA_VERSION = "phase3-execution-checkpoint-1";

export type ExecutionCheckpointState = {
  schemaVersion: typeof EXECUTION_CHECKPOINT_SCHEMA_VERSION;
  cursor: ExecutionCursor;
};

export type DurableExecutionState =
  | {
      ok: true;
      registry: IntentRegistry;
      executionCursor: ExecutionCursor | null;
      journal: IntentJournal;
      checkpoints: ExecutionCheckpointStore;
    }
  | { ok: false; reasonCodes: string[] };

type PairPosition = { generation: string; envelopeSha256: string };

type PairTarget = {
  directory: string;
  scopeKey: ScopeKey;
  stateName: string;
  kind: string;
  latch: RuntimePersistenceLatch;
};

type PairLoad =
  | { kind: "ABSENT" }
  | { kind: "PRESENT"; payload: unknown; position: PairPosition }
  | { kind: "UNPROVEN"; reasonCodes: string[] };

const CHECKPOINT_STATE_KEYS = ["cursor", "schemaVersion"];
const CURSOR_KEYS = ["lastExecutionId", "lastExecutionTime", "market", "opaque", "venue"];

// Writes one exact pair in order from a known position. A write that does not prove the
// requested state committed is rejected, and the pair store blocks the shared latch. Once
// that latch is blocked, by this writer or anything else, every later write is refused.
class ExactPairWriter<T> {
  private readonly target: PairTarget;
  private position: PairPosition | null;
  private available = true;

  constructor(target: PairTarget, position: PairPosition | null) {
    this.target = target;
    this.position = position;
  }

  async write(payload: T): Promise<void> {
    const failure = `${this.target.stateName.toUpperCase().replaceAll("-", "_")}_WRITE_FAILED`;
    if (!this.available || this.target.latch.blocked) {
      this.target.latch.block([failure]);
      throw new Error(failure);
    }
    this.available = false;
    let result: PersistResult<T>;
    try {
      result = await this.commit(payload);
    } catch {
      this.target.latch.block([failure]);
      throw new Error(failure);
    }
    if (
      result.disposition !== "REQUESTED_STATE_COMMITTED" ||
      result.committedGeneration === null ||
      result.committedEnvelopeSha256 === null
    ) {
      this.target.latch.block([failure]);
      throw new Error(failure);
    }
    this.position = {
      generation: result.committedGeneration,
      envelopeSha256: result.committedEnvelopeSha256,
    };
    this.available = true;
  }

  private commit(payload: T): Promise<PersistResult<T>> {
    const target = this.target;
    const common = {
      directory: target.directory,
      stateName: target.stateName,
      expectedKind: target.kind,
      expectedScopeKey: target.scopeKey,
      payload,
      latch: target.latch,
    };
    if (this.position === null) {
      return initializeExactPair({
        ...common,
        bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
      });
    }
    return persistExactPairTransition({
      ...common,
      expectedGeneration: this.position.generation,
      expectedPredecessorEnvelopeSha256: this.position.envelopeSha256,
    });
  }
}

// Loads the durable intent journal and execution checkpoint of one scope. Anything that is
// not an exact proven pair with a valid payload fails closed. A fresh directory gets an empty
// journal first, so a checkpoint never exists without the journal its executions are in.
export async function openDurableExecutionState(args: {
  directory: string;
  scopeKey: ScopeKey;
  latch: RuntimePersistenceLatch;
}): Promise<DurableExecutionState> {
  const journalTarget: PairTarget = {
    ...args,
    stateName: INTENT_JOURNAL_STATE_NAME,
    kind: INTENT_JOURNAL_KIND,
  };
  const checkpointTarget: PairTarget = {
    ...args,
    stateName: EXECUTION_CHECKPOINT_STATE_NAME,
    kind: EXECUTION_CHECKPOINT_KIND,
  };
  const journalPair = await loadPair(journalTarget);
  const checkpointPair = await loadPair(checkpointTarget);
  const reasonCodes: string[] = [];
  if (journalPair.kind === "UNPROVEN") {
    reasonCodes.push("INTENT_JOURNAL_UNPROVEN", ...journalPair.reasonCodes);
  }
  if (checkpointPair.kind === "UNPROVEN") {
    reasonCodes.push("EXECUTION_CHECKPOINT_UNPROVEN", ...checkpointPair.reasonCodes);
  }
  if (journalPair.kind === "ABSENT" && checkpointPair.kind === "PRESENT") {
    reasonCodes.push("EXECUTION_CHECKPOINT_WITHOUT_JOURNAL");
  }
  if (reasonCodes.length > 0) {
    return { ok: false, reasonCodes };
  }

  let registry = new IntentRegistry();
  if (journalPair.kind === "PRESENT") {
    try {
      registry = IntentRegistry.fromState(journalPair.payload);
    } catch (error) {
      const code = error instanceof IntentRegistryError ? error.reasonCode : "IMPORT_FAILED";
      return { ok: false, reasonCodes: ["INTENT_JOURNAL_INVALID", code] };
    }
    if (registry.list().some((record) => record.intent.scopeKey !== args.scopeKey)) {
      return { ok: false, reasonCodes: ["INTENT_JOURNAL_INVALID", "INTENT_SCOPE_MISMATCH"] };
    }
  }
  let executionCursor: ExecutionCursor | null = null;
  if (checkpointPair.kind === "PRESENT") {
    executionCursor = parseCheckpoint(checkpointPair.payload, args.scopeKey);
    if (executionCursor === null) {
      return { ok: false, reasonCodes: ["EXECUTION_CHECKPOINT_INVALID"] };
    }
  }

  const journalWriter = new ExactPairWriter<IntentRegistryState>(
    journalTarget,
    journalPair.kind === "PRESENT" ? journalPair.position : null,
  );
  if (journalPair.kind === "ABSENT") {
    try {
      await journalWriter.write(registry.exportState());
    } catch {
      return { ok: false, reasonCodes: ["INTENT_JOURNAL_INITIALIZATION_FAILED"] };
    }
  }
  const checkpointWriter = new ExactPairWriter<ExecutionCheckpointState>(
    checkpointTarget,
    checkpointPair.kind === "PRESENT" ? checkpointPair.position : null,
  );
  return {
    ok: true,
    registry,
    executionCursor,
    journal: { persist: (state) => journalWriter.write(state) },
    checkpoints: {
      persist: (cursor) =>
        checkpointWriter.write({
          schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION,
          cursor: { ...cursor },
        }),
    },
  };
}

async function loadPair(target: PairTarget): Promise<PairLoad> {
  const inspection = await inspectExactPair({
    directory: target.directory,
    stateName: target.stateName,
    expectedKind: target.kind,
    expectedScopeKey: target.scopeKey,
  });
  if (inspection.pairStatus === "BOTH_ABSENT") {
    return { kind: "ABSENT" };
  }
  if (
    !inspection.pairAuthorityProven ||
    inspection.generation === null ||
    inspection.envelopeSha256 === null ||
    inspection.primary.status !== "VALID"
  ) {
    return { kind: "UNPROVEN", reasonCodes: ["PREDECESSOR_UNPROVEN", ...inspection.reasonCodes] };
  }
  return {
    kind: "PRESENT",
    payload: inspection.primary.envelope.payload,
    position: { generation: inspection.generation, envelopeSha256: inspection.envelopeSha256 },
  };
}

function parseCheckpoint(value: unknown, scopeKey: ScopeKey): ExecutionCursor | null {
  if (!hasExactKeys(value, CHECKPOINT_STATE_KEYS)) {
    return null;
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== EXECUTION_CHECKPOINT_SCHEMA_VERSION ||
    !hasExactKeys(state.cursor, CURSOR_KEYS) ||
    !isValidCursor(state.cursor, scopeKey)
  ) {
    return null;
  }
  return { ...state.cursor };
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
