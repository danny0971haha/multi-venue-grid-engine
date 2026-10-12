import type { WriteOutcomeKind } from "../domain/enums.js";
import { decimalAbs, decimalCmp, decimalMul } from "../math/decimal.js";
import { incrementCanonicalGeneration } from "../persistence/atomic-pair-store.js";
import type { PairInspection } from "../persistence/exact-pair-inspection.js";
import { sortReasonCodes } from "../persistence/exact-pair-inspection.js";
import { assertCurrentLease, runLeaseFencedMutation } from "../persistence/runtime-lease.js";
import type { FencedMutationResult, LeaseResult } from "../persistence/runtime-lease.js";
import { evaluateRisk } from "../risk/risk-engine.js";
import type { RiskDecision, RiskInput } from "../risk/risk-types.js";
import { FROZEN_PLANNED_GROSS_NOTIONAL_USDT } from "../risk/risk-types.js";
import { isWellFormedHaltId } from "./halt-id.js";
import {
  isNonRunningHaltStatus,
  isTerminalHaltStatus,
  makeHaltRecord,
  parseHaltRecord,
} from "./record.js";
import { initializeHaltPair, loadHaltAuthority, persistHaltTransition } from "./store.js";
import type { HaltAuthoritativeSnapshot, HaltOwnedOrder } from "./transport.js";
import type {
  DurableHaltRecord,
  HaltAcknowledgeRequest,
  HaltAcknowledgementLineage,
  HaltClock,
  HaltOperationResult,
  HaltRuntimeContext,
  HaltRuntimeDisposition,
  HaltStatus,
} from "./types.js";
import {
  ACK_SNAPSHOT_MAX_STALE_MS,
  HaltProcessFence,
  PHASE_2E_REASON_CODE_CATALOG,
} from "./types.js";

export { HaltProcessFence };

export function fixedHaltClock(iso: string): HaltClock {
  return {
    nowIso() {
      return iso;
    },
  };
}

export function systemHaltClock(): HaltClock {
  return {
    nowIso() {
      return new Date().toISOString();
    },
  };
}

export function sortPhase2EReasonCodes(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map<string, number>(
    PHASE_2E_REASON_CODE_CATALOG.map((code, index) => [code, index]),
  );
  return unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
}

export function formatHaltResultDiagnostic(result: HaltOperationResult): string {
  return JSON.stringify({
    durableStatus: result.durableStatus,
    runtimeDisposition: result.runtimeDisposition,
    allowRiskIncrease: result.allowRiskIncrease,
    systemAllowRiskIncrease: result.systemAllowRiskIncrease,
    haltId: result.haltId,
    durableGeneration: result.durableGeneration,
    durableEnvelopeSha256: result.durableEnvelopeSha256,
    leaseGeneration: result.leaseGeneration,
    mutationInvoked: result.mutationInvoked,
    cancelInvoked: result.cancelInvoked,
    flattenInvoked: result.flattenInvoked,
    reduceInvoked: result.reduceInvoked,
    unresolvedPossibleExposureReserved: result.unresolvedPossibleExposureReserved,
    acknowledgementCommitted: result.acknowledgementCommitted,
    reasonCodes: result.reasonCodes,
    latchState: result.latchState,
  });
}

