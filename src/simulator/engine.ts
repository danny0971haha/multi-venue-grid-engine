import { V01_EXPERIMENT_CONFIG } from "../domain/config.js";
import type {
  GridLevelState,
  IntentPurpose,
  Ownership,
  WriteOutcomeKind,
} from "../domain/enums.js";
import {
  ALL_LEVELS,
  makeClientOrderId,
  makeIntentId,
  makeScopeKey,
  type AnchorEpoch,
  type ClientOrderId,
  type ExchangeOrderId,
  type ExecutionId,
  type ExperimentId,
  type GridLogicalLevelId,
  type IntentId,
  type MarketId,
  type RunId,
  type ScopeKey,
  type VenueId,
} from "../domain/ids.js";
import {
  classifyOwnership,
  planOwnedDuplicateCleanup,
  type DuplicateCleanupPlan,
} from "../domain/ownership.js";
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
  decimalAdd,
  decimalCmp,
  decimalDiv,
  decimalIsZero,
  decimalMul,
  parseDecimalString,
  type DecimalRounding,
  type DecimalString,
} from "../math/decimal.js";
import {
  evaluateGridQuantity,
  normalizeTheoreticalGrid,
  oppositeSide,
  theoreticalExitPrice,
  theoreticalGrid,
  type NormalizedLevel,
} from "../strategy/geometry.js";
import {
  assessEnvelopeFeasibility,
  normalizePrice,
  normalizeQuantity,
  type MarketRules,
} from "../strategy/marketRules.js";
import { assertTransition, isRiskIncreasingState } from "../strategy/levelState.js";

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

export type PossibleExposure = {
  signedPosition: DecimalString;
  ownedWorkingRiskIncreasing: Array<{
    logicalLevelId: GridLogicalLevelId;
    price: DecimalString;
    quantity: DecimalString;
  }>;
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
  executionIds: ExecutionId[];
  weightedExecutionPrice: DecimalString | null;
  entryIntentId: IntentId | null;
  exitIntentId: IntentId | null;
  workingExchangeOrderId: ExchangeOrderId | null;
};

