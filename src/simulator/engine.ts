import { V01_EXPERIMENT_CONFIG } from "../domain/config.js";
import type {
  GridLevelState,
  IntentPurpose,
  Ownership,
  WriteOutcomeKind,
} from "../domain/enums.js";
import {
  ALL_LEVELS,
  type AnchorEpoch,
  type ClientOrderId,
  type ExchangeOrderId,
  type ExecutionId,
  type ExperimentId,
  type GridLogicalLevelId,
  type IntentId,
  type MarketId,
  makeClientOrderId,
  makeIntentId,
  makeScopeKey,
  type RunId,
  type ScopeKey,
  type VenueId,
} from "../domain/ids.js";
import {
  classifyOwnership,
  type DuplicateCleanupPlan,
  isProvenAuthoritySource,
  type OrderAuthorityLink,
  planOwnedDuplicateCleanup,
} from "../domain/ownership.js";

export type { OrderAuthorityLink } from "../domain/ownership.js";

import type {
  AccountSnapshot,
  CancelAck,
  ExchangeOrderObservation,
  ExecutionObservation,
  ExperimentConfig,
  ObservationMeta,
  OrderAck,
  OrderIntent,
  PositionSnapshot,
  VenueWriteResult,
} from "../domain/types.js";
import {
  type DecimalRounding,
  type DecimalString,
  decimalAdd,
  decimalCmp,
  decimalDiv,
  decimalIsZero,
  decimalMul,
  decimalSub,
  parseDecimalString,
} from "../math/decimal.js";
import {
  evaluateGridQuantity,
  type NormalizedLevel,
  normalizeTheoreticalGrid,
  oppositeSide,
  theoreticalExitPrice,
  theoreticalGrid,
} from "../strategy/geometry.js";
import { assertTransition } from "../strategy/levelState.js";
import {
  assessEnvelopeFeasibility,
  type MarketRules,
  normalizePrice,
  normalizeQuantity,
} from "../strategy/marketRules.js";
import { assertValidSimulatorSnapshot, isImportableSequenceCounter } from "./snapshot.js";

export { SIMULATOR_SCHEMA_VERSION, SnapshotImportError } from "./snapshot.js";

export type SimulatorInit = {
  experimentId: ExperimentId;
  runId: RunId;
  accountScope: string;
  venue: VenueId;
  market: MarketId;
  strategy: string;
  anchorEpoch: AnchorEpoch;
  anchorPrice: DecimalString;
  marketRules: MarketRules;
  priceRounding: DecimalRounding;
  quantityRounding: DecimalRounding;
  leaseGeneration: string;
  createdAt: string;
  quantity: DecimalString;
};

export type ExecutionIntegrityFaultCode =
  | "NON_POSITIVE_EXECUTION_QUANTITY"
  | "NON_POSITIVE_EXECUTION_PRICE"
  | "EXECUTION_OVERFILL"
  | "EXECUTION_ID_COLLISION"
  | "ORDER_ID_COLLISION"
  | "EXECUTION_ORDER_MISSING"
  | "EXECUTION_AUTHORITY_UNPROVEN"
  | "EXECUTION_STATE_TRANSITION_INVALID"
  | "EXECUTION_INVENTORY_CONFLICT"
  | "EXECUTION_EFFECT_CALCULATION_FAILURE"
  | "ORDER_SEQ_EXHAUSTED"
  | "EXECUTION_SEQ_EXHAUSTED";

export type ExecutionIntegrityFault = {
  code: ExecutionIntegrityFaultCode;
  executionId: string | null;
  exchangeOrderId: string;
};

export class SimulatorIntegrityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SimulatorIntegrityError";
    this.code = code;
  }
}

export type OwnedWorkingRiskIncreasing = {
  exchangeOrderId: ExchangeOrderId;
  logicalLevelId: GridLogicalLevelId | null;
  side: "BUY" | "SELL";
  price: DecimalString | null;
  quantity: DecimalString;
};

export type PossibleExposure = {
  signedPosition: DecimalString;
  ownedWorkingRiskIncreasing: OwnedWorkingRiskIncreasing[];
  unknownSubmissions: Array<{
    intentId: IntentId;
    price: DecimalString | null;
    quantity: DecimalString;
  }>;
  proposedRiskIncreasing: Array<{
    intentId: IntentId;
    price: DecimalString | null;
    quantity: DecimalString;
  }>;
};

export type LevelView = {
  logicalLevelId: GridLogicalLevelId;
  state: GridLevelState;
  theoreticalEntryPrice: DecimalString;
  normalizedEntryPrice: DecimalString;
  theoreticalExitPrice: DecimalString;
  normalizedExitPrice: DecimalString;
  originalQuantity: DecimalString | null;
  executedQuantity: DecimalString;
  remainingQuantity: DecimalString | null;
  openInventory: DecimalString;
  entryExecutedQuantity: DecimalString;
  exitExecutedQuantity: DecimalString;
  executionIds: ExecutionId[];
  weightedExecutionPrice: DecimalString | null;
  entryIntentId: IntentId | null;
  exitIntentId: IntentId | null;
  entryMutationSequence: string;
  exitMutationSequence: string;
  entryIntentTerminal: boolean;
  exitIntentTerminal: boolean;
  workingExchangeOrderId: ExchangeOrderId | null;
};

export type SimulatorSnapshot = {
  schemaVersion: "phase1-simulator-2";
  init: SimulatorInit;
  config: ExperimentConfig;
  entriesPlanned: boolean;
  riskIncreaseBlocked: boolean;
  executionGap: boolean;
  executionConflict: boolean;
  executionIntegrityFault: ExecutionIntegrityFault | null;
  snapshotStale: boolean;
  orderSeq: number;
  executionSeq: number;
  levels: LevelView[];
  intents: OrderIntent[];
  orders: InternalOrder[];
  authorityLinks: OrderAuthorityLink[];
  executions: ExecutionObservation[];
  unknownWrites: UnknownWrite[];
  position: PositionSnapshot;
  account: AccountSnapshot;
};

type UnknownWrite = {
  intentId: IntentId;
  requestFingerprint: string;
  purpose: IntentPurpose;
  price: DecimalString | null;
  quantity: DecimalString;
};

type InternalOrder = {
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  intentId: IntentId | null;
  logicalLevelId: GridLogicalLevelId | null;
  purpose: IntentPurpose;
  side: "BUY" | "SELL";
  type: string;
  price: DecimalString | null;
  originalQuantity: DecimalString;
  executedQuantity: DecimalString;
  remainingQuantity: DecimalString;
  status: string;
  reduceOnly: boolean;
  ownership: Ownership;
  presentInOpenBook: boolean;
  anchorEpoch: AnchorEpoch | null;
  scopeKey: ScopeKey | null;
};

type MutableLevel = LevelView;

export class DeterministicSimulator {
  private readonly init: SimulatorInit;
  private readonly scopeKey: ScopeKey;
  private readonly config: ExperimentConfig = V01_EXPERIMENT_CONFIG;
  private entriesPlanned = false;
  private riskIncreaseBlocked = false;
  private executionGap = false;
  private executionConflict = false;
  private executionIntegrityFault: ExecutionIntegrityFault | null = null;
  private snapshotStale = false;
  private orderSeq = 0;
  private executionSeq = 0;
  private readonly levels = new Map<GridLogicalLevelId, MutableLevel>();
  private readonly intents = new Map<IntentId, OrderIntent>();
  private readonly orders = new Map<ExchangeOrderId, InternalOrder>();
  private readonly authorityLinks = new Map<ExchangeOrderId, OrderAuthorityLink>();
  private readonly executions = new Map<ExecutionId, ExecutionObservation>();
  private readonly unknownWrites = new Map<IntentId, UnknownWrite>();
  private position: PositionSnapshot;
  private account: AccountSnapshot;

