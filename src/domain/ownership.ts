import type { Ownership, ReconciliationDisposition } from "./enums.js";
import type {
  AnchorEpoch,
  ClientOrderId,
  ExchangeOrderId,
  LogicalLevelId,
  ScopeKey,
} from "./ids.js";

export type OwnershipEvidence = {
  currentScopeKey: ScopeKey;
  currentAnchorEpoch: AnchorEpoch;
  knownClientOrderIds: ReadonlySet<ClientOrderId>;
  knownExchangeOrderIds: ReadonlySet<ExchangeOrderId>;
  clientOrderEpochById: ReadonlyMap<ClientOrderId, AnchorEpoch>;
};

export type ObservedIdentity = {
  clientOrderId: ClientOrderId | null;
  exchangeOrderId: ExchangeOrderId | null;
  scopeKey: ScopeKey | null;
  anchorEpoch: AnchorEpoch | null;
};

export function classifyOwnership(
  observed: ObservedIdentity,
  evidence: OwnershipEvidence,
): Ownership {
  if (observed.scopeKey !== null && observed.scopeKey !== evidence.currentScopeKey) {
    return "UNOWNED";
  }
  if (observed.anchorEpoch !== null && observed.anchorEpoch !== evidence.currentAnchorEpoch) {
    return "UNOWNED";
  }
  if (observed.clientOrderId !== null) {
    const recordedEpoch = evidence.clientOrderEpochById.get(observed.clientOrderId);
    if (recordedEpoch !== undefined && recordedEpoch !== evidence.currentAnchorEpoch) {
      return "UNOWNED";
    }
    if (evidence.knownClientOrderIds.has(observed.clientOrderId)) {
      return "OWNED";
    }
  }
  if (
    observed.exchangeOrderId !== null &&
    evidence.knownExchangeOrderIds.has(observed.exchangeOrderId)
  ) {
    return "OWNED";
  }
  return "AMBIGUOUS";
}

export type DuplicateCleanupPlan = {
  logicalLevelId: LogicalLevelId | null;
  survivorExchangeOrderId: ExchangeOrderId;
  cancelExchangeOrderIds: ExchangeOrderId[];
  disposition: ReconciliationDisposition;
};

export function planOwnedDuplicateCleanup(
  ownedExchangeOrderIds: ExchangeOrderId[],
  logicalLevelId: LogicalLevelId | null,
): DuplicateCleanupPlan {
  const sorted = [...ownedExchangeOrderIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const survivor = sorted[0];
  if (survivor === undefined) {
    throw new Error("NO_OWNED_DUPLICATE_CANDIDATES");
  }
  return {
    logicalLevelId,
    survivorExchangeOrderId: survivor,
    cancelExchangeOrderIds: sorted.slice(1),
    disposition: "CANCEL_OWNED_DUPLICATE",
  };
}