export async function initializeDurableHalt(
  context: HaltRuntimeContext,
  extras?: { startingEquityUsd?: string | null; highWaterEquityUsd?: string | null },
): Promise<HaltOperationResult> {
  const lease = await proveLease(context);
  if (!lease.ok) {
    return failClosed(context, ["LEASE_UNCERTAIN", ...lease.reasonCodes], {
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  const payload = makeHaltRecord({
    scopeKey: context.scopeKey,
    experimentId: context.experimentId,
    haltId: null,
    haltReasons: [],
    status: "RUNNING",
    leaseGeneration: context.leaseAuthority.generation,
    leaseEnvelopeSha256: context.leaseAuthority.leaseEnvelopeSha256,
    predecessorHaltId: null,
    predecessorStatus: null,
    incidentGeneration: "1",
    acknowledgement: null,
    unresolvedPossibleExposure: false,
    flatnessProven: false,
    snapshotFresh: false,
    snapshotObservedAt: null,
    startingEquityUsd: extras?.startingEquityUsd ?? null,
    highWaterEquityUsd: extras?.highWaterEquityUsd ?? null,
    lastRiskEvaluationAt: null,
    updatedAt: context.haltClock.nowIso(),
  });
  const persist = await initializeHaltPair({
    directory: context.directory,
    scopeKey: context.scopeKey,
    payload,
    latch: context.latch,
  });
  if (persist.disposition !== "REQUESTED_STATE_COMMITTED" || persist.state === null) {
    return failClosed(context, ["HALT_PAIR_UNPROVEN", ...persist.reasonCodes], {
      inspection: persist.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  return successFromRecord(
    context,
    persist.state,
    persist.inspection,
    persist,
    ["DURABLE_HALT_RUNNING"],
    {
      runtimeDisposition: "RUNNING",
    },
  );
}

export async function inspectHaltContinuation(
  context: HaltRuntimeContext,
): Promise<HaltOperationResult> {
  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (!loaded.ok) {
    return failClosed(context, loaded.reasonCodes, {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  if (isNonRunningHaltStatus(loaded.record.status)) {
    return successFromRecord(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["RISK_INCREASE_FENCED"],
      { runtimeDisposition: dispositionFromStatus(loaded.record.status) },
    );
  }
  return authorizeCurrentRunningContinuation(context, loaded);
}

async function authorizeCurrentRunningContinuation(
  context: HaltRuntimeContext,
  loaded: {
    record: DurableHaltRecord;
    inspection: PairInspection;
    generation: string;
    envelopeSha256: string;
  },
): Promise<HaltOperationResult> {
  const persist = {
    committedGeneration: loaded.generation,
    committedEnvelopeSha256: loaded.envelopeSha256,
  };
  const blocked = (reasonCodes: readonly string[]): HaltOperationResult =>
    successFromRecord(context, loaded.record, loaded.inspection, persist, reasonCodes, {
      runtimeDisposition: "FAIL_CLOSED",
      forceRiskBlocked: true,
    });
  const lease = await proveLease(context);
  if (!lease.ok) {
    return blocked(["LEASE_UNCERTAIN", "RISK_INCREASE_FENCED", ...lease.reasonCodes]);
  }
  if (context.latch.blocked) {
    return blocked(["LATCH_ALREADY_BLOCKED", "RISK_INCREASE_FENCED"]);
  }
  if (context.processFence.tripped) {
    return blocked(["RISK_INCREASE_FENCED"]);
  }
  if (loaded.record.unresolvedPossibleExposure) {
    return blocked(["UNRESOLVED_UNKNOWN", "RISK_INCREASE_FENCED"]);
  }
  return successFromRecord(
    context,
    loaded.record,
    loaded.inspection,
    persist,
    ["DURABLE_HALT_RUNNING"],
    { runtimeDisposition: "RUNNING" },
  );
}

export async function applyRiskDecision(
  context: HaltRuntimeContext,
  riskInput: unknown,
): Promise<HaltOperationResult> {
  const decision = evaluateRisk(riskInput);
  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (!loaded.ok) {
    if (decision.action === "HALT") {
      context.processFence.trip();
    }
    return failClosed(context, ["HALT_PAIR_UNPROVEN", ...loaded.reasonCodes], {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  if (isNonRunningHaltStatus(loaded.record.status)) {
    const codes = ["RISK_INCREASE_FENCED"];
    if (decision.action === "CONTINUE") {
      codes.push("CONTINUE_CANNOT_OVERRIDE_HALT");
    }
    return successFromRecord(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      codes,
      { runtimeDisposition: dispositionFromStatus(loaded.record.status) },
    );
  }
  if (decision.action === "HALT") {
    return executeHardHalt(context, {
      haltReasons: decision.reasonCodes,
      lastRiskEvaluationAt: decision.evaluatedAt,
    });
  }
  if (decision.action === "REDUCE") {
    return executeBoundedReduce(
      context,
      loaded.record,
      loaded.inspection,
      loaded.generation,
      loaded.envelopeSha256,
    );
  }
  return authorizeCurrentRunningContinuation(context, loaded);
}

export async function executeHardHalt(
  context: HaltRuntimeContext,
  args: { haltReasons: readonly string[]; lastRiskEvaluationAt: string | null },
): Promise<HaltOperationResult> {
  context.processFence.trip();
  const lease = await proveLease(context);
  if (!lease.ok) {
    return failClosed(context, ["LEASE_UNCERTAIN", "RISK_INCREASE_FENCED", ...lease.reasonCodes], {
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  if (context.latch.blocked) {
    return failClosed(context, ["LATCH_ALREADY_BLOCKED", "RISK_INCREASE_FENCED"], {
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (!loaded.ok) {
    return failClosed(context, loaded.reasonCodes, {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  if (isNonRunningHaltStatus(loaded.record.status)) {
    return successFromRecord(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["RISK_INCREASE_FENCED"],
      { runtimeDisposition: dispositionFromStatus(loaded.record.status) },
    );
  }

  const haltId = context.haltIdSource.nextHaltId();
  if (!isWellFormedHaltId(haltId)) {
    return failClosed(context, ["INVALID_HALT_ID", "RISK_INCREASE_FENCED"], {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  const nextIncident = incrementCanonicalGeneration(loaded.record.incidentGeneration);
  if (!nextIncident.ok) {
    return failClosed(context, ["INVALID_HALT_RECORD", "RISK_INCREASE_FENCED"], {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }

  const haltingRecord = makeHaltRecord({
    ...loaded.record,
    haltId,
    haltReasons: sanitizeHaltReasons(args.haltReasons),
    status: "HALTING",
    leaseGeneration: context.leaseAuthority.generation,
    leaseEnvelopeSha256: context.leaseAuthority.leaseEnvelopeSha256,
    predecessorHaltId: loaded.record.haltId,
    predecessorStatus: loaded.record.status,
    incidentGeneration: nextIncident.generation,
    acknowledgement: null,
    unresolvedPossibleExposure: false,
    flatnessProven: false,
    snapshotFresh: false,
    snapshotObservedAt: null,
    lastRiskEvaluationAt: args.lastRiskEvaluationAt,
    updatedAt: context.haltClock.nowIso(),
  });

  const relock = await proveLease(context);
  if (!relock.ok) {
    return failClosed(context, ["LEASE_UNCERTAIN", "RISK_INCREASE_FENCED", ...relock.reasonCodes], {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }
  const haltingPersist = await persistHaltTransition({
    directory: context.directory,
    scopeKey: context.scopeKey,
    expectedGeneration: loaded.generation,
    expectedPredecessorEnvelopeSha256: loaded.envelopeSha256,
    payload: haltingRecord,
    latch: context.latch,
  });
  if (haltingPersist.disposition !== "REQUESTED_STATE_COMMITTED" || haltingPersist.state === null) {
    return failClosed(
      context,
      ["FINAL_PAIR_UNPROVEN", "RISK_INCREASE_FENCED", ...haltingPersist.reasonCodes],
      {
        inspection: haltingPersist.inspection,
        runtimeDisposition: "FAIL_CLOSED",
      },
    );
  }

  let mutation: MutationTrace;
  try {
    mutation = await remediateAfterHalting(context);
  } catch {
    return resultFromCommitted(
      context,
      haltingPersist.state,
      haltingPersist.inspection,
      {
        committedGeneration: haltingPersist.committedGeneration,
        committedEnvelopeSha256: haltingPersist.committedEnvelopeSha256,
      },
      [
        "HALTING_COMMITTED",
        "UNRESOLVED_UNKNOWN",
        "RECONCILIATION_REQUIRED",
        "RISK_INCREASE_FENCED",
      ],
      emptyMutation(),
    );
  }
  const terminalStatus = decideTerminalStatus(mutation);
  const terminalRecord = makeHaltRecord({
    ...haltingPersist.state,
    status: terminalStatus,
    unresolvedPossibleExposure: mutation.unresolvedPossibleExposure,
    flatnessProven: mutation.flatnessProven,
    snapshotFresh: mutation.snapshotFresh,
    snapshotObservedAt: mutation.snapshotObservedAt,
    leaseGeneration: context.leaseAuthority.generation,
    leaseEnvelopeSha256: context.leaseAuthority.leaseEnvelopeSha256,
    updatedAt: context.haltClock.nowIso(),
  });

  const beforeTerminal = await proveLease(context);
  if (!beforeTerminal.ok) {
    return resultFromCommitted(
      context,
      haltingPersist.state,
      haltingPersist.inspection,
      {
        committedGeneration: haltingPersist.committedGeneration,
        committedEnvelopeSha256: haltingPersist.committedEnvelopeSha256,
      },
      [
        "LEASE_UNCERTAIN",
        "RISK_INCREASE_FENCED",
        "HALTING_COMMITTED",
        ...mutation.reasonCodes,
        ...beforeTerminal.reasonCodes,
      ],
      mutation,
    );
  }
  if (context.latch.blocked) {
    return resultFromCommitted(
      context,
      haltingPersist.state,
      haltingPersist.inspection,
      {
        committedGeneration: haltingPersist.committedGeneration,
        committedEnvelopeSha256: haltingPersist.committedEnvelopeSha256,
      },
      [
        "LATCH_ALREADY_BLOCKED",
        "RISK_INCREASE_FENCED",
        "HALTING_COMMITTED",
        ...mutation.reasonCodes,
      ],
      mutation,
    );
  }

  const reloaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (!reloaded.ok) {
    return failClosed(context, reloaded.reasonCodes, {
      inspection: reloaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
      mutation,
    });
  }
  const terminalPersist = await persistHaltTransition({
    directory: context.directory,
    scopeKey: context.scopeKey,
    expectedGeneration: reloaded.generation,
    expectedPredecessorEnvelopeSha256: reloaded.envelopeSha256,
    payload: terminalRecord,
    latch: context.latch,
  });
  if (
    terminalPersist.disposition !== "REQUESTED_STATE_COMMITTED" ||
    terminalPersist.state === null
  ) {
    return resultFromCommitted(
      context,
      haltingPersist.state,
      terminalPersist.inspection,
      {
        committedGeneration: haltingPersist.committedGeneration,
        committedEnvelopeSha256: haltingPersist.committedEnvelopeSha256,
      },
      [
        "FINAL_PAIR_UNPROVEN",
        "RISK_INCREASE_FENCED",
        "HALTING_COMMITTED",
        ...mutation.reasonCodes,
        ...terminalPersist.reasonCodes,
      ],
      mutation,
    );
  }
  return resultFromCommitted(
    context,
    terminalPersist.state,
    terminalPersist.inspection,
    {
      committedGeneration: terminalPersist.committedGeneration,
      committedEnvelopeSha256: terminalPersist.committedEnvelopeSha256,
    },
    ["HALT_ID_CREATED", committedStatusCode(terminalPersist.state.status), ...mutation.reasonCodes],
    mutation,
  );
}

export async function acknowledgeHalt(
  context: HaltRuntimeContext,
  args: HaltAcknowledgeRequest,
): Promise<HaltOperationResult> {
  const extra = ignoredCallerAuthorizationCodes(args);

  if (context.latch.blocked) {
    return failClosed(
      context,
      ["LATCH_BLOCKS_ACK", "LATCH_ALREADY_BLOCKED", "ACK_REJECTED", ...extra],
      {
        runtimeDisposition: "FAIL_CLOSED",
      },
    );
  }

  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (!loaded.ok) {
    return failClosed(context, ["ACK_REJECTED", ...loaded.reasonCodes, ...extra], {
      inspection: loaded.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }

  const rejectLoaded = (reasonCodes: readonly string[]): HaltOperationResult =>
    resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", ...reasonCodes, ...extra],
      emptyMutation(),
    );

  const idCheck = compareSuppliedHaltId(args.suppliedHaltId, loaded.record.haltId);
  if (!idCheck.ok) {
    return rejectLoaded(idCheck.reasonCodes);
  }

  const lease = await proveLease(context);
  if (!lease.ok) {
    return rejectLoaded(["LEASE_UNCERTAIN", ...lease.reasonCodes]);
  }

  if (!isTerminalHaltStatus(loaded.record.status)) {
    return rejectLoaded(["RISK_INCREASE_FENCED"]);
  }

  const initialResume = await obtainInternalResumeAuthority(context, loaded.record);
  if (!initialResume.ok) {
    return rejectLoaded(initialResume.reasonCodes);
  }

  if (context.ackTransitionHooks?.beforeAckPersistLeaseRecheck !== undefined) {
    await context.ackTransitionHooks.beforeAckPersistLeaseRecheck();
  }

  const relock = await proveLease(context);
  if (!relock.ok) {
    return rejectLoaded(["LEASE_UNCERTAIN", ...relock.reasonCodes]);
  }
  if (context.latch.blocked) {
    return rejectLoaded(["LATCH_BLOCKS_ACK"]);
  }

  const finalResume = await obtainInternalResumeAuthority(context, loaded.record);
  if (!finalResume.ok) {
    return rejectLoaded(finalResume.reasonCodes);
  }

  const nextGeneration = incrementCanonicalGeneration(loaded.generation);
  if (!nextGeneration.ok) {
    return rejectLoaded(["FINAL_PAIR_UNPROVEN"]);
  }

  const acknowledgement: HaltAcknowledgementLineage = {
    acknowledgedHaltId: loaded.record.haltId as string,
    predecessorStoreGeneration: loaded.generation,
    predecessorEnvelopeSha256: loaded.envelopeSha256,
    newStoreGeneration: nextGeneration.generation,
    priorLeaseGeneration: loaded.record.leaseGeneration ?? context.leaseAuthority.generation,
    currentLeaseGeneration: context.leaseAuthority.generation,
    resultingStatus: "RUNNING",
    snapshotSourceId: finalResume.snapshot.sourceId,
    snapshotObservedAt: finalResume.snapshot.observedAt,
    snapshotLeaseGeneration: finalResume.snapshot.leaseGeneration,
  };
  const running = makeHaltRecord({
    ...loaded.record,
    haltId: null,
    haltReasons: [],
    status: "RUNNING",
    leaseGeneration: context.leaseAuthority.generation,
    leaseEnvelopeSha256: context.leaseAuthority.leaseEnvelopeSha256,
    predecessorHaltId: loaded.record.haltId,
    predecessorStatus: loaded.record.status,
    acknowledgement,
    unresolvedPossibleExposure: false,
    flatnessProven: false,
    snapshotFresh: finalResume.snapshot.fresh,
    snapshotObservedAt: finalResume.snapshot.observedAt,
    lastRiskEvaluationAt: finalResume.riskDecision.evaluatedAt,
    updatedAt: context.haltClock.nowIso(),
  });

  let persist: Awaited<ReturnType<typeof persistHaltTransition>>;
  try {
    persist = await persistHaltTransition({
      directory: context.directory,
      scopeKey: context.scopeKey,
      expectedGeneration: loaded.generation,
      expectedPredecessorEnvelopeSha256: loaded.envelopeSha256,
      payload: running,
      latch: context.latch,
    });
  } catch {
    return rejectLoaded(["FINAL_PAIR_UNPROVEN"]);
  }
  if (persist.disposition !== "REQUESTED_STATE_COMMITTED" || persist.state === null) {
    const after = await loadHaltAuthority({
      directory: context.directory,
      scopeKey: context.scopeKey,
    });
    if (after.ok) {
      return resultFromCommitted(
        context,
        after.record,
        after.inspection,
        { committedGeneration: after.generation, committedEnvelopeSha256: after.envelopeSha256 },
        ["ACK_REJECTED", "FINAL_PAIR_UNPROVEN", ...persist.reasonCodes, ...extra],
        emptyMutation(),
      );
    }
    return failClosed(
      context,
      ["ACK_REJECTED", "FINAL_PAIR_UNPROVEN", ...persist.reasonCodes, ...extra],
      {
        inspection: persist.inspection,
        runtimeDisposition: "FAIL_CLOSED",
      },
    );
  }

  if (context.ackTransitionHooks?.afterAckPersistedBeforeFinalInspect !== undefined) {
    await context.ackTransitionHooks.afterAckPersistedBeforeFinalInspect();
  }

  const finalInspect = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (
    !finalInspect.ok ||
    finalInspect.record.status !== "RUNNING" ||
    finalInspect.record.acknowledgement === null ||
    finalInspect.record.acknowledgement.acknowledgedHaltId !== acknowledgement.acknowledgedHaltId ||
    finalInspect.record.acknowledgement.snapshotSourceId !== acknowledgement.snapshotSourceId ||
    finalInspect.record.acknowledgement.snapshotObservedAt !== acknowledgement.snapshotObservedAt ||
    finalInspect.record.acknowledgement.snapshotLeaseGeneration !==
      acknowledgement.snapshotLeaseGeneration ||
    finalInspect.envelopeSha256 !== persist.committedEnvelopeSha256
  ) {
    return failClosed(context, ["ACK_REJECTED", "FINAL_PAIR_UNPROVEN", ...extra], {
      inspection: finalInspect.ok ? finalInspect.inspection : persist.inspection,
      runtimeDisposition: "FAIL_CLOSED",
    });
  }

  context.processFence.clearAfterProvenAck();
  return resultFromCommitted(
    context,
    finalInspect.record,
    finalInspect.inspection,
    {
      committedGeneration: finalInspect.generation,
      committedEnvelopeSha256: finalInspect.envelopeSha256,
    },
    ["ACK_COMMITTED", "DURABLE_HALT_RUNNING", ...extra],
    emptyMutation(),
    true,
  );
}

type MutationTrace = {
  cancelInvoked: boolean;
  flattenInvoked: boolean;
  reduceInvoked: boolean;
  unresolvedPossibleExposure: boolean;
  flatnessProven: boolean;
  snapshotFresh: boolean;
  snapshotObservedAt: string | null;
  reasonCodes: string[];
  cancelUnknown: boolean;
  cancelFailed: boolean;
  flattenUnknown: boolean;
  flattenFailed: boolean;
};

function emptyMutation(): MutationTrace {
  return {
    cancelInvoked: false,
    flattenInvoked: false,
    reduceInvoked: false,
    unresolvedPossibleExposure: false,
    flatnessProven: false,
    snapshotFresh: false,
    snapshotObservedAt: null,
    reasonCodes: [],
    cancelUnknown: false,
    cancelFailed: false,
    flattenUnknown: false,
    flattenFailed: false,
  };
}

async function executeBoundedReduce(
  context: HaltRuntimeContext,
  record: DurableHaltRecord,
  inspection: PairInspection,
  generation: string,
  envelopeSha256: string,
): Promise<HaltOperationResult> {
  const lease = await proveLease(context);
  if (!lease.ok) {
    return resultFromCommitted(
      context,
      record,
      inspection,
      { committedGeneration: generation, committedEnvelopeSha256: envelopeSha256 },
      [
        "LEASE_UNCERTAIN",
        "REDUCE_DISTINCT_FROM_HALT",
        "RISK_INCREASE_FENCED",
        ...lease.reasonCodes,
      ],
      emptyMutation(),
    );
  }
  const fenced = await runLeaseFencedMutation({
    directory: context.directory,
    scopeKey: context.scopeKey,
    authority: context.leaseAuthority,
    latch: context.latch,
    clock: context.leaseClock,
    mutation: () => context.transport.reduce(),
  });
  const trace = emptyMutation();
  if (fenced.callbackCount > 0) {
    trace.reduceInvoked = true;
  }
  if (fenced.outcome !== "SENT" || fenced.value === null) {
    trace.unresolvedPossibleExposure = fenced.outcome === "UNKNOWN";
    trace.reasonCodes.push(
      "REDUCE_DISTINCT_FROM_HALT",
      "RISK_INCREASE_FENCED",
      "MUTATION_NOT_SENT",
    );
  } else {
    trace.reasonCodes.push("REDUCE_DISTINCT_FROM_HALT", "RISK_INCREASE_FENCED");
  }
  return resultFromCommitted(
    context,
    record,
    inspection,
    { committedGeneration: generation, committedEnvelopeSha256: envelopeSha256 },
    trace.reasonCodes,
    trace,
    false,
    { runtimeDisposition: "REDUCING", forceRiskBlocked: true },
  );
}

async function remediateAfterHalting(context: HaltRuntimeContext): Promise<MutationTrace> {
  const trace = emptyMutation();
  const listed = await runFencedTransport(context, () => context.transport.listOpenOrders());
  if (listed.outcome !== "SENT" || listed.value === null) {
    trace.unresolvedPossibleExposure = true;
    trace.cancelUnknown = true;
    trace.reasonCodes.push(
      "LIST_OPEN_ORDERS_UNKNOWN",
      "UNRESOLVED_UNKNOWN",
      "RECONCILIATION_REQUIRED",
    );
    return trace;
  }
  const orders = listed.value;
  const ownedRiskIncreasing = orders.filter(
    (order) => order.ownership === "OWNED" && order.riskIncreasing,
  );
  const ambiguousRiskIncreasing = orders.some(
    (order) => order.ownership === "AMBIGUOUS" && order.riskIncreasing,
  );
  if (orders.some((order) => order.ownership === "UNOWNED")) {
    trace.reasonCodes.push("UNOWNED_CANCEL_REFUSED");
  }
  if (orders.some((order) => order.ownership === "AMBIGUOUS")) {
    trace.reasonCodes.push("AMBIGUOUS_ORDERS_PRESENT");
  }
  if (ambiguousRiskIncreasing) {
    trace.unresolvedPossibleExposure = true;
    trace.reasonCodes.push("RECONCILIATION_REQUIRED");
  }

  for (const order of ownedRiskIncreasing) {
    const lease = await proveLease(context);
    if (!lease.ok) {
      trace.reasonCodes.push("LEASE_UNCERTAIN", "CANCEL_FAILED");
      trace.cancelFailed = true;
      break;
    }
    const fenced = await runFencedTransport(context, () =>
      context.transport.cancel(order.exchangeOrderId),
    );
    if (fenced.callbackCount > 0) {
      trace.cancelInvoked = true;
    }
    const kind = writeKind(fenced.outcome, fenced.value?.kind);
    if (kind === "UNKNOWN") {
      trace.cancelUnknown = true;
      trace.unresolvedPossibleExposure = true;
      trace.reasonCodes.push("CANCEL_UNKNOWN", "UNRESOLVED_UNKNOWN", "RECONCILIATION_REQUIRED");
    } else if (kind !== "ACK") {
      trace.cancelFailed = true;
      trace.reasonCodes.push("CANCEL_FAILED");
    }
  }

  if (trace.cancelUnknown) {
    return trace;
  }

  const flattenLease = await proveLease(context);
  if (!flattenLease.ok) {
    trace.reasonCodes.push("LEASE_UNCERTAIN", "FLATTEN_FAILED");
    trace.flattenFailed = true;
    return trace;
  }
  const flatten = await runFencedTransport(context, () => context.transport.flatten());
  if (flatten.callbackCount > 0) {
    trace.flattenInvoked = true;
  }
  const flattenKind = writeKind(flatten.outcome, flatten.value?.kind);
  if (flattenKind === "UNKNOWN") {
    trace.flattenUnknown = true;
    trace.unresolvedPossibleExposure = true;
    trace.reasonCodes.push("FLATTEN_UNKNOWN", "UNRESOLVED_UNKNOWN", "RECONCILIATION_REQUIRED");
    return trace;
  }
  if (flattenKind !== "ACK") {
    trace.flattenFailed = true;
    trace.reasonCodes.push("FLATTEN_FAILED");
  } else {
    trace.reasonCodes.push("FLATTEN_ACK_NOT_FLATNESS");
  }

  const snapshotLease = await proveLease(context);
  if (!snapshotLease.ok) {
    trace.reasonCodes.push("LEASE_UNCERTAIN", "STALE_SNAPSHOT");
    return trace;
  }
  const snapshotFence = await runFencedTransport(context, () => context.transport.freshSnapshot());
  if (snapshotFence.outcome !== "SENT" || snapshotFence.value === null) {
    trace.reasonCodes.push("STALE_SNAPSHOT", "SNAPSHOT_NOT_AUTHORITATIVE");
    return trace;
  }
  const snapshot = snapshotFence.value;
  const observation = classifySnapshotObservedAt(snapshot.observedAt, context.haltClock);
  trace.snapshotObservedAt = snapshot.observedAt;
  trace.snapshotFresh = observation.kind === "ok" && snapshot.fresh === true;
  if (!trace.snapshotFresh) {
    trace.reasonCodes.push("STALE_SNAPSHOT");
    if (observation.kind === "future") {
      trace.reasonCodes.push("SNAPSHOT_OBSERVED_AT_FUTURE");
    }
    if (observation.kind === "malformed") {
      trace.reasonCodes.push("SNAPSHOT_OBSERVED_AT_MALFORMED");
    }
  }
  if (!snapshot.authoritative) {
    trace.reasonCodes.push("SNAPSHOT_NOT_AUTHORITATIVE");
  }
  if (snapshot.leaseGeneration !== context.leaseAuthority.generation) {
    trace.reasonCodes.push("SNAPSHOT_LEASE_MISMATCH");
  }
  const positionFlat =
    decimalCmp(snapshot.signedPosition, "0") === 0 && !snapshot.ownedRiskIncreasingRemaining;
  if (
    flattenKind === "ACK" &&
    !trace.cancelFailed &&
    !trace.cancelUnknown &&
    !trace.unresolvedPossibleExposure &&
    trace.snapshotFresh &&
    snapshot.authoritative &&
    snapshot.leaseGeneration === context.leaseAuthority.generation &&
    positionFlat
  ) {
    trace.flatnessProven = true;
  }
  return trace;
}

function decideTerminalStatus(trace: MutationTrace): HaltStatus {
  if (trace.cancelUnknown || trace.flattenUnknown || trace.unresolvedPossibleExposure) {
    return "RECONCILIATION_REQUIRED";
  }
  if (trace.flatnessProven) {
    return "HALTED_FLAT";
  }
  if (trace.cancelFailed && !trace.flattenInvoked) {
    return "HALT_FAILED";
  }
  if (trace.flattenFailed) {
    return "HALTED_UNFLAT";
  }
  return "HALTED_UNFLAT";
}

function committedStatusCode(status: HaltStatus): string {
  if (status === "HALTED_FLAT") {
    return "HALTED_FLAT_COMMITTED";
  }
  if (status === "HALTED_UNFLAT") {
    return "HALTED_UNFLAT_COMMITTED";
  }
  if (status === "HALT_FAILED") {
    return "HALT_FAILED_COMMITTED";
  }
  if (status === "RECONCILIATION_REQUIRED") {
    return "RECONCILIATION_REQUIRED";
  }
  if (status === "HALTING") {
    return "HALTING_COMMITTED";
  }
  return "DURABLE_HALT_RUNNING";
}

function evaluateInternalAckGates(args: {
  record: DurableHaltRecord;
  snapshot: HaltAuthoritativeSnapshot;
  orders: readonly HaltOwnedOrder[];
  riskDecision: RiskDecision;
  expectedLeaseGeneration: string;
  expectedSnapshotSourceId: string;
  observation: SnapshotObservation;
}): { ok: true } | { ok: false; reasonCodes: string[] } {
  const codes: string[] = [];
  if (args.record.unresolvedPossibleExposure) {
    codes.push("UNRESOLVED_UNKNOWN");
  }
  if (args.observation.kind === "stale") {
    codes.push("STALE_SNAPSHOT");
  }
  if (args.observation.kind === "future") {
    codes.push("SNAPSHOT_OBSERVED_AT_FUTURE", "STALE_SNAPSHOT");
  }
  if (args.observation.kind === "malformed") {
    codes.push("SNAPSHOT_OBSERVED_AT_MALFORMED", "STALE_SNAPSHOT");
  }
  if (args.snapshot.fresh !== true) {
    codes.push("STALE_SNAPSHOT");
  }
  if (!args.snapshot.authoritative) {
    codes.push("SNAPSHOT_NOT_AUTHORITATIVE");
  }
  if (args.snapshot.sourceId !== args.expectedSnapshotSourceId || args.snapshot.sourceId === "") {
    codes.push("SNAPSHOT_SOURCE_UNPROVEN", "SNAPSHOT_NOT_AUTHORITATIVE");
  }
  if (args.snapshot.leaseGeneration !== args.expectedLeaseGeneration) {
    codes.push("SNAPSHOT_LEASE_MISMATCH");
  }
  const ownedRiskIncreasingRemaining = args.orders.some(
    (order) => order.ownership === "OWNED" && order.riskIncreasing,
  );
  const ambiguousRiskIncreasingRemaining = args.orders.some(
    (order) => order.ownership === "AMBIGUOUS" && order.riskIncreasing,
  );
  if (ownedRiskIncreasingRemaining || args.snapshot.ownedRiskIncreasingRemaining) {
    codes.push("OWNED_RISK_INCREASING_REMAINING");
  }
  if (ambiguousRiskIncreasingRemaining) {
    codes.push("AMBIGUOUS_ORDERS_PRESENT");
  }
  if (args.snapshot.unknownReservations.length > 0) {
    codes.push("UNRESOLVED_UNKNOWN");
  }
  if (args.riskDecision.action !== "CONTINUE" || !args.riskDecision.riskMetricsWithinLimits) {
    codes.push("ACTIVE_RISK_BREACH");
  }
  if (args.riskDecision.reasonCodes.includes("PLANNED_NOTIONAL")) {
    codes.push("PLANNED_EXPOSURE_UNSAFE");
  }
  if (
    args.riskDecision.metrics.plannedGrossNotional !== null &&
    decimalCmp(args.riskDecision.metrics.plannedGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT) >
      0
  ) {
    codes.push("PLANNED_EXPOSURE_UNSAFE");
  }
  if (args.riskDecision.reasonCodes.includes("ACTUAL_NOTIONAL")) {
    codes.push("ACTUAL_EXPOSURE_UNSAFE");
  }
  if (
    args.riskDecision.metrics.actualGrossNotional !== null &&
    decimalCmp(args.riskDecision.metrics.actualGrossNotional, FROZEN_PLANNED_GROSS_NOTIONAL_USDT) >
      0
  ) {
    codes.push("ACTUAL_EXPOSURE_UNSAFE");
  }
  if (args.riskDecision.reasonCodes.includes("RECONCILIATION_REQUIRED")) {
    codes.push("UNRESOLVED_UNKNOWN");
  }
  if (args.riskDecision.reasonCodes.includes("STALE_OR_MISSING_INPUT")) {
    codes.push("STALE_SNAPSHOT");
  }
  if (authoritativeSnapshotMismatchesRisk(args.snapshot, args.riskDecision)) {
    codes.push("SNAPSHOT_RISK_MISMATCH");
  }
  return codes.length === 0 ? { ok: true } : { ok: false, reasonCodes: codes };
}

function ignoredCallerAuthorizationCodes(args: HaltAcknowledgeRequest): string[] {
  const codes: string[] = [];
  if (Object.hasOwn(args, "ignoredCallerState")) {
    codes.push("FORGED_CALLER_STATE_IGNORED");
  }
  if (Object.hasOwn(args, "resumeEvidence")) {
    codes.push("CALLER_RESUME_EVIDENCE_IGNORED");
  }
  if (Object.hasOwn(args, "resumeRiskInput")) {
    codes.push("CALLER_RISK_INPUT_IGNORED");
  }
  void args.ignoredCallerState;
  void args.resumeEvidence;
  void args.resumeRiskInput;
  void args.operatorNote;
  return codes;
}

type SnapshotObservation =
  | { kind: "ok"; observedMs: bigint; nowMs: bigint }
  | { kind: "stale" }
  | { kind: "future" }
  | { kind: "malformed" };

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EPOCH_MS_PATTERN = /^(0|[1-9][0-9]{0,12})$/;

function parseTimestampMs(value: string): bigint | null {
  if (EPOCH_MS_PATTERN.test(value)) {
    return BigInt(value);
  }
  if (ISO_UTC_PATTERN.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return BigInt(parsed);
  }
  return null;
}

function classifySnapshotObservedAt(observedAt: string, clock: HaltClock): SnapshotObservation {
  const nowMs = parseTimestampMs(clock.nowIso());
  const observedMs = parseTimestampMs(observedAt);
  if (nowMs === null || observedMs === null) {
    return { kind: "malformed" };
  }
  if (observedMs > nowMs) {
    return { kind: "future" };
  }
  const maxStaleMs = BigInt(ACK_SNAPSHOT_MAX_STALE_MS);
  if (nowMs - observedMs > maxStaleMs) {
    return { kind: "stale" };
  }
  return { kind: "ok", observedMs, nowMs };
}

async function runFencedTransport<T>(
  context: HaltRuntimeContext,
  mutation: () => T | Promise<T>,
): Promise<FencedMutationResult<T>> {
  return runLeaseFencedMutation({
    directory: context.directory,
    scopeKey: context.scopeKey,
    authority: context.leaseAuthority,
    latch: context.latch,
    clock: context.leaseClock,
    mutation,
  });
}

function fencedFailureCodes(result: FencedMutationResult<unknown>): string[] {
  if (result.outcome === "UNKNOWN") {
    return ["UNRESOLVED_UNKNOWN", "RECONCILIATION_REQUIRED"];
  }
  return ["LEASE_UNCERTAIN", "MUTATION_NOT_SENT"];
}

async function obtainInternalResumeAuthority(
  context: HaltRuntimeContext,
  record: DurableHaltRecord,
): Promise<
  | { ok: true; snapshot: HaltAuthoritativeSnapshot; riskDecision: RiskDecision }
  | { ok: false; reasonCodes: string[] }
> {
  if (record.unresolvedPossibleExposure) {
    return { ok: false, reasonCodes: ["UNRESOLVED_UNKNOWN"] };
  }
  if (record.startingEquityUsd === null || record.highWaterEquityUsd === null) {
    return { ok: false, reasonCodes: ["DURABLE_RISK_BASELINE_MISSING"] };
  }

  const snapshotFence = await runFencedTransport(context, () => context.transport.freshSnapshot());
  if (snapshotFence.outcome !== "SENT" || snapshotFence.value === null) {
    return {
      ok: false,
      reasonCodes: [
        "STALE_SNAPSHOT",
        "SNAPSHOT_NOT_AUTHORITATIVE",
        ...fencedFailureCodes(snapshotFence),
      ],
    };
  }
  const snapshot = snapshotFence.value;
  const observation = classifySnapshotObservedAt(snapshot.observedAt, context.haltClock);

  const listed = await runFencedTransport(context, () => context.transport.listOpenOrders());
  if (listed.outcome !== "SENT" || listed.value === null) {
    return {
      ok: false,
      reasonCodes: ["LIST_OPEN_ORDERS_UNKNOWN", ...fencedFailureCodes(listed)],
    };
  }

  const nowMs = parseTimestampMs(context.haltClock.nowIso());
  if (nowMs === null || observation.kind !== "ok") {
    const observationCodes: string[] = [];
    if (observation.kind === "future") {
      observationCodes.push("SNAPSHOT_OBSERVED_AT_FUTURE", "STALE_SNAPSHOT");
    } else if (observation.kind === "malformed" || nowMs === null) {
      observationCodes.push("SNAPSHOT_OBSERVED_AT_MALFORMED", "STALE_SNAPSHOT");
    } else {
      observationCodes.push("STALE_SNAPSHOT");
    }
    return { ok: false, reasonCodes: observationCodes };
  }

  const riskInput = buildInternalRiskInput({
    record,
    snapshot,
    evaluatedAtMs: nowMs.toString(10),
    observedAtMs: observation.observedMs.toString(10),
    latchBlocked: context.latch.blocked,
    pairAuthorityProven: true,
  });
  const riskDecision = evaluateRisk(riskInput);
  const gates = evaluateInternalAckGates({
    record,
    snapshot,
    orders: listed.value,
    riskDecision,
    expectedLeaseGeneration: context.leaseAuthority.generation,
    expectedSnapshotSourceId: context.expectedSnapshotSourceId,
    observation,
  });
  if (!gates.ok) {
    return { ok: false, reasonCodes: gates.reasonCodes };
  }
  return { ok: true, snapshot, riskDecision };
}

function buildInternalRiskInput(args: {
  record: DurableHaltRecord;
  snapshot: HaltAuthoritativeSnapshot;
  evaluatedAtMs: string;
  observedAtMs: string;
  latchBlocked: boolean;
  pairAuthorityProven: boolean;
}): RiskInput {
  return {
    signedPosition: args.snapshot.signedPosition,
    markOrMidPrice: args.snapshot.markOrMidPrice,
    equity: args.snapshot.equity,
    startingEquity: args.record.startingEquityUsd,
    highWaterEquity: args.record.highWaterEquityUsd,
    realizedTradingPnl: args.snapshot.realizedTradingPnl,
    fees: args.snapshot.fees,
    funding: args.snapshot.funding,
    fundingConvention: args.snapshot.fundingConvention,
    ownedActiveOrders: [],
    unknownReservations: args.snapshot.unknownReservations.map((item) => ({ ...item })),
    proposedBatch: [],
    gridLower: args.snapshot.gridLower,
    gridUpper: args.snapshot.gridUpper,
    freshness: {
      evaluatedAt: args.evaluatedAtMs,
      maxStaleMs: ACK_SNAPSHOT_MAX_STALE_MS,
      positionObservedAt: args.observedAtMs,
      equityObservedAt: args.observedAtMs,
      markObservedAt: args.observedAtMs,
      pnlObservedAt: args.observedAtMs,
    },
    reconciliation: {
      unresolved:
        args.record.unresolvedPossibleExposure || args.snapshot.unknownReservations.length > 0,
    },
    lease: { proven: true, expired: false, lost: false },
    latchBlocked: args.latchBlocked,
    durableInspection: { pairAuthorityProven: args.pairAuthorityProven },
    haltAuthorityClear: false,
    boundedReduction: {
      possible: true,
      ambiguous: false,
      cancelOnly: false,
      snapshotFresh: args.snapshot.fresh,
    },
  };
}

function authoritativeSnapshotMismatchesRisk(
  snapshot: HaltAuthoritativeSnapshot,
  riskDecision: RiskDecision,
): boolean {
  if (snapshot.actualGrossNotional === null || riskDecision.metrics.actualGrossNotional === null) {
    return true;
  }
  if (riskDecision.metrics.signedPosition === null) {
    return true;
  }
  if (decimalCmp(snapshot.signedPosition, riskDecision.metrics.signedPosition) !== 0) {
    return true;
  }
  if (decimalCmp(snapshot.actualGrossNotional, riskDecision.metrics.actualGrossNotional) !== 0) {
    return true;
  }
  const computed = decimalMul(decimalAbs(snapshot.signedPosition), snapshot.markOrMidPrice);
  return decimalCmp(snapshot.actualGrossNotional, computed) !== 0;
}

function compareSuppliedHaltId(
  supplied: string | null,
  durableHaltId: string | null,
): { ok: true } | { ok: false; reasonCodes: string[] } {
  if (supplied === null || supplied === "") {
    return { ok: false, reasonCodes: ["NO_ACKNOWLEDGEMENT_SUPPLIED"] };
  }
  if (!isWellFormedHaltId(supplied)) {
    return { ok: false, reasonCodes: ["MALFORMED_HALT_ID"] };
  }
  if (durableHaltId === null) {
    return { ok: false, reasonCodes: ["HALT_ID_MISMATCH"] };
  }
  if (supplied !== durableHaltId) {
    return { ok: false, reasonCodes: ["STALE_HALT_ID", "HALT_ID_MISMATCH"] };
  }
  return { ok: true };
}

async function proveLease(
  context: HaltRuntimeContext,
): Promise<{ ok: true; result: LeaseResult } | { ok: false; reasonCodes: string[] }> {
  if (context.latch.blocked) {
    return { ok: false, reasonCodes: ["LATCH_ALREADY_BLOCKED", "LEASE_UNCERTAIN"] };
  }
  const result = await assertCurrentLease({
    directory: context.directory,
    scopeKey: context.scopeKey,
    authority: context.leaseAuthority,
    latch: context.latch,
    clock: context.leaseClock,
  });
  if (result.disposition !== "ACQUIRED" || result.authority === null) {
    return { ok: false, reasonCodes: ["LEASE_UNCERTAIN", ...result.reasonCodes] };
  }
  if (
    result.authority.generation !== context.leaseAuthority.generation ||
    result.authority.leaseEnvelopeSha256 !== context.leaseAuthority.leaseEnvelopeSha256
  ) {
    return { ok: false, reasonCodes: ["LEASE_UNCERTAIN"] };
  }
  return { ok: true, result };
}

function writeKind(
  outcome: "SENT" | "NOT_SENT" | "UNKNOWN",
  kind: WriteOutcomeKind | undefined,
): WriteOutcomeKind {
  if (outcome === "UNKNOWN") {
    return "UNKNOWN";
  }
  if (outcome === "NOT_SENT") {
    return "NOT_SENT";
  }
  return kind ?? "UNKNOWN";
}

function sanitizeHaltReasons(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => /^[A-Z][A-Z0-9_]{0,127}$/.test(reason)).slice(0, 64);
}

function dispositionFromStatus(status: HaltStatus): HaltRuntimeDisposition {
  if (status === "RUNNING") {
    return "RUNNING";
  }
  if (status === "HALTING") {
    return "HALTING";
  }
  if (status === "RECONCILIATION_REQUIRED") {
    return "RECONCILIATION_REQUIRED";
  }
  return "HALTED";
}

function authorizationFrom(
  record: DurableHaltRecord,
  context: HaltRuntimeContext,
  forceRiskBlocked: boolean,
): {
  allowRiskIncrease: boolean;
  systemAllowRiskIncrease: boolean;
} {
  const allowed =
    !forceRiskBlocked &&
    record.status === "RUNNING" &&
    !context.processFence.tripped &&
    !context.latch.blocked &&
    !record.unresolvedPossibleExposure;
  return { allowRiskIncrease: allowed, systemAllowRiskIncrease: allowed };
}

function successFromRecord(
  context: HaltRuntimeContext,
  record: DurableHaltRecord,
  inspection: PairInspection,
  persist: { committedGeneration: string | null; committedEnvelopeSha256: string | null },
  reasonCodes: readonly string[],
  extras?: { runtimeDisposition?: HaltRuntimeDisposition; forceRiskBlocked?: boolean },
): HaltOperationResult {
  return resultFromCommitted(
    context,
    record,
    inspection,
    persist,
    reasonCodes,
    emptyMutation(),
    false,
    extras,
  );
}

function resultFromCommitted(
  context: HaltRuntimeContext,
  record: DurableHaltRecord,
  inspection: PairInspection,
  persist: { committedGeneration: string | null; committedEnvelopeSha256: string | null },
  reasonCodes: readonly string[],
  mutation: MutationTrace,
  acknowledgementCommitted = false,
  extras?: { runtimeDisposition?: HaltRuntimeDisposition; forceRiskBlocked?: boolean },
): HaltOperationResult {
  const auth = authorizationFrom(record, context, extras?.forceRiskBlocked === true);
  const parsed = parseHaltRecord(record);
  const safeRecord = parsed.ok ? parsed.record : record;
  return {
    durableStatus: safeRecord.status,
    runtimeDisposition: extras?.runtimeDisposition ?? dispositionFromStatus(safeRecord.status),
    allowRiskIncrease: auth.allowRiskIncrease,
    systemAllowRiskIncrease: auth.systemAllowRiskIncrease,
    haltId: safeRecord.haltId,
    durableGeneration: persist.committedGeneration,
    durableEnvelopeSha256: persist.committedEnvelopeSha256,
    leaseGeneration: safeRecord.leaseGeneration ?? context.leaseAuthority.generation,
    mutationInvoked: mutation.cancelInvoked || mutation.flattenInvoked || mutation.reduceInvoked,
    cancelInvoked: mutation.cancelInvoked,
    flattenInvoked: mutation.flattenInvoked,
    reduceInvoked: mutation.reduceInvoked,
    unresolvedPossibleExposureReserved:
      mutation.unresolvedPossibleExposure || safeRecord.unresolvedPossibleExposure,
    acknowledgementCommitted,
    reasonCodes: sortPhase2EReasonCodes(reasonCodes),
    inspection,
    latchState: context.latch.snapshot(),
    record: safeRecord,
  };
}

function failClosed(
  context: HaltRuntimeContext,
  reasonCodes: readonly string[],
  extras?: {
    inspection?: PairInspection;
    runtimeDisposition?: HaltRuntimeDisposition;
    mutation?: MutationTrace;
  },
): HaltOperationResult {
  const mutation = extras?.mutation ?? emptyMutation();
  const inspection =
    extras?.inspection ??
    ({
      pairStatus: "UNPROVEN",
      primary: { status: "MISSING" },
      backup: { status: "MISSING" },
      exactBytesEqual: false,
      pairAuthorityProven: false,
      lineageStatus: "UNVERIFIED",
      generation: null,
      envelopeSha256: null,
      reasonCodes: sortReasonCodes(reasonCodes),
      allowRiskIncrease: false,
    } satisfies PairInspection);
  return {
    durableStatus: extras?.runtimeDisposition === "HALTING" ? "HALTING" : "HALT_FAILED",
    runtimeDisposition: extras?.runtimeDisposition ?? "FAIL_CLOSED",
    allowRiskIncrease: false,
    systemAllowRiskIncrease: false,
    haltId: null,
    durableGeneration: inspection.generation,
    durableEnvelopeSha256: inspection.envelopeSha256,
    leaseGeneration: context.leaseAuthority.generation,
    mutationInvoked: mutation.cancelInvoked || mutation.flattenInvoked || mutation.reduceInvoked,
    cancelInvoked: mutation.cancelInvoked,
    flattenInvoked: mutation.flattenInvoked,
    reduceInvoked: mutation.reduceInvoked,
    unresolvedPossibleExposureReserved: mutation.unresolvedPossibleExposure,
    acknowledgementCommitted: false,
    reasonCodes: sortPhase2EReasonCodes(reasonCodes),
    inspection,
    latchState: context.latch.snapshot(),
    record: null,
  };
}