  private constructor(init: SimulatorInit) {
    this.init = {
      ...init,
      anchorPrice: parseDecimalString(init.anchorPrice),
      quantity: parseDecimalString(init.quantity),
    };
    this.scopeKey = makeScopeKey(init.accountScope, init.venue, init.market, init.strategy);
    this.position = {
      venue: init.venue,
      market: init.market,
      quantity: "0",
      markPrice: null,
      notionalUsd: null,
      unrealizedPnlUsd: null,
      meta: this.meta("position"),
    };
    this.account = {
      equityUsd: null,
      availableMarginUsd: null,
      realizedDailyPnlUsd: null,
      feesDailyUsd: null,
      fundingDailyUsd: null,
      meta: this.meta("account"),
    };
  }

  static create(init: SimulatorInit): DeterministicSimulator {
    const simulator = new DeterministicSimulator(init);
    simulator.initializeLevels();
    return simulator;
  }

  static fromSnapshot(snapshot: SimulatorSnapshot): DeterministicSimulator {
    const valid = assertValidSimulatorSnapshot(snapshot);
    const simulator = new DeterministicSimulator(valid.init);
    simulator.entriesPlanned = valid.entriesPlanned;
    simulator.executionGap = valid.executionGap;
    simulator.executionConflict = valid.executionConflict === true;
    simulator.executionIntegrityFault = valid.executionIntegrityFault ?? null;
    simulator.snapshotStale = valid.snapshotStale;
    simulator.orderSeq = valid.orderSeq;
    simulator.executionSeq = valid.executionSeq;
    simulator.position = valid.position;
    simulator.account = valid.account;
    for (const logicalLevelId of ALL_LEVELS) {
      const level = valid.levels.find((item) => item.logicalLevelId === logicalLevelId);
      if (level === undefined) {
        throw new Error(`MISSING_LEVEL:${logicalLevelId}`);
      }
      simulator.levels.set(logicalLevelId, {
        ...level,
        executionIds: [...level.executionIds],
      });
    }
    for (const intent of valid.intents) {
      simulator.intents.set(intent.intentId, intent);
    }
    for (const order of valid.orders) {
      simulator.insertOrder({ ...order });
    }
    for (const link of valid.authorityLinks) {
      simulator.authorityLinks.set(link.exchangeOrderId, { ...link });
    }
    for (const execution of valid.executions) {
      simulator.insertExecution(execution);
    }
    for (const unknown of valid.unknownWrites) {
      simulator.unknownWrites.set(unknown.intentId, unknown);
    }
    for (const order of simulator.orders.values()) {
      order.ownership = simulator.classifyObserved(order);
    }
    simulator.riskIncreaseBlocked = valid.riskIncreaseBlocked || simulator.hasDerivedRiskBlockers();
    return simulator;
  }

  planEntries():
    | { status: "PLANNED"; intents: OrderIntent[] }
    | { status: "INFEASIBLE"; reason: string } {
    const envelope = assessEnvelopeFeasibility(this.init.marketRules, this.config);
    if (envelope.status === "INFEASIBLE") {
      return envelope;
    }
    const theoretical = theoreticalGrid(this.init.anchorPrice);
    const normalized = normalizeTheoreticalGrid(
      theoretical,
      this.init.marketRules,
      this.init.priceRounding,
    );
    const geometry = {
      status: "FEASIBLE" as const,
      anchor: parseDecimalString(this.init.anchorPrice),
      theoretical,
      normalized,
    };
    const quantity = normalizeQuantity(
      this.init.quantity,
      this.init.marketRules,
      this.init.quantityRounding,
    );
    const quantityFit = evaluateGridQuantity(geometry, quantity, this.init.marketRules);
    if (quantityFit.status === "INFEASIBLE") {
      return quantityFit;
    }
    if (this.entriesPlanned) {
      if (this.canIncreaseRisk()) {
        this.seedIdleTerminalLevels(quantity);
      }
      return { status: "PLANNED", intents: this.currentEntryIntents() };
    }
    if (!this.canIncreaseRisk()) {
      return { status: "PLANNED", intents: [] };
    }

    const intents: OrderIntent[] = [];
    for (const levelGeometry of geometry.normalized) {
      const level = this.requireLevel(levelGeometry.logicalLevelId);
      const sequence = nextSequence(level.entryMutationSequence);
      const intent = this.createIntent({
        logicalLevelId: levelGeometry.logicalLevelId,
        purpose: "GRID_ENTRY",
        side: levelGeometry.side,
        price: levelGeometry.normalizedPrice,
        quantity,
        reduceOnly: false,
        sequence,
      });
      this.assignEntryIntent(level, intent, sequence);
      intents.push(intent);
    }
    this.entriesPlanned = true;
    return { status: "PLANNED", intents };
  }

  submit(intentId: IntentId, outcome: WriteOutcomeKind): VenueWriteResult<OrderAck> {
    const intent = this.requireIntent(intentId);
    const levelId = this.requireLevelId(intent.logicalLevelId);
    const level = this.requireLevel(levelId);
    if (this.isIntentTerminal(level, intent.purpose, intent.intentId)) {
      return { kind: "NOT_SENT", reason: "INTENT_TERMINAL" };
    }
    if (outcome === "ACK") {
      this.peekGeneratedOrderId();
    }
    if (intent.purpose === "GRID_ENTRY") {
      this.setState(level, "ENTRY_SUBMITTING", "LOCAL");
    } else if (intent.purpose === "GRID_EXIT") {
      this.setState(level, "EXIT_SUBMITTING", "LOCAL");
    }

    const fingerprint = requestFingerprint(this.init.venue, this.init.market, intent);
    if (outcome === "NOT_SENT") {
      if (intent.purpose === "GRID_ENTRY") {
        this.setState(level, "IDLE", "LOCAL");
      } else if (intent.purpose === "GRID_EXIT") {
        this.setState(level, "POSITION_OPEN", "LOCAL");
      }
      return { kind: "NOT_SENT", reason: "LOCAL_GATE" };
    }
    if (outcome === "REJECTED") {
      this.markPurposeTerminal(level, intent.purpose);
      if (intent.purpose === "GRID_ENTRY") {
        this.setState(level, "IDLE", "REJECTED");
      } else if (intent.purpose === "GRID_EXIT") {
        this.setState(level, "POSITION_OPEN", "REJECTED");
      }
      return {
        kind: "REJECTED",
        code: "SIM_REJECTED",
        message: "Simulator rejected placement",
        meta: this.meta("place"),
      };
    }
    if (outcome === "UNKNOWN") {
      this.unknownWrites.set(intent.intentId, {
        intentId: intent.intentId,
        requestFingerprint: fingerprint,
        purpose: intent.purpose,
        price: intent.price,
        quantity: intent.quantity,
      });
      this.setState(level, "RECONCILING", "UNKNOWN");
      this.riskIncreaseBlocked = true;
      return {
        kind: "UNKNOWN",
        reason: "SIMULATED_UNKNOWN",
        requestFingerprint: fingerprint,
        lastKnownMeta: this.meta("place"),
      };
    }

    const exchangeOrderId = this.nextOrderId();
    const order: InternalOrder = {
      exchangeOrderId,
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      logicalLevelId: levelId,
      purpose: intent.purpose,
      side: intent.side,
      type: intent.type,
      price: intent.price,
      originalQuantity: intent.quantity,
      executedQuantity: "0",
      remainingQuantity: intent.quantity,
      status: "WORKING",
      reduceOnly: intent.reduceOnly,
      ownership: "OWNED",
      presentInOpenBook: true,
      anchorEpoch: intent.anchorEpoch,
      scopeKey: intent.scopeKey,
    };
    this.insertOrder(order);
    this.recordAuthority({
      source: "ACK",
      evidenceId: `ack:${exchangeOrderId}`,
      exchangeOrderId,
      intentId: intent.intentId,
      clientOrderId: requireClientOrderId(intent.clientOrderId),
      scopeKey: intent.scopeKey,
      anchorEpoch: intent.anchorEpoch,
    });
    level.originalQuantity = intent.quantity;
    level.executedQuantity = "0";
    level.remainingQuantity = intent.quantity;
    level.workingExchangeOrderId = exchangeOrderId;
    if (intent.purpose === "GRID_ENTRY") {
      level.entryIntentId = intent.intentId;
      this.setState(level, "ENTRY_WORKING", "ACK");
    } else {
      level.exitIntentId = intent.intentId;
      this.setState(level, "EXIT_WORKING", "ACK");
    }
    return {
      kind: "ACK",
      ack: {
        exchangeOrderId,
        clientOrderId: intent.clientOrderId,
        intentId: intent.intentId,
      },
      meta: this.meta("place"),
    };
  }

