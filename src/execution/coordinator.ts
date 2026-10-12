import type { Ownership } from "../domain/enums.js";
import type {
  AnchorEpoch,
  ClientOrderId,
  ExchangeOrderId,
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
  type CancelResolution,
  type IntentLink,
  type IntentRecord,
  type IntentRegistry,
  type IntentStatus,
  type RecordedExecution,
  intentFingerprint,
  placeIntentProblem,
} from "./intent-registry.js";
import type {
  ClientOrderLookup,
  ExecutionVenuePort,
  ExposureInputSource,
  ExposureInputs,
  FenceResult,
  IntentJournal,
  MutationFence,
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

type LookupDecision =
  | { kind: "UNRESOLVED"; reasonCode: string }
  | { kind: "LINK"; link: IntentLink }
  | { kind: "RESOLVE_CANCEL"; resolution: CancelResolution };

type ExecutionFacts = Pick<RecordedExecution, "exchangeOrderId" | "quantity" | "price">;

// Owns intent identity and place/cancel outcomes for one experiment scope. One operation runs
// at a time; any unresolved intent, journal failure or open-order scan blocker blocks risk
// increase.
export class ExecutionCoordinator {
  private readonly config: ExecutionCoordinatorConfig;
  private readonly registry: IntentRegistry;
  private readonly venue: ExecutionVenuePort;
  private readonly fence: MutationFence;
  private readonly journal: IntentJournal;
  private readonly exposure: ExposureInputSource;
  private busy = false;
  private journalFailed = false;
  private openOrderBlockers: string[] = [];
  private writesThisCycle = 0;

  constructor(deps: ExecutionCoordinatorDeps) {
    const budget = deps.config.writeBudgetPerCycle;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new Error("INVALID_WRITE_BUDGET");
    }
    this.config = { ...deps.config };
    this.registry = deps.registry;
    this.venue = deps.venue;
    this.fence = deps.fence;
    this.journal = deps.journal;
    this.exposure = deps.exposure;
  }

  canIncreaseRisk(): boolean {
    return (
      !this.journalFailed &&
      this.registry.unresolved().length === 0 &&
      this.openOrderBlockers.length === 0
    );
  }

  // Starts a new write-budget cycle. Refused while an operation is in flight.
  startCycle(): boolean {
    if (this.busy) {
      return false;
    }
    this.writesThisCycle = 0;
    return true;
  }

  isJournalLatched(): boolean {
    return this.journalFailed;
  }

  async submit(intent: OrderIntent): Promise<SubmitResult> {
    if (this.busy) {
      return refused("COORDINATOR_BUSY");
    }
    this.busy = true;
    try {
      return await this.submitExclusive(intent);
    } finally {
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
    try {
      return await this.reconcileExclusive();
    } finally {
      this.busy = false;
    }
  }

  // Checks every intent and the whole batch's exposure before the first send. Sends then run
  // in order; after one is not sent, the rest are neither attempted nor recorded.
  async submitBatch(intents: readonly OrderIntent[]): Promise<BatchResult> {
    if (this.busy) {
      return batchRefused(["COORDINATOR_BUSY"]);
    }
    this.busy = true;
    try {
      return await this.submitBatchExclusive(intents);
    } finally {
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
    try {
      return await this.cleanupExclusive(anchorEpoch);
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

  private async submitExclusive(intent: OrderIntent): Promise<SubmitResult> {
    if (this.journalFailed) {
      return refused("JOURNAL_LATCHED");
    }
    const problem = placeIntentProblem(intent);
    if (problem !== null) {
      return refused(problem);
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

  private async submitBatchExclusive(intents: readonly OrderIntent[]): Promise<BatchResult> {
    if (this.journalFailed) {
      return batchRefused(["JOURNAL_LATCHED"]);
    }
    if (!Array.isArray(intents) || intents.length === 0) {
      return batchRefused(["EMPTY_BATCH"]);
    }
    const identities = new Set<string>();
    const slots = new Set<string>();
    for (const intent of intents) {
      const problem =
        placeIntentProblem(intent) ??
        (this.registry.get(intent.intentId) !== null
          ? "INTENT_ALREADY_RECORDED"
          : this.admissionProblem(intent));
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
    const fenced = await this.fence.run(() => this.venue.placeOrder(structuredClone(intent)));
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
    return null;
  }

  private applyPlaceOutcome(
    intent: OrderIntent,
    fenced: FenceResult<VenueWriteResult<OrderAck>>,
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
