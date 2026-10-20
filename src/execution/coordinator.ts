import type { Ownership } from "../domain/enums.js";
import type {
  AnchorEpoch,
  ClientOrderId,
  ExchangeOrderId,
  ExecutionId,
  ExperimentId,
  IntentId,
  MarketId,
  RunId,
  ScopeKey,
  VenueId,
} from "../domain/ids.js";
import { isEngineClientOrderId, parseScopeKey } from "../domain/ids.js";
import {
  type DuplicateCleanupPlan,
  type OrderAuthorityLink,
  type OwnershipEvidence,
  classifyOwnership,
  planOwnedDuplicateCleanup,
} from "../domain/ownership.js";
import type {
  CancelAck,
  CancelRequest,
  ExchangeOrderObservation,
  ExecutionObservation,
  OrderAck,
  OrderIntent,
  VenueWriteResult,
} from "../domain/types.js";
import { decimalAdd, decimalCmp, decimalSub, isCanonicalDecimalString } from "../math/decimal.js";
import { plannedExposureDecision } from "../risk/exposure.js";
import type {
  RiskProposedIntent,
  RiskUnknownReservation,
  RiskWorkingOrder,
} from "../risk/risk-types.js";
import {
  type ContinuationDecision,
  decideContinuation,
  unevaluatedContinuation,
} from "./continuation.js";
import {
  type CancelResolution,
  type IntentLink,
  type IntentRecord,
  type IntentRegistry,
  type IntentStatus,
  type RecordedExecution,
  detachPlaceIntent,
  intentFingerprint,
} from "./intent-registry.js";
import type {
  ClientOrderLookup,
  ExecutionCheckpointStore,
  ExecutionCursor,
  ExecutionPage,
  ExecutionVenuePort,
  ExposureInputSource,
  ExposureInputs,
  FenceResult,
  HaltAuthorityPort,
  IntentJournal,
  MutationFence,
  RiskInputSource,
} from "./ports.js";

export type ExecutionCoordinatorConfig = {
  experimentId: ExperimentId;
  runId: RunId;
  scopeKey: ScopeKey;
  // Maximum venue writes (places and cancels) between two startCycle calls.
  writeBudgetPerCycle: number;
};

export type ExecutionCoordinatorDeps = {
  config: ExecutionCoordinatorConfig;
  registry: IntentRegistry;
  venue: ExecutionVenuePort;
  fence: MutationFence;
  journal: IntentJournal;
  exposure: ExposureInputSource;
  checkpoints: ExecutionCheckpointStore;
  // The last durable replay cursor, or null to replay the venue's retained history.
  executionCursor: ExecutionCursor | null;
  // Account inputs and halt authority of the continuation gate.
  riskInputs: RiskInputSource;
  haltAuthority: HaltAuthorityPort;
};

export type SubmitDisposition = "REFUSED" | "ALREADY_RECORDED" | "RECORDED";

export type SubmitResult = {
  disposition: SubmitDisposition;
  record: IntentRecord | null;
  reasonCodes: string[];
};

export type ReconcileItem = {
  intentId: IntentId;
  status: IntentStatus;
  reasonCodes: string[];
};

export type ReconcileResult = {
  reasonCodes: string[];
  items: ReconcileItem[];
};

export type BatchItem = {
  intentId: IntentId;
  status: IntentStatus;
  reasonCodes: string[];
};

export type BatchResult = {
  disposition: "REFUSED" | "SUBMITTED";
  reasonCodes: string[];
  items: BatchItem[];
};

export type OpenOrderClassification = {
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  ownership: Ownership;
  intentId: IntentId | null;
};

export type OpenOrderScan = {
  reasonCodes: string[];
  orders: OpenOrderClassification[];
  duplicates: DuplicateCleanupPlan[];
};

export type CleanupCancel = {
  intentId: IntentId;
  exchangeOrderId: ExchangeOrderId;
  status: IntentStatus;
  reasonCodes: string[];
};

export type DuplicateCleanupResult = {
  scan: OpenOrderScan;
  cancels: CleanupCancel[];
  reasonCodes: string[];
};

export type ExposureReservation = {
  ownedActiveOrders: RiskWorkingOrder[];
  unknownReservations: RiskUnknownReservation[];
};

// reasonCodes are the execution blockers left after the operation; recorded lists the
// execution IDs it newly recorded.
export type ExecutionReplayResult = {
  reasonCodes: string[];
  recorded: ExecutionId[];
};

// Venue adapters must normalize a duplicate-client-order-ID rejection to this code. It proves
// an order with this intent's client ID already exists, so it is never a plain rejection.
export const DUPLICATE_CLIENT_ORDER_ID_CODE = "DUPLICATE_CLIENT_ORDER_ID";

const RISK_REDUCING_PURPOSES = new Set<string>([
  "GRID_EXIT",
  "RISK_REDUCTION",
  "EMERGENCY_FLATTEN",
]);
// Records whose linked order may still be working at the venue.
const WORKING_STATUSES = new Set<IntentStatus>(["LINKED", "CANCEL_PREPARED", "CANCEL_UNVERIFIED"]);
// Records whose send may have reached the venue without a linked order.
const POSSIBLY_LIVE_STATUSES = new Set<IntentStatus>(["PREPARED", "UNKNOWN"]);
// Pages one replay may read before it stops with risk increase still blocked.
const MAX_REPLAY_PAGES = 100;
const STREAM_SEQUENCE_PATTERN = /^(0|[1-9][0-9]*)$/;

type LookupDecision =
  | { kind: "UNRESOLVED"; reasonCode: string }
  | { kind: "LINK"; link: IntentLink }
  | { kind: "RESOLVE_CANCEL"; resolution: CancelResolution };

type ExecutionFacts = Pick<RecordedExecution, "exchangeOrderId" | "quantity" | "price">;

type ExecutionPlan = {
  problem: string | null;
  additions: Map<IntentId, RecordedExecution[]>;
};

// A place the fenced callback withheld without calling the venue, because authority to
// increase risk was revoked after admission. Module-private, so no venue result can be one.
class WithheldPlace {
  readonly reasonCodes: string[];

  constructor(reasonCodes: string[]) {
    this.reasonCodes = reasonCodes;
  }
}

// Owns intent identity, place/cancel outcomes and execution replay for one experiment scope.
// One operation runs at a time; any unresolved intent, journal failure, open-order scan
// blocker or execution blocker blocks risk increase. A new coordinator starts with its open
// orders and execution history unproven. A risk-increasing submit also needs a grant from the
// continuation gate, which any other operation revokes.
export class ExecutionCoordinator {
  private readonly config: ExecutionCoordinatorConfig;
  private readonly registry: IntentRegistry;
  private readonly venue: ExecutionVenuePort;
  private readonly fence: MutationFence;
  private readonly journal: IntentJournal;
  private readonly exposure: ExposureInputSource;
  private readonly checkpoints: ExecutionCheckpointStore;
  private readonly riskInputs: RiskInputSource;
  private readonly haltAuthority: HaltAuthorityPort;
  private cursor: ExecutionCursor | null;
  private busy = false;
  private journalFailed = false;
  // Cleared only by a scan that proves every open order owned and unduplicated.
  private openOrderBlockers: string[] = ["OPEN_ORDER_SCAN_REQUIRED"];
  // Cleared only by a replay that reaches the venue's current end.
  private executionBlockers = new Set<string>(["EXECUTION_REPLAY_INCOMPLETE"]);
  private lastStreamSequence: bigint | null = null;
  private writesThisCycle = 0;
  // Set only by a continuation gate that allowed risk increase; used up by the next operation.
  private continuationGranted = false;

