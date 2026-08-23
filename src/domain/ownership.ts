import type { OrderAuthoritySource, Ownership, ReconciliationDisposition } from "./enums.js";
import type {
  AnchorEpoch,
  ClientOrderId,
  ExchangeOrderId,
  IntentId,
  LogicalLevelId,
  ScopeKey,
} from "./ids.js";

export type OrderAuthorityLink = {
  source: OrderAuthoritySource;
  evidenceId: string;
  exchangeOrderId: ExchangeOrderId;
  intentId: IntentId;
  clientOrderId: ClientOrderId;
  scopeKey: ScopeKey;
  anchorEpoch: AnchorEpoch;
};

export type OwnershipEvidence = {
  currentScopeKey: ScopeKey;
  currentAnchorEpoch: AnchorEpoch;
  knownClientOrderIds: ReadonlySet<ClientOrderId>;
  knownExchangeOrderIds: ReadonlySet<ExchangeOrderId>;
  clientOrderEpochById: ReadonlyMap<ClientOrderId, AnchorEpoch>;
  authorityLinks?: ReadonlyArray<OrderAuthorityLink>;
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
  }
  if (hasMatchingProvenAuthority(observed, evidence)) {
    return "OWNED";
  }
  return "AMBIGUOUS";
}

function hasMatchingProvenAuthority(
  observed: ObservedIdentity,
  evidence: OwnershipEvidence,
): boolean {
  if (observed.exchangeOrderId === null) {
    return false;
  }
  const matches = (evidence.authorityLinks ?? []).filter(
    (link) => link.exchangeOrderId === observed.exchangeOrderId,
  );
  if (matches.length !== 1) {
    return false;
  }
  const link = matches[0];
  if (link === undefined) {
    return false;
  }
  if (!isProvenAuthoritySource(link.source) || link.evidenceId.length === 0) {
    return false;
  }
  if (
    link.scopeKey !== evidence.currentScopeKey ||
    link.anchorEpoch !== evidence.currentAnchorEpoch
  ) {
    return false;
  }
  if (observed.clientOrderId !== null && observed.clientOrderId !== link.clientOrderId) {
    return false;
  }
  if (observed.scopeKey !== null && observed.scopeKey !== link.scopeKey) {
    return false;
  }
  if (observed.anchorEpoch !== null && observed.anchorEpoch !== link.anchorEpoch) {
    return false;
  }
  return true;
}

export function isProvenAuthoritySource(source: string): source is OrderAuthoritySource {
  return source === "ACK" || source === "AUTHORITATIVE_OBSERVATION";
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
