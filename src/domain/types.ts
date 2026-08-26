import type { DecimalString } from "../math/decimal.js";
import type { IntentPurpose, Liquidity, Ownership, OrderType, Side, TimeInForce } from "./enums.js";
import type {
  AnchorEpoch,
  ClientOrderId,
  ExchangeOrderId,
  ExecutionId,
  ExperimentId,
  IntentId,
  LogicalLevelId,
  MarketId,
  RunId,
  ScopeKey,
  VenueId,
} from "./ids.js";

export type ExperimentConfig = {
  version: "0.1.0";
  capitalCeilingUsd: DecimalString;
  leverage: DecimalString;
  marginBudgetUsd: DecimalString;
  maxPlannedGrossNotionalUsd: DecimalString;
  gridLevels: 10;
  gridHalfBandFraction: DecimalString;
  dailyLossLimitUsd: DecimalString;
  drawdownFromStartLimitUsd: DecimalString;
  boundaryBufferFraction: DecimalString;
};

export type ObservationMeta = {
  venue: VenueId;
  source: string;
  serverTime: string | null;
  receivedAt: string;
  observedAt: string;
  freshnessMs: number | null;
  sequence: string | null;
};

export type OrderIntent = {
  intentId: IntentId;
  experimentId: ExperimentId;
  runId: RunId;
  scopeKey: ScopeKey;
  anchorEpoch: AnchorEpoch;
  logicalLevelId: LogicalLevelId | null;
  purpose: IntentPurpose;
  side: Side;
  type: OrderType;
  timeInForce: TimeInForce | null;
  price: DecimalString | null;
  quantity: DecimalString;
  reduceOnly: boolean;
  clientOrderId: ClientOrderId | null;
  leaseGeneration: string;
  createdAt: string;
};

export type VenueWriteResult<TAck> =
  | { kind: "ACK"; ack: TAck; meta: ObservationMeta }
  | { kind: "REJECTED"; code: string | null; message: string; meta: ObservationMeta | null }
  | {
      kind: "UNKNOWN";
      reason: string;
      requestFingerprint: string;
      lastKnownMeta: ObservationMeta | null;
    }
  | { kind: "NOT_SENT"; reason: string };

export type OrderAck = {
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  intentId: IntentId;
};

export type CancelAck = {
  exchangeOrderId: ExchangeOrderId;
  cancelled: true;
};

export type ExchangeOrderObservation = {
  venue: VenueId;
  market: MarketId;
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  side: Side;
  type: string;
  price: DecimalString | null;
  originalQuantity: DecimalString;
  executedQuantity: DecimalString;
  remainingQuantity: DecimalString | null;
  status: string;
  reduceOnly: boolean | null;
  ownership: Ownership;
  meta: ObservationMeta;
};

export type ExecutionObservation = {
  venue: VenueId;
  market: MarketId;
  executionId: ExecutionId;
  exchangeOrderId: ExchangeOrderId;
  clientOrderId: ClientOrderId | null;
  side: Side;
  price: DecimalString;
  quantity: DecimalString;
  feeAmount: DecimalString | null;
  feeAsset: string | null;
  liquidity: Liquidity;
  meta: ObservationMeta;
};

export type PositionSnapshot = {
  venue: VenueId;
  market: MarketId;
  quantity: DecimalString;
  markPrice: DecimalString | null;
  notionalUsd: DecimalString | null;
  unrealizedPnlUsd: DecimalString | null;
  meta: ObservationMeta;
};

export type AccountSnapshot = {
  equityUsd: DecimalString | null;
  availableMarginUsd: DecimalString | null;
  realizedDailyPnlUsd: DecimalString | null;
  feesDailyUsd: DecimalString | null;
  fundingDailyUsd: DecimalString | null;
  meta: ObservationMeta;
};
