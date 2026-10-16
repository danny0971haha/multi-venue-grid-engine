import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ClientOrderId, ExchangeOrderId } from "../../src/domain/ids.js";
import type {
  CancelAck,
  CancelRequest,
  ExchangeOrderObservation,
  ExecutionObservation,
  OrderAck,
  OrderIntent,
  VenueWriteResult,
} from "../../src/domain/types.js";
import type {
  ClientOrderLookup,
  ExecutionCursor,
  ExecutionPage,
  ExecutionVenuePort,
} from "../../src/execution/ports.js";
import type { DecimalString } from "../../src/math/decimal.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";

export const PHASE3E_OBSERVED_AT = "2026-08-22T00:00:00.000Z";

const OPS_FILE = "ops.jsonl";
const EVENTS_FILE = "events.jsonl";

type ForeignOrder = {
  clientOrderId: ClientOrderId | null;
  side: OrderIntent["side"];
  price: DecimalString;
  quantity: DecimalString;
};

type VenueOp =
  | { op: "PLACE"; intent: OrderIntent }
  | { op: "CANCEL"; request: CancelRequest }
  | { op: "FILL"; exchangeOrderId: ExchangeOrderId; quantity: DecimalString; price: DecimalString }
  | { op: "FOREIGN"; order: ForeignOrder };

export type VenueEvent = { label: string; type: string } & Record<string, unknown>;

// Appends one event line synchronously, so it survives a SIGKILL right after the call.
export function appendEvent(directory: string, event: VenueEvent): void {
  mkdirSync(directory, { recursive: true });
  appendFileSync(path.join(directory, EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

export function readEvents(directory: string): VenueEvent[] {
  const file = path.join(directory, EVENTS_FILE);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as VenueEvent);
}

// Venue truth that outlives a process: every accepted write is appended to ops.jsonl, and a
// new instance replays the log into a fresh deterministic SimulatedVenue. Every call is logged
// to events.jsonl before it reaches the venue, so a call that never happened leaves no line.
export class FileBackedVenue implements ExecutionVenuePort {
  private readonly directory: string;
  private readonly label: string;
  private readonly inner: SimulatedVenue;
  private readonly hangAfterAcceptPath: string | null;

  private constructor(
    directory: string,
    label: string,
    inner: SimulatedVenue,
    hangAfterAcceptPath: string | null,
  ) {
    this.directory = directory;
    this.label = label;
    this.inner = inner;
    this.hangAfterAcceptPath = hangAfterAcceptPath;
  }

  // hangAfterAcceptPath: the first accepted place is stored, the path is written, and the
  // process then blocks forever before the response returns, for a kill during transport.
  static async open(
    directory: string,
    label: string,
    options: { hangAfterAcceptPath?: string | null } = {},
  ): Promise<FileBackedVenue> {
    mkdirSync(directory, { recursive: true });
    const inner = new SimulatedVenue("sim", "BTC_USDC_PERP", PHASE3E_OBSERVED_AT);
    const file = path.join(directory, OPS_FILE);
    const lines = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
      : [];
    for (const line of lines) {
      const op = JSON.parse(line) as VenueOp;
      if (op.op === "PLACE") {
        const result = await inner.placeOrder(op.intent);
        if (result.kind !== "ACK") {
          throw new Error("PHASE3E_VENUE_REPLAY_DIVERGED");
        }
      } else if (op.op === "CANCEL") {
        const result = await inner.cancelOrder(op.request);
        if (result.kind !== "ACK") {
          throw new Error("PHASE3E_VENUE_REPLAY_DIVERGED");
        }
      } else if (op.op === "FILL") {
        inner.fill(op.exchangeOrderId, op.quantity, op.price);
      } else {
        inner.addForeignOrder(op.order);
      }
    }
    return new FileBackedVenue(directory, label, inner, options.hangAfterAcceptPath ?? null);
  }

  async placeOrder(intent: OrderIntent): Promise<VenueWriteResult<OrderAck>> {
    this.event("PLACE", { clientOrderId: intent.clientOrderId });
    const result = await this.inner.placeOrder(intent);
    if (result.kind === "ACK") {
      this.append({ op: "PLACE", intent });
      if (this.hangAfterAcceptPath !== null) {
        writeFileSync(this.hangAfterAcceptPath, "accepted\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
    return result;
  }

  async cancelOrder(request: CancelRequest): Promise<VenueWriteResult<CancelAck>> {
    this.event("CANCEL", { exchangeOrderId: request.exchangeOrderId });
    const result = await this.inner.cancelOrder(request);
    if (result.kind === "ACK") {
      this.append({ op: "CANCEL", request });
    }
    return result;
  }

  async lookupClientOrder(clientOrderId: ClientOrderId): Promise<ClientOrderLookup> {
    this.event("LOOKUP", { clientOrderId });
    return this.inner.lookupClientOrder(clientOrderId);
  }

  async listOpenOrders(): Promise<ExchangeOrderObservation[]> {
    this.event("LIST", {});
    return this.inner.listOpenOrders();
  }

  async listExecutionsSince(cursor: ExecutionCursor | null): Promise<ExecutionPage> {
    this.event("EXECUTIONS", {});
    return this.inner.listExecutionsSince(cursor);
  }

  // Venue-side changes made while no runtime is up.
  fill(
    exchangeOrderId: ExchangeOrderId,
    quantity: DecimalString,
    price: DecimalString,
  ): ExecutionObservation {
    const execution = this.inner.fill(exchangeOrderId, quantity, price);
    this.append({ op: "FILL", exchangeOrderId, quantity, price });
    return execution;
  }

  addForeignOrder(order: ForeignOrder): ExchangeOrderId {
    const exchangeOrderId = this.inner.addForeignOrder(order);
    this.append({ op: "FOREIGN", order });
    return exchangeOrderId;
  }

  async openOrders(): Promise<ExchangeOrderObservation[]> {
    return this.inner.listOpenOrders();
  }

  private event(type: string, fields: Record<string, unknown>): void {
    appendEvent(this.directory, { label: this.label, type, ...fields });
  }

  private append(op: VenueOp): void {
    appendFileSync(path.join(this.directory, OPS_FILE), `${JSON.stringify(op)}\n`);
  }
}