  discoverOwnedOrder(intentId: IntentId): ExchangeOrderObservation {
    const intent = this.requireIntent(intentId);
    if (this.unknownWrites.get(intentId) === undefined) {
      throw new Error("NO_UNKNOWN_WRITE_TO_DISCOVER");
    }
    this.peekGeneratedOrderId();
    const levelId = this.requireLevelId(intent.logicalLevelId);
    const level = this.requireLevel(levelId);
    const exchangeOrderId = this.nextOrderId();
    const order: InternalOrder = {
      exchangeOrderId,
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      logicalLevelId: levelId,
      purpose: intent.purpose,
      side: intent.side,
      type: intent.type,
      price: intent.price,
      originalQuantity: intent.quantity,
      executedQuantity: "0",
      remainingQuantity: intent.quantity,
      status: "WORKING",
      reduceOnly: intent.reduceOnly,
      ownership: "OWNED",
      presentInOpenBook: true,
      anchorEpoch: intent.anchorEpoch,
      scopeKey: intent.scopeKey,
    };
    this.insertOrder(order);
    this.recordAuthority({
      source: "AUTHORITATIVE_OBSERVATION",
      evidenceId: `obs:${exchangeOrderId}`,
      exchangeOrderId,
      intentId: intent.intentId,
      clientOrderId: requireClientOrderId(intent.clientOrderId),
      scopeKey: intent.scopeKey,
      anchorEpoch: intent.anchorEpoch,
    });
    level.originalQuantity = intent.quantity;
    level.executedQuantity = "0";
    level.remainingQuantity = intent.quantity;
    level.workingExchangeOrderId = exchangeOrderId;
    if (intent.purpose === "GRID_ENTRY") {
      level.entryIntentId = intent.intentId;
      this.setState(level, "ENTRY_WORKING", "OBSERVATION");
    } else {
      level.exitIntentId = intent.intentId;
      this.setState(level, "EXIT_WORKING", "OBSERVATION");
    }
    this.unknownWrites.delete(intentId);
    this.refreshRiskBlock();
    return this.observeOrder(exchangeOrderId);
  }

  injectOwnedDuplicate(
    logicalLevelId: GridLogicalLevelId,
    price: DecimalString,
    quantity: DecimalString,
  ): ExchangeOrderId {
    const level = this.requireLevel(logicalLevelId);
    const exchangeOrderId = this.nextOrderId();
    const sourceIntentId = level.entryIntentId ?? level.exitIntentId;
    const sourceIntent = sourceIntentId === null ? undefined : this.intents.get(sourceIntentId);
    const clientOrderId = sourceIntent?.clientOrderId ?? `dup-${logicalLevelId}`;
    this.insertOrder({
      exchangeOrderId,
      clientOrderId,
      intentId: sourceIntentId,
      logicalLevelId,
      purpose: "GRID_ENTRY",
      side: level.logicalLevelId.startsWith("B") ? "BUY" : "SELL",
      type: "LIMIT",
      price,
      originalQuantity: quantity,
      executedQuantity: "0",
      remainingQuantity: quantity,
      status: "WORKING",
      reduceOnly: false,
      ownership: "OWNED",
      presentInOpenBook: true,
      anchorEpoch: this.init.anchorEpoch,
      scopeKey: this.scopeKey,
    });
    if (sourceIntent !== undefined && sourceIntent.clientOrderId !== null) {
      this.recordAuthority({
        source: "AUTHORITATIVE_OBSERVATION",
        evidenceId: `obs:${exchangeOrderId}`,
        exchangeOrderId,
        intentId: sourceIntent.intentId,
        clientOrderId: sourceIntent.clientOrderId,
        scopeKey: this.scopeKey,
        anchorEpoch: this.init.anchorEpoch,
      });
    }
    return exchangeOrderId;
  }

