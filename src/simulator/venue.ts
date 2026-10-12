import type { ClientOrderId, ExchangeOrderId, IntentId, MarketId, VenueId } from "../domain/ids.js";
import type {
  CancelAck,
  CancelRequest,
  ExchangeOrderObservation,
  ExecutionObservation,
  ObservationMeta,
  OrderAck,
  OrderIntent,
  VenueWriteResult,
} from "../domain/types.js";
import type { ClientOrderLookup, ExecutionVenuePort } from "../execution/ports.js";
import { DUPLICATE_CLIENT_ORDER_ID_CODE } from "../execution/coordinator.js";
import { type DecimalString, decimalAdd, decimalCmp, decimalSub } from "../math/decimal.js";
import { requestFingerprint } from "./engine.js";

// ACK: accepted and acknowledged. REJECT: refused, not stored.
// UNKNOWN_ACCEPTED / THROW_ACCEPTED: stored, but the caller gets UNKNOWN / an exception.
// UNKNOWN_DROPPED: never stored, and the caller gets UNKNOWN.
export type SimulatedPlaceBehavior =
  | "ACK"
  | "REJECT"
  | "UNKNOWN_ACCEPTED"
  | "UNKNOWN_DROPPED"
  | "THROW_ACCEPTED";

// ACK: cancelled and acknowledged. REJECT: refused, the order stays open.
// UNKNOWN_APPLIED / THROW_APPLIED: cancelled, but the caller gets UNKNOWN / an exception.
// UNKNOWN_DROPPED: never applied, and the caller gets UNKNOWN.
// A cancel of an order that is not open (cancelled or fully filled) is always rejected.
export type SimulatedCancelBehavior =
  | "ACK"
  | "REJECT"
  | "UNKNOWN_APPLIED"
  | "UNKNOWN_DROPPED"
  | "THROW_APPLIED";

type SimulatedOrder = {
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  intentId: IntentId;
  side: OrderIntent["side"];
  type: OrderIntent["type"];
  price: DecimalString | null;
  originalQuantity: DecimalString;
  executedQuantity: DecimalString;
  reduceOnly: boolean;
  forgotten: boolean;
  cancelled: boolean;
};

// Deterministic fake venue with scripted place/cancel outcomes and fault injection. It holds
// venue truth only; it never decides intent state.
export class SimulatedVenue implements ExecutionVenuePort {
  readonly calls = { place: 0, cancel: 0, lookup: 0 };
  private readonly venue: VenueId;
  private readonly market: MarketId;
  private readonly observedAt: string;
  private readonly script: SimulatedPlaceBehavior[] = [];
  private readonly cancelScript: SimulatedCancelBehavior[] = [];
  private readonly orders = new Map<ExchangeOrderId, SimulatedOrder>();
  private readonly byClientOrderId = new Map<ClientOrderId, ExchangeOrderId>();
  private readonly executions: ExecutionObservation[] = [];
  private failingLookups = 0;
  private nextOrder = 1;
  private nextExecution = 1;

  constructor(venue: VenueId, market: MarketId, observedAt: string) {
    this.venue = venue;
    this.market = market;
    this.observedAt = observedAt;
  }

  scriptPlace(...behaviors: SimulatedPlaceBehavior[]): void {
    this.script.push(...behaviors);
  }

  scriptCancel(...behaviors: SimulatedCancelBehavior[]): void {
    this.cancelScript.push(...behaviors);
  }

  failNextLookups(count: number): void {
    this.failingLookups = count;
  }

  async placeOrder(intent: OrderIntent): Promise<VenueWriteResult<OrderAck>> {
    this.calls.place += 1;
    const behavior = this.script.shift() ?? "ACK";
    if (behavior === "REJECT") {
      return this.rejected("SIM_REJECTED", "place");
    }
    if (intent.clientOrderId !== null && this.byClientOrderId.has(intent.clientOrderId)) {
      return this.rejected(DUPLICATE_CLIENT_ORDER_ID_CODE, "place");
    }
    const fingerprint = requestFingerprint(this.venue, this.market, intent);
    if (behavior === "UNKNOWN_DROPPED") {
      return this.unknown(fingerprint);
    }
    const order = this.accept(intent);
    if (behavior === "UNKNOWN_ACCEPTED") {
      return this.unknown(fingerprint);
    }
    if (behavior === "THROW_ACCEPTED") {
      throw new Error("SIM_TRANSPORT_TIMEOUT");
    }
    return {
      kind: "ACK",
      ack: {
        exchangeOrderId: order.exchangeOrderId,
        clientOrderId: order.clientOrderId,
        intentId: intent.intentId,
      },
      meta: this.meta("place"),
    };
  }

  async cancelOrder(request: CancelRequest): Promise<VenueWriteResult<CancelAck>> {
    this.calls.cancel += 1;
    const behavior = this.cancelScript.shift() ?? "ACK";
    const order = this.orders.get(request.exchangeOrderId);
    if (order === undefined || !isOpen(order)) {
      return this.rejected("SIM_ORDER_NOT_OPEN", "cancel");
    }
    if (behavior === "REJECT") {
      return this.rejected("SIM_REJECTED", "cancel");
    }
    const fingerprint = `cancel:${order.exchangeOrderId}`;
    if (behavior === "UNKNOWN_DROPPED") {
      return this.unknown(fingerprint);
    }
    order.cancelled = true;
    if (behavior === "UNKNOWN_APPLIED") {
      return this.unknown(fingerprint);
    }
    if (behavior === "THROW_APPLIED") {
      throw new Error("SIM_TRANSPORT_TIMEOUT");
    }
    return {
      kind: "ACK",
      ack: { exchangeOrderId: order.exchangeOrderId, cancelled: true },
      meta: this.meta("cancel"),
    };
  }

