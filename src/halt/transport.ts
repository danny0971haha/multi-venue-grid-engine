import type { WriteOutcomeKind } from "../domain/enums.js";
import type { ExchangeOrderId } from "../domain/ids.js";
import type { FundingConvention } from "../risk/risk-types.js";
import { DEFAULT_SNAPSHOT_SOURCE_ID } from "./types.js";

export type HaltOwnedOrder = {
  exchangeOrderId: ExchangeOrderId;
  ownership: "OWNED" | "UNOWNED" | "AMBIGUOUS";
  riskIncreasing: boolean;
};

export type HaltUnknownReservation = {
  side: "BUY" | "SELL";
  price: string | null;
  quantity: string | null;
};

export type HaltAuthoritativeSnapshot = {
  fresh: boolean;
  authoritative: boolean;
  leaseGeneration: string;
  signedPosition: string;
  actualGrossNotional: string | null;
  ownedRiskIncreasingRemaining: boolean;
  observedAt: string;
  sourceId: string;
  markOrMidPrice: string;
  equity: string;
  realizedTradingPnl: string;
  fees: string;
  funding: string;
  fundingConvention: FundingConvention;
  gridLower: string;
  gridUpper: string;
  unknownReservations: readonly HaltUnknownReservation[];
};

export type HaltMutationTransport = {
  listOpenOrders(): HaltOwnedOrder[] | Promise<HaltOwnedOrder[]>;
  cancel(exchangeOrderId: ExchangeOrderId): Promise<{ kind: WriteOutcomeKind }>;
  flatten(): Promise<{ kind: WriteOutcomeKind }>;
  reduce(): Promise<{ kind: WriteOutcomeKind }>;
  freshSnapshot(): Promise<HaltAuthoritativeSnapshot>;
};

export type ScriptedHaltTransport = HaltMutationTransport & {
  calls: {
    cancel: ExchangeOrderId[];
    flatten: number;
    reduce: number;
    snapshot: number;
  };
  setOpenOrders(next: readonly HaltOwnedOrder[]): void;
};

const FALLBACK_SNAPSHOT: HaltAuthoritativeSnapshot = {
  fresh: false,
  authoritative: false,
  leaseGeneration: "0",
  signedPosition: "0",
  actualGrossNotional: null,
  ownedRiskIncreasingRemaining: true,
  observedAt: "0",
  sourceId: DEFAULT_SNAPSHOT_SOURCE_ID,
  markOrMidPrice: "100",
  equity: "100",
  realizedTradingPnl: "0",
  fees: "0",
  funding: "0",
  fundingConvention: "RECEIVED_POSITIVE",
  gridLower: "97",
  gridUpper: "103",
  unknownReservations: [],
};

export function createScriptedHaltTransport(script: {
  orders?: readonly HaltOwnedOrder[];
  cancelById?: Readonly<Record<string, WriteOutcomeKind>>;
  defaultCancel?: WriteOutcomeKind;
  flatten?: WriteOutcomeKind;
  reduce?: WriteOutcomeKind;
  snapshots?: readonly HaltAuthoritativeSnapshot[];
}): ScriptedHaltTransport {
  let orders = [...(script.orders ?? [])];
  const cancelById = script.cancelById ?? {};
  const defaultCancel = script.defaultCancel ?? "ACK";
  const flattenOutcome = script.flatten ?? "ACK";
  const reduceOutcome = script.reduce ?? "ACK";
  const snapshots = [...(script.snapshots ?? [])];
  let snapshotIndex = 0;
  const calls: ScriptedHaltTransport["calls"] = {
    cancel: [],
    flatten: 0,
    reduce: 0,
    snapshot: 0,
  };

  return {
    calls,
    setOpenOrders(next) {
      orders = [...next];
    },
    listOpenOrders() {
      return orders.map((order) => ({ ...order }));
    },
    async cancel(exchangeOrderId) {
      calls.cancel.push(exchangeOrderId);
      const configured = cancelById[exchangeOrderId];
      const kind = configured ?? defaultCancel;
      if (kind === "ACK") {
        orders = orders.filter((order) => order.exchangeOrderId !== exchangeOrderId);
      }
      return { kind };
    },
    async flatten() {
      calls.flatten += 1;
      return { kind: flattenOutcome };
    },
    async reduce() {
      calls.reduce += 1;
      return { kind: reduceOutcome };
    },
    async freshSnapshot() {
      calls.snapshot += 1;
      const next = snapshots[snapshotIndex];
      if (snapshotIndex < snapshots.length - 1) {
        snapshotIndex += 1;
      }
      if (next === undefined) {
        return { ...FALLBACK_SNAPSHOT, unknownReservations: [] };
      }
      return {
        ...next,
        unknownReservations: next.unknownReservations.map((item) => ({ ...item })),
      };
    },
  };
}