  applyExecution(input: {
    executionId?: ExecutionId;
    exchangeOrderId: ExchangeOrderId;
    quantity: DecimalString;
    price: DecimalString;
  }): ExecutionObservation | null {
    const quantity = parseDecimalString(input.quantity);
    const price = parseDecimalString(input.price);
    if (decimalCmp(quantity, "0") <= 0) {
      this.failIntegrity({
        code: "NON_POSITIVE_EXECUTION_QUANTITY",
        executionId: input.executionId ?? null,
        exchangeOrderId: input.exchangeOrderId,
      });
    }
    if (decimalCmp(price, "0") <= 0) {
      this.failIntegrity({
        code: "NON_POSITIVE_EXECUTION_PRICE",
        executionId: input.executionId ?? null,
        exchangeOrderId: input.exchangeOrderId,
      });
    }
    if (input.executionId !== undefined) {
      const existing = this.executions.get(input.executionId);
      if (existing !== undefined) {
        if (isExactExecutionReplay(existing, input.exchangeOrderId, quantity, price)) {
          return existing;
        }
        this.executionConflict = true;
        throw new Error("EXECUTION_ID_CONFLICT");
      }
    }
    const order = this.orders.get(input.exchangeOrderId);
    if (order === undefined) {
      this.failIntegrity({
        code: "EXECUTION_ORDER_MISSING",
        executionId: input.executionId ?? null,
        exchangeOrderId: input.exchangeOrderId,
      });
    }

    let executionId: ExecutionId;
    let nextExecutionSeq = this.executionSeq;
    if (input.executionId !== undefined) {
      executionId = input.executionId;
      const generatedSeq = parseGeneratedSequence(executionId, GENERATED_EXECUTION_PREFIX);
      if (generatedSeq !== null) {
        this.assertCommittedSequenceImportable(
          "execution",
          generatedSeq,
          executionId,
          order.exchangeOrderId,
        );
        if (generatedSeq > nextExecutionSeq) {
          nextExecutionSeq = generatedSeq;
        }
      }
    } else {
      this.assertSequenceIncrementable("execution");
      const candidateSeq = this.executionSeq + 1;
      executionId = formatGeneratedId(GENERATED_EXECUTION_PREFIX, candidateSeq);
      if (this.executions.has(executionId)) {
        this.failIntegrity({
          code: "EXECUTION_ID_COLLISION",
          executionId,
          exchangeOrderId: order.exchangeOrderId,
        });
      }
      nextExecutionSeq = candidateSeq;
    }

    const residual = decimalSub(order.originalQuantity, order.executedQuantity);
    if (decimalCmp(quantity, residual) > 0) {
      this.failIntegrity({
        code: "EXECUTION_OVERFILL",
        executionId,
        exchangeOrderId: order.exchangeOrderId,
      });
    }

    const nextExecutedQuantity = decimalAdd(order.executedQuantity, quantity);
    const nextRemainingQuantity = remainingAfter(order.originalQuantity, nextExecutedQuantity);
    const nextOrder: InternalOrder = {
      ...order,
      executedQuantity: nextExecutedQuantity,
      remainingQuantity: nextRemainingQuantity,
      status: decimalIsZero(nextRemainingQuantity) ? "FILLED" : "PARTIALLY_FILLED",
      presentInOpenBook: decimalIsZero(nextRemainingQuantity) ? false : order.presentInOpenBook,
    };
    const execution: ExecutionObservation = {
      venue: this.init.venue,
      market: this.init.market,
      executionId,
      exchangeOrderId: order.exchangeOrderId,
      clientOrderId: order.clientOrderId,
      side: order.side,
      price,
      quantity,
      feeAmount: null,
      feeAsset: null,
      liquidity: "UNKNOWN",
      meta: this.meta("execution"),
    };
    let computed: { nextLevel?: MutableLevel; nextExitIntent?: OrderIntent };
    try {
      computed = this.computeExecutionEffects(order, nextOrder, execution);
    } catch (error) {
      this.recordExecutionEffectFault(error, executionId, order.exchangeOrderId);
      throw error;
    }
    if (!this.hasProvenAuthorityLinkage(order)) {
      this.failIntegrity({
        code: "EXECUTION_AUTHORITY_UNPROVEN",
        executionId,
        exchangeOrderId: order.exchangeOrderId,
      });
    }
    const nextPosition = this.nextPositionAfterFill(order.side, quantity);

    this.insertExecution(execution);
    this.commitOrderQuantities(order, nextOrder);
    if (computed.nextLevel !== undefined) {
      this.levels.set(computed.nextLevel.logicalLevelId, computed.nextLevel);
    }
    if (computed.nextExitIntent !== undefined) {
      this.intents.set(computed.nextExitIntent.intentId, computed.nextExitIntent);
    }
    this.position = nextPosition;
    this.executionSeq = nextExecutionSeq;
    return execution;
  }

  requestCancel(
    exchangeOrderId: ExchangeOrderId,
    outcome: WriteOutcomeKind,
  ): VenueWriteResult<CancelAck> {
    const order = this.orders.get(exchangeOrderId);
    if (order === undefined) {
      return { kind: "NOT_SENT", reason: "ORDER_NOT_FOUND" };
    }
    const ownership = this.classifyObserved(order);
    if (ownership === "UNOWNED") {
      return { kind: "NOT_SENT", reason: "REFUSES_UNOWNED_CANCEL" };
    }
    if (ownership !== "OWNED") {
      return { kind: "NOT_SENT", reason: "REFUSES_UNPROVEN_CANCEL_AUTHORITY" };
    }
    if (outcome === "NOT_SENT") {
      return { kind: "NOT_SENT", reason: "LOCAL_GATE" };
    }

    const level = order.logicalLevelId === null ? undefined : this.levels.get(order.logicalLevelId);
    const hasExecution = decimalCmp(order.executedQuantity, "0") > 0;
    const remainingIsZero = decimalIsZero(order.remainingQuantity);

    if (hasExecution && remainingIsZero) {
      order.presentInOpenBook = false;
      if (outcome === "UNKNOWN") {
        this.riskIncreaseBlocked = true;
        return {
          kind: "UNKNOWN",
          reason: "CANCEL_UNKNOWN",
          requestFingerprint: `cancel:${exchangeOrderId}`,
          lastKnownMeta: this.meta("cancel"),
        };
      }
      if (outcome !== "ACK") {
        return {
          kind: "REJECTED",
          code: "CANCEL_REJECTED",
          message: "Simulator rejected cancel",
          meta: this.meta("cancel"),
        };
      }
      return {
        kind: "ACK",
        ack: { exchangeOrderId, cancelled: true },
        meta: this.meta("cancel"),
      };
    }

    if (level !== undefined) {
      this.setState(level, "CANCEL_PENDING", "LOCAL");
    }
    if (outcome === "UNKNOWN") {
      this.riskIncreaseBlocked = true;
      if (level !== undefined) {
        this.setState(level, "RECONCILING", "UNKNOWN");
      }
      return {
        kind: "UNKNOWN",
        reason: "CANCEL_UNKNOWN",
        requestFingerprint: `cancel:${exchangeOrderId}`,
        lastKnownMeta: this.meta("cancel"),
      };
    }
    if (outcome !== "ACK") {
      if (level !== undefined) {
        this.setState(level, this.workingStateAfterRejectedCancel(order), "REJECTED");
      }
      return {
        kind: "REJECTED",
        code: "CANCEL_REJECTED",
        message: "Simulator rejected cancel",
        meta: this.meta("cancel"),
      };
    }
    order.status = "CANCELLED";
    order.presentInOpenBook = false;
    order.remainingQuantity = "0";
    if (level !== undefined) {
      level.remainingQuantity = "0";
      level.workingExchangeOrderId = null;
      this.markPurposeTerminal(level, order.purpose);
      if (!decimalIsZero(level.openInventory)) {
        this.setState(level, "POSITION_OPEN", "ACK");
        this.ensureExitIntent(level);
      } else {
        this.setState(level, "IDLE", "ACK");
      }
    }
    return {
      kind: "ACK",
      ack: { exchangeOrderId, cancelled: true },
      meta: this.meta("cancel"),
    };
  }

  disappear(exchangeOrderId: ExchangeOrderId): void {
    const order = this.orders.get(exchangeOrderId);
    if (order === undefined) {
      throw new Error("UNKNOWN_EXCHANGE_ORDER");
    }
    order.presentInOpenBook = false;
    order.status = "DISAPPEARED";
    if (order.logicalLevelId !== null) {
      const level = this.requireLevel(order.logicalLevelId);
      this.setState(level, "RECONCILING", "OBSERVATION");
      this.riskIncreaseBlocked = true;
    }
  }

  applyPositionDelta(signedQuantity: DecimalString): void {
    this.position = {
      ...this.position,
      quantity: parseDecimalString(signedQuantity),
      meta: this.meta("position-delta"),
    };
  }

  injectForeignOrder(
    order: Omit<InternalOrder, "ownership" | "presentInOpenBook" | "intentId">,
  ): void {
    this.insertOrder({
      ...order,
      intentId: null,
      ownership: "UNOWNED",
      presentInOpenBook: true,
    });
  }

  injectAmbiguousOrder(
    exchangeOrderId: ExchangeOrderId,
    side: "BUY" | "SELL",
    price: DecimalString,
    quantity: DecimalString,
  ): void {
    this.insertOrder({
      exchangeOrderId,
      clientOrderId: null,
      intentId: null,
      logicalLevelId: null,
      purpose: "GRID_ENTRY",
      side,
      type: "LIMIT",
      price,
      originalQuantity: quantity,
      executedQuantity: "0",
      remainingQuantity: quantity,
      status: "WORKING",
      reduceOnly: false,
      ownership: "AMBIGUOUS",
      presentInOpenBook: true,
      anchorEpoch: null,
      scopeKey: null,
    });
    this.riskIncreaseBlocked = true;
  }

