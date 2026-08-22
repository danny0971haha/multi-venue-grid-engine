export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK" | "POST_ONLY";

export type IntentPurpose =
  | "GRID_ENTRY"
  | "GRID_EXIT"
  | "RISK_REDUCTION"
  | "EMERGENCY_FLATTEN"
  | "CANCEL";

export type Ownership = "OWNED" | "UNOWNED" | "AMBIGUOUS";

export type WriteOutcomeKind = "ACK" | "REJECTED" | "UNKNOWN" | "NOT_SENT";

export type GridLevelState =
  | "IDLE"
  | "ENTRY_SUBMITTING"
  | "ENTRY_WORKING"
  | "ENTRY_PARTIAL"
  | "POSITION_OPEN"
  | "EXIT_SUBMITTING"
  | "EXIT_WORKING"
  | "EXIT_PARTIAL"
  | "CANCEL_PENDING"
  | "RECONCILING"
  | "ERROR_REQUIRES_RECONCILIATION"
  | "HALTED";

export type ReconciliationDisposition =
  | "PROVEN_CONSISTENT"
  | "REPAIR_LOCAL_FROM_VENUE"
  | "CANCEL_OWNED_DUPLICATE"
  | "WAIT_FOR_FRESH_EVIDENCE"
  | "BLOCK_RISK_INCREASE"
  | "HARD_HALT";

export type Liquidity = "MAKER" | "TAKER" | "UNKNOWN";
