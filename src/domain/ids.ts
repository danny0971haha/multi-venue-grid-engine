import { createHash } from "node:crypto";

export type ExperimentId = string;
export type RunId = string;
export type ScopeKey = string;
export type VenueId = string;
export type MarketId = string;
export type AnchorEpoch = string;
export type LogicalLevelId = string;
export type IntentId = string;
export type ClientOrderId = string;
export type ExchangeOrderId = string;
export type ExecutionId = string;
export type HaltId = string;
export type RuntimeOwnerId = string;
export type LeaseGeneration = bigint;

export const BUY_LEVELS = ["B1", "B2", "B3", "B4", "B5"] as const;
export const SELL_LEVELS = ["S1", "S2", "S3", "S4", "S5"] as const;
export const ALL_LEVELS = [...BUY_LEVELS, ...SELL_LEVELS] as const;

export type GridLogicalLevelId = (typeof ALL_LEVELS)[number];

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function makeScopeKey(
  accountScope: string,
  venue: VenueId,
  market: MarketId,
  strategy: string,
): ScopeKey {
  const parts = [accountScope, venue, market, strategy];
  if (parts.some((part) => part.length === 0 || part.includes("/"))) {
    throw new Error("INVALID_SCOPE_PART");
  }
  return parts.join("/");
}

export function parseScopeKey(scopeKey: ScopeKey): {
  accountScope: string;
  venue: VenueId;
  market: MarketId;
  strategy: string;
} {
  const parts = scopeKey.split("/");
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
    throw new Error("INVALID_SCOPE_KEY");
  }
  return {
    accountScope: parts[0] ?? "",
    venue: parts[1] ?? "",
    market: parts[2] ?? "",
    strategy: parts[3] ?? "",
  };
}

export function isGridLogicalLevelId(value: string): value is GridLogicalLevelId {
  return (ALL_LEVELS as readonly string[]).includes(value);
}

export function assertGridLogicalLevelId(value: string): GridLogicalLevelId {
  if (!isGridLogicalLevelId(value)) {
    throw new Error(`INVALID_LOGICAL_LEVEL:${value}`);
  }
  return value;
}

export function makeIntentId(input: {
  experimentId: ExperimentId;
  runId: RunId;
  scopeKey: ScopeKey;
  anchorEpoch: AnchorEpoch;
  logicalLevelId: LogicalLevelId | null;
  purpose: string;
  sequence: string;
}): IntentId {
  return [
    "int",
    input.experimentId,
    input.runId,
    input.scopeKey,
    input.anchorEpoch,
    input.logicalLevelId ?? "none",
    input.purpose,
    input.sequence,
  ].join(":");
}

export function makeClientOrderId(input: {
  scopeKey: ScopeKey;
  anchorEpoch: AnchorEpoch;
  logicalLevelId: LogicalLevelId | null;
  purpose: string;
  intentId: IntentId;
}): ClientOrderId {
  const digest = sha256Hex(
    [
      input.scopeKey,
      input.anchorEpoch,
      input.logicalLevelId ?? "none",
      input.purpose,
      input.intentId,
    ].join("|"),
  );
  return `mv1${digest.slice(0, 20)}`;
}

export function parseLeaseGeneration(value: string): LeaseGeneration {
  if (!/^\d+$/.test(value)) {
    throw new Error("INVALID_LEASE_GENERATION");
  }
  return BigInt(value);
}

export function leaseGenerationToString(value: LeaseGeneration): string {
  return value.toString(10);
}