  async lookupClientOrder(clientOrderId: ClientOrderId): Promise<ClientOrderLookup> {
    this.calls.lookup += 1;
    if (this.failingLookups > 0) {
      this.failingLookups -= 1;
      throw new Error("SIM_LOOKUP_FAILED");
    }
    const exchangeOrderId = this.byClientOrderId.get(clientOrderId);
    if (exchangeOrderId === undefined) {
      return { order: null, executions: [] };
    }
    const order = this.requireOrder(exchangeOrderId);
    return {
      order: order.forgotten ? null : this.observe(order),
      executions: this.executions
        .filter((execution) => execution.exchangeOrderId === exchangeOrderId)
        .map((execution) => structuredClone(execution)),
    };
  }

  fill(
    exchangeOrderId: ExchangeOrderId,
    quantity: DecimalString,
    price: DecimalString,
  ): ExecutionObservation {
    const order = this.requireOrder(exchangeOrderId);
    const executedQuantity = decimalAdd(order.executedQuantity, quantity);
    if (
      order.cancelled ||
      decimalCmp(quantity, "0") <= 0 ||
      decimalCmp(executedQuantity, order.originalQuantity) > 0
    ) {
      throw new Error("SIM_INVALID_FILL");
    }
    order.executedQuantity = executedQuantity;
    const execution: ExecutionObservation = {
      venue: this.venue,
      market: this.market,
      executionId: `sim-exec-${this.nextExecution}`,
      exchangeOrderId,
      clientOrderId: order.clientOrderId,
      side: order.side,
      price,
      quantity,
      feeAmount: null,
      feeAsset: null,
      liquidity: "UNKNOWN",
      meta: this.meta("execution"),
    };
    this.nextExecution += 1;
    this.executions.push(execution);
    return structuredClone(execution);
  }

  // Models a venue whose order history no longer returns the order; executions remain.
  forgetOrder(exchangeOrderId: ExchangeOrderId): void {
    this.requireOrder(exchangeOrderId).forgotten = true;
  }

  orderForClientOrderId(clientOrderId: ClientOrderId): ExchangeOrderObservation | null {
    const exchangeOrderId = this.byClientOrderId.get(clientOrderId);
    return exchangeOrderId === undefined ? null : this.observe(this.requireOrder(exchangeOrderId));
  }

  private accept(intent: OrderIntent): SimulatedOrder {
    const order: SimulatedOrder = {
      exchangeOrderId: `sim-order-${this.nextOrder}`,
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      side: intent.side,
      type: intent.type,
      price: intent.price,
      originalQuantity: intent.quantity,
      executedQuantity: "0",
      reduceOnly: intent.reduceOnly,
      forgotten: false,
      cancelled: false,
    };
    this.nextOrder += 1;
    this.orders.set(order.exchangeOrderId, order);
    if (order.clientOrderId !== null) {
      this.byClientOrderId.set(order.clientOrderId, order.exchangeOrderId);
    }
    return order;
  }

  private observe(order: SimulatedOrder): ExchangeOrderObservation {
    const remainingQuantity = decimalSub(order.originalQuantity, order.executedQuantity);
    return {
      venue: this.venue,
      market: this.market,
      exchangeOrderId: order.exchangeOrderId,
      clientOrderId: order.clientOrderId,
      side: order.side,
      type: order.type,
      price: order.price,
      originalQuantity: order.originalQuantity,
      executedQuantity: order.executedQuantity,
      remainingQuantity,
      status: order.cancelled
        ? "CANCELLED"
        : decimalCmp(remainingQuantity, "0") === 0
          ? "FILLED"
          : "OPEN",
      reduceOnly: order.reduceOnly,
      // Ownership classification belongs to the coordinator, not the venue.
      ownership: "AMBIGUOUS",
      meta: this.meta("order"),
    };
  }

  private requireOrder(exchangeOrderId: ExchangeOrderId): SimulatedOrder {
    const order = this.orders.get(exchangeOrderId);
    if (order === undefined) {
      throw new Error("SIM_ORDER_NOT_FOUND");
    }
    return order;
  }

  private rejected<TAck>(code: string, source: "place" | "cancel"): VenueWriteResult<TAck> {
    return {
      kind: "REJECTED",
      code,
      message:
        source === "place"
          ? "Simulated venue rejected placement"
          : "Simulated venue rejected cancel",
      meta: this.meta(source),
    };
  }

  private unknown<TAck>(fingerprint: string): VenueWriteResult<TAck> {
    return {
      kind: "UNKNOWN",
      reason: "SIM_RESPONSE_LOST",
      requestFingerprint: fingerprint,
      lastKnownMeta: null,
    };
  }

  private meta(source: string): ObservationMeta {
    return {
      venue: this.venue,
      source,
      serverTime: this.observedAt,
      receivedAt: this.observedAt,
      observedAt: this.observedAt,
      freshnessMs: 0,
      sequence: null,
    };
  }
}

function isOpen(order: SimulatedOrder): boolean {
  return !order.cancelled && decimalCmp(order.executedQuantity, order.originalQuantity) < 0;
}
