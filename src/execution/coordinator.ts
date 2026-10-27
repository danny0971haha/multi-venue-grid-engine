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
import {
  type DecimalString,
  decimalCmp,
  InvalidDecimalError,
  isCanonicalDecimalString,
} from "../math/decimal.js";
import { exactAdd, exactSub } from "../math/exact-decimal.js";
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
  type ExecutionContradiction,
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

// A material contradiction found by a lookup, kept like one found in the execution stream:
// the reason code it is persisted under and the observed executions that prove it.
type LookupContradiction = { reasonCode: string; evidence: ExecutionObservation[] };

type LookupDecision =
  | { kind: "UNRESOLVED"; reasonCode: string; contradiction: LookupContradiction | null }
  | { kind: "LINK"; link: IntentLink }
  | { kind: "RESOLVE_CANCEL"; resolution: CancelResolution };

type ExecutionFacts = Pick<RecordedExecution, "exchangeOrderId" | "quantity" | "price">;

// The fields of a stream execution that decide whether and where it is recorded, each read
// once when it arrives. A value that is not a string, or whose read throws, is null.
type StreamFacts = {
  venue: string | null;
  market: string | null;
  executionId: string | null;
  exchangeOrderId: string | null;
  clientOrderId: string | null;
  side: string | null;
  price: string | null;
  quantity: string | null;
};

// The observed fields kept as a contradiction, from a replay page, a lookup or the stream.
type ExecutionEvidence = Readonly<
  Record<
    "executionId" | "exchangeOrderId" | "clientOrderId" | "side" | "quantity" | "price",
    unknown
  >
>;

