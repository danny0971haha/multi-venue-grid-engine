import type { WriteOutcomeKind } from "../domain/enums.js";
import type { ExchangeOrderId } from "../domain/ids.js";

export type HaltOwnedOrder = {
  exchangeOrderId: ExchangeOrderId;
  ownership: "OWNED" | "UNOWNED" | "AMBIGUOUS";
  riskIncreasing: boolean;
};

export type HaltAuthoritativeSnapshot = {
  fresh: boolean;
  authoritative: boolean;
  leaseGeneration: string;
  signedPosition: string;
  actualGrossNotional: string | null;
  ownedRiskIncreasingRemaining: boolean;
  observedAt: string;
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
};

export function createScriptedHaltTransport(script: {
  orders?: readonly HaltOwnedOrder[];
  cancelById?: Readonly<Record<string, WriteOutcomeKind>>;
  defaultCancel?: WriteOutcomeKind;
  flatten?: WriteOutcomeKind;
  reduce?: WriteOutcomeKind;
  snapshots?: readonly HaltAuthoritativeSnapshot[];
}): ScriptedHaltTransport {
  const orders = [...(script.orders ?? [])];
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
    listOpenOrders() {
      return orders.map((order) => ({ ...order }));
    },
    async cancel(exchangeOrderId) {
      calls.cancel.push(exchangeOrderId);
      const configured = cancelById[exchangeOrderId];
      return { kind: configured ?? defaultCancel };
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
        return {
          fresh: false,
          authoritative: false,
          leaseGeneration: "0",
          signedPosition: "0",
          actualGrossNotional: null,
          ownedRiskIncreasingRemaining: true,
          observedAt: "0",
        };
      }
      return { ...next };
    },
  };
}
