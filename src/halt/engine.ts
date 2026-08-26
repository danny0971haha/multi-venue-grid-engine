import type { WriteOutcomeKind } from "../domain/enums.js";
import { decimalCmp } from "../math/decimal.js";
import { incrementCanonicalGeneration } from "../persistence/atomic-pair-store.js";
import type { PairInspection } from "../persistence/exact-pair-inspection.js";
import { sortReasonCodes } from "../persistence/exact-pair-inspection.js";
import { assertCurrentLease, runLeaseFencedMutation } from "../persistence/runtime-lease.js";
import type { LeaseResult } from "../persistence/runtime-lease.js";
import { evaluateRisk } from "../risk/risk-engine.js";
import type { RiskDecision } from "../risk/risk-types.js";
import { FROZEN_PLANNED_GROSS_NOTIONAL_USDT } from "../risk/risk-types.js";
import { isWellFormedHaltId } from "./halt-id.js";
import {
  isNonRunningHaltStatus,
  isTerminalHaltStatus,
  makeHaltRecord,
  parseHaltRecord,
} from "./record.js";
import { initializeHaltPair, loadHaltAuthority, persistHaltTransition } from "./store.js";
import type {
  DurableHaltRecord,
  HaltAcknowledgementLineage,
  HaltClock,
  HaltOperationResult,
  HaltResumeEvidence,
  HaltRuntimeContext,
  HaltRuntimeDisposition,
  HaltStatus,
} from "./types.js";
import { HaltProcessFence, PHASE_2E_REASON_CODE_CATALOG } from "./types.js";

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
  return successFromRecord(
    context,
    loaded.record,
    loaded.inspection,
    { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
    loaded.record.status === "RUNNING" ? ["DURABLE_HALT_RUNNING"] : ["RISK_INCREASE_FENCED"],
    {
      runtimeDisposition: dispositionFromStatus(loaded.record.status),
    },
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
  const continueLease = await proveLease(context);
  if (!continueLease.ok) {
    return successFromRecord(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["LEASE_UNCERTAIN", "RISK_INCREASE_FENCED", ...continueLease.reasonCodes],
      { runtimeDisposition: "FAIL_CLOSED", forceRiskBlocked: true },
    );
  }
  return successFromRecord(
    context,
    loaded.record,
    loaded.inspection,
    { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
    ["DURABLE_HALT_RUNNING"],
    { runtimeDisposition: "RUNNING" },
  );
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

  const mutation = await remediateAfterHalting(context);
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
  args: {
    suppliedHaltId: string | null;
    resumeRiskInput: unknown;
    resumeEvidence: HaltResumeEvidence;
    ignoredCallerState?: unknown;
  },
): Promise<HaltOperationResult> {
  const extra: string[] = [];
  if (Object.hasOwn(args, "ignoredCallerState")) {
    extra.push("FORGED_CALLER_STATE_IGNORED");
  }
  void args.ignoredCallerState;

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

  const idCheck = compareSuppliedHaltId(args.suppliedHaltId, loaded.record.haltId);
  if (!idCheck.ok) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", ...idCheck.reasonCodes, ...extra],
      emptyMutation(),
    );
  }

  const lease = await proveLease(context);
  if (!lease.ok) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", "LEASE_UNCERTAIN", ...lease.reasonCodes, ...extra],
      emptyMutation(),
    );
  }

  if (!isTerminalHaltStatus(loaded.record.status)) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", "RISK_INCREASE_FENCED", ...extra],
      emptyMutation(),
    );
  }

  const gates = evaluateSafeResumeGates({
    record: loaded.record,
    resumeEvidence: args.resumeEvidence,
    riskDecision: evaluateRisk(args.resumeRiskInput),
    expectedLeaseGeneration: context.leaseAuthority.generation,
  });
  if (!gates.ok) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", ...gates.reasonCodes, ...extra],
      emptyMutation(),
    );
  }

  const nextGeneration = incrementCanonicalGeneration(loaded.generation);
  if (!nextGeneration.ok) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", "FINAL_PAIR_UNPROVEN", ...extra],
      emptyMutation(),
    );
  }

  const acknowledgement: HaltAcknowledgementLineage = {
    acknowledgedHaltId: loaded.record.haltId as string,
    predecessorStoreGeneration: loaded.generation,
    predecessorEnvelopeSha256: loaded.envelopeSha256,
    newStoreGeneration: nextGeneration.generation,
    priorLeaseGeneration: loaded.record.leaseGeneration ?? context.leaseAuthority.generation,
    currentLeaseGeneration: context.leaseAuthority.generation,
    resultingStatus: "RUNNING",
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
    snapshotFresh: args.resumeEvidence.snapshotFresh,
    snapshotObservedAt: args.resumeEvidence.snapshotFresh ? context.haltClock.nowIso() : null,
    updatedAt: context.haltClock.nowIso(),
  });

  const relock = await proveLease(context);
  if (!relock.ok) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", "LEASE_UNCERTAIN", ...relock.reasonCodes, ...extra],
      emptyMutation(),
    );
  }
  if (context.latch.blocked) {
    return resultFromCommitted(
      context,
      loaded.record,
      loaded.inspection,
      { committedGeneration: loaded.generation, committedEnvelopeSha256: loaded.envelopeSha256 },
      ["ACK_REJECTED", "LATCH_BLOCKS_ACK", ...extra],
      emptyMutation(),
    );
  }

  const persist = await persistHaltTransition({
    directory: context.directory,
    scopeKey: context.scopeKey,
    expectedGeneration: loaded.generation,
    expectedPredecessorEnvelopeSha256: loaded.envelopeSha256,
    payload: running,
    latch: context.latch,
  });
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

  const finalInspect = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  if (
    !finalInspect.ok ||
    finalInspect.record.status !== "RUNNING" ||
    finalInspect.record.acknowledgement === null ||
    finalInspect.record.acknowledgement.acknowledgedHaltId !== acknowledgement.acknowledgedHaltId ||
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
  const orders = await context.transport.listOpenOrders();
  const ownedRiskIncreasing = orders.filter(
    (order) => order.ownership === "OWNED" && order.riskIncreasing,
  );
  if (orders.some((order) => order.ownership === "UNOWNED")) {
    trace.reasonCodes.push("UNOWNED_CANCEL_REFUSED");
  }
  if (orders.some((order) => order.ownership === "AMBIGUOUS")) {
    trace.reasonCodes.push("AMBIGUOUS_ORDERS_PRESENT");
  }

  for (const order of ownedRiskIncreasing) {
    const lease = await proveLease(context);
    if (!lease.ok) {
      trace.reasonCodes.push("LEASE_UNCERTAIN", "CANCEL_FAILED");
      trace.cancelFailed = true;
      break;
    }
    const fenced = await runLeaseFencedMutation({
      directory: context.directory,
      scopeKey: context.scopeKey,
      authority: context.leaseAuthority,
      latch: context.latch,
      clock: context.leaseClock,
      mutation: () => context.transport.cancel(order.exchangeOrderId),
    });
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
  const flatten = await runLeaseFencedMutation({
    directory: context.directory,
    scopeKey: context.scopeKey,
    authority: context.leaseAuthority,
    latch: context.latch,
    clock: context.leaseClock,
    mutation: () => context.transport.flatten(),
  });
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
  const snapshotFence = await runLeaseFencedMutation({
    directory: context.directory,
    scopeKey: context.scopeKey,
    authority: context.leaseAuthority,
    latch: context.latch,
    clock: context.leaseClock,
    mutation: () => context.transport.freshSnapshot(),
  });
  if (snapshotFence.outcome !== "SENT" || snapshotFence.value === null) {
    trace.reasonCodes.push("STALE_SNAPSHOT", "SNAPSHOT_NOT_AUTHORITATIVE");
    return trace;
  }
  const snapshot = snapshotFence.value;
  trace.snapshotFresh = snapshot.fresh;
  trace.snapshotObservedAt = snapshot.observedAt;
  if (!snapshot.fresh) {
    trace.reasonCodes.push("STALE_SNAPSHOT");
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
    snapshot.fresh &&
    snapshot.authoritative &&
    snapshot.leaseGeneration === context.leaseAuthority.generation &&
    positionFlat
  ) {
    trace.flatnessProven = true;
  }
  return trace;
}

function decideTerminalStatus(trace: MutationTrace): HaltStatus {
  if (trace.cancelUnknown || trace.flattenUnknown) {
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

function evaluateSafeResumeGates(args: {
  record: DurableHaltRecord;
  resumeEvidence: HaltResumeEvidence;
  riskDecision: RiskDecision;
  expectedLeaseGeneration: string;
}): { ok: true } | { ok: false; reasonCodes: string[] } {
  const codes: string[] = [];
  if (args.record.unresolvedPossibleExposure) {
    codes.push("UNRESOLVED_UNKNOWN");
  }
  if (!args.resumeEvidence.snapshotFresh) {
    codes.push("STALE_SNAPSHOT");
  }
  if (!args.resumeEvidence.snapshotAuthoritative) {
    codes.push("SNAPSHOT_NOT_AUTHORITATIVE");
  }
  if (args.resumeEvidence.snapshotLeaseGeneration !== args.expectedLeaseGeneration) {
    codes.push("SNAPSHOT_LEASE_MISMATCH");
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
  return codes.length === 0 ? { ok: true } : { ok: false, reasonCodes: codes };
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