type ExecutionPlan = {
  problem: string | null;
  // The observed executions that raised the problem, kept as contradictions.
  evidence: ExecutionEvidence[];
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
  // The facts of stream executions that arrived while another operation ran. They are checked
  // in arrival order before that operation releases the coordinator.
  private readonly deferredStream: StreamFacts[] = [];
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
    const blockers = new Set<string>([...this.openOrderBlockers, ...this.executionBlockerCodes()]);
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

  // The replay and stream blockers of this process, plus the persisted contradictions. A
  // stream execution still waiting to be checked blocks as a dropped event.
  executionBlockerCodes(): string[] {
    const codes = new Set<string>(this.executionBlockers);
    if (this.deferredStream.length > 0) {
      codes.add("EXECUTION_STREAM_EVENT_DROPPED");
    }
    for (const entry of this.registry.executionContradictions()) {
      codes.add(entry.reasonCode);
    }
    return [...codes].sort(compareStrings);
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
      await this.release();
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
      await this.release();
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
      await this.release();
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
      await this.release();
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
      await this.release();
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
      await this.release();
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
      await this.release();
    }
  }

  // Records one execution pushed by the venue stream. The stream is never trusted to be
  // complete: a gap, an unusable sequence, a dropped event or any execution problem blocks
  // risk increase until a later replay completes. It never moves the replay cursor. Only the
  // execution's identity, order, side, price, quantity and stream sequence are read, each
  // once on arrival; its fee, liquidity and other meta fields cannot affect the check. One
  // that arrives while another operation runs is checked before that operation releases the
  // coordinator, so a problem it shows is persisted as a direct one would be. After a journal
  // failure it is dropped.
  async ingestStreamExecution(execution: ExecutionObservation): Promise<ExecutionReplayResult> {
    this.continuationGranted = false;
    const reasonCodes: string[] = [];
    const { facts, sequence } = readStreamExecution(execution);
    const sequenceProblem = this.observeStreamSequence(sequence);
    if (sequenceProblem !== null) {
      this.executionBlockers.add(sequenceProblem);
      reasonCodes.push(sequenceProblem);
    }
    if (this.busy || this.journalFailed) {
      this.executionBlockers.add("EXECUTION_STREAM_EVENT_DROPPED");
      if (!this.journalFailed) {
        this.deferredStream.push(facts);
      }
      reasonCodes.push(
        "EXECUTION_STREAM_EVENT_DROPPED",
        this.busy ? "COORDINATOR_BUSY" : "JOURNAL_LATCHED",
      );
      return { reasonCodes, recorded: [] };
    }
    this.busy = true;
    try {
      return await this.ingestExclusive(facts, reasonCodes);
    } finally {
      await this.release();
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
      await this.release();
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
        const remaining = remainingQuantity(intent.quantity, record.executedQuantity);
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
    if (this.executionBlockerCodes().length > 0 && isRiskIncreasing(intent)) {
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
      (this.continuationGranted && this.executionBlockerCodes().length === 0)
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
  // A material contradiction is made durable before the next record is looked up, so a later
  // lookup that omits it can resolve the record but never clear the contradiction.
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
        const found = decision.contradiction;
        if (found !== null && !(await this.recordProblem(found.reasonCode, found.evidence))) {
          return { reasonCodes: ["JOURNAL_WRITE_FAILED"], items };
        }
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
    // stay, because it may have read past their events before they were raised. Persisted
    // contradictions are not cleared here: a replay past their evidence cannot see it again.
    // Neither are stream executions still waiting to be checked: they block until they are.
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
        if (!(await this.recordProblem(plan.problem, plan.evidence))) {
          return this.replayStopped("JOURNAL_WRITE_FAILED", recorded);
        }
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

  // Ends the running operation. Stream executions that arrived while it ran are checked
  // first, in arrival order, each revoking any continuation grant as a direct ingest does.
  // After a journal failure the rest stay queued and keep risk increase blocked.
  private async release(): Promise<void> {
    try {
      while (this.deferredStream.length > 0 && !this.journalFailed) {
        this.continuationGranted = false;
        await this.ingestExclusive(this.deferredStream[0] as StreamFacts, []);
        this.deferredStream.shift();
      }
    } finally {
      this.busy = false;
    }
  }

  private async ingestExclusive(
    facts: StreamFacts,
    reasonCodes: string[],
  ): Promise<ExecutionReplayResult> {
    const plan = this.planExecutions([facts]);
    if (plan.problem === "EXECUTION_OBSERVATION_INVALID") {
      // The stream does not send an event again, and no replay can be shown to include this
      // one, so what could be read of it is kept as durable evidence.
      plan.problem = "EXECUTION_STREAM_EVENT_UNUSABLE";
      plan.evidence = [facts];
    }
    if (plan.problem !== null) {
      const durable = await this.recordProblem(plan.problem, plan.evidence);
      return {
        reasonCodes: [...reasonCodes, plan.problem, ...(durable ? [] : ["JOURNAL_WRITE_FAILED"])],
        recorded: [],
      };
    }
    const recorded = this.applyPlan(plan.additions);
    if (recorded.length > 0 && !(await this.persist())) {
      return { reasonCodes: [...reasonCodes, "JOURNAL_WRITE_FAILED"], recorded };
    }
    return { reasonCodes, recorded };
  }

  // A sequence past the next expected one is a gap. A repeated or older one may be a
  // duplicate or a late event; the execution ID checks make either harmless.
  private observeStreamSequence(text: string | null): string | null {
    if (text === null || !STREAM_SEQUENCE_PATTERN.test(text)) {
      return "EXECUTION_STREAM_SEQUENCE_UNUSABLE";
    }
    const sequence = BigInt(text);
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
    const problem = (reasonCode: string, evidence: ExecutionEvidence[] = []): ExecutionPlan => ({
      problem: reasonCode,
      evidence,
      additions: new Map(),
    });
    for (const raw of observed) {
      if (!isExecutionInMarket(raw, venue, market)) {
        return problem("EXECUTION_OBSERVATION_INVALID");
      }
      const execution = raw;
      const intentId = this.registry.intentIdForExchangeOrderId(execution.exchangeOrderId);
      if (intentId === null) {
        return problem(this.unattributedProblem(execution), [execution]);
      }
      const record = this.registry.get(intentId) as IntentRecord;
      if (!executionMatchesIntent(execution, record.intent, venue, market)) {
        return problem("EXECUTION_MISMATCH", [execution]);
      }
      const owner = this.registry.intentIdForExecutionId(execution.executionId);
      if (owner !== null) {
        if (owner !== intentId) {
          return problem("EXECUTION_ID_COLLISION", [execution]);
        }
        const recorded = record.executions.find(
          (item) => item.executionId === execution.executionId,
        );
        if (recorded === undefined || !sameExecution(recorded, execution)) {
          return problem("EXECUTION_CONFLICT", [execution]);
        }
        continue;
      }
      const earlier = seen.get(execution.executionId);
      if (earlier !== undefined) {
        if (!sameExecution(earlier, execution)) {
          return problem("EXECUTION_CONFLICT", [earlier, execution]);
        }
        continue;
      }
      if (!WORKING_STATUSES.has(record.status)) {
        return problem("EXECUTION_AFTER_CLOSE", [execution]);
      }
      seen.set(execution.executionId, execution);
      additions.set(intentId, [...(additions.get(intentId) ?? []), toRecorded(execution)]);
    }
    for (const [intentId, executions] of additions) {
      const record = this.registry.get(intentId) as IntentRecord;
      if (exceedsLimit(record.executedQuantity, executions, record.intent.quantity)) {
        return problem(
          "EXECUTION_OVERFILL",
          executions.map((item) => seen.get(item.executionId) as ExecutionObservation),
        );
      }
      if (sumQuantities(record.executedQuantity, executions) === null) {
        return problem("EXECUTION_QUANTITY_UNBOUNDED");
      }
    }
    return { problem: null, evidence: [], additions };
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

  // Blocks on the problem and keeps its evidence durable. Returns false only when the evidence
  // changed the registry but the journal write failed.
  private async recordProblem(
    reasonCode: string,
    evidence: readonly ExecutionEvidence[],
  ): Promise<boolean> {
    this.executionBlockers.add(reasonCode);
    const entries = evidence.map((execution) => toContradiction(reasonCode, execution));
    return !this.registry.recordContradictions(entries) || (await this.persist());
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

// Reads each observed field once. A field that is not a string is kept as null; the registry
// accepts null IDs only for a stream execution that could not be checked.
function toContradiction(reasonCode: string, execution: ExecutionEvidence): ExecutionContradiction {
  const { executionId, exchangeOrderId, clientOrderId, side, quantity, price } = execution;
  return {
    reasonCode,
    executionId: typeof executionId === "string" ? executionId : null,
    exchangeOrderId: typeof exchangeOrderId === "string" ? exchangeOrderId : null,
    clientOrderId: typeof clientOrderId === "string" ? clientOrderId : null,
    side: typeof side === "string" ? side : null,
    quantity: typeof quantity === "string" ? quantity : null,
    price: typeof price === "string" ? price : null,
  };
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

// Reads, once each, the fields of a stream execution that decide whether and where it is
// recorded, and its meta sequence. No other field is read.
function readStreamExecution(value: unknown): { facts: StreamFacts; sequence: string | null } {
  const facts: StreamFacts = {
    venue: readString(value, "venue"),
    market: readString(value, "market"),
    executionId: readString(value, "executionId"),
    exchangeOrderId: readString(value, "exchangeOrderId"),
    clientOrderId: readString(value, "clientOrderId"),
    side: readString(value, "side"),
    price: readString(value, "price"),
    quantity: readString(value, "quantity"),
  };
  return { facts, sequence: readString(readField(value, "meta"), "sequence") };
}

// A field of an object, read once; undefined when the value is not an object or the read throws.
function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function readString(value: unknown, field: string): string | null {
  const read = readField(value, field);
  return typeof read === "string" ? read : null;
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

// Decides an unresolved place from a fresh lookup. Material contradictions in the executions
// are checked first and carry their evidence, which is kept as the execution stream keeps it.
// Every other reason only leaves the place unresolved until a later lookup proves it.
function evaluateLookup(
  intent: OrderIntent,
  lookup: ClientOrderLookup,
  registry: IntentRegistry,
): LookupDecision {
  const { venue, market } = parseScopeKey(intent.scopeKey);
  const order = lookup.order;
  const orderMatches = order === null || orderMatchesIntent(order, intent, venue, market);
  const screened = screenExecutions(intent, lookup.executions, venue, market);
  if (screened.decision !== null) {
    return screened.decision;
  }
  const unique = screened.unique;
  // The record is unlinked, so any owner of these executions is another intent.
  const owned = unique.filter(
    (execution) => registry.intentIdForExecutionId(execution.executionId) !== null,
  );
  if (owned.length > 0) {
    return contradicted("EXECUTION_ID_COLLISION", "EXECUTION_ID_COLLISION", owned);
  }
  // Executions of this client order ID on more than one exchange order. Without a matching
  // order to anchor them, none of them can be told apart from the others.
  const anchor =
    order !== null && orderMatches ? order.exchangeOrderId : (unique[0]?.exchangeOrderId ?? null);
  const offOrder = unique.filter((execution) => execution.exchangeOrderId !== anchor);
  if (offOrder.length > 0) {
    return contradicted(
      "LOOKUP_EXECUTION_MISMATCH",
      "EXECUTION_MISMATCH",
      order !== null && orderMatches ? offOrder : unique,
    );
  }
  // Executions of this client order ID on an exchange order another record owns.
  const first = unique[0];
  if (first !== undefined && registry.intentIdForExchangeOrderId(first.exchangeOrderId) !== null) {
    return contradicted("EXCHANGE_ORDER_ID_COLLISION", "EXECUTION_MISMATCH", unique);
  }
  if (exceedsLimit("0", unique, intent.quantity)) {
    return contradicted("LOOKUP_OVERFILL", "EXECUTION_OVERFILL", unique);
  }

  if (!orderMatches) {
    return unresolved("LOOKUP_ORDER_MISMATCH");
  }
  if (screened.invalid) {
    return unresolved("LOOKUP_EXECUTION_MISMATCH");
  }
  const exchangeOrderId = order?.exchangeOrderId ?? first?.exchangeOrderId ?? null;
  if (exchangeOrderId === null) {
    return unresolved("NO_DEFINITIVE_EVIDENCE");
  }
  const executed = sumQuantities("0", unique);
  if (executed === null) {
    return unresolved("LOOKUP_QUANTITY_UNBOUNDED");
  }
  if (registry.intentIdForExchangeOrderId(exchangeOrderId) !== null) {
    return unresolved("EXCHANGE_ORDER_ID_COLLISION");
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
// order is a reconciliation case, never a cancel or a fill. Material contradictions in the
// executions are checked first and carry their evidence, as in a place lookup.
function evaluateCancelLookup(
  record: IntentRecord,
  lookup: ClientOrderLookup,
  registry: IntentRegistry,
): LookupDecision {
  const intent = record.intent;
  const { venue, market } = parseScopeKey(intent.scopeKey);
  const order = lookup.order;
  const screened = screenExecutions(intent, lookup.executions, venue, market);
  if (screened.decision !== null) {
    return screened.decision;
  }
  const unique = screened.unique;
  const offRecord = unique.filter(
    (execution) => execution.exchangeOrderId !== record.exchangeOrderId,
  );
  if (offRecord.length > 0) {
    return contradicted("LOOKUP_EXECUTION_MISMATCH", "EXECUTION_MISMATCH", offRecord);
  }
  const changed = unique.filter((execution) => {
    const recorded = record.executions.find((item) => item.executionId === execution.executionId);
    return recorded !== undefined && !sameExecution(execution, recorded);
  });
  if (changed.length > 0) {
    return contradicted("LOOKUP_EXECUTION_MISMATCH", "EXECUTION_CONFLICT", changed);
  }
  const foreign = unique.filter((execution) => {
    const owner = registry.intentIdForExecutionId(execution.executionId);
    return owner !== null && owner !== intent.intentId;
  });
  if (foreign.length > 0) {
    return contradicted("EXECUTION_ID_COLLISION", "EXECUTION_ID_COLLISION", foreign);
  }
  // Executions the record has not recorded add to what it has already executed.
  const fresh = unique.filter(
    (execution) => registry.intentIdForExecutionId(execution.executionId) === null,
  );
  if (exceedsLimit(record.executedQuantity, fresh, intent.quantity)) {
    return contradicted("LOOKUP_OVERFILL", "EXECUTION_OVERFILL", fresh);
  }

  if (
    order !== null &&
    (!orderMatchesIntent(order, intent, venue, market) ||
      order.exchangeOrderId !== record.exchangeOrderId)
  ) {
    return unresolved("LOOKUP_ORDER_MISMATCH");
  }
  if (screened.invalid) {
    return unresolved("LOOKUP_EXECUTION_MISMATCH");
  }
  const executed = sumQuantities("0", unique);
  if (executed === null) {
    return unresolved("LOOKUP_QUANTITY_UNBOUNDED");
  }
  const compared = decimalCmp(executed, intent.quantity);
  if (compared > 0) {
    // The total from the recorded quantity was too long to compute, but this one proves it.
    return contradicted("LOOKUP_OVERFILL", "EXECUTION_OVERFILL", fresh);
  }
  for (const recorded of record.executions) {
    if (!unique.some((execution) => execution.executionId === recorded.executionId)) {
      return unresolved("EXECUTION_EVIDENCE_MISSING");
    }
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

// Exact total of execution quantities from a starting total, or null when the exact total could
// need more digits than exact arithmetic allows. A total is never rounded.
function sumQuantities(
  start: DecimalString,
  executions: readonly { quantity: DecimalString }[],
): DecimalString | null {
  try {
    return executions.reduce((sum, execution) => exactAdd(sum, execution.quantity), start);
  } catch (error) {
    if (!(error instanceof InvalidDecimalError)) {
      throw error;
    }
    return null;
  }
}

// Exact quantity an order may still execute. When the exact residual could need more digits than
// exact arithmetic allows, the full order quantity bounds it from above, so a reservation is
// never understated.
function remainingQuantity(quantity: DecimalString, executed: DecimalString): DecimalString {
  try {
    return exactSub(quantity, executed);
  } catch (error) {
    if (!(error instanceof InvalidDecimalError)) {
      throw error;
    }
    return quantity;
  }
}

// Whether positive quantities provably take a starting total past the limit, using exact
// arithmetic only. When the exact total needs more digits than exact arithmetic allows, the
// room left under the limit is shrunk by each quantity, largest first; a quantity whose
// subtraction is also too long is skipped, which only overstates the room. The total then
// provably exceeds the limit when a quantity exceeds the room left, or when the room reaches
// zero with a skipped quantity left out.
function exceedsLimit(
  start: DecimalString,
  executions: readonly { quantity: DecimalString }[],
  limit: DecimalString,
): boolean {
  const total = sumQuantities(start, executions);
  if (total !== null) {
    return decimalCmp(total, limit) > 0;
  }
  let room = differenceOrNull(limit, start);
  if (room === null) {
    return false;
  }
  let skipped = false;
  const largestFirst = [...executions].sort((left, right) =>
    decimalCmp(right.quantity, left.quantity),
  );
  for (const { quantity } of largestFirst) {
    if (decimalCmp(quantity, room) > 0) {
      return true;
    }
    const next = differenceOrNull(room, quantity);
    if (next === null) {
      skipped = true;
    } else {
      room = next;
    }
  }
  return skipped && decimalCmp(room, "0") === 0;
}

// Exact difference, or null when it could need more digits than exact arithmetic allows.
function differenceOrNull(left: DecimalString, right: DecimalString): DecimalString | null {
  try {
    return exactSub(left, right);
  } catch (error) {
    if (!(error instanceof InvalidDecimalError)) {
      throw error;
    }
    return null;
  }
}

function unresolved(reasonCode: string): LookupDecision {
  return { kind: "UNRESOLVED", reasonCode, contradiction: null };
}

// Unresolved with a material contradiction, kept under the durable code with its evidence.
function contradicted(
  reasonCode: string,
  durableCode: string,
  evidence: ExecutionObservation[],
): LookupDecision {
  return { kind: "UNRESOLVED", reasonCode, contradiction: { reasonCode: durableCode, evidence } };
}

function resolvedCancel(
  status: CancelResolution["status"],
  executions: RecordedExecution[],
  reasonCode: string,
): LookupDecision {
  return { kind: "RESOLVE_CANCEL", resolution: { status, executions, reasonCodes: [reasonCode] } };
}

type ScreenedExecutions = {
  unique: ExecutionObservation[];
  // An execution without its own identity in this market; it cannot be kept as evidence.
  invalid: boolean;
  decision: LookupDecision | null;
};

// Validates and de-duplicates execution evidence for one intent, sorted by execution ID. An
// execution that contradicts the intent, or another report of the same execution ID, is a
// material contradiction and the first one found is the decision.
function screenExecutions(
  intent: OrderIntent,
  observed: readonly ExecutionObservation[],
  venue: VenueId,
  market: MarketId,
): ScreenedExecutions {
  const executions = new Map<string, ExecutionObservation>();
  let invalid = false;
  const stop = (decision: LookupDecision): ScreenedExecutions => ({
    unique: [],
    invalid,
    decision,
  });
  for (const execution of observed) {
    if (!isExecutionInMarket(execution, venue, market)) {
      invalid = true;
      continue;
    }
    if (!executionMatchesIntent(execution, intent, venue, market)) {
      return stop(contradicted("LOOKUP_EXECUTION_MISMATCH", "EXECUTION_MISMATCH", [execution]));
    }
    const seen = executions.get(execution.executionId);
    if (seen !== undefined && !sameExecution(seen, execution)) {
      return stop(
        contradicted("LOOKUP_EXECUTION_MISMATCH", "EXECUTION_CONFLICT", [seen, execution]),
      );
    }
    executions.set(execution.executionId, execution);
  }
  const unique = [...executions.values()].sort((left, right) =>
    left.executionId < right.executionId ? -1 : 1,
  );
  return { unique, invalid, decision: null };
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