export type SimulatorSnapshot = {
  schemaVersion: "phase1-simulator-1";
  init: SimulatorInit;
  config: ExperimentConfig;
  entriesPlanned: boolean;
  riskIncreaseBlocked: boolean;
  executionGap: boolean;
  snapshotStale: boolean;
  orderSeq: number;
  executionSeq: number;
  levels: LevelView[];
  intents: OrderIntent[];
  orders: InternalOrder[];
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
  private snapshotStale = false;
  private orderSeq = 0;
  private executionSeq = 0;
  private readonly levels = new Map<GridLogicalLevelId, MutableLevel>();
  private readonly intents = new Map<IntentId, OrderIntent>();
  private readonly orders = new Map<ExchangeOrderId, InternalOrder>();
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
    const simulator = new DeterministicSimulator(snapshot.init);
    simulator.entriesPlanned = snapshot.entriesPlanned;
    simulator.riskIncreaseBlocked = snapshot.riskIncreaseBlocked;
    simulator.executionGap = snapshot.executionGap;
    simulator.snapshotStale = snapshot.snapshotStale;
    simulator.orderSeq = snapshot.orderSeq;
    simulator.executionSeq = snapshot.executionSeq;
    simulator.position = snapshot.position;
    simulator.account = snapshot.account;
    for (const level of snapshot.levels) {
      simulator.levels.set(level.logicalLevelId, {
        ...level,
        executionIds: [...level.executionIds],
      });
    }
    for (const intent of snapshot.intents) {
      simulator.intents.set(intent.intentId, intent);
    }
    for (const order of snapshot.orders) {
      simulator.orders.set(order.exchangeOrderId, { ...order });
    }
    for (const execution of snapshot.executions) {
      simulator.executions.set(execution.executionId, execution);
    }
    for (const unknown of snapshot.unknownWrites) {
      simulator.unknownWrites.set(unknown.intentId, unknown);
    }
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
    if (this.entriesPlanned || this.hasLiveExposure()) {
      return { status: "PLANNED", intents: this.entryIntents() };
    }

    const intents: OrderIntent[] = [];
    for (const level of geometry.normalized) {
      const intent = this.createIntent({
        logicalLevelId: level.logicalLevelId,
        purpose: "GRID_ENTRY",
        side: level.side,
        price: level.normalizedPrice,
        quantity,
        reduceOnly: false,
        sequence: "1",
      });
      intents.push(intent);
    }
    this.entriesPlanned = true;
    return { status: "PLANNED", intents };
  }

  submit(intentId: IntentId, outcome: WriteOutcomeKind): VenueWriteResult<OrderAck> {
    const intent = this.requireIntent(intentId);
    const levelId = this.requireLevelId(intent.logicalLevelId);
    const level = this.requireLevel(levelId);
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
    this.orders.set(exchangeOrderId, order);
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
    this.orders.set(exchangeOrderId, order);
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
    this.orders.set(exchangeOrderId, {
      exchangeOrderId,
      clientOrderId: sourceIntent?.clientOrderId ?? `dup-${logicalLevelId}`,
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
    return exchangeOrderId;
  }

  applyExecution(input: {
    executionId?: ExecutionId;
    exchangeOrderId: ExchangeOrderId;
    quantity: DecimalString;
    price: DecimalString;
  }): ExecutionObservation | null {
    const order = this.orders.get(input.exchangeOrderId);
    if (order === undefined) {
      throw new Error("UNKNOWN_EXCHANGE_ORDER");
    }
    const executionId = input.executionId ?? this.nextExecutionId();
    if (this.executions.has(executionId)) {
      return this.executions.get(executionId) ?? null;
    }
    const quantity = parseDecimalString(input.quantity);
    const price = parseDecimalString(input.price);
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
    this.executions.set(executionId, execution);
    order.executedQuantity = decimalAdd(order.executedQuantity, quantity);
    order.remainingQuantity = remainingAfter(order.originalQuantity, order.executedQuantity);
    if (decimalIsZero(order.remainingQuantity)) {
      order.status = "FILLED";
      order.presentInOpenBook = false;
    } else {
      order.status = "PARTIALLY_FILLED";
    }
    this.applyExecutionToLevel(order, execution);
    this.applyFillToPosition(order.side, quantity);
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
    if (order.ownership !== "OWNED") {
      return { kind: "NOT_SENT", reason: "REFUSES_UNOWNED_CANCEL" };
    }
    const level = order.logicalLevelId === null ? undefined : this.levels.get(order.logicalLevelId);
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
      return {
        kind: "REJECTED",
        code: "CANCEL_REJECTED",
        message: "Simulator rejected cancel",
        meta: this.meta("cancel"),
      };
    }
    order.status = "CANCELLED";
    order.presentInOpenBook = false;
    if (level !== undefined && order.logicalLevelId !== null) {
      this.setState(level, order.purpose === "GRID_EXIT" ? "POSITION_OPEN" : "IDLE", "ACK");
      level.workingExchangeOrderId = null;
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
    this.orders.set(order.exchangeOrderId, {
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
    this.orders.set(exchangeOrderId, {
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
    return classifyOwnership(
      {
        clientOrderId: order.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        scopeKey: order.scopeKey,
        anchorEpoch: order.anchorEpoch,
      },
      this.ownershipEvidence(),
    );
  }

  planDuplicateCleanup(logicalLevelId: GridLogicalLevelId): DuplicateCleanupPlan {
    const owned = [...this.orders.values()]
      .filter(
        (order) =>
          order.ownership === "OWNED" &&
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
          order.ownership === "OWNED" &&
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
    const ownedWorkingRiskIncreasing = [...this.levels.values()]
      .filter((level) => level.state === "ENTRY_WORKING" || level.state === "ENTRY_PARTIAL")
      .map((level) => ({
        logicalLevelId: level.logicalLevelId,
        price: level.normalizedEntryPrice,
        quantity: level.remainingQuantity ?? "0",
      }));
    const unknownSubmissions = [...this.unknownWrites.values()]
      .filter((write) => write.purpose === "GRID_ENTRY")
      .map((write) => ({
        intentId: write.intentId,
        price: write.price,
        quantity: write.quantity,
      }));
    const proposedRiskIncreasing = this.entryIntents()
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
    if (this.riskIncreaseBlocked || this.executionGap || this.snapshotStale) {
      return false;
    }
    if (this.unknownWrites.size > 0) {
      return false;
    }
    if (
      [...this.levels.values()].some(
        (level) => level.state === "RECONCILING" || level.state === "ERROR_REQUIRES_RECONCILIATION",
      )
    ) {
      return false;
    }
    if ([...this.orders.values()].some((order) => order.ownership === "AMBIGUOUS")) {
      return false;
    }
    return true;
  }

  exportSnapshot(): SimulatorSnapshot {
    return {
      schemaVersion: "phase1-simulator-1",
      init: this.init,
      config: this.config,
      entriesPlanned: this.entriesPlanned,
      riskIncreaseBlocked: this.riskIncreaseBlocked,
      executionGap: this.executionGap,
      snapshotStale: this.snapshotStale,
      orderSeq: this.orderSeq,
      executionSeq: this.executionSeq,
      levels: [...this.levels.values()].map((level) => ({
        ...level,
        executionIds: [...level.executionIds],
      })),
      intents: [...this.intents.values()],
      orders: [...this.orders.values()].map((order) => ({ ...order })),
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
      executionIds: [],
      weightedExecutionPrice: null,
      entryIntentId: null,
      exitIntentId: null,
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
    const intentId = makeIntentId({
      experimentId: this.init.experimentId,
      runId: this.init.runId,
      scopeKey: this.scopeKey,
      anchorEpoch: this.init.anchorEpoch,
      logicalLevelId: input.logicalLevelId,
      purpose: input.purpose,
      sequence: input.sequence,
    });
    const intent: OrderIntent = {
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
    this.intents.set(intentId, intent);
    return intent;
  }

  private applyExecutionToLevel(order: InternalOrder, execution: ExecutionObservation): void {
    if (order.logicalLevelId === null) {
      return;
    }
    const level = this.requireLevel(order.logicalLevelId);
    level.executionIds.push(execution.executionId);
    level.executedQuantity = order.executedQuantity;
    level.remainingQuantity = order.remainingQuantity;
    level.originalQuantity = order.originalQuantity;
    level.weightedExecutionPrice = weightedPrice(
      [...this.executions.values()].filter(
        (item) => item.exchangeOrderId === order.exchangeOrderId,
      ),
    );
    if (order.purpose === "GRID_ENTRY") {
      if (decimalIsZero(order.remainingQuantity)) {
        this.setState(level, "POSITION_OPEN", "OBSERVATION");
        this.ensureExitIntent(level);
        level.workingExchangeOrderId = null;
      } else {
        this.setState(level, "ENTRY_PARTIAL", "OBSERVATION");
      }
      return;
    }
    if (order.purpose === "GRID_EXIT") {
      if (decimalIsZero(order.remainingQuantity)) {
        this.setState(level, "IDLE", "OBSERVATION");
        level.workingExchangeOrderId = null;
      } else {
        this.setState(level, "EXIT_PARTIAL", "OBSERVATION");
      }
    }
  }

  private ensureExitIntent(level: MutableLevel): void {
    if (level.exitIntentId !== null) {
      return;
    }
    const intent = this.createIntent({
      logicalLevelId: level.logicalLevelId,
      purpose: "GRID_EXIT",
      side: oppositeSide(level.logicalLevelId),
      price: level.normalizedExitPrice,
      quantity: level.originalQuantity ?? this.init.quantity,
      reduceOnly: true,
      sequence: "exit-1",
    });
    level.exitIntentId = intent.intentId;
  }

  private applyFillToPosition(side: "BUY" | "SELL", quantity: DecimalString): void {
    const delta = side === "BUY" ? quantity : decimalMul(quantity, "-1");
    this.position = {
      ...this.position,
      quantity: decimalAdd(this.position.quantity, delta),
      meta: this.meta("position"),
    };
  }

  private setState(
    level: MutableLevel,
    next: GridLevelState,
    evidence: "ACK" | "OBSERVATION" | "REJECTED" | "UNKNOWN" | "LOCAL",
  ): void {
    assertTransition(level.state, next, evidence);
    level.state = next;
  }

  private hasLiveExposure(): boolean {
    return [...this.levels.values()].some(
      (level) =>
        isRiskIncreasingState(level.state) ||
        level.state === "POSITION_OPEN" ||
        level.state === "EXIT_SUBMITTING" ||
        level.state === "EXIT_WORKING" ||
        level.state === "EXIT_PARTIAL",
    );
  }

  private refreshRiskBlock(): void {
    this.riskIncreaseBlocked =
      this.unknownWrites.size > 0 ||
      this.executionGap ||
      this.snapshotStale ||
      [...this.levels.values()].some((level) => level.state === "RECONCILING");
  }

  private entryIntents(): OrderIntent[] {
    return [...this.intents.values()].filter((intent) => intent.purpose === "GRID_ENTRY");
  }

  private ownershipEvidence() {
    return {
      currentScopeKey: this.scopeKey,
      currentAnchorEpoch: this.init.anchorEpoch,
      knownClientOrderIds: new Set(
        [...this.intents.values()]
          .map((intent) => intent.clientOrderId)
          .filter((value): value is ClientOrderId => value !== null),
      ),
      knownExchangeOrderIds: new Set(
        [...this.orders.values()]
          .filter((order) => order.ownership === "OWNED")
          .map((order) => order.exchangeOrderId),
      ),
      clientOrderEpochById: new Map(
        [...this.intents.values()]
          .filter((intent) => intent.clientOrderId !== null)
          .map((intent) => [intent.clientOrderId as ClientOrderId, intent.anchorEpoch]),
      ),
    };
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
    this.orderSeq += 1;
    return `sim-ord-${String(this.orderSeq).padStart(4, "0")}`;
  }

  private nextExecutionId(): ExecutionId {
    this.executionSeq += 1;
    return `sim-exec-${String(this.executionSeq).padStart(4, "0")}`;
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
