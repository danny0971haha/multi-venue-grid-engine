import type { DecimalString } from "../math/decimal.js";

export const FROZEN_CAPITAL_CEILING_USDT = "100";
export const FROZEN_LEVERAGE = "5";
export const FROZEN_MARGIN_BUDGET_USDT = "30";
export const FROZEN_PLANNED_GROSS_NOTIONAL_USDT = "150";
export const FROZEN_DAILY_NET_LOSS_USDT = "-5";
export const FROZEN_START_DRAWDOWN_USDT = "10";
export const FROZEN_BOUNDARY_BUFFER = "0.01";
export const FROZEN_GRID_HALF_BAND = "0.03";

export type RiskAction = "CONTINUE" | "REDUCE" | "HALT";

export type RiskSide = "BUY" | "SELL";

export type FundingConvention = "RECEIVED_POSITIVE" | "PAID_POSITIVE";

export type RiskWorkingOrder = {
  side: RiskSide;
  price: DecimalString;
  remainingQuantity: DecimalString;
  reduceOnly: boolean;
  owned: boolean;
};

export type RiskUnknownReservation = {
  side: RiskSide;
  price: DecimalString | null;
  quantity: DecimalString | null;
};

export type RiskProposedIntent = {
  side: RiskSide;
  price: DecimalString | null;
  quantity: DecimalString;
  reduceOnly: boolean;
  purpose: "GRID_ENTRY" | "GRID_EXIT" | "RISK_REDUCTION" | "EMERGENCY_FLATTEN" | "CANCEL";
};

export type RiskLeaseAssertion = {
  proven: boolean;
  expired: boolean;
  lost: boolean;
};

export type RiskDurableInspection = {
  pairAuthorityProven: boolean;
};

export type RiskReconciliation = {
  unresolved: boolean;
};

export type RiskBoundedReduction = {
  possible: boolean;
  ambiguous: boolean;
  cancelOnly: boolean;
  snapshotFresh: boolean;
};

export type RiskFreshness = {
  evaluatedAt: string;
  maxStaleMs: string;
  positionObservedAt: string | null;
  equityObservedAt: string | null;
  markObservedAt: string | null;
  pnlObservedAt: string | null;
};

export type RiskInput = {
  signedPosition: DecimalString | null;
  markOrMidPrice: DecimalString | null;
  equity: DecimalString | null;
  startingEquity: DecimalString | null;
  highWaterEquity: DecimalString | null;
  realizedTradingPnl: DecimalString | null;
  fees: DecimalString | null;
  funding: DecimalString | null;
  fundingConvention: FundingConvention | null;
  ownedActiveOrders: readonly RiskWorkingOrder[];
  unknownReservations: readonly RiskUnknownReservation[];
  proposedBatch: readonly RiskProposedIntent[];
  gridLower: DecimalString | null;
  gridUpper: DecimalString | null;
  freshness: RiskFreshness;
  reconciliation: RiskReconciliation;
  lease: RiskLeaseAssertion;
  latchBlocked: boolean;
  durableInspection: RiskDurableInspection;
  haltAuthorityClear: false;
  boundedReduction: RiskBoundedReduction;
};

export type RiskMetrics = {
  plannedGrossNotional: DecimalString | null;
  actualGrossNotional: DecimalString | null;
  worstLongNotional: DecimalString | null;
  worstShortNotional: DecimalString | null;
  netDailyPnl: DecimalString | null;
  equity: DecimalString | null;
  startingEquity: DecimalString | null;
  highWaterEquity: DecimalString | null;
  startDrawdown: DecimalString | null;
  signedPosition: DecimalString | null;
  markOrMidPrice: DecimalString | null;
  plannedCap: typeof FROZEN_PLANNED_GROSS_NOTIONAL_USDT;
  dailyLossLimit: typeof FROZEN_DAILY_NET_LOSS_USDT;
  startDrawdownLimit: typeof FROZEN_START_DRAWDOWN_USDT;
};

export type RiskDecision = {
  action: RiskAction;
  reasonCodes: string[];
  metrics: RiskMetrics;
  riskMetricsWithinLimits: boolean;
  systemAllowRiskIncrease: false;
  evaluatedAt: string;
};

export const PHASE_2D_REASON_CODE_CATALOG = [
  "PERSISTENCE_UNPROVEN",
  "LEASE_UNPROVEN",
  "DURABLE_HALT_OR_ACK_UNAVAILABLE",
  "RECONCILIATION_REQUIRED",
  "STALE_OR_MISSING_INPUT",
  "DAILY_LOSS",
  "START_DRAWDOWN",
  "BOUNDARY",
  "ACTUAL_NOTIONAL",
  "PLANNED_NOTIONAL",
  "CONTINUE_METRICS_ONLY",
  "LATCH_BLOCKED",
  "PAIR_UNPROVEN",
  "LEASE_LOST",
  "LEASE_EXPIRED",
  "FEE_MISSING",
  "FUNDING_MISSING",
  "FUNDING_CONVENTION_MISSING",
  "UNBOUNDED_EXPOSURE",
  "INVALID_DECIMAL",
  "INVALID_RISK_INPUT",
  "REDUCTION_NOT_PROVEN",
  "REDUCTION_AMBIGUOUS",
  "CANCEL_ONLY_REDUCTION",
  "BOUNDARY_SEED_BLOCKED",
  "HIGH_WATER_OBSERVED",
] as const;

export type Phase2DReasonCode = (typeof PHASE_2D_REASON_CODE_CATALOG)[number];