  constructor(deps: ExecutionCoordinatorDeps) {
    const budget = deps.config.writeBudgetPerCycle;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new Error("INVALID_WRITE_BUDGET");
    }
    const cursor = deps.executionCursor;
    if (cursor !== null && !isValidCursor(cursor, deps.config.scopeKey)) {
      throw new Error("INVALID_EXECUTION_CURSOR");
    }
    this.config = { ...deps.config };
    this.registry = deps.registry;
    this.venue = deps.venue;
    this.fence = deps.fence;
    this.journal = deps.journal;
    this.exposure = deps.exposure;
    this.checkpoints = deps.checkpoints;
    this.riskInputs = deps.riskInputs;
    this.haltAuthority = deps.haltAuthority;
    this.cursor = cursor === null ? null : copyCursor(cursor);
  }

  // Whether this coordinator's own state blocks nothing. A risk-increasing submit also needs a
  // continuation grant.
  canIncreaseRisk(): boolean {
    return this.riskIncreaseBlockers().length === 0;
  }

  // Every reason this coordinator's own state blocks risk increase, sorted; empty only when
  // nothing blocks. The continuation grant is not one of them.
  riskIncreaseBlockers(): string[] {
    const blockers = new Set<string>([...this.openOrderBlockers, ...this.executionBlockers]);
    if (this.journalFailed) {
      blockers.add("JOURNAL_LATCHED");
    }
    if (this.registry.unresolved().length > 0) {
      blockers.add("UNRESOLVED_INTENT");
    }
    return [...blockers].sort(compareStrings);
  }

  // The cursor of the last replay page whose executions and checkpoint are durable.
  executionCursor(): ExecutionCursor | null {
    return this.cursor === null ? null : copyCursor(this.cursor);
  }

  executionBlockerCodes(): string[] {
    return [...this.executionBlockers].sort(compareStrings);
  }

  // Starts a new write-budget cycle and revokes any continuation grant. Refused while an
  // operation is in flight.
  startCycle(): boolean {
    if (this.busy) {
      return false;
    }
    this.continuationGranted = false;
    this.writesThisCycle = 0;
    return true;
  }

  isJournalLatched(): boolean {
    return this.journalFailed;
  }

  // A risk-increasing intent is admitted only under a continuation grant. Whatever happens,
  // the call uses the grant up.
  async submit(intent: OrderIntent): Promise<SubmitResult> {
    if (this.busy) {
      return refused("COORDINATOR_BUSY");
    }
    this.busy = true;
    try {
      return await this.submitExclusive(intent);
    } finally {
      this.continuationGranted = false;
      this.busy = false;
    }
  }

  // Cancels one linked order recorded by this coordinator. A sent or possibly sent cancel is
  // never assumed to have worked; it stays unresolved until fresh venue evidence.
  async cancel(intentId: IntentId): Promise<SubmitResult> {
    if (this.busy) {
      return refused("COORDINATOR_BUSY");
    }
    this.busy = true;
    this.continuationGranted = false;
    try {
      return await this.cancelExclusive(intentId);
    } finally {
      this.busy = false;
    }
  }

  async reconcileUnresolved(): Promise<ReconcileResult> {
    if (this.busy) {
      return { reasonCodes: ["COORDINATOR_BUSY"], items: [] };
    }
    this.busy = true;
    this.continuationGranted = false;
    try {
      return await this.reconcileExclusive();
    } finally {
      this.busy = false;
    }
  }

  // Checks every intent and the whole batch's exposure before the first send. Sends then run
  // in order; after one is not sent, the rest are neither attempted nor recorded. One
  // continuation grant covers the whole batch and is used up by it.
  async submitBatch(intents: readonly OrderIntent[]): Promise<BatchResult> {
    if (this.busy) {
      return batchRefused(["COORDINATOR_BUSY"]);
    }
    this.busy = true;
    try {
      return await this.submitBatchExclusive(intents);
    } finally {
      this.continuationGranted = false;
      this.busy = false;
    }
  }

  // Classifies every open order of the market from a fresh snapshot. Any order that is not
  // provably owned, and any owned duplicate, blocks risk increase until a later clean scan.
  async scanOpenOrders(anchorEpoch: AnchorEpoch): Promise<OpenOrderScan> {
    if (this.busy) {
      return { reasonCodes: ["COORDINATOR_BUSY"], orders: [], duplicates: [] };
    }
    this.busy = true;
    this.continuationGranted = false;
    try {
      return await this.scanExclusive(anchorEpoch);
    } finally {
      this.busy = false;
    }
  }

  // Cancels owned duplicates found by a fresh scan, keeping each slot's survivor. Unowned and
  // ambiguous orders are never candidates. A cancelled duplicate stays reserved and unresolved
  // until reconciliation proves it closed.
  async cleanupOwnedDuplicates(anchorEpoch: AnchorEpoch): Promise<DuplicateCleanupResult> {
    if (this.busy) {
      return {
        scan: { reasonCodes: ["COORDINATOR_BUSY"], orders: [], duplicates: [] },
        cancels: [],
        reasonCodes: ["COORDINATOR_BUSY"],
      };
    }
    this.busy = true;
    this.continuationGranted = false;
    try {
      return await this.cleanupExclusive(anchorEpoch);
    } finally {
      this.busy = false;
    }
  }

  // Reads execution history from the durable cursor to the venue's current end and records
  // every new execution of a linked order. Pages may overlap; an execution already recorded
  // with the same facts is skipped. Risk increase stays blocked until a replay reaches the
  // end with every execution attributed and durable.
  async replayExecutions(): Promise<ExecutionReplayResult> {
    if (this.busy) {
      return { reasonCodes: ["COORDINATOR_BUSY"], recorded: [] };
    }
    this.busy = true;
    this.continuationGranted = false;
    try {
      return await this.replayExclusive();
    } finally {
      this.busy = false;
    }
  }

  // Records one execution pushed by the venue stream. The stream is never trusted to be
  // complete: a gap, an unusable sequence, a dropped event or any execution problem blocks
  // risk increase until a later replay completes. It never moves the replay cursor.
  async ingestStreamExecution(execution: ExecutionObservation): Promise<ExecutionReplayResult> {
    this.continuationGranted = false;
    const reasonCodes: string[] = [];
    const sequenceProblem = this.observeStreamSequence(execution);
    if (sequenceProblem !== null) {
      this.executionBlockers.add(sequenceProblem);
      reasonCodes.push(sequenceProblem);
    }
    if (this.busy || this.journalFailed) {
      this.executionBlockers.add("EXECUTION_STREAM_EVENT_DROPPED");
      reasonCodes.push(
        "EXECUTION_STREAM_EVENT_DROPPED",
        this.busy ? "COORDINATOR_BUSY" : "JOURNAL_LATCHED",
      );
      return { reasonCodes, recorded: [] };
    }
    this.busy = true;
    try {
      return await this.ingestExclusive(execution, reasonCodes);
    } finally {
      this.busy = false;
    }
  }

  // Reports every connection of the execution stream, including the first. Events missed
  // while disconnected are unknown, so risk increase stays blocked until a replay started
  // after this call completes. A reconnect never authorizes anything by itself.
  executionStreamReconnected(): void {
    this.continuationGranted = false;
    this.lastStreamSequence = null;
    this.executionBlockers.add("EXECUTION_STREAM_RECONNECTED");
  }

  // The continuation gate. Reconciles unresolved intents, scans open orders and replays
  // executions, then evaluates the frozen risk rules on fresh account inputs with this
  // coordinator's own working orders and reservations, and inspects the durable halt
  // authority. Only CONTINUE, with no blocker left and a RUNNING halt record that allows risk
  // increase, grants the next operation; anything else leaves risk increase denied. The gate
  // never sends, cancels or reduces anything itself.
  async evaluateContinuation(anchorEpoch: AnchorEpoch): Promise<ContinuationDecision> {
    if (this.busy) {
      return unevaluatedContinuation(["COORDINATOR_BUSY"]);
    }
    this.busy = true;
    this.continuationGranted = false;
    try {
      const decision = await this.continuationExclusive(anchorEpoch);
      this.continuationGranted = decision.allowRiskIncrease;
      return decision;
    } finally {
      this.busy = false;
    }
  }

  // Exposure this coordinator's records still reserve: every risk-increasing order that may
  // still work at the venue. A cancel is never assumed to have worked before it is resolved.
  exposureReservation(): ExposureReservation {
    const ownedActiveOrders: RiskWorkingOrder[] = [];
    const unknownReservations: RiskUnknownReservation[] = [];
    for (const record of this.registry.list()) {
      const intent = record.intent;
      // Reduce-only exits cannot add exposure, as in computeExposure.
      if (!isRiskIncreasing(intent)) {
        continue;
      }
      if (WORKING_STATUSES.has(record.status)) {
        const remaining = decimalSub(intent.quantity, record.executedQuantity);
        if (intent.price === null) {
          unknownReservations.push({ side: intent.side, price: null, quantity: remaining });
        } else {
          ownedActiveOrders.push({
            side: intent.side,
            price: intent.price,
            remainingQuantity: remaining,
            reduceOnly: false,
            owned: true,
          });
        }
      } else if (POSSIBLY_LIVE_STATUSES.has(record.status)) {
        unknownReservations.push({
          side: intent.side,
          price: intent.price,
          quantity: intent.quantity,
        });
      }
    }
    return { ownedActiveOrders, unknownReservations };
  }

  private async continuationExclusive(anchorEpoch: AnchorEpoch): Promise<ContinuationDecision> {
    await this.reconcileExclusive();
    await this.scanExclusive(anchorEpoch);
    await this.replayExclusive();
    const reservation = this.exposureReservation();
    let riskInputs: unknown = null;
    try {
      riskInputs = await this.riskInputs.read();
    } catch {
      riskInputs = null;
    }
    let haltView: unknown = null;
    try {
      haltView = await this.haltAuthority.inspect();
    } catch {
      haltView = null;
    }
    // Blockers raised while the reads above were pending count too.
    return decideContinuation({
      riskInputs,
      haltView,
      reservation,
      blockers: this.riskIncreaseBlockers(),
    });
  }

  private async submitExclusive(input: OrderIntent): Promise<SubmitResult> {
    if (this.journalFailed) {
      return refused("JOURNAL_LATCHED");
    }
    // Only this snapshot is read from here on; the caller's object is never consulted again,
    // so every check, the record and the send describe the same request.
    const intent = detachPlaceIntent(input);
    if (typeof intent === "string") {
      return refused(intent);
    }
    const existing = this.registry.get(intent.intentId);
    if (existing !== null) {
      if (existing.requestFingerprint !== intentFingerprint(intent)) {
        return refused("INTENT_CONTENT_CONFLICT");
      }
      return {
        disposition: "ALREADY_RECORDED",
        record: existing,
        reasonCodes: ["INTENT_ALREADY_RECORDED"],
      };
    }
    const admission = this.admissionProblem(intent);
    if (admission !== null) {
      return refused(admission);
    }
    if (!this.budgetAllows(1)) {
      return refused("WRITE_BUDGET_EXHAUSTED");
    }
    const denied = await this.exposureProblem([intent]);
    if (denied !== null) {
      return { disposition: "REFUSED", record: null, reasonCodes: denied };
    }
    const sent = await this.sendPlace(intent);
    return { disposition: "RECORDED", ...sent };
  }

  private async submitBatchExclusive(input: readonly OrderIntent[]): Promise<BatchResult> {
    if (this.journalFailed) {
      return batchRefused(["JOURNAL_LATCHED"]);
    }
    if (!Array.isArray(input) || input.length === 0) {
      return batchRefused(["EMPTY_BATCH"]);
    }
    // The batch is this array of detached snapshots; neither the caller's array nor its
    // intents are consulted again.
    const intents: OrderIntent[] = [];
    const identities = new Set<string>();
    const slots = new Set<string>();
    for (const element of input) {
      const intent = detachPlaceIntent(element);
      if (typeof intent === "string") {
        return batchRefused([intent]);
      }
      const problem =
        this.registry.get(intent.intentId) !== null
          ? "INTENT_ALREADY_RECORDED"
          : this.admissionProblem(intent);
      if (problem !== null) {
        return batchRefused([problem]);
      }
      const clientOrderId = intent.clientOrderId as ClientOrderId;
      if (identities.has(intent.intentId) || identities.has(clientOrderId)) {
        return batchRefused(["BATCH_IDENTITY_CONFLICT"]);
      }
      // One intent per slot, as admission enforces against unresolved records.
      if (slots.has(slotKey(intent))) {
        return batchRefused(["BATCH_SLOT_CONFLICT"]);
      }
      identities.add(intent.intentId).add(clientOrderId);
      slots.add(slotKey(intent));
      intents.push(intent);
    }
    if (!this.budgetAllows(intents.length)) {
      return batchRefused(["WRITE_BUDGET_EXHAUSTED"]);
    }
    const denied = await this.exposureProblem(intents);
    if (denied !== null) {
      return batchRefused(denied);
    }

    const items: BatchItem[] = [];
    let stoppedBy: string | null = null;
    for (const intent of intents) {
      stoppedBy ??= this.journalFailed ? "JOURNAL_LATCHED" : this.admissionProblem(intent);
      if (stoppedBy !== null) {
        items.push({
          intentId: intent.intentId,
          status: "NOT_SENT",
          reasonCodes: ["BATCH_STOPPED_BEFORE_SEND", stoppedBy],
        });
        continue;
      }
      const { record, reasonCodes } = await this.sendPlace(intent);
      items.push({ intentId: intent.intentId, status: record.status, reasonCodes });
      if (record.status === "NOT_SENT") {
        stoppedBy = "PRIOR_MUTATION_NOT_SENT";
      }
    }
    return {
      disposition: "SUBMITTED",
      reasonCodes: stoppedBy === null ? [] : ["BATCH_INCOMPLETE"],
      items,
    };
  }

  // Writes the intent ahead, then sends it through the fence. Callers have already admitted
  // the intent and gated its exposure and write budget.
  private async sendPlace(
    intent: OrderIntent,
  ): Promise<{ record: IntentRecord; reasonCodes: string[] }> {
    this.registry.prepare(intent);
    if (!(await this.persist())) {
      const record = this.registry.markNotSent(intent.intentId, ["JOURNAL_WRITE_FAILED"]);
      return { record, reasonCodes: ["JOURNAL_WRITE_FAILED"] };
    }

    this.writesThisCycle += 1;
    // Authority to increase risk may be revoked while this send waits on exposure, the journal
    // or the fence, so the callback checks it again immediately before transmission.
    const fenced = await this.fence.run(
      async (): Promise<VenueWriteResult<OrderAck> | WithheldPlace> => {
        const revoked = this.revokedRiskIncrease(intent);
        if (revoked !== null) {
          return new WithheldPlace(revoked);
        }
        return this.venue.placeOrder(structuredClone(intent));
      },
    );
    const reasonCodes = this.applyPlaceOutcome(intent, fenced);
    if (!(await this.persist())) {
      reasonCodes.push("JOURNAL_WRITE_FAILED");
    }
    return { record: this.registry.get(intent.intentId) as IntentRecord, reasonCodes };
  }

  // Gates risk-increasing intents before any send: the position, every owned working order,
  // every possibly-live submission and all intents together, without netting.
  private async exposureProblem(intents: readonly OrderIntent[]): Promise<string[] | null> {
    if (!intents.some(isRiskIncreasing)) {
      return null;
    }
    let inputs: ExposureInputs;
    try {
      inputs = await this.exposure.read();
    } catch {
      return ["PLANNED_EXPOSURE_DENIED", "EXPOSURE_INPUT_UNAVAILABLE"];
    }
    if (typeof inputs !== "object" || inputs === null) {
      return ["PLANNED_EXPOSURE_DENIED", "EXPOSURE_INPUT_UNAVAILABLE"];
    }
    const decision = plannedExposureDecision({
      signedPosition: inputs.signedPosition,
      markOrMidPrice: inputs.markOrMidPrice,
      ...this.exposureReservation(),
      proposedBatch: intents.map(toProposedIntent),
    });
    return decision.allowed ? null : ["PLANNED_EXPOSURE_DENIED", ...decision.reasonCodes];
  }

  private budgetAllows(writes: number): boolean {
    return this.writesThisCycle + writes <= this.config.writeBudgetPerCycle;
  }

  private admissionProblem(intent: OrderIntent): string | null {
    if (!this.inScope(intent)) {
      return "INTENT_SCOPE_MISMATCH";
    }
    if (intent.leaseGeneration !== this.fence.leaseGeneration) {
      return "INTENT_LEASE_GENERATION_MISMATCH";
    }
    if (this.registry.intentIdForClientOrderId(intent.clientOrderId as ClientOrderId) !== null) {
      return "CLIENT_ORDER_ID_COLLISION";
    }
    const unresolved = this.registry.unresolved();
    if (unresolved.some((record) => slotKey(record.intent) === slotKey(intent))) {
      return "UNRESOLVED_INTENT_FOR_SLOT";
    }
    if (unresolved.length > 0 && isRiskIncreasing(intent)) {
      return "UNRESOLVED_INTENT_BLOCKS_RISK_INCREASE";
    }
    if (this.openOrderBlockers.length > 0 && isRiskIncreasing(intent)) {
      return "OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE";
    }
    if (this.executionBlockers.size > 0 && isRiskIncreasing(intent)) {
      return "EXECUTION_REPLAY_BLOCKS_RISK_INCREASE";
    }
    if (!this.continuationGranted && isRiskIncreasing(intent)) {
      return "CONTINUATION_NOT_GRANTED";
    }
    return null;
  }

  // Why an admitted risk-increasing place may no longer be sent, or null. A stream reconnect
  // or event can arrive during any wait after admission; it revokes the continuation grant and
  // leaves an execution blocker. Reduce-only exits never needed that authority.
  private revokedRiskIncrease(intent: OrderIntent): string[] | null {
    if (
      !isRiskIncreasing(intent) ||
      (this.continuationGranted && this.executionBlockers.size === 0)
    ) {
      return null;
    }
    return ["RISK_INCREASE_REVOKED_BEFORE_SEND", ...this.executionBlockerCodes()];
  }

  private applyPlaceOutcome(
    intent: OrderIntent,
    fenced: FenceResult<VenueWriteResult<OrderAck> | WithheldPlace>,
  ): string[] {
    const intentId = intent.intentId;
    if (fenced.outcome === "NOT_SENT") {
      return this.registry.markNotSent(intentId, ["FENCE_NOT_SENT", ...fenced.reasonCodes])
        .reasonCodes;
    }
    const result = fenced.value;
    if (fenced.outcome !== "SENT" || result === null) {
      // A thrown or unproven send is never a rejection.
      return this.registry.markUnknown(intentId, [
        "TRANSPORT_OUTCOME_UNKNOWN",
        ...fenced.reasonCodes,
      ]).reasonCodes;
    }
    if (result instanceof WithheldPlace) {
      return this.registry.markNotSent(intentId, result.reasonCodes).reasonCodes;
    }
    switch (result.kind) {
      case "ACK":
        return this.linkAck(intent, result.ack);
      case "REJECTED":
        if (result.code === DUPLICATE_CLIENT_ORDER_ID_CODE) {
          return this.registry.markUnknown(intentId, ["DUPLICATE_CLIENT_ORDER_ID_REJECTION"])
            .reasonCodes;
        }
        return this.registry.markRejected(intentId, ["VENUE_REJECTED"]).reasonCodes;
      case "UNKNOWN":
        return this.registry.markUnknown(intentId, ["VENUE_OUTCOME_UNKNOWN"]).reasonCodes;
      case "NOT_SENT":
        return this.registry.markNotSent(intentId, ["VENUE_NOT_SENT"]).reasonCodes;
      default:
        return this.registry.markUnknown(intentId, ["UNRECOGNIZED_VENUE_RESULT"]).reasonCodes;
    }
  }

  private linkAck(intent: OrderIntent, ack: OrderAck): string[] {
    const intentId = intent.intentId;
    if (
      typeof ack !== "object" ||
      ack === null ||
      ack.intentId !== intentId ||
      ack.clientOrderId !== intent.clientOrderId ||
      typeof ack.exchangeOrderId !== "string" ||
      ack.exchangeOrderId.length === 0
    ) {
      return this.registry.markUnknown(intentId, ["ACK_IDENTITY_MISMATCH"]).reasonCodes;
    }
    if (this.registry.intentIdForExchangeOrderId(ack.exchangeOrderId) !== null) {
      return this.registry.markUnknown(intentId, ["EXCHANGE_ORDER_ID_COLLISION"]).reasonCodes;
    }
    return this.registry.link(intentId, {
      exchangeOrderId: ack.exchangeOrderId,
      authority: { source: "ACK", evidenceId: `ack:${ack.exchangeOrderId}` },
      executions: [],
      reasonCodes: ["VENUE_ACK"],
    }).reasonCodes;
  }

  private async cancelExclusive(intentId: IntentId): Promise<SubmitResult> {
    if (this.journalFailed) {
      return refused("JOURNAL_LATCHED");
    }
    const record = this.registry.get(intentId);
    if (record === null) {
      return refused("INTENT_NOT_REGISTERED");
    }
    const problem = this.cancelProblem(record);
    if (problem !== null || record.exchangeOrderId === null) {
      return refused(problem ?? "CANCEL_REQUIRES_LINKED_ORDER");
    }
    if (!this.budgetAllows(1)) {
      return refused("WRITE_BUDGET_EXHAUSTED");
    }

    this.registry.markCancelPrepared(intentId, []);
    if (!(await this.persist())) {
      const reverted = this.revertCancel(record, ["JOURNAL_WRITE_FAILED"]);
      return { disposition: "RECORDED", record: reverted, reasonCodes: ["JOURNAL_WRITE_FAILED"] };
    }

    const request: CancelRequest = {
      scopeKey: record.intent.scopeKey,
      exchangeOrderId: record.exchangeOrderId,
      clientOrderId: record.intent.clientOrderId,
    };
    this.writesThisCycle += 1;
    const fenced = await this.fence.run(() => this.venue.cancelOrder(structuredClone(request)));
    const reasonCodes = this.applyCancelOutcome(record, fenced);
    if (!(await this.persist())) {
      reasonCodes.push("JOURNAL_WRITE_FAILED");
    }
    return { disposition: "RECORDED", record: this.registry.get(intentId), reasonCodes };
  }

  // Only a linked, not fully executed order of this scope is provably owned and cancellable.
  private cancelProblem(record: IntentRecord): string | null {
    if (!this.inScope(record.intent)) {
      return "INTENT_SCOPE_MISMATCH";
    }
    switch (record.status) {
      case "LINKED":
        return decimalCmp(record.executedQuantity, record.intent.quantity) < 0
          ? null
          : "ORDER_FULLY_EXECUTED";
      case "CANCEL_PREPARED":
      case "CANCEL_UNVERIFIED":
        return "CANCEL_UNRESOLVED";
      case "CANCELLED":
      case "FILLED":
        return "ORDER_ALREADY_CLOSED";
      default:
        return "CANCEL_REQUIRES_LINKED_ORDER";
    }
  }

  // A cancel ACK proves at most that the request was accepted (VENUE_ADAPTER_CONTRACT §9.1),
  // and a rejection may mean the order already closed. Only a proven non-send restores LINKED.
  private applyCancelOutcome(
    record: IntentRecord,
    fenced: FenceResult<VenueWriteResult<CancelAck>>,
  ): string[] {
    const intentId = record.intent.intentId;
    if (fenced.outcome === "NOT_SENT") {
      return this.revertCancel(record, ["FENCE_NOT_SENT", ...fenced.reasonCodes]).reasonCodes;
    }
    const result = fenced.value;
    if (fenced.outcome !== "SENT" || result === null) {
      return this.registry.markCancelUnverified(intentId, [
        "TRANSPORT_OUTCOME_UNKNOWN",
        ...fenced.reasonCodes,
      ]).reasonCodes;
    }
    switch (result.kind) {
      case "ACK":
        return this.registry.markCancelUnverified(intentId, [
          cancelAckMatches(record, result.ack) ? "CANCEL_ACK" : "ACK_IDENTITY_MISMATCH",
        ]).reasonCodes;
      case "REJECTED":
        return this.registry.markCancelUnverified(intentId, ["CANCEL_REJECTED"]).reasonCodes;
      case "UNKNOWN":
        return this.registry.markCancelUnverified(intentId, ["VENUE_OUTCOME_UNKNOWN"]).reasonCodes;
      case "NOT_SENT":
        return this.revertCancel(record, ["VENUE_NOT_SENT"]).reasonCodes;
      default:
        return this.registry.markCancelUnverified(intentId, ["UNRECOGNIZED_VENUE_RESULT"])
          .reasonCodes;
    }
  }

  // Restores the pre-cancel LINKED record when the cancel provably never left this process.
  private revertCancel(record: IntentRecord, reasonCodes: string[]): IntentRecord {
    return this.registry.resolveCancel(record.intent.intentId, {
      status: "LINKED",
      executions: record.executions,
      reasonCodes,
    });
  }

  private inScope(intent: OrderIntent): boolean {
    return (
      intent.experimentId === this.config.experimentId &&
      intent.runId === this.config.runId &&
      intent.scopeKey === this.config.scopeKey
    );
  }

  // Resolves unresolved place and cancel intents only from venue evidence for their client
  // order ID. Absence of evidence never proves an order was not sent, cancelled or filled.
  private async reconcileExclusive(): Promise<ReconcileResult> {
    if (this.journalFailed) {
      return { reasonCodes: ["JOURNAL_LATCHED"], items: [] };
    }
    const items: ReconcileItem[] = [];
    let changed = false;
    for (const record of this.registry.unresolved()) {
      const intent = record.intent;
      let lookup: ClientOrderLookup;
      try {
        lookup = await this.venue.lookupClientOrder(intent.clientOrderId as ClientOrderId);
      } catch {
        items.push({
          intentId: intent.intentId,
          status: record.status,
          reasonCodes: ["LOOKUP_FAILED"],
        });
        continue;
      }
      const decision =
        record.exchangeOrderId === null
          ? evaluateLookup(intent, lookup, this.registry)
          : evaluateCancelLookup(record, lookup, this.registry);
      if (decision.kind === "UNRESOLVED") {
        items.push({
          intentId: intent.intentId,
          status: record.status,
          reasonCodes: [decision.reasonCode],
        });
        continue;
      }
      const next =
        decision.kind === "LINK"
          ? this.registry.link(intent.intentId, decision.link)
          : this.registry.resolveCancel(intent.intentId, decision.resolution);
      changed = true;
      items.push({
        intentId: intent.intentId,
        status: next.status,
        reasonCodes: next.reasonCodes,
      });
    }
    const reasonCodes: string[] = [];
    if (changed && !(await this.persist())) {
      reasonCodes.push("JOURNAL_WRITE_FAILED");
    }
    return { reasonCodes, items };
  }

  private async scanExclusive(anchorEpoch: AnchorEpoch): Promise<OpenOrderScan> {
    // Until this scan completes, an unexpected throw leaves risk increase blocked.
    this.openOrderBlockers = ["OPEN_ORDER_SCAN_FAILED"];
    let snapshot: ExchangeOrderObservation[];
    try {
      snapshot = await this.venue.listOpenOrders();
    } catch {
      return this.failedScan("OPEN_ORDER_SCAN_FAILED");
    }
    if (!this.validSnapshot(snapshot)) {
      return this.failedScan("OPEN_ORDER_OBSERVATION_INVALID");
    }
    const records = new Map(this.registry.list().map((record) => [record.intent.intentId, record]));
    const evidence = this.ownershipEvidence([...records.values()], anchorEpoch);
    const orders = snapshot
      .map((order) => this.classifyOpenOrder(order, evidence, records))
      .sort((left, right) => compareStrings(left.exchangeOrderId, right.exchangeOrderId));
    const duplicates = ownedDuplicates(orders, records);

    const blockers = new Set<string>();
    for (const order of orders) {
      if (order.ownership !== "OWNED") {
        blockers.add(`${order.ownership}_OPEN_ORDER`);
      }
    }
    if (duplicates.length > 0) {
      blockers.add("OWNED_DUPLICATE_OPEN_ORDER");
    }
    this.openOrderBlockers = [...blockers].sort(compareStrings);
    return { reasonCodes: [...this.openOrderBlockers], orders, duplicates };
  }

  private failedScan(reasonCode: string): OpenOrderScan {
    this.openOrderBlockers = [reasonCode];
    return { reasonCodes: [reasonCode], orders: [], duplicates: [] };
  }

  // A snapshot proves nothing unless every entry is an open order of this market with a
  // unique exchange order ID.
  private validSnapshot(snapshot: unknown): snapshot is ExchangeOrderObservation[] {
    if (!Array.isArray(snapshot)) {
      return false;
    }
    const { venue, market } = parseScopeKey(this.config.scopeKey);
    const seen = new Set<string>();
    for (const order of snapshot as unknown[]) {
      if (typeof order !== "object" || order === null) {
        return false;
      }
      const observed = order as ExchangeOrderObservation;
      if (
        observed.venue !== venue ||
        observed.market !== market ||
        !isNonEmptyString(observed.exchangeOrderId) ||
        seen.has(observed.exchangeOrderId) ||
        observed.status !== "OPEN" ||
        (observed.clientOrderId !== null && !isNonEmptyString(observed.clientOrderId))
      ) {
        return false;
      }
      seen.add(observed.exchangeOrderId);
    }
    return true;
  }

  // Authority comes only from records whose linked order may still be working; a terminal
  // record observed open again proves nothing about ownership.
  private ownershipEvidence(
    records: readonly IntentRecord[],
    anchorEpoch: AnchorEpoch,
  ): OwnershipEvidence {
    const knownClientOrderIds = new Set<ClientOrderId>();
    const knownExchangeOrderIds = new Set<ExchangeOrderId>();
    const clientOrderEpochById = new Map<ClientOrderId, AnchorEpoch>();
    const authorityLinks: OrderAuthorityLink[] = [];
    for (const record of records) {
      const intent = record.intent;
      const clientOrderId = intent.clientOrderId as ClientOrderId;
      knownClientOrderIds.add(clientOrderId);
      clientOrderEpochById.set(clientOrderId, intent.anchorEpoch);
      if (record.exchangeOrderId === null) {
        continue;
      }
      knownExchangeOrderIds.add(record.exchangeOrderId);
      if (WORKING_STATUSES.has(record.status) && record.authority !== null) {
        authorityLinks.push({
          source: record.authority.source,
          evidenceId: record.authority.evidenceId,
          exchangeOrderId: record.exchangeOrderId,
          intentId: intent.intentId,
          clientOrderId,
          scopeKey: intent.scopeKey,
          anchorEpoch: intent.anchorEpoch,
        });
      }
    }
    return {
      currentScopeKey: this.config.scopeKey,
      currentAnchorEpoch: anchorEpoch,
      knownClientOrderIds,
      knownExchangeOrderIds,
      clientOrderEpochById,
      authorityLinks,
    };
  }

  private classifyOpenOrder(
    order: ExchangeOrderObservation,
    evidence: OwnershipEvidence,
    records: ReadonlyMap<IntentId, IntentRecord>,
  ): OpenOrderClassification {
    const identity = { exchangeOrderId: order.exchangeOrderId, clientOrderId: order.clientOrderId };
    const intentId = this.registry.intentIdForExchangeOrderId(order.exchangeOrderId);
    const ownership = classifyOwnership(
      { ...identity, scopeKey: null, anchorEpoch: null },
      evidence,
    );
    if (ownership === "OWNED") {
      // Proven authority is not enough: the open order must still be the recorded one.
      const record = intentId === null ? undefined : records.get(intentId);
      const owned = record !== undefined && observedMatchesRecord(order, record);
      return { ...identity, ownership: owned ? "OWNED" : "AMBIGUOUS", intentId };
    }
    if (
      ownership === "AMBIGUOUS" &&
      intentId === null &&
      order.clientOrderId !== null &&
      !isEngineClientOrderId(order.clientOrderId)
    ) {
      // No record links it and this engine cannot have generated its client order ID.
      return { ...identity, ownership: "UNOWNED", intentId };
    }
    return { ...identity, ownership, intentId };
  }

  private async cleanupExclusive(anchorEpoch: AnchorEpoch): Promise<DuplicateCleanupResult> {
    const scan = await this.scanExclusive(anchorEpoch);
    const cancels: CleanupCancel[] = [];
    let stoppedBy: string | null = null;
    for (const exchangeOrderId of scan.duplicates.flatMap((plan) => plan.cancelExchangeOrderIds)) {
      // Only OWNED orders are planned, and OWNED implies a record linked to this order ID.
      const intentId = this.registry.intentIdForExchangeOrderId(exchangeOrderId) as IntentId;
      if (stoppedBy !== null) {
        cancels.push({
          intentId,
          exchangeOrderId,
          status: (this.registry.get(intentId) as IntentRecord).status,
          reasonCodes: ["CLEANUP_STOPPED_BEFORE_SEND", stoppedBy],
        });
        continue;
      }
      const result = await this.cancelExclusive(intentId);
      const status = (this.registry.get(intentId) as IntentRecord).status;
      cancels.push({ intentId, exchangeOrderId, status, reasonCodes: result.reasonCodes });
      if (status !== "CANCEL_UNVERIFIED") {
        stoppedBy = "PRIOR_CANCEL_NOT_SENT";
      }
    }
    return { scan, cancels, reasonCodes: stoppedBy === null ? [] : ["CLEANUP_INCOMPLETE"] };
  }

  private async replayExclusive(): Promise<ExecutionReplayResult> {
    if (this.journalFailed) {
      return { reasonCodes: ["JOURNAL_LATCHED"], recorded: [] };
    }
    // This replay re-proves or clears earlier problems; stream blockers raised while it runs
    // stay, because it may have read past their events before they were raised.
    this.executionBlockers = new Set(["EXECUTION_REPLAY_INCOMPLETE"]);
    const recorded: ExecutionId[] = [];
    for (let pages = 0; pages < MAX_REPLAY_PAGES; pages += 1) {
      let page: ExecutionPage;
      try {
        page = await this.venue.listExecutionsSince(
          this.cursor === null ? null : copyCursor(this.cursor),
        );
      } catch {
        return this.replayStopped("EXECUTION_REPLAY_READ_FAILED", recorded);
      }
      if (!this.validPage(page)) {
        return this.replayStopped("EXECUTION_PAGE_INVALID", recorded);
      }
      const plan = this.planExecutions(page.executions);
      if (plan.problem !== null) {
        return this.replayStopped(plan.problem, recorded);
      }
      const added = this.applyPlan(plan.additions);
      recorded.push(...added);
      // The checkpoint never moves past executions that are not yet durable.
      if (added.length > 0 && !(await this.persist())) {
        return this.replayStopped("JOURNAL_WRITE_FAILED", recorded);
      }
      const next = copyCursor(page.nextCursor);
      try {
        await this.checkpoints.persist(copyCursor(next));
      } catch {
        return this.replayStopped("EXECUTION_CHECKPOINT_WRITE_FAILED", recorded);
      }
      this.cursor = next;
      if (!page.hasMore) {
        this.executionBlockers.delete("EXECUTION_REPLAY_INCOMPLETE");
        return { reasonCodes: this.executionBlockerCodes(), recorded };
      }
    }
    return this.replayStopped("EXECUTION_REPLAY_PAGE_LIMIT", recorded);
  }

  private replayStopped(reasonCode: string, recorded: ExecutionId[]): ExecutionReplayResult {
    this.executionBlockers.add(reasonCode);
    return { reasonCodes: this.executionBlockerCodes(), recorded };
  }

  private async ingestExclusive(
    execution: ExecutionObservation,
    reasonCodes: string[],
  ): Promise<ExecutionReplayResult> {
    const plan = this.planExecutions([execution]);
    if (plan.problem !== null) {
      this.executionBlockers.add(plan.problem);
      return { reasonCodes: [...reasonCodes, plan.problem], recorded: [] };
    }
    const recorded = this.applyPlan(plan.additions);
    if (recorded.length > 0 && !(await this.persist())) {
      return { reasonCodes: [...reasonCodes, "JOURNAL_WRITE_FAILED"], recorded };
    }
    return { reasonCodes, recorded };
  }

  // A sequence past the next expected one is a gap. A repeated or older one may be a
  // duplicate or a late event; the execution ID checks make either harmless.
  private observeStreamSequence(execution: unknown): string | null {
    const sequence = streamSequence(execution);
    if (sequence === null) {
      return "EXECUTION_STREAM_SEQUENCE_UNUSABLE";
    }
    const last = this.lastStreamSequence;
    if (last === null || sequence > last) {
      this.lastStreamSequence = sequence;
    }
    return last !== null && sequence > last + 1n ? "EXECUTION_STREAM_GAP" : null;
  }

  private validPage(page: unknown): page is ExecutionPage {
    if (typeof page !== "object" || page === null) {
      return false;
    }
    const candidate = page as ExecutionPage;
    return (
      Array.isArray(candidate.executions) &&
      typeof candidate.hasMore === "boolean" &&
      isValidCursor(candidate.nextCursor, this.config.scopeKey)
    );
  }

  // Checks observed executions against the registry before anything is recorded. The first
  // problem wins and nothing is applied. An execution already recorded with the same facts,
  // or repeated within the batch, is skipped.
  private planExecutions(observed: readonly unknown[]): ExecutionPlan {
    const { venue, market } = parseScopeKey(this.config.scopeKey);
    const additions = new Map<IntentId, RecordedExecution[]>();
    const seen = new Map<ExecutionId, ExecutionObservation>();
    const problem = (reasonCode: string): ExecutionPlan => ({
      problem: reasonCode,
      additions: new Map(),
    });
    for (const raw of observed) {
      if (!isExecutionInMarket(raw, venue, market)) {
        return problem("EXECUTION_OBSERVATION_INVALID");
      }
      const execution = raw;
      const intentId = this.registry.intentIdForExchangeOrderId(execution.exchangeOrderId);
      if (intentId === null) {
        return problem(this.unattributedProblem(execution));
      }
      const record = this.registry.get(intentId) as IntentRecord;
      if (!executionMatchesIntent(execution, record.intent, venue, market)) {
        return problem("EXECUTION_MISMATCH");
      }
      const owner = this.registry.intentIdForExecutionId(execution.executionId);
      if (owner !== null) {
        if (owner !== intentId) {
          return problem("EXECUTION_ID_COLLISION");
        }
        const recorded = record.executions.find(
          (item) => item.executionId === execution.executionId,
        );
        if (recorded === undefined || !sameExecution(recorded, execution)) {
          return problem("EXECUTION_CONFLICT");
        }
        continue;
      }
      const earlier = seen.get(execution.executionId);
      if (earlier !== undefined) {
        if (!sameExecution(earlier, execution)) {
          return problem("EXECUTION_CONFLICT");
        }
        continue;
      }
      if (!WORKING_STATUSES.has(record.status)) {
        return problem("EXECUTION_AFTER_CLOSE");
      }
      seen.set(execution.executionId, execution);
      additions.set(intentId, [...(additions.get(intentId) ?? []), toRecorded(execution)]);
    }
    for (const [intentId, executions] of additions) {
      const record = this.registry.get(intentId) as IntentRecord;
      const executed = executions.reduce(
        (sum, execution) => decimalAdd(sum, execution.quantity),
        record.executedQuantity,
      );
      if (decimalCmp(executed, record.intent.quantity) > 0) {
        return problem("EXECUTION_OVERFILL");
      }
    }
    return { problem: null, additions };
  }

  // No record links the execution's order. It may belong to an intent whose ack was lost,
  // another runtime or a manual order; the execution alone cannot attribute it.
  private unattributedProblem(execution: ExecutionObservation): string {
    const clientOrderId = execution.clientOrderId;
    const intentId =
      clientOrderId === null ? null : this.registry.intentIdForClientOrderId(clientOrderId);
    if (intentId === null) {
      return "UNATTRIBUTED_EXECUTION";
    }
    const record = this.registry.get(intentId) as IntentRecord;
    return record.exchangeOrderId === null ? "EXECUTION_FOR_UNLINKED_INTENT" : "EXECUTION_MISMATCH";
  }

  // Applies a checked plan in intent ID order and returns the recorded execution IDs, sorted.
  private applyPlan(additions: ReadonlyMap<IntentId, RecordedExecution[]>): ExecutionId[] {
    const recorded: ExecutionId[] = [];
    for (const intentId of [...additions.keys()].sort(compareStrings)) {
      const executions = additions.get(intentId) as RecordedExecution[];
      this.registry.applyExecutions(intentId, executions);
      recorded.push(...executions.map((execution) => execution.executionId));
    }
    return recorded.sort(compareStrings);
  }

  private async persist(): Promise<boolean> {
    try {
      await this.journal.persist(this.registry.exportState());
      return true;
    } catch {
      this.journalFailed = true;
      return false;
    }
  }
}