  markExecutionGap(): void {
    this.executionGap = true;
    this.riskIncreaseBlocked = true;
  }

  markSnapshotStale(): void {
    this.snapshotStale = true;
    this.riskIncreaseBlocked = true;
  }

  classifyObserved(
    order: Pick<InternalOrder, "clientOrderId" | "exchangeOrderId" | "scopeKey" | "anchorEpoch">,
  ): Ownership {
    const stored = this.orders.get(order.exchangeOrderId ?? ("" as ExchangeOrderId));
    const identity = {
      clientOrderId: stored?.clientOrderId ?? order.clientOrderId,
      exchangeOrderId: stored?.exchangeOrderId ?? order.exchangeOrderId,
      scopeKey: stored?.scopeKey ?? order.scopeKey,
      anchorEpoch: stored?.anchorEpoch ?? order.anchorEpoch,
    };
    const classified = classifyOwnership(identity, this.ownershipEvidence());
    if (classified === "UNOWNED") {
      return "UNOWNED";
    }
    if (stored !== undefined) {
      return this.hasProvenAuthorityLinkage(stored) ? "OWNED" : "AMBIGUOUS";
    }
    return classified;
  }

  planDuplicateCleanup(logicalLevelId: GridLogicalLevelId): DuplicateCleanupPlan {
    const owned = [...this.orders.values()]
      .filter(
        (order) =>
          this.classifyObserved(order) === "OWNED" &&
          order.logicalLevelId === logicalLevelId &&
          order.presentInOpenBook,
      )
      .map((order) => order.exchangeOrderId);
    return planOwnedDuplicateCleanup(owned, logicalLevelId);
  }

  planDuplicateCleanupByPrice(price: DecimalString): DuplicateCleanupPlan {
    const owned = [...this.orders.values()]
      .filter(
        (order) =>
          this.classifyObserved(order) === "OWNED" &&
          order.price !== null &&
          decimalCmp(order.price, price) === 0 &&
          order.presentInOpenBook,
      )
      .map((order) => order.exchangeOrderId);
    return planOwnedDuplicateCleanup(owned, null);
  }

  cancelCandidatesInclude(plan: DuplicateCleanupPlan, exchangeOrderId: ExchangeOrderId): boolean {
    return plan.cancelExchangeOrderIds.includes(exchangeOrderId);
  }

  listOpenOrders(): ExchangeOrderObservation[] {
    return [...this.orders.values()]
      .filter((order) => order.presentInOpenBook)
      .map((order) => this.toObservation(order));
  }

  listExecutions(): ExecutionObservation[] {
    return [...this.executions.values()];
  }

  level(logicalLevelId: GridLogicalLevelId): LevelView {
    return structuredClone(this.requireLevel(logicalLevelId));
  }

  getPosition(): PositionSnapshot {
    return { ...this.position, meta: { ...this.position.meta } };
  }

  getAccount(): AccountSnapshot {
    return { ...this.account, meta: { ...this.account.meta } };
  }

  possibleExposure(): PossibleExposure {
    const ownedWorkingRiskIncreasing = [...this.orders.values()]
      .filter((order) => this.isOwnedWorkingRiskIncreasing(order))
      .map((order) => ({
        exchangeOrderId: order.exchangeOrderId,
        logicalLevelId: order.logicalLevelId,
        side: order.side,
        price: order.price,
        quantity: order.remainingQuantity,
      }))
      .sort((left, right) => compareExchangeOrderId(left.exchangeOrderId, right.exchangeOrderId));
    const unknownSubmissions = [...this.unknownWrites.values()]
      .filter((write) => write.purpose === "GRID_ENTRY")
      .map((write) => ({
        intentId: write.intentId,
        price: write.price,
        quantity: write.quantity,
      }));
    const proposedRiskIncreasing = this.currentEntryIntents()
      .filter((intent) => {
        const levelId = intent.logicalLevelId;
        if (levelId === null) {
          return false;
        }
        const level = this.levels.get(levelId as GridLogicalLevelId);
        return level?.state === "IDLE" && this.entriesPlanned;
      })
      .map((intent) => ({
        intentId: intent.intentId,
        price: intent.price,
        quantity: intent.quantity,
      }));
    return {
      signedPosition: this.position.quantity,
      ownedWorkingRiskIncreasing,
      unknownSubmissions,
      proposedRiskIncreasing,
    };
  }

  canIncreaseRisk(): boolean {
    return !this.riskIncreaseBlocked && !this.hasDerivedRiskBlockers();
  }

  exportSnapshot(): SimulatorSnapshot {
    return {
      schemaVersion: "phase1-simulator-2",
      init: this.init,
      config: this.config,
      entriesPlanned: this.entriesPlanned,
      riskIncreaseBlocked: this.riskIncreaseBlocked,
      executionGap: this.executionGap,
      executionConflict: this.executionConflict,
      executionIntegrityFault: this.executionIntegrityFault,
      snapshotStale: this.snapshotStale,
      orderSeq: this.orderSeq,
      executionSeq: this.executionSeq,
      levels: ALL_LEVELS.map((logicalLevelId) => {
        const level = this.requireLevel(logicalLevelId);
        return {
          ...level,
          executionIds: [...level.executionIds],
        };
      }),
      intents: [...this.intents.values()],
      orders: [...this.orders.values()].map((order) => ({
        ...order,
        ownership: this.classifyObserved(order),
      })),
      authorityLinks: [...this.authorityLinks.values()].sort((left, right) =>
        left.exchangeOrderId < right.exchangeOrderId
          ? -1
          : left.exchangeOrderId > right.exchangeOrderId
            ? 1
            : left.evidenceId < right.evidenceId
              ? -1
              : left.evidenceId > right.evidenceId
                ? 1
                : 0,
      ),
      executions: [...this.executions.values()],
      unknownWrites: [...this.unknownWrites.values()],
      position: this.position,
      account: this.account,
    };
  }

  private initializeLevels(): void {
    const normalized = normalizeTheoreticalGrid(
      theoreticalGrid(this.init.anchorPrice),
      this.init.marketRules,
      this.init.priceRounding,
    );
    for (const level of normalized) {
      this.levels.set(level.logicalLevelId, this.createLevel(level));
    }
  }

  private createLevel(level: NormalizedLevel): MutableLevel {
    return {
      logicalLevelId: level.logicalLevelId,
      state: "IDLE",
      theoreticalEntryPrice: level.theoreticalPrice,
      normalizedEntryPrice: level.normalizedPrice,
      theoreticalExitPrice: theoreticalExitPrice(this.init.anchorPrice, level.logicalLevelId),
      normalizedExitPrice: normalizePrice(
        theoreticalExitPrice(this.init.anchorPrice, level.logicalLevelId),
        this.init.marketRules,
        this.init.priceRounding,
      ),
      originalQuantity: null,
      executedQuantity: "0",
      remainingQuantity: null,
      openInventory: "0",
      entryExecutedQuantity: "0",
      exitExecutedQuantity: "0",
      executionIds: [],
      weightedExecutionPrice: null,
      entryIntentId: null,
      exitIntentId: null,
      entryMutationSequence: "0",
      exitMutationSequence: "0",
      entryIntentTerminal: true,
      exitIntentTerminal: true,
      workingExchangeOrderId: null,
    };
  }

