import type { PairInspection } from "../persistence/exact-pair-inspection.js";
import type { LeaseAuthority, LeaseClock } from "../persistence/runtime-lease.js";
import type {
  LatchState,
  RuntimePersistenceLatch,
} from "../persistence/runtime-persistence-latch.js";
import type { HaltIdSource } from "./halt-id.js";
import type { HaltMutationTransport } from "./transport.js";

export const HALT_KIND = "durable-halt";
export const HALT_STATE_NAME = "durable-halt";
export const HALT_RECORD_SCHEMA_VERSION = 1;

export type HaltStatus =
  | "RUNNING"
  | "HALTING"
  | "HALTED_FLAT"
  | "HALTED_UNFLAT"
  | "HALT_FAILED"
  | "RECONCILIATION_REQUIRED";

export type HaltRuntimeDisposition =
  | "RUNNING"
  | "HALTING"
  | "HALTED"
  | "REDUCING"
  | "RECONCILIATION_REQUIRED"
  | "FAIL_CLOSED";

export type HaltAcknowledgementLineage = {
  acknowledgedHaltId: string;
  predecessorStoreGeneration: string;
  predecessorEnvelopeSha256: string;
  newStoreGeneration: string;
  priorLeaseGeneration: string;
  currentLeaseGeneration: string;
  resultingStatus: HaltStatus;
};

export type DurableHaltRecord = {
  schemaVersion: 1;
  scopeKey: string;
  experimentId: string;
  haltId: string | null;
  haltReasons: string[];
  status: HaltStatus;
  leaseGeneration: string | null;
  leaseEnvelopeSha256: string | null;
  predecessorHaltId: string | null;
  predecessorStatus: HaltStatus | null;
  incidentGeneration: string;
  acknowledgement: HaltAcknowledgementLineage | null;
  unresolvedPossibleExposure: boolean;
  flatnessProven: boolean;
  snapshotFresh: boolean;
  snapshotObservedAt: string | null;
  startingEquityUsd: string | null;
  highWaterEquityUsd: string | null;
  lastRiskEvaluationAt: string | null;
  updatedAt: string;
};

export type HaltClock = {
  nowIso(): string;
};

export type HaltResumeEvidence = {
  snapshotFresh: boolean;
  snapshotAuthoritative: boolean;
  snapshotLeaseGeneration: string;
};

export class HaltProcessFence {
  #tripped = false;

  trip(): void {
    this.#tripped = true;
  }

  get tripped(): boolean {
    return this.#tripped;
  }

  clearAfterProvenAck(): void {
    this.#tripped = false;
  }
}

export type HaltRuntimeContext = {
  directory: string;
  scopeKey: string;
  experimentId: string;
  latch: RuntimePersistenceLatch;
  leaseAuthority: LeaseAuthority;
  leaseClock: LeaseClock;
  haltClock: HaltClock;
  haltIdSource: HaltIdSource;
  transport: HaltMutationTransport;
  processFence: HaltProcessFence;
};

export type HaltOperationResult = {
  durableStatus: HaltStatus;
  runtimeDisposition: HaltRuntimeDisposition;
  allowRiskIncrease: boolean;
  systemAllowRiskIncrease: boolean;
  haltId: string | null;
  durableGeneration: string | null;
  durableEnvelopeSha256: string | null;
  leaseGeneration: string | null;
  mutationInvoked: boolean;
  cancelInvoked: boolean;
  flattenInvoked: boolean;
  reduceInvoked: boolean;
  unresolvedPossibleExposureReserved: boolean;
  acknowledgementCommitted: boolean;
  reasonCodes: string[];
  inspection: PairInspection;
  latchState: LatchState;
  record: DurableHaltRecord | null;
};

export const PHASE_2E_REASON_CODE_CATALOG = [
  "HALT_ID_CREATED",
  "HALTING_COMMITTED",
  "HALTED_FLAT_COMMITTED",
  "HALTED_UNFLAT_COMMITTED",
  "HALT_FAILED_COMMITTED",
  "RECONCILIATION_REQUIRED",
  "ACK_COMMITTED",
  "ACK_REJECTED",
  "NO_ACKNOWLEDGEMENT_SUPPLIED",
  "STALE_HALT_ID",
  "HALT_ID_MISMATCH",
  "MALFORMED_HALT_ID",
  "FORGED_CALLER_STATE_IGNORED",
  "STALE_SNAPSHOT",
  "SNAPSHOT_NOT_AUTHORITATIVE",
  "SNAPSHOT_LEASE_MISMATCH",
  "UNRESOLVED_UNKNOWN",
  "ACTIVE_RISK_BREACH",
  "PLANNED_EXPOSURE_UNSAFE",
  "ACTUAL_EXPOSURE_UNSAFE",
  "LEASE_UNCERTAIN",
  "LATCH_BLOCKS_ACK",
  "LATCH_ALREADY_BLOCKED",
  "FINAL_PAIR_UNPROVEN",
  "PREDECESSOR_UNPROVEN",
  "CONTINUE_CANNOT_OVERRIDE_HALT",
  "REDUCE_DISTINCT_FROM_HALT",
  "RISK_INCREASE_FENCED",
  "UNOWNED_CANCEL_REFUSED",
  "AMBIGUOUS_ORDERS_PRESENT",
  "CANCEL_FAILED",
  "CANCEL_UNKNOWN",
  "FLATTEN_FAILED",
  "FLATTEN_UNKNOWN",
  "FLATTEN_ACK_NOT_FLATNESS",
  "DURABLE_HALT_RUNNING",
  "INVALID_HALT_RECORD",
  "INVALID_HALT_STATUS",
  "INVALID_HALT_ID",
  "INVALID_EXPERIMENT_ID",
  "HALT_PAIR_UNPROVEN",
  "MUTATION_NOT_SENT",
] as const;
