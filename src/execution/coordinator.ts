import type {
  ClientOrderId,
  ExperimentId,
  IntentId,
  MarketId,
  RunId,
  ScopeKey,
  VenueId,
} from "../domain/ids.js";
import { parseScopeKey } from "../domain/ids.js";
import type {
  ExchangeOrderObservation,
  ExecutionObservation,
  OrderAck,
  OrderIntent,
  VenueWriteResult,
} from "../domain/types.js";
import { decimalAdd, decimalCmp, isCanonicalDecimalString } from "../math/decimal.js";
import {
  type IntentLink,
  type IntentRecord,
  type IntentRegistry,
  type IntentStatus,
  intentFingerprint,
  placeIntentProblem,
} from "./intent-registry.js";
import type {
  ClientOrderLookup,
  ExecutionVenuePort,
  FenceResult,
  IntentJournal,
  MutationFence,
} from "./ports.js";

export type ExecutionCoordinatorConfig = {
  experimentId: ExperimentId;
  runId: RunId;
  scopeKey: ScopeKey;
};

export type ExecutionCoordinatorDeps = {
  config: ExecutionCoordinatorConfig;
  registry: IntentRegistry;
  venue: ExecutionVenuePort;
  fence: MutationFence;
  journal: IntentJournal;
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

// Venue adapters must normalize a duplicate-client-order-ID rejection to this code. It proves
// an order with this intent's client ID already exists, so it is never a plain rejection.
export const DUPLICATE_CLIENT_ORDER_ID_CODE = "DUPLICATE_CLIENT_ORDER_ID";

const RISK_REDUCING_PURPOSES = new Set<string>([
  "GRID_EXIT",
  "RISK_REDUCTION",
  "EMERGENCY_FLATTEN",
]);

type LookupDecision =
  | { kind: "UNRESOLVED"; reasonCode: string }
  | { kind: "LINK"; link: IntentLink };

// Owns intent identity and place outcomes for one experiment scope. One operation runs at a
// time; any unresolved intent or journal failure blocks risk increase.
export class ExecutionCoordinator {
  private readonly config: ExecutionCoordinatorConfig;
  private readonly registry: IntentRegistry;
  private readonly venue: ExecutionVenuePort;
  private readonly fence: MutationFence;
  private readonly journal: IntentJournal;
  private busy = false;
  private journalFailed = false;

  constructor(deps: ExecutionCoordinatorDeps) {
    this.config = { ...deps.config };
    this.registry = deps.registry;
    this.venue = deps.venue;
    this.fence = deps.fence;
    this.journal = deps.journal;
  }

  canIncreaseRisk(): boolean {
    return !this.journalFailed && this.registry.unresolved().length === 0;
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

    this.registry.prepare(intent);
    if (!(await this.persist())) {
      const record = this.registry.markNotSent(intent.intentId, ["JOURNAL_WRITE_FAILED"]);
      return { disposition: "RECORDED", record, reasonCodes: ["JOURNAL_WRITE_FAILED"] };
    }

    const fenced = await this.fence.run(() => this.venue.placeOrder(structuredClone(intent)));
    const reasonCodes = this.applyPlaceOutcome(intent, fenced);
    if (!(await this.persist())) {
      reasonCodes.push("JOURNAL_WRITE_FAILED");
    }
    return { disposition: "RECORDED", record: this.registry.get(intent.intentId), reasonCodes };
  }

  private admissionProblem(intent: OrderIntent): string | null {
    if (
      intent.experimentId !== this.config.experimentId ||
      intent.runId !== this.config.runId ||
      intent.scopeKey !== this.config.scopeKey
    ) {
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

  // Resolves PREPARED/UNKNOWN intents only from venue evidence for their client order ID.
  // Absence of evidence never proves the order was not sent.
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
      const decision = evaluateLookup(intent, lookup, this.registry);
      if (decision.kind === "UNRESOLVED") {
        items.push({
          intentId: intent.intentId,
          status: record.status,
          reasonCodes: [decision.reasonCode],
        });
        continue;
      }
      const linked = this.registry.link(intent.intentId, decision.link);
      changed = true;
      items.push({
        intentId: intent.intentId,
        status: linked.status,
        reasonCodes: linked.reasonCodes,
      });
    }
    const reasonCodes: string[] = [];
    if (changed && !(await this.persist())) {
      reasonCodes.push("JOURNAL_WRITE_FAILED");
    }
    return { reasonCodes, items };
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
  const executions = new Map<string, ExecutionObservation>();
  for (const execution of lookup.executions) {
    if (!executionMatchesIntent(execution, intent, venue, market)) {
      return unresolved("LOOKUP_EXECUTION_MISMATCH");
    }
    const seen = executions.get(execution.executionId);
    if (seen !== undefined && !sameExecution(seen, execution)) {
      return unresolved("LOOKUP_EXECUTION_MISMATCH");
    }
    executions.set(execution.executionId, execution);
  }
  const unique = [...executions.values()].sort((left, right) =>
    left.executionId < right.executionId ? -1 : 1,
  );

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
      executions: unique.map((execution) => ({
        executionId: execution.executionId,
        exchangeOrderId: execution.exchangeOrderId,
        quantity: execution.quantity,
        price: execution.price,
      })),
      reasonCodes: ["RECONCILED_BY_CLIENT_ORDER_ID"],
    },
  };
}

function unresolved(reasonCode: string): LookupDecision {
  return { kind: "UNRESOLVED", reasonCode };
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

function sameExecution(left: ExecutionObservation, right: ExecutionObservation): boolean {
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