  private createIntent(input: {
    logicalLevelId: GridLogicalLevelId;
    purpose: IntentPurpose;
    side: "BUY" | "SELL";
    price: DecimalString;
    quantity: DecimalString;
    reduceOnly: boolean;
    sequence: string;
  }): OrderIntent {
    const intent = this.buildIntent(input);
    this.intents.set(intent.intentId, intent);
    return intent;
  }

  private buildIntent(input: {
    logicalLevelId: GridLogicalLevelId;
    purpose: IntentPurpose;
    side: "BUY" | "SELL";
    price: DecimalString;
    quantity: DecimalString;
    reduceOnly: boolean;
    sequence: string;
  }): OrderIntent {
    const intentId = makeIntentId({
      experimentId: this.init.experimentId,
      runId: this.init.runId,
      scopeKey: this.scopeKey,
      anchorEpoch: this.init.anchorEpoch,
      logicalLevelId: input.logicalLevelId,
      purpose: input.purpose,
      sequence: input.sequence,
    });
    return {
      intentId,
      experimentId: this.init.experimentId,
      runId: this.init.runId,
      scopeKey: this.scopeKey,
      anchorEpoch: this.init.anchorEpoch,
      logicalLevelId: input.logicalLevelId,
      purpose: input.purpose,
      side: input.side,
      type: "LIMIT",
      timeInForce: "GTC",
      price: input.price,
      quantity: input.quantity,
      reduceOnly: input.reduceOnly,
      clientOrderId: makeClientOrderId({
        scopeKey: this.scopeKey,
        anchorEpoch: this.init.anchorEpoch,
        logicalLevelId: input.logicalLevelId,
        purpose: input.purpose,
        intentId,
      }),
      leaseGeneration: this.init.leaseGeneration,
      createdAt: this.init.createdAt,
    };
  }

  private computeExecutionEffects(
    order: InternalOrder,
    nextOrder: InternalOrder,
    execution: ExecutionObservation,
  ): { nextLevel?: MutableLevel; nextExitIntent?: OrderIntent } {
    if (order.logicalLevelId === null) {
      return {};
    }
    const level = this.requireLevel(order.logicalLevelId);
    const nextLevel: MutableLevel = {
      ...level,
      executionIds: [...level.executionIds, execution.executionId],
    };
    nextLevel.executedQuantity = nextOrder.executedQuantity;
    nextLevel.remainingQuantity = nextOrder.remainingQuantity;
    nextLevel.originalQuantity = nextOrder.originalQuantity;
    nextLevel.weightedExecutionPrice = weightedPrice([
      ...[...this.executions.values()].filter(
        (item) => item.exchangeOrderId === order.exchangeOrderId,
      ),
      execution,
    ]);
    this.applyInventory(nextLevel, order.purpose, execution.quantity);
    let nextExitIntent: OrderIntent | undefined;
    const attachExitIfNeeded = (): void => {
      const built = this.buildExitIntent(nextLevel);
      if (built === undefined) {
        return;
      }
      nextExitIntent = built.intent;
      nextLevel.exitIntentId = built.intent.intentId;
      nextLevel.exitMutationSequence = built.sequence;
      nextLevel.exitIntentTerminal = false;
    };
    if (order.purpose === "GRID_ENTRY") {
      if (decimalIsZero(nextOrder.remainingQuantity)) {
        this.markPurposeTerminal(nextLevel, "GRID_ENTRY");
        this.setState(nextLevel, "POSITION_OPEN", "OBSERVATION");
        attachExitIfNeeded();
        nextLevel.workingExchangeOrderId = null;
      } else {
        this.setState(nextLevel, "ENTRY_PARTIAL", "OBSERVATION");
      }
      return nextExitIntent === undefined ? { nextLevel } : { nextLevel, nextExitIntent };
    }
    if (order.purpose === "GRID_EXIT") {
      if (decimalIsZero(nextOrder.remainingQuantity)) {
        this.markPurposeTerminal(nextLevel, "GRID_EXIT");
        nextLevel.workingExchangeOrderId = null;
        if (decimalIsZero(nextLevel.openInventory)) {
          this.setState(nextLevel, "IDLE", "OBSERVATION");
        } else {
          this.setState(nextLevel, "POSITION_OPEN", "OBSERVATION");
          attachExitIfNeeded();
        }
      } else {
        this.setState(nextLevel, "EXIT_PARTIAL", "OBSERVATION");
      }
    }
    return nextExitIntent === undefined ? { nextLevel } : { nextLevel, nextExitIntent };
  }

  private buildExitIntent(
    level: MutableLevel,
  ): { intent: OrderIntent; sequence: string } | undefined {
    if (level.exitIntentId !== null && !level.exitIntentTerminal) {
      return undefined;
    }
    if (decimalIsZero(level.openInventory)) {
      return undefined;
    }
    const sequence = nextSequence(level.exitMutationSequence);
    return {
      sequence,
      intent: this.buildIntent({
        logicalLevelId: level.logicalLevelId,
        purpose: "GRID_EXIT",
        side: oppositeSide(level.logicalLevelId),
        price: level.normalizedExitPrice,
        quantity: level.openInventory,
        reduceOnly: true,
        sequence,
      }),
    };
  }

  private ensureExitIntent(level: MutableLevel): void {
    const built = this.buildExitIntent(level);
    if (built === undefined) {
      return;
    }
    this.intents.set(built.intent.intentId, built.intent);
    level.exitIntentId = built.intent.intentId;
    level.exitMutationSequence = built.sequence;
    level.exitIntentTerminal = false;
  }

  private nextPositionAfterFill(side: "BUY" | "SELL", quantity: DecimalString): PositionSnapshot {
    const delta = side === "BUY" ? quantity : decimalMul(quantity, "-1");
    return {
      ...this.position,
      quantity: decimalAdd(this.position.quantity, delta),
      meta: this.meta("position"),
    };
  }

  private commitOrderQuantities(order: InternalOrder, nextOrder: InternalOrder): void {
    order.executedQuantity = nextOrder.executedQuantity;
    order.remainingQuantity = nextOrder.remainingQuantity;
    order.status = nextOrder.status;
    order.presentInOpenBook = nextOrder.presentInOpenBook;
  }

  private setState(
    level: MutableLevel,
    next: GridLevelState,
    evidence: "ACK" | "OBSERVATION" | "REJECTED" | "UNKNOWN" | "LOCAL",
  ): void {
    assertTransition(level.state, next, evidence);
    level.state = next;
  }

  private refreshRiskBlock(): void {
    this.riskIncreaseBlocked = this.hasDerivedRiskBlockers();
  }

  private isOwnedWorkingRiskIncreasing(order: InternalOrder): boolean {
    if (!order.presentInOpenBook) {
      return false;
    }
    if (this.classifyObserved(order) !== "OWNED") {
      return false;
    }
    if (order.purpose !== "GRID_ENTRY" || order.reduceOnly) {
      return false;
    }
    if (decimalCmp(order.remainingQuantity, "0") <= 0) {
      return false;
    }
    return order.status === "WORKING" || order.status === "PARTIALLY_FILLED";
  }

  private hasDerivedRiskBlockers(): boolean {
    if (
      this.executionGap ||
      this.executionConflict ||
      this.executionIntegrityFault !== null ||
      this.snapshotStale
    ) {
      return true;
    }
    if (this.unknownWrites.size > 0) {
      return true;
    }
    if (
      [...this.levels.values()].some(
        (level) => level.state === "RECONCILING" || level.state === "ERROR_REQUIRES_RECONCILIATION",
      )
    ) {
      return true;
    }
    return [...this.orders.values()].some((order) => this.classifyObserved(order) === "AMBIGUOUS");
  }