function refused(reasonCode: string): SubmitResult {
  return { disposition: "REFUSED", record: null, reasonCodes: [reasonCode] };
}

function batchRefused(reasonCodes: string[]): BatchResult {
  return { disposition: "REFUSED", reasonCodes, items: [] };
}

// A reduce-only order with a risk-increasing purpose is still counted, so the gate never
// relies on reduce-only alone.
function toProposedIntent(intent: OrderIntent): RiskProposedIntent {
  return {
    side: intent.side,
    price: intent.price,
    quantity: intent.quantity,
    reduceOnly: !isRiskIncreasing(intent),
    purpose: intent.purpose,
  };
}

// Groups owned open orders by logical slot; a slot with more than one is a duplicate. The
// survivor rule depends only on exchange order IDs, never on snapshot order.
function ownedDuplicates(
  orders: readonly OpenOrderClassification[],
  records: ReadonlyMap<IntentId, IntentRecord>,
): DuplicateCleanupPlan[] {
  const groups = new Map<string, { intent: OrderIntent; exchangeOrderIds: ExchangeOrderId[] }>();
  for (const order of orders) {
    const record = order.intentId === null ? undefined : records.get(order.intentId);
    if (order.ownership !== "OWNED" || record === undefined) {
      continue;
    }
    const key = slotKey(record.intent);
    const group = groups.get(key) ?? { intent: record.intent, exchangeOrderIds: [] };
    group.exchangeOrderIds.push(order.exchangeOrderId);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .filter(([, group]) => group.exchangeOrderIds.length > 1)
    .map(([, group]) =>
      planOwnedDuplicateCleanup(group.exchangeOrderIds, group.intent.logicalLevelId),
    );
}

function observedMatchesRecord(order: ExchangeOrderObservation, record: IntentRecord): boolean {
  const { venue, market } = parseScopeKey(record.intent.scopeKey);
  return (
    orderMatchesIntent(order, record.intent, venue, market) &&
    order.exchangeOrderId === record.exchangeOrderId &&
    // The venue can only know more executions than recorded, never fewer.
    decimalCmp(order.executedQuantity, record.executedQuantity) >= 0
  );
}

export function isValidCursor(value: unknown, scopeKey: ScopeKey): value is ExecutionCursor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { venue, market } = parseScopeKey(scopeKey);
  const cursor = value as ExecutionCursor;
  return (
    cursor.venue === venue &&
    cursor.market === market &&
    isNonEmptyString(cursor.opaque) &&
    (cursor.lastExecutionId === null || isNonEmptyString(cursor.lastExecutionId)) &&
    (cursor.lastExecutionTime === null || isNonEmptyString(cursor.lastExecutionTime))
  );
}