  private seedIdleTerminalLevels(quantity: DecimalString): void {
    for (const level of this.levels.values()) {
      if (level.state !== "IDLE" || !level.entryIntentTerminal) {
        continue;
      }
      if (!decimalIsZero(level.openInventory)) {
        continue;
      }
      this.resetLevelForNewCycle(level);
      const sequence = nextSequence(level.entryMutationSequence);
      const intent = this.createIntent({
        logicalLevelId: level.logicalLevelId,
        purpose: "GRID_ENTRY",
        side: level.logicalLevelId.startsWith("B") ? "BUY" : "SELL",
        price: level.normalizedEntryPrice,
        quantity,
        reduceOnly: false,
        sequence,
      });
      this.assignEntryIntent(level, intent, sequence);
    }
  }

  private assignEntryIntent(level: MutableLevel, intent: OrderIntent, sequence: string): void {
    level.entryIntentId = intent.intentId;
    level.entryMutationSequence = sequence;
    level.entryIntentTerminal = false;
  }

  private resetLevelForNewCycle(level: MutableLevel): void {
    level.exitIntentId = null;
    level.exitIntentTerminal = true;
    level.entryExecutedQuantity = "0";
    level.exitExecutedQuantity = "0";
    level.openInventory = "0";
    level.executionIds = [];
    level.originalQuantity = null;
    level.executedQuantity = "0";
    level.remainingQuantity = null;
    level.weightedExecutionPrice = null;
    level.workingExchangeOrderId = null;
  }

  private applyInventory(
    level: MutableLevel,
    purpose: IntentPurpose,
    quantity: DecimalString,
  ): void {
    if (purpose === "GRID_ENTRY") {
      level.entryExecutedQuantity = decimalAdd(level.entryExecutedQuantity, quantity);
    } else if (purpose === "GRID_EXIT") {
      level.exitExecutedQuantity = decimalAdd(level.exitExecutedQuantity, quantity);
    }
    if (decimalCmp(level.exitExecutedQuantity, level.entryExecutedQuantity) > 0) {
      throw new Error("NEGATIVE_OPEN_INVENTORY");
    }
    level.openInventory = decimalSub(level.entryExecutedQuantity, level.exitExecutedQuantity);
  }

  private markPurposeTerminal(level: MutableLevel, purpose: IntentPurpose): void {
    if (purpose === "GRID_ENTRY") {
      level.entryIntentTerminal = true;
    } else if (purpose === "GRID_EXIT") {
      level.exitIntentTerminal = true;
    }
  }

  private isIntentTerminal(
    level: MutableLevel,
    purpose: IntentPurpose,
    intentId: IntentId,
  ): boolean {
    if (purpose === "GRID_ENTRY") {
      return level.entryIntentId === intentId && level.entryIntentTerminal;
    }
    if (purpose === "GRID_EXIT") {
      return level.exitIntentId === intentId && level.exitIntentTerminal;
    }
    return false;
  }

  private currentEntryIntents(): OrderIntent[] {
    const intents: OrderIntent[] = [];
    for (const level of this.levels.values()) {
      if (level.entryIntentId === null || level.entryIntentTerminal) {
        continue;
      }
      const intent = this.intents.get(level.entryIntentId);
      if (intent !== undefined) {
        intents.push(intent);
      }
    }
    return intents;
  }

  private workingStateAfterRejectedCancel(order: InternalOrder): GridLevelState {
    if (decimalCmp(order.executedQuantity, "0") > 0) {
      return order.purpose === "GRID_EXIT" ? "EXIT_PARTIAL" : "ENTRY_PARTIAL";
    }
    return order.purpose === "GRID_EXIT" ? "EXIT_WORKING" : "ENTRY_WORKING";
  }

  private ownershipEvidence() {
    const currentIntents = [...this.intents.values()].filter((intent) =>
      this.isCurrentScopeIntent(intent),
    );
    return {
      currentScopeKey: this.scopeKey,
      currentAnchorEpoch: this.init.anchorEpoch,
      knownClientOrderIds: new Set(
        currentIntents
          .map((intent) => intent.clientOrderId)
          .filter((value): value is ClientOrderId => value !== null),
      ),
      knownExchangeOrderIds: new Set(this.authorityLinks.keys()),
      clientOrderEpochById: new Map(
        currentIntents
          .filter((intent) => intent.clientOrderId !== null)
          .map((intent) => [intent.clientOrderId as ClientOrderId, intent.anchorEpoch]),
      ),
      authorityLinks: [...this.authorityLinks.values()],
    };
  }

  private isCurrentScopeIntent(intent: OrderIntent): boolean {
    return (
      intent.experimentId === this.init.experimentId &&
      intent.runId === this.init.runId &&
      intent.scopeKey === this.scopeKey &&
      intent.anchorEpoch === this.init.anchorEpoch
    );
  }

  private hasProvenAuthorityLinkage(order: InternalOrder): boolean {
    const link = this.authorityLinks.get(order.exchangeOrderId);
    if (
      link === undefined ||
      !isProvenAuthoritySource(link.source) ||
      link.evidenceId.length === 0
    ) {
      return false;
    }
    if (order.intentId === null || link.intentId !== order.intentId) {
      return false;
    }
    const intent = this.intents.get(link.intentId);
    if (
      intent === undefined ||
      !this.isCurrentScopeIntent(intent) ||
      intent.clientOrderId === null
    ) {
      return false;
    }
    if (
      link.exchangeOrderId !== order.exchangeOrderId ||
      link.clientOrderId !== order.clientOrderId ||
      link.clientOrderId !== intent.clientOrderId ||
      order.clientOrderId !== intent.clientOrderId
    ) {
      return false;
    }
    if (
      link.scopeKey !== this.scopeKey ||
      link.anchorEpoch !== this.init.anchorEpoch ||
      order.scopeKey !== link.scopeKey ||
      order.anchorEpoch !== link.anchorEpoch ||
      intent.scopeKey !== link.scopeKey ||
      intent.anchorEpoch !== link.anchorEpoch
    ) {
      return false;
    }
    if (order.logicalLevelId !== intent.logicalLevelId) {
      return false;
    }
    if (order.purpose !== intent.purpose || order.side !== intent.side) {
      return false;
    }
    return decimalCmp(order.originalQuantity, intent.quantity) === 0;
  }

  private recordAuthority(link: OrderAuthorityLink): void {
    if (link.evidenceId.length === 0) {
      throw new Error("EMPTY_AUTHORITY_EVIDENCE_ID");
    }
    if (!isProvenAuthoritySource(link.source)) {
      throw new Error("INVALID_AUTHORITY_SOURCE");
    }
    if ([...this.authorityLinks.values()].some((item) => item.evidenceId === link.evidenceId)) {
      throw new Error("DUPLICATE_AUTHORITY_EVIDENCE_ID");
    }
    if (this.authorityLinks.has(link.exchangeOrderId)) {
      throw new Error("CONFLICTING_ORDER_AUTHORITY");
    }
    this.authorityLinks.set(link.exchangeOrderId, link);
  }

  private observeOrder(exchangeOrderId: ExchangeOrderId): ExchangeOrderObservation {
    const order = this.orders.get(exchangeOrderId);
    if (order === undefined) {
      throw new Error("UNKNOWN_EXCHANGE_ORDER");
    }
    return this.toObservation(order);
  }