function copyCursor(cursor: ExecutionCursor): ExecutionCursor {
  return {
    venue: cursor.venue,
    market: cursor.market,
    opaque: cursor.opaque,
    lastExecutionId: cursor.lastExecutionId,
    lastExecutionTime: cursor.lastExecutionTime,
  };
}

function isExecutionInMarket(
  value: unknown,
  venue: VenueId,
  market: MarketId,
): value is ExecutionObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const execution = value as ExecutionObservation;
  return (
    execution.venue === venue &&
    execution.market === market &&
    isNonEmptyString(execution.executionId) &&
    isNonEmptyString(execution.exchangeOrderId)
  );
}

function streamSequence(execution: unknown): bigint | null {
  if (typeof execution !== "object" || execution === null) {
    return null;
  }
  const meta = (execution as ExecutionObservation).meta;
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const sequence = meta.sequence;
  return typeof sequence === "string" && STREAM_SEQUENCE_PATTERN.test(sequence)
    ? BigInt(sequence)
    : null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slotKey(intent: OrderIntent): string {
  return [
    intent.scopeKey,
    intent.anchorEpoch,
    intent.logicalLevelId ?? "none",
    intent.purpose,
  ].join("|");
}

function isRiskIncreasing(intent: OrderIntent): boolean {
  return !(intent.reduceOnly && RISK_REDUCING_PURPOSES.has(intent.purpose));
}

function evaluateLookup(
  intent: OrderIntent,
  lookup: ClientOrderLookup,
  registry: IntentRegistry,
): LookupDecision {
  const { venue, market } = parseScopeKey(intent.scopeKey);
  const order = lookup.order;
  if (order !== null && !orderMatchesIntent(order, intent, venue, market)) {
    return unresolved("LOOKUP_ORDER_MISMATCH");
  }
  const unique = uniqueExecutions(intent, lookup.executions, venue, market);
  if (unique === null) {
    return unresolved("LOOKUP_EXECUTION_MISMATCH");
  }

  const exchangeOrderId = order?.exchangeOrderId ?? unique[0]?.exchangeOrderId ?? null;
  if (exchangeOrderId === null) {
    return unresolved("NO_DEFINITIVE_EVIDENCE");
  }
  if (unique.some((execution) => execution.exchangeOrderId !== exchangeOrderId)) {
    return unresolved("LOOKUP_EXECUTION_MISMATCH");
  }
  const executed = unique.reduce((sum, execution) => decimalAdd(sum, execution.quantity), "0");
  if (decimalCmp(executed, intent.quantity) > 0) {
    return unresolved("LOOKUP_OVERFILL");
  }
  if (registry.intentIdForExchangeOrderId(exchangeOrderId) !== null) {
    return unresolved("EXCHANGE_ORDER_ID_COLLISION");
  }
  if (unique.some((execution) => registry.intentIdForExecutionId(execution.executionId) !== null)) {
    return unresolved("EXECUTION_ID_COLLISION");
  }
  if (order !== null) {
    if (decimalCmp(order.executedQuantity, executed) !== 0) {
      return unresolved("EXECUTION_EVIDENCE_INCOMPLETE");
    }
  } else if (decimalCmp(executed, intent.quantity) < 0) {
    // Partial executions without the order itself cannot prove whether the rest still works.
    return unresolved("ORDER_STATE_UNPROVEN");
  }

  const evidenceId =
    order !== null ? `order:${exchangeOrderId}` : `execution:${unique[0]?.executionId ?? ""}`;
  return {
    kind: "LINK",
    link: {
      exchangeOrderId,
      authority: { source: "AUTHORITATIVE_OBSERVATION", evidenceId },
      executions: unique.map(toRecorded),
      reasonCodes: ["RECONCILED_BY_CLIENT_ORDER_ID"],
    },
  };
}

// Decides a pending cancel from a fresh lookup. Execution evidence wins over the cancel: only
// an observed order status, or executions covering the full quantity, ends it. A missing
// order is a reconciliation case, never a cancel or a fill.
function evaluateCancelLookup(
  record: IntentRecord,
  lookup: ClientOrderLookup,
  registry: IntentRegistry,
): LookupDecision {
  const intent = record.intent;
  const { venue, market } = parseScopeKey(intent.scopeKey);
  const order = lookup.order;
  if (
    order !== null &&
    (!orderMatchesIntent(order, intent, venue, market) ||
      order.exchangeOrderId !== record.exchangeOrderId)
  ) {
    return unresolved("LOOKUP_ORDER_MISMATCH");
  }
  const unique = uniqueExecutions(intent, lookup.executions, venue, market);
  if (
    unique === null ||
    unique.some((execution) => execution.exchangeOrderId !== record.exchangeOrderId)
  ) {
    return unresolved("LOOKUP_EXECUTION_MISMATCH");
  }
  const executed = unique.reduce((sum, execution) => decimalAdd(sum, execution.quantity), "0");
  const compared = decimalCmp(executed, intent.quantity);
  if (compared > 0) {
    return unresolved("LOOKUP_OVERFILL");
  }
  for (const recorded of record.executions) {
    const observed = unique.find((execution) => execution.executionId === recorded.executionId);
    if (observed === undefined) {
      return unresolved("EXECUTION_EVIDENCE_MISSING");
    }
    if (!sameExecution(observed, recorded)) {
      return unresolved("LOOKUP_EXECUTION_MISMATCH");
    }
  }
  const foreign = unique.some((execution) => {
    const owner = registry.intentIdForExecutionId(execution.executionId);
    return owner !== null && owner !== intent.intentId;
  });
  if (foreign) {
    return unresolved("EXECUTION_ID_COLLISION");
  }

  const executions = unique.map(toRecorded);
  const full = compared === 0;
  if (order === null) {
    return full
      ? resolvedCancel("FILLED", executions, "FILLED_BY_EXECUTION_EVIDENCE")
      : unresolved("ORDER_NOT_OBSERVED");
  }
  if (decimalCmp(order.executedQuantity, executed) !== 0) {
    return unresolved("EXECUTION_EVIDENCE_INCOMPLETE");
  }
  if (order.status === "FILLED" && full) {
    return resolvedCancel("FILLED", executions, "ORDER_FILLED");
  }
  if (order.status === "CANCELLED" && !full) {
    return resolvedCancel("CANCELLED", executions, "CANCEL_VERIFIED");
  }
  if (order.status === "OPEN" && !full) {
    return resolvedCancel("LINKED", executions, "ORDER_STILL_ACTIVE");
  }
  return unresolved("ORDER_STATUS_UNPROVEN");
}

function unresolved(reasonCode: string): LookupDecision {
  return { kind: "UNRESOLVED", reasonCode };
}

function resolvedCancel(
  status: CancelResolution["status"],
  executions: RecordedExecution[],
  reasonCode: string,
): LookupDecision {
  return { kind: "RESOLVE_CANCEL", resolution: { status, executions, reasonCodes: [reasonCode] } };
}

// Validates and de-duplicates execution evidence for one intent, sorted by execution ID. Null
// means an execution contradicts the intent or another report of the same execution ID.
function uniqueExecutions(
  intent: OrderIntent,
  observed: readonly ExecutionObservation[],
  venue: VenueId,
  market: MarketId,
): ExecutionObservation[] | null {
  const executions = new Map<string, ExecutionObservation>();
  for (const execution of observed) {
    if (!executionMatchesIntent(execution, intent, venue, market)) {
      return null;
    }
    const seen = executions.get(execution.executionId);
    if (seen !== undefined && !sameExecution(seen, execution)) {
      return null;
    }
    executions.set(execution.executionId, execution);
  }
  return [...executions.values()].sort((left, right) =>
    left.executionId < right.executionId ? -1 : 1,
  );
}

function toRecorded(execution: ExecutionObservation): RecordedExecution {
  return {
    executionId: execution.executionId,
    exchangeOrderId: execution.exchangeOrderId,
    quantity: execution.quantity,
    price: execution.price,
  };
}

function cancelAckMatches(record: IntentRecord, ack: CancelAck): boolean {
  return (
    typeof ack === "object" &&
    ack !== null &&
    ack.exchangeOrderId === record.exchangeOrderId &&
    ack.cancelled === true
  );
}

function orderMatchesIntent(
  order: ExchangeOrderObservation,
  intent: OrderIntent,
  venue: VenueId,
  market: MarketId,
): boolean {
  return (
    order.venue === venue &&
    order.market === market &&
    isNonEmptyString(order.exchangeOrderId) &&
    order.clientOrderId === intent.clientOrderId &&
    order.side === intent.side &&
    // A market order's reported price is not part of its identity.
    (intent.price === null || sameDecimal(order.price, intent.price)) &&
    sameDecimal(order.originalQuantity, intent.quantity) &&
    isCanonicalDecimalString(order.executedQuantity) &&
    decimalCmp(order.executedQuantity, "0") >= 0 &&
    (order.reduceOnly === null || order.reduceOnly === intent.reduceOnly)
  );
}

function executionMatchesIntent(
  execution: ExecutionObservation,
  intent: OrderIntent,
  venue: VenueId,
  market: MarketId,
): boolean {
  return (
    execution.venue === venue &&
    execution.market === market &&
    isNonEmptyString(execution.executionId) &&
    isNonEmptyString(execution.exchangeOrderId) &&
    execution.clientOrderId === intent.clientOrderId &&
    execution.side === intent.side &&
    isPositiveDecimal(execution.quantity) &&
    isPositiveDecimal(execution.price)
  );
}

function sameExecution(left: ExecutionFacts, right: ExecutionFacts): boolean {
  return (
    left.exchangeOrderId === right.exchangeOrderId &&
    decimalCmp(left.quantity, right.quantity) === 0 &&
    decimalCmp(left.price, right.price) === 0
  );
}

function sameDecimal(left: string | null, right: string): boolean {
  return left !== null && isCanonicalDecimalString(left) && decimalCmp(left, right) === 0;
}

function isPositiveDecimal(value: string): boolean {
  return isCanonicalDecimalString(value) && decimalCmp(value, "0") > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