  private toObservation(order: InternalOrder): ExchangeOrderObservation {
    return {
      venue: this.init.venue,
      market: this.init.market,
      exchangeOrderId: order.exchangeOrderId,
      clientOrderId: order.clientOrderId,
      side: order.side,
      type: order.type,
      price: order.price,
      originalQuantity: order.originalQuantity,
      executedQuantity: order.executedQuantity,
      remainingQuantity: order.remainingQuantity,
      status: order.status,
      reduceOnly: order.reduceOnly,
      ownership: this.classifyObserved(order),
      meta: this.meta("open-order"),
    };
  }

  private requireIntent(intentId: IntentId): OrderIntent {
    const intent = this.intents.get(intentId);
    if (intent === undefined) {
      throw new Error(`UNKNOWN_INTENT:${intentId}`);
    }
    return intent;
  }

  private requireLevel(logicalLevelId: GridLogicalLevelId): MutableLevel {
    const level = this.levels.get(logicalLevelId);
    if (level === undefined) {
      throw new Error(`UNKNOWN_LEVEL:${logicalLevelId}`);
    }
    return level;
  }

  private requireLevelId(logicalLevelId: string | null): GridLogicalLevelId {
    if (logicalLevelId === null || !ALL_LEVELS.includes(logicalLevelId as GridLogicalLevelId)) {
      throw new Error("INTENT_MISSING_LEVEL");
    }
    return logicalLevelId as GridLogicalLevelId;
  }

  private nextOrderId(): ExchangeOrderId {
    const exchangeOrderId = this.peekGeneratedOrderId();
    this.orderSeq += 1;
    return exchangeOrderId;
  }

  private peekGeneratedOrderId(): ExchangeOrderId {
    this.assertSequenceIncrementable("order");
    const exchangeOrderId = formatGeneratedId(GENERATED_ORDER_PREFIX, this.orderSeq + 1);
    if (this.orders.has(exchangeOrderId)) {
      this.failIntegrity({
        code: "ORDER_ID_COLLISION",
        executionId: null,
        exchangeOrderId,
      });
    }
    return exchangeOrderId;
  }

  private assertSequenceIncrementable(kind: "order" | "execution"): void {
    const sequence = kind === "order" ? this.orderSeq : this.executionSeq;
    this.assertCommittedSequenceImportable(
      kind,
      sequence + 1,
      null,
      `${kind}Seq:${String(sequence)}`,
    );
  }

  private assertCommittedSequenceImportable(
    kind: "order" | "execution",
    committedSequence: number,
    executionId: ExecutionId | null,
    exchangeOrderId: ExchangeOrderId,
  ): void {
    if (isImportableSequenceCounter(committedSequence)) {
      return;
    }
    this.failIntegrity({
      code: kind === "order" ? "ORDER_SEQ_EXHAUSTED" : "EXECUTION_SEQ_EXHAUSTED",
      executionId,
      exchangeOrderId,
    });
  }

  private recordExecutionEffectFault(
    error: unknown,
    executionId: ExecutionId,
    exchangeOrderId: ExchangeOrderId,
  ): void {
    if (error instanceof Error && error.message === "NEGATIVE_OPEN_INVENTORY") {
      this.recordIntegrityFault({
        code: "EXECUTION_INVENTORY_CONFLICT",
        executionId,
        exchangeOrderId,
      });
      return;
    }
    if (error instanceof Error && error.message.startsWith("FORBIDDEN_STATE_TRANSITION")) {
      this.recordIntegrityFault({
        code: "EXECUTION_STATE_TRANSITION_INVALID",
        executionId,
        exchangeOrderId,
      });
      return;
    }
    this.recordIntegrityFault({
      code: "EXECUTION_EFFECT_CALCULATION_FAILURE",
      executionId,
      exchangeOrderId,
    });
  }

  private insertOrder(order: InternalOrder): void {
    if (this.orders.has(order.exchangeOrderId)) {
      this.failIntegrity({
        code: "ORDER_ID_COLLISION",
        executionId: null,
        exchangeOrderId: order.exchangeOrderId,
      });
    }
    this.orders.set(order.exchangeOrderId, order);
  }

  private insertExecution(execution: ExecutionObservation): void {
    if (this.executions.has(execution.executionId)) {
      this.failIntegrity({
        code: "EXECUTION_ID_COLLISION",
        executionId: execution.executionId,
        exchangeOrderId: execution.exchangeOrderId,
      });
    }
    this.executions.set(execution.executionId, execution);
  }

  private recordIntegrityFault(fault: ExecutionIntegrityFault): void {
    if (this.executionIntegrityFault !== null) {
      return;
    }
    this.executionIntegrityFault = {
      code: fault.code,
      executionId: fault.executionId,
      exchangeOrderId: fault.exchangeOrderId,
    };
  }

  private failIntegrity(fault: ExecutionIntegrityFault): never {
    this.recordIntegrityFault(fault);
    throw new SimulatorIntegrityError(fault.code);
  }

  private meta(source: string): ObservationMeta {
    const freshnessMs = this.snapshotStale ? 60_000 : 0;
    return {
      venue: this.init.venue,
      source,
      serverTime: this.snapshotStale ? null : this.init.createdAt,
      receivedAt: this.init.createdAt,
      observedAt: this.init.createdAt,
      freshnessMs,
      sequence: null,
    };
  }
}

const GENERATED_ORDER_PREFIX = "sim-ord-";
const GENERATED_EXECUTION_PREFIX = "sim-exec-";

function formatGeneratedId(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(4, "0")}`;
}

function parseGeneratedSequence(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) {
    return null;
  }
  const digits = id.slice(prefix.length);
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function requireClientOrderId(clientOrderId: ClientOrderId | null): ClientOrderId {
  if (clientOrderId === null) {
    throw new Error("AUTHORITY_REQUIRES_CLIENT_ORDER_ID");
  }
  return clientOrderId;
}

export function requestFingerprint(venue: VenueId, market: MarketId, intent: OrderIntent): string {
  return [
    venue,
    market,
    intent.intentId,
    intent.clientOrderId ?? "",
    intent.side,
    intent.type,
    intent.price ?? "",
    intent.quantity,
    intent.reduceOnly ? "1" : "0",
    intent.purpose,
    intent.leaseGeneration,
  ].join("|");
}

function isExactExecutionReplay(
  existing: ExecutionObservation,
  exchangeOrderId: ExchangeOrderId,
  quantity: DecimalString,
  price: DecimalString,
): boolean {
  return (
    existing.exchangeOrderId === exchangeOrderId &&
    decimalCmp(existing.quantity, quantity) === 0 &&
    decimalCmp(existing.price, price) === 0
  );
}

function compareExchangeOrderId(left: ExchangeOrderId, right: ExchangeOrderId): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function nextSequence(current: string): string {
  if (!/^\d+$/.test(current)) {
    throw new Error("INVALID_MUTATION_SEQUENCE");
  }
  return (BigInt(current) + 1n).toString(10);
}

function remainingAfter(original: DecimalString, executed: DecimalString): DecimalString {
  const remaining = decimalAdd(original, decimalMul(executed, "-1"));
  if (decimalCmp(remaining, "0") < 0) {
    throw new Error("NEGATIVE_REMAINING_QUANTITY");
  }
  return remaining;
}

function weightedPrice(executions: ExecutionObservation[]): DecimalString | null {
  if (executions.length === 0) {
    return null;
  }
  let notional = "0";
  let quantity = "0";
  for (const execution of executions) {
    notional = decimalAdd(notional, decimalMul(execution.price, execution.quantity));
    quantity = decimalAdd(quantity, execution.quantity);
  }
  if (decimalIsZero(quantity)) {
    return null;
  }
  return decimalDiv(notional, quantity, "HALF_UP");
}
