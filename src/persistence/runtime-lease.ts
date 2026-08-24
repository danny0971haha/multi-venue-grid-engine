import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  incrementCanonicalGeneration,
  initializeExactPair,
  persistExactPairTransition,
  sortPhase2BReasonCodes,
} from "./atomic-pair-store.js";
import {
  isCanonicalGenerationString,
  parseAndValidateDurableEnvelope,
} from "./durable-envelope.js";
import type { PairInspection } from "./exact-pair-inspection.js";
import { inspectExactPair } from "./exact-pair-inspection.js";
import {
  acquireHostLocalCoordinationGuard,
  COORDINATION_CAPABILITY,
  isHostLocalCoordinationMode,
} from "./lease-coordination.js";
import type { LatchState, RuntimePersistenceLatch } from "./runtime-persistence-latch.js";

export const LEASE_KIND = "runtime-lease";
export const LEASE_STATE_NAME = "runtime-lease";
export const LEASE_RECORD_SCHEMA_VERSION = 1;
export const LEASE_TTL_MS = 30_000n;
export const MAX_CLOCK_SKEW_MS = 1_000n;
export const MAX_FORWARD_JUMP_MS = 86_400_000n;
export const MAX_TIMESTAMP_MS = 9_999_999_999_999n;

export type LeaseStatus = "ACTIVE" | "RELEASED";

export type RuntimeLeaseRecord = {
  schemaVersion: 1;
  scopeKey: string;
  ownerId: string;
  processInstanceId: string;
  generation: string;
  status: LeaseStatus;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  updatedAt: string;
};

export type LeaseAuthority = {
  scopeKey: string;
  ownerId: string;
  processInstanceId: string;
  generation: string;
  leaseEnvelopeSha256: string;
  leaseStoreGeneration: string;
  observedExpiresAt: string;
};

export type LeaseClock = {
  nowMs(): bigint;
};

export type LeaseDisposition =
  | "ACQUIRED"
  | "BLOCKED"
  | "HEARTBEAT_COMMITTED"
  | "RELEASED"
  | "AUTHORITY_UNPROVEN"
  | "DISTRIBUTED_FENCING_UNPROVEN";

export type LeaseResult = {
  disposition: LeaseDisposition;
  authority: LeaseAuthority | null;
  record: RuntimeLeaseRecord | null;
  allowRiskIncrease: false;
  reasonCodes: string[];
  latchState: LatchState;
  coordinationCapability: typeof COORDINATION_CAPABILITY;
  distributedFencingProven: false;
  inspection: PairInspection;
};

export type FencedMutationOutcome = "SENT" | "NOT_SENT" | "UNKNOWN";

export type FencedMutationResult<T> = {
  outcome: FencedMutationOutcome;
  value: T | null;
  allowRiskIncrease: false;
  reasonCodes: string[];
  callbackCount: number;
  latchState: LatchState;
  coordinationCapability: typeof COORDINATION_CAPABILITY;
  distributedFencingProven: false;
};

export type LeaseOperationRequest = {
  directory: string;
  scopeKey: string;
  ownerId: string;
  processInstanceId: string;
  latch: RuntimePersistenceLatch;
  clock?: LeaseClock;
  coordinationMode?: string;
};

export type LeaseTokenRequest = {
  directory: string;
  scopeKey: string;
  authority: LeaseAuthority;
  latch: RuntimePersistenceLatch;
  clock?: LeaseClock;
  coordinationMode?: string;
};

export const PHASE_2C_REASON_CODE_CATALOG = [
  "LEASE_ACQUIRED",
  "LEASE_HEARTBEAT_COMMITTED",
  "LEASE_RELEASED",
  "LEASE_BLOCKED",
  "LEASE_HELD_BY_OTHER",
  "LEASE_NOT_EXPIRED",
  "LEASE_EXPIRED",
  "LEASE_RELEASED_STATUS",
  "CLOCK_REGRESSION",
  "CLOCK_FORWARD_JUMP",
  "FUTURE_TIMESTAMP",
  "MALFORMED_TIMESTAMP",
  "EXCESSIVE_TIMESTAMP",
  "INVALID_OWNER_ID",
  "INVALID_PROCESS_INSTANCE_ID",
  "INVALID_LEASE_RECORD",
  "INVALID_LEASE_STATUS",
  "LEASE_TTL_MISMATCH",
  "HEARTBEAT_REGRESSION",
  "LEASE_GENERATION_MISMATCH",
  "OWNER_MISMATCH",
  "PROCESS_INSTANCE_MISMATCH",
  "SCOPE_MISMATCH",
  "STALE_LEASE_TOKEN",
  "FORGED_LEASE_TOKEN",
  "LEASE_AUTHORITY_UNPROVEN",
  "LEASE_RECORD_DIVERGED",
  "LEASE_GENERATION_REGRESSION",
  "DISTRIBUTED_FENCING_UNPROVEN",
  "COORDINATION_LOCK_UNCERTAIN",
  "COORDINATION_LOCK_TIMEOUT",
  "COORDINATION_LOCK_HELD",
  "FENCED_OWNER",
  "MUTATION_NOT_SENT",
  "MUTATION_SENT",
  "FENCED_CALLBACK_THREW",
  "LATCH_ALREADY_BLOCKED",
] as const;

const OWNER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const TIMESTAMP_PATTERN = /^(0|[1-9][0-9]{0,12})$/;
const LEASE_RECORD_KEYS = [
  "acquiredAt",
  "expiresAt",
  "generation",
  "heartbeatAt",
  "ownerId",
  "processInstanceId",
  "schemaVersion",
  "scopeKey",
  "status",
  "updatedAt",
] as const;

const observedGenerationByScope = new Map<string, string>();
const lastCommitByProcessInstance = new Map<
  string,
  { generation: string; envelopeSha256: string; expiresAt: string }
>();
const fencedTokens = new Set<string>();

let preCallbackHookForTests: (() => void) | null = null;

export function setLeasePreCallbackHookForTests(hook: (() => void) | null): void {
  preCallbackHookForTests = hook;
}

export function resetLeaseProcessStateForTests(): void {
  observedGenerationByScope.clear();
  lastCommitByProcessInstance.clear();
  fencedTokens.clear();
}

export function systemLeaseClock(): LeaseClock {
  return {
    nowMs() {
      return BigInt(Date.now());
    },
  };
}

export function fixedLeaseClock(nowMs: bigint | string): LeaseClock {
  const value = typeof nowMs === "string" ? BigInt(nowMs) : nowMs;
  return {
    nowMs() {
      return value;
    },
  };
}

export function createProcessInstanceId(): string {
  return `p${randomBytes(16).toString("hex")}`;
}

export function isCanonicalLeaseTimestamp(value: string): boolean {
  return TIMESTAMP_PATTERN.test(value);
}

export function sortPhase2CReasonCodes(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map<string, number>(
    PHASE_2C_REASON_CODE_CATALOG.map((code, index) => [code, index]),
  );
  return unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
}

export function formatLeaseResultDiagnostic(result: LeaseResult): string {
  return JSON.stringify({
    disposition: result.disposition,
    allowRiskIncrease: result.allowRiskIncrease,
    reasonCodes: result.reasonCodes,
    coordinationCapability: result.coordinationCapability,
    distributedFencingProven: result.distributedFencingProven,
    authority:
      result.authority === null
        ? null
        : {
            scopeKey: result.authority.scopeKey,
            ownerId: result.authority.ownerId,
            processInstanceId: result.authority.processInstanceId,
            generation: result.authority.generation,
            leaseStoreGeneration: result.authority.leaseStoreGeneration,
            leaseEnvelopeSha256: result.authority.leaseEnvelopeSha256,
            observedExpiresAt: result.authority.observedExpiresAt,
          },
    latchState: result.latchState,
    inspection: {
      pairStatus: result.inspection.pairStatus,
      pairAuthorityProven: result.inspection.pairAuthorityProven,
      allowRiskIncrease: result.inspection.allowRiskIncrease,
      generation: result.inspection.generation,
      envelopeSha256: result.inspection.envelopeSha256,
      reasonCodes: result.inspection.reasonCodes,
    },
  });
}

export async function acquireRuntimeLease(request: LeaseOperationRequest): Promise<LeaseResult> {
  return withLeaseCoordination(request, async (nowMs) => {
    const identities = validateIdentities(request.ownerId, request.processInstanceId);
    if (identities !== null) {
      return leaseFail(request, "BLOCKED", identities);
    }
    const inspection = await inspectLeasePair(request.directory, request.scopeKey);
    if (inspection.pairStatus === "BOTH_ABSENT") {
      return initializeFirstLease(request, nowMs);
    }
    if (!inspection.pairAuthorityProven) {
      return leaseFail(
        request,
        "AUTHORITY_UNPROVEN",
        ["LEASE_AUTHORITY_UNPROVEN", ...inspection.reasonCodes],
        inspection,
        true,
      );
    }
    const parsed = parseProvenLease(inspection);
    if (!parsed.ok) {
      return leaseFail(request, "AUTHORITY_UNPROVEN", parsed.reasonCodes, inspection, true);
    }
    if (hasObservedRegression(request.directory, request.scopeKey, parsed.record.generation)) {
      return leaseFail(
        request,
        "AUTHORITY_UNPROVEN",
        ["LEASE_GENERATION_REGRESSION", "LEASE_AUTHORITY_UNPROVEN"],
        inspection,
        true,
      );
    }
    observeGeneration(request.directory, request.scopeKey, parsed.record.generation);
    const clockCodes = clockReadCodes(parsed.record, nowMs);
    if (clockCodes !== null) {
      return leaseFail(request, "AUTHORITY_UNPROVEN", clockCodes, inspection, true);
    }
    if (parsed.record.status === "ACTIVE" && !isExpired(parsed.record, nowMs)) {
      return leaseFail(
        request,
        "BLOCKED",
        ["LEASE_BLOCKED", "LEASE_HELD_BY_OTHER", "LEASE_NOT_EXPIRED"],
        inspection,
      );
    }
    return takeoverLease(request, nowMs, inspection, parsed.record);
  });
}

export async function heartbeatRuntimeLease(request: LeaseTokenRequest): Promise<LeaseResult> {
  return withLeaseCoordination(request, async (nowMs) => {
    const inspection = await inspectLeasePair(request.directory, request.scopeKey);
    const matched = matchDurableToken(request, inspection, nowMs, {
      requireActive: true,
      requireUnexpired: true,
    });
    if (!matched.ok) {
      return leaseFail(
        request,
        matched.disposition,
        matched.reasonCodes,
        inspection,
        matched.blockLatch,
      );
    }
    const nextHeartbeatAt = maxTimestamp(matched.record.heartbeatAt, canonicalTimestamp(nowMs));
    if (compareTimestamp(nextHeartbeatAt, matched.record.heartbeatAt) < 0) {
      return leaseFail(request, "AUTHORITY_UNPROVEN", ["HEARTBEAT_REGRESSION"], inspection, true);
    }
    const next: RuntimeLeaseRecord = {
      schemaVersion: 1,
      scopeKey: matched.record.scopeKey,
      ownerId: matched.record.ownerId,
      processInstanceId: matched.record.processInstanceId,
      generation: matched.record.generation,
      status: "ACTIVE",
      acquiredAt: matched.record.acquiredAt,
      heartbeatAt: nextHeartbeatAt,
      expiresAt: addTtl(nextHeartbeatAt),
      updatedAt: canonicalTimestamp(nowMs),
    };
    return commitLeaseTransition(request, next, inspection, "HEARTBEAT_COMMITTED", [
      "LEASE_HEARTBEAT_COMMITTED",
    ]);
  });
}

export async function releaseRuntimeLease(request: LeaseTokenRequest): Promise<LeaseResult> {
  return withLeaseCoordination(request, async (nowMs) => {
    const inspection = await inspectLeasePair(request.directory, request.scopeKey);
    const matched = matchDurableToken(request, inspection, nowMs, {
      requireActive: true,
      requireUnexpired: false,
    });
    if (!matched.ok) {
      return leaseFail(
        request,
        matched.disposition,
        matched.reasonCodes,
        inspection,
        matched.blockLatch,
      );
    }
    const next: RuntimeLeaseRecord = {
      schemaVersion: 1,
      scopeKey: matched.record.scopeKey,
      ownerId: matched.record.ownerId,
      processInstanceId: matched.record.processInstanceId,
      generation: matched.record.generation,
      status: "RELEASED",
      acquiredAt: matched.record.acquiredAt,
      heartbeatAt: matched.record.heartbeatAt,
      expiresAt: matched.record.expiresAt,
      updatedAt: canonicalTimestamp(nowMs),
    };
    const committed = await commitLeaseTransition(request, next, inspection, "RELEASED", [
      "LEASE_RELEASED",
    ]);
    if (committed.authority !== null) {
      fenceToken(request.directory, committed.authority);
    }
    return committed;
  });
}

export async function assertCurrentLease(request: LeaseTokenRequest): Promise<LeaseResult> {
  return withLeaseCoordination(request, async (nowMs) => {
    const inspection = await inspectLeasePair(request.directory, request.scopeKey);
    const matched = matchDurableToken(request, inspection, nowMs, {
      requireActive: true,
      requireUnexpired: true,
    });
    if (!matched.ok) {
      return leaseFail(
        request,
        matched.disposition,
        matched.reasonCodes,
        inspection,
        matched.blockLatch,
      );
    }
    return {
      disposition: "ACQUIRED",
      authority: matched.authority,
      record: matched.record,
      allowRiskIncrease: false,
      reasonCodes: sortLeaseCodes(["LEASE_ACQUIRED", ...inspection.reasonCodes]),
      latchState: request.latch.snapshot(),
      coordinationCapability: COORDINATION_CAPABILITY,
      distributedFencingProven: false,
      inspection,
    };
  });
}

export async function runLeaseFencedMutation<T>(
  request: LeaseTokenRequest & { mutation: () => T },
): Promise<FencedMutationResult<T>> {
  const distributed = distributedFailure(request);
  if (distributed !== null) {
    return mutationFail(request, distributed, false);
  }
  if (request.latch.blocked) {
    return mutationFail(request, ["LATCH_ALREADY_BLOCKED", "MUTATION_NOT_SENT"], false);
  }
  if (isTokenFenced(request.directory, request.authority)) {
    return mutationFail(request, ["FENCED_OWNER", "STALE_LEASE_TOKEN", "MUTATION_NOT_SENT"], false);
  }

  const clock = request.clock ?? systemLeaseClock();
  const nowMs = clock.nowMs();
  const guard = await acquireHostLocalCoordinationGuard(request.directory);
  if (!guard.ok) {
    request.latch.block(guard.reasonCodes);
    return mutationFail(request, [...guard.reasonCodes, "MUTATION_NOT_SENT"], true);
  }

  try {
    const inspection = await inspectLeasePair(request.directory, request.scopeKey);
    const matched = matchDurableToken(request, inspection, nowMs, {
      requireActive: true,
      requireUnexpired: true,
    });
    if (!matched.ok) {
      if (matched.blockLatch) {
        request.latch.block(matched.reasonCodes);
      }
      if (matched.fenceCaller) {
        fenceToken(request.directory, request.authority);
      }
      return {
        outcome: "NOT_SENT",
        value: null,
        allowRiskIncrease: false,
        reasonCodes: sortLeaseCodes([...matched.reasonCodes, "MUTATION_NOT_SENT"]),
        callbackCount: 0,
        latchState: request.latch.snapshot(),
        coordinationCapability: COORDINATION_CAPABILITY,
        distributedFencingProven: false,
      };
    }

    if (preCallbackHookForTests !== null) {
      preCallbackHookForTests();
    }

    const syncCheck = synchronousFenceCheck(request, matched.authority, nowMs);
    if (!syncCheck.ok) {
      if (syncCheck.blockLatch) {
        request.latch.block(syncCheck.reasonCodes);
      }
      fenceToken(request.directory, request.authority);
      return {
        outcome: "NOT_SENT",
        value: null,
        allowRiskIncrease: false,
        reasonCodes: sortLeaseCodes([...syncCheck.reasonCodes, "MUTATION_NOT_SENT"]),
        callbackCount: 0,
        latchState: request.latch.snapshot(),
        coordinationCapability: COORDINATION_CAPABILITY,
        distributedFencingProven: false,
      };
    }

    try {
      const value = request.mutation();
      return {
        outcome: "SENT",
        value,
        allowRiskIncrease: false,
        reasonCodes: sortLeaseCodes(["MUTATION_SENT"]),
        callbackCount: 1,
        latchState: request.latch.snapshot(),
        coordinationCapability: COORDINATION_CAPABILITY,
        distributedFencingProven: false,
      };
    } catch {
      return {
        outcome: "UNKNOWN",
        value: null,
        allowRiskIncrease: false,
        reasonCodes: sortLeaseCodes(["FENCED_CALLBACK_THREW"]),
        callbackCount: 1,
        latchState: request.latch.snapshot(),
        coordinationCapability: COORDINATION_CAPABILITY,
        distributedFencingProven: false,
      };
    }
  } finally {
    await guard.guard.release();
  }
}

async function withLeaseCoordination(
  request: {
    directory: string;
    latch: RuntimePersistenceLatch;
    clock?: LeaseClock;
    coordinationMode?: string;
  },
  run: (nowMs: bigint) => Promise<LeaseResult>,
): Promise<LeaseResult> {
  const distributed = distributedFailure(request);
  if (distributed !== null) {
    return leaseFail(request, "DISTRIBUTED_FENCING_UNPROVEN", distributed);
  }
  if (request.latch.blocked) {
    return leaseFail(request, "BLOCKED", ["LATCH_ALREADY_BLOCKED", "LEASE_BLOCKED"]);
  }
  const clock = request.clock ?? systemLeaseClock();
  const nowMs = clock.nowMs();
  const guard = await acquireHostLocalCoordinationGuard(request.directory);
  if (!guard.ok) {
    return leaseFail(request, "AUTHORITY_UNPROVEN", guard.reasonCodes, undefined, true);
  }
  try {
    return await run(nowMs);
  } finally {
    await guard.guard.release();
  }
}

async function initializeFirstLease(
  request: LeaseOperationRequest,
  nowMs: bigint,
): Promise<LeaseResult> {
  const now = canonicalTimestamp(nowMs);
  const record = makeLeaseRecord({
    scopeKey: request.scopeKey,
    ownerId: request.ownerId,
    processInstanceId: request.processInstanceId,
    generation: "1",
    status: "ACTIVE",
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: addTtl(now),
    updatedAt: now,
  });
  const persist = await initializeExactPair({
    directory: request.directory,
    stateName: LEASE_STATE_NAME,
    expectedKind: LEASE_KIND,
    expectedScopeKey: request.scopeKey,
    payload: record,
    bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
    latch: request.latch,
  });
  if (persist.disposition !== "REQUESTED_STATE_COMMITTED" || persist.state === null) {
    return leaseFail(
      request,
      "AUTHORITY_UNPROVEN",
      ["LEASE_AUTHORITY_UNPROVEN", ...persist.reasonCodes],
      persist.inspection,
      true,
    );
  }
  return authorityFromPersist(request, persist.state, persist, "ACQUIRED", ["LEASE_ACQUIRED"]);
}

async function takeoverLease(
  request: LeaseOperationRequest,
  nowMs: bigint,
  inspection: PairInspection,
  previous: RuntimeLeaseRecord,
): Promise<LeaseResult> {
  const nextGeneration = incrementCanonicalGeneration(previous.generation);
  if (!nextGeneration.ok) {
    return leaseFail(request, "AUTHORITY_UNPROVEN", [nextGeneration.reasonCode], inspection, true);
  }
  if (inspection.envelopeSha256 === null || inspection.generation === null) {
    return leaseFail(request, "AUTHORITY_UNPROVEN", ["LEASE_AUTHORITY_UNPROVEN"], inspection, true);
  }
  const now = canonicalTimestamp(nowMs);
  const record = makeLeaseRecord({
    scopeKey: request.scopeKey,
    ownerId: request.ownerId,
    processInstanceId: request.processInstanceId,
    generation: nextGeneration.generation,
    status: "ACTIVE",
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: addTtl(now),
    updatedAt: now,
  });
  const persist = await persistExactPairTransition({
    directory: request.directory,
    stateName: LEASE_STATE_NAME,
    expectedKind: LEASE_KIND,
    expectedScopeKey: request.scopeKey,
    expectedGeneration: inspection.generation,
    expectedPredecessorEnvelopeSha256: inspection.envelopeSha256,
    payload: record,
    latch: request.latch,
  });
  if (persist.disposition !== "REQUESTED_STATE_COMMITTED" || persist.state === null) {
    return leaseFail(
      request,
      "AUTHORITY_UNPROVEN",
      ["LEASE_AUTHORITY_UNPROVEN", ...persist.reasonCodes],
      persist.inspection,
      true,
    );
  }
  return authorityFromPersist(request, persist.state, persist, "ACQUIRED", ["LEASE_ACQUIRED"]);
}

async function commitLeaseTransition(
  request: {
    directory: string;
    scopeKey: string;
    latch: RuntimePersistenceLatch;
    authority?: LeaseAuthority;
  },
  next: RuntimeLeaseRecord,
  inspection: PairInspection,
  disposition: LeaseDisposition,
  extraCodes: string[],
): Promise<LeaseResult> {
  if (inspection.envelopeSha256 === null || inspection.generation === null) {
    return leaseFail(request, "AUTHORITY_UNPROVEN", ["LEASE_AUTHORITY_UNPROVEN"], inspection, true);
  }
  const persist = await persistExactPairTransition({
    directory: request.directory,
    stateName: LEASE_STATE_NAME,
    expectedKind: LEASE_KIND,
    expectedScopeKey: request.scopeKey,
    expectedGeneration: inspection.generation,
    expectedPredecessorEnvelopeSha256: inspection.envelopeSha256,
    payload: next,
    latch: request.latch,
  });
  if (persist.disposition !== "REQUESTED_STATE_COMMITTED" || persist.state === null) {
    return leaseFail(
      request,
      "AUTHORITY_UNPROVEN",
      ["LEASE_AUTHORITY_UNPROVEN", ...persist.reasonCodes],
      persist.inspection,
      true,
    );
  }
  return authorityFromPersist(request, persist.state, persist, disposition, extraCodes);
}

function authorityFromPersist(
  request: { directory: string; latch: RuntimePersistenceLatch },
  payload: unknown,
  persist: {
    committedEnvelopeSha256: string | null;
    committedGeneration: string | null;
    inspection: PairInspection;
  },
  disposition: LeaseDisposition,
  extraCodes: string[],
): LeaseResult {
  const parsed = parseLeaseRecord(payload);
  if (
    !parsed.ok ||
    persist.committedEnvelopeSha256 === null ||
    persist.committedGeneration === null
  ) {
    return leaseFail(
      request,
      "AUTHORITY_UNPROVEN",
      ["LEASE_AUTHORITY_UNPROVEN", ...(parsed.ok ? [] : parsed.reasonCodes)],
      persist.inspection,
      true,
    );
  }
  const authority: LeaseAuthority = {
    scopeKey: parsed.record.scopeKey,
    ownerId: parsed.record.ownerId,
    processInstanceId: parsed.record.processInstanceId,
    generation: parsed.record.generation,
    leaseEnvelopeSha256: persist.committedEnvelopeSha256,
    leaseStoreGeneration: persist.committedGeneration,
    observedExpiresAt: parsed.record.expiresAt,
  };
  rememberCommit(request.directory, authority);
  observeGeneration(request.directory, parsed.record.scopeKey, parsed.record.generation);
  return {
    disposition,
    authority,
    record: parsed.record,
    allowRiskIncrease: false,
    reasonCodes: sortLeaseCodes([...extraCodes, ...persist.inspection.reasonCodes]),
    latchState: request.latch.snapshot(),
    coordinationCapability: COORDINATION_CAPABILITY,
    distributedFencingProven: false,
    inspection: persist.inspection,
  };
}

function matchDurableToken(
  request: LeaseTokenRequest,
  inspection: PairInspection,
  nowMs: bigint,
  options: { requireActive: boolean; requireUnexpired: boolean },
):
  | {
      ok: true;
      record: RuntimeLeaseRecord;
      authority: LeaseAuthority;
    }
  | {
      ok: false;
      disposition: LeaseDisposition;
      reasonCodes: string[];
      blockLatch: boolean;
      fenceCaller: boolean;
    } {
  if (isTokenFenced(request.directory, request.authority)) {
    return {
      ok: false,
      disposition: "BLOCKED",
      reasonCodes: ["FENCED_OWNER", "STALE_LEASE_TOKEN"],
      blockLatch: false,
      fenceCaller: true,
    };
  }
  if (!inspection.pairAuthorityProven) {
    return {
      ok: false,
      disposition: "AUTHORITY_UNPROVEN",
      reasonCodes: ["LEASE_AUTHORITY_UNPROVEN", ...inspection.reasonCodes],
      blockLatch: true,
      fenceCaller: true,
    };
  }
  const parsed = parseProvenLease(inspection);
  if (!parsed.ok) {
    return {
      ok: false,
      disposition: "AUTHORITY_UNPROVEN",
      reasonCodes: parsed.reasonCodes,
      blockLatch: true,
      fenceCaller: true,
    };
  }
  if (hasObservedRegression(request.directory, request.scopeKey, parsed.record.generation)) {
    return {
      ok: false,
      disposition: "AUTHORITY_UNPROVEN",
      reasonCodes: ["LEASE_GENERATION_REGRESSION", "LEASE_AUTHORITY_UNPROVEN"],
      blockLatch: true,
      fenceCaller: true,
    };
  }
  observeGeneration(request.directory, request.scopeKey, parsed.record.generation);
  const clockCodes = clockReadCodes(parsed.record, nowMs);
  if (clockCodes !== null) {
    return {
      ok: false,
      disposition: "AUTHORITY_UNPROVEN",
      reasonCodes: clockCodes,
      blockLatch: true,
      fenceCaller: true,
    };
  }
  const local = lastCommitByProcessInstance.get(
    lastCommitKey(request.directory, request.authority.processInstanceId),
  );
  if (
    local !== undefined &&
    local.generation === parsed.record.generation &&
    local.envelopeSha256 !== inspection.envelopeSha256
  ) {
    return {
      ok: false,
      disposition: "AUTHORITY_UNPROVEN",
      reasonCodes: ["LEASE_RECORD_DIVERGED", "LEASE_AUTHORITY_UNPROVEN"],
      blockLatch: true,
      fenceCaller: true,
    };
  }
  if (local !== undefined && isExpiredAt(local.expiresAt, nowMs) && options.requireUnexpired) {
    return {
      ok: false,
      disposition: "BLOCKED",
      reasonCodes: ["LEASE_EXPIRED", "STALE_LEASE_TOKEN", "FENCED_OWNER"],
      blockLatch: false,
      fenceCaller: true,
    };
  }
  const mismatches: string[] = [];
  if (
    parsed.record.scopeKey !== request.scopeKey ||
    parsed.record.scopeKey !== request.authority.scopeKey
  ) {
    mismatches.push("SCOPE_MISMATCH");
  }
  if (parsed.record.ownerId !== request.authority.ownerId) {
    mismatches.push("OWNER_MISMATCH", "FORGED_LEASE_TOKEN");
  }
  if (parsed.record.processInstanceId !== request.authority.processInstanceId) {
    mismatches.push("PROCESS_INSTANCE_MISMATCH", "FORGED_LEASE_TOKEN");
  }
  if (parsed.record.generation !== request.authority.generation) {
    mismatches.push("LEASE_GENERATION_MISMATCH", "STALE_LEASE_TOKEN");
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      disposition: "BLOCKED",
      reasonCodes: mismatches,
      blockLatch: false,
      fenceCaller: true,
    };
  }
  if (options.requireActive && parsed.record.status !== "ACTIVE") {
    return {
      ok: false,
      disposition: "BLOCKED",
      reasonCodes: ["LEASE_RELEASED_STATUS", "STALE_LEASE_TOKEN", "FENCED_OWNER"],
      blockLatch: false,
      fenceCaller: true,
    };
  }
  if (options.requireUnexpired && isExpired(parsed.record, nowMs)) {
    return {
      ok: false,
      disposition: "BLOCKED",
      reasonCodes: ["LEASE_EXPIRED", "STALE_LEASE_TOKEN", "FENCED_OWNER"],
      blockLatch: false,
      fenceCaller: true,
    };
  }
  if (inspection.envelopeSha256 === null || inspection.generation === null) {
    return {
      ok: false,
      disposition: "AUTHORITY_UNPROVEN",
      reasonCodes: ["LEASE_AUTHORITY_UNPROVEN"],
      blockLatch: true,
      fenceCaller: true,
    };
  }
  return {
    ok: true,
    record: parsed.record,
    authority: {
      scopeKey: parsed.record.scopeKey,
      ownerId: parsed.record.ownerId,
      processInstanceId: parsed.record.processInstanceId,
      generation: parsed.record.generation,
      leaseEnvelopeSha256: inspection.envelopeSha256,
      leaseStoreGeneration: inspection.generation,
      observedExpiresAt: parsed.record.expiresAt,
    },
  };
}

function synchronousFenceCheck(
  request: LeaseTokenRequest,
  expected: LeaseAuthority,
  nowMs: bigint,
): { ok: true } | { ok: false; reasonCodes: string[]; blockLatch: boolean } {
  if (request.latch.blocked) {
    return { ok: false, reasonCodes: ["LATCH_ALREADY_BLOCKED"], blockLatch: false };
  }
  try {
    const primaryPath = path.join(request.directory, `${LEASE_STATE_NAME}.json`);
    const backupPath = path.join(request.directory, `${LEASE_STATE_NAME}.json.bak`);
    const primary = readFileSync(primaryPath);
    const backup = readFileSync(backupPath);
    if (!primary.equals(backup)) {
      return { ok: false, reasonCodes: ["LEASE_AUTHORITY_UNPROVEN"], blockLatch: true };
    }
    const parsed = parseAndValidateDurableEnvelope(primary);
    if (!parsed.ok) {
      return {
        ok: false,
        reasonCodes: ["LEASE_AUTHORITY_UNPROVEN", ...parsed.reasonCodes],
        blockLatch: true,
      };
    }
    if (
      parsed.envelope.kind !== LEASE_KIND ||
      parsed.envelope.scopeKey !== request.scopeKey ||
      parsed.envelope.envelopeSha256 !== expected.leaseEnvelopeSha256 ||
      parsed.envelope.storeGeneration !== expected.leaseStoreGeneration
    ) {
      return {
        ok: false,
        reasonCodes: ["LEASE_GENERATION_MISMATCH", "STALE_LEASE_TOKEN"],
        blockLatch: false,
      };
    }
    const record = parseLeaseRecord(parsed.envelope.payload);
    if (!record.ok) {
      return { ok: false, reasonCodes: record.reasonCodes, blockLatch: true };
    }
    if (
      record.record.ownerId !== expected.ownerId ||
      record.record.processInstanceId !== expected.processInstanceId ||
      record.record.generation !== expected.generation ||
      record.record.status !== "ACTIVE"
    ) {
      return {
        ok: false,
        reasonCodes: ["LEASE_GENERATION_MISMATCH", "STALE_LEASE_TOKEN"],
        blockLatch: false,
      };
    }
    if (isExpired(record.record, nowMs)) {
      return { ok: false, reasonCodes: ["LEASE_EXPIRED", "STALE_LEASE_TOKEN"], blockLatch: false };
    }
    return { ok: true };
  } catch {
    return { ok: false, reasonCodes: ["LEASE_AUTHORITY_UNPROVEN", "IO_FAILURE"], blockLatch: true };
  }
}

function parseProvenLease(
  inspection: PairInspection,
): { ok: true; record: RuntimeLeaseRecord } | { ok: false; reasonCodes: string[] } {
  if (inspection.primary.status !== "VALID") {
    return { ok: false, reasonCodes: ["LEASE_AUTHORITY_UNPROVEN", "INVALID_LEASE_RECORD"] };
  }
  return parseLeaseRecord(inspection.primary.envelope.payload);
}

export function parseLeaseRecord(
  payload: unknown,
): { ok: true; record: RuntimeLeaseRecord } | { ok: false; reasonCodes: string[] } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD"] };
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== LEASE_RECORD_KEYS.length ||
    keys.some((key, index) => key !== LEASE_RECORD_KEYS[index])
  ) {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD"] };
  }
  if (record.schemaVersion !== LEASE_RECORD_SCHEMA_VERSION) {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD"] };
  }
  if (typeof record.scopeKey !== "string") {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD", "SCOPE_MISMATCH"] };
  }
  if (typeof record.ownerId !== "string" || !OWNER_ID_PATTERN.test(record.ownerId)) {
    return { ok: false, reasonCodes: ["INVALID_OWNER_ID"] };
  }
  if (
    typeof record.processInstanceId !== "string" ||
    !OWNER_ID_PATTERN.test(record.processInstanceId)
  ) {
    return { ok: false, reasonCodes: ["INVALID_PROCESS_INSTANCE_ID"] };
  }
  if (typeof record.generation !== "string" || !isCanonicalGenerationString(record.generation)) {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD", "LEASE_GENERATION_MISMATCH"] };
  }
  if (record.status !== "ACTIVE" && record.status !== "RELEASED") {
    return { ok: false, reasonCodes: ["INVALID_LEASE_STATUS"] };
  }
  const acquiredAt = parseTimestampField(record.acquiredAt);
  const heartbeatAt = parseTimestampField(record.heartbeatAt);
  const expiresAt = parseTimestampField(record.expiresAt);
  const updatedAt = parseTimestampField(record.updatedAt);
  if (!acquiredAt.ok || !heartbeatAt.ok || !expiresAt.ok || !updatedAt.ok) {
    return {
      ok: false,
      reasonCodes: [
        ...(!acquiredAt.ok ? acquiredAt.reasonCodes : []),
        ...(!heartbeatAt.ok ? heartbeatAt.reasonCodes : []),
        ...(!expiresAt.ok ? expiresAt.reasonCodes : []),
        ...(!updatedAt.ok ? updatedAt.reasonCodes : []),
      ],
    };
  }
  if (compareTimestamp(acquiredAt.value, heartbeatAt.value) > 0) {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD"] };
  }
  if (addTtl(heartbeatAt.value) !== expiresAt.value) {
    return { ok: false, reasonCodes: ["LEASE_TTL_MISMATCH"] };
  }
  if (compareTimestamp(updatedAt.value, heartbeatAt.value) < 0) {
    return { ok: false, reasonCodes: ["INVALID_LEASE_RECORD"] };
  }
  return {
    ok: true,
    record: {
      schemaVersion: 1,
      scopeKey: record.scopeKey,
      ownerId: record.ownerId,
      processInstanceId: record.processInstanceId,
      generation: record.generation,
      status: record.status,
      acquiredAt: acquiredAt.value,
      heartbeatAt: heartbeatAt.value,
      expiresAt: expiresAt.value,
      updatedAt: updatedAt.value,
    },
  };
}

function parseTimestampField(
  value: unknown,
): { ok: true; value: string } | { ok: false; reasonCodes: string[] } {
  if (typeof value !== "string") {
    return { ok: false, reasonCodes: ["MALFORMED_TIMESTAMP"] };
  }
  if (!isCanonicalLeaseTimestamp(value)) {
    if (/^[0-9]+$/.test(value) && value.length > 13) {
      return { ok: false, reasonCodes: ["EXCESSIVE_TIMESTAMP"] };
    }
    return { ok: false, reasonCodes: ["MALFORMED_TIMESTAMP"] };
  }
  const numeric = BigInt(value);
  if (numeric > MAX_TIMESTAMP_MS) {
    return { ok: false, reasonCodes: ["EXCESSIVE_TIMESTAMP"] };
  }
  return { ok: true, value };
}

function clockReadCodes(record: RuntimeLeaseRecord, nowMs: bigint): string[] | null {
  const codes: string[] = [];
  const acquiredAt = BigInt(record.acquiredAt);
  const heartbeatAt = BigInt(record.heartbeatAt);
  if (acquiredAt - nowMs > MAX_CLOCK_SKEW_MS) {
    codes.push("FUTURE_TIMESTAMP", "CLOCK_REGRESSION");
  }
  if (heartbeatAt - nowMs > MAX_CLOCK_SKEW_MS) {
    codes.push("CLOCK_REGRESSION");
  }
  if (nowMs - heartbeatAt > MAX_FORWARD_JUMP_MS) {
    codes.push("CLOCK_FORWARD_JUMP");
  }
  return codes.length === 0 ? null : [...new Set(codes)];
}

function isExpired(record: RuntimeLeaseRecord, nowMs: bigint): boolean {
  return isExpiredAt(record.expiresAt, nowMs);
}

function isExpiredAt(expiresAt: string, nowMs: bigint): boolean {
  return nowMs >= BigInt(expiresAt);
}

function addTtl(heartbeatAt: string): string {
  return (BigInt(heartbeatAt) + LEASE_TTL_MS).toString(10);
}

function canonicalTimestamp(nowMs: bigint): string {
  if (nowMs < 0n || nowMs > MAX_TIMESTAMP_MS) {
    throw new Error("MALFORMED_TIMESTAMP");
  }
  return nowMs.toString(10);
}

function maxTimestamp(left: string, right: string): string {
  return compareTimestamp(left, right) >= 0 ? left : right;
}

function compareTimestamp(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

function makeLeaseRecord(record: Omit<RuntimeLeaseRecord, "schemaVersion">): RuntimeLeaseRecord {
  return {
    schemaVersion: 1,
    scopeKey: record.scopeKey,
    ownerId: record.ownerId,
    processInstanceId: record.processInstanceId,
    generation: record.generation,
    status: record.status,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
  };
}

function validateIdentities(ownerId: string, processInstanceId: string): string[] | null {
  const codes: string[] = [];
  if (!OWNER_ID_PATTERN.test(ownerId)) {
    codes.push("INVALID_OWNER_ID");
  }
  if (!OWNER_ID_PATTERN.test(processInstanceId)) {
    codes.push("INVALID_PROCESS_INSTANCE_ID");
  }
  return codes.length === 0 ? null : codes;
}

function distributedFailure(request: { coordinationMode?: string }): string[] | null {
  if (isHostLocalCoordinationMode(request.coordinationMode)) {
    return null;
  }
  return ["DISTRIBUTED_FENCING_UNPROVEN"];
}

function observeGeneration(directory: string, scopeKey: string, generation: string): void {
  const key = `${directory}\0${scopeKey}`;
  const previous = observedGenerationByScope.get(key);
  if (previous === undefined || BigInt(generation) > BigInt(previous)) {
    observedGenerationByScope.set(key, generation);
  }
}

function hasObservedRegression(directory: string, scopeKey: string, generation: string): boolean {
  const previous = observedGenerationByScope.get(`${directory}\0${scopeKey}`);
  return previous !== undefined && BigInt(generation) < BigInt(previous);
}

function rememberCommit(directory: string, authority: LeaseAuthority): void {
  lastCommitByProcessInstance.set(lastCommitKey(directory, authority.processInstanceId), {
    generation: authority.generation,
    envelopeSha256: authority.leaseEnvelopeSha256,
    expiresAt: authority.observedExpiresAt,
  });
}

function lastCommitKey(directory: string, processInstanceId: string): string {
  return `${directory}\0${processInstanceId}`;
}

function tokenKey(directory: string, authority: LeaseAuthority): string {
  return `${directory}\0${authority.scopeKey}\0${authority.ownerId}\0${authority.processInstanceId}\0${authority.generation}`;
}

function fenceToken(directory: string, authority: LeaseAuthority): void {
  fencedTokens.add(tokenKey(directory, authority));
}

function isTokenFenced(directory: string, authority: LeaseAuthority): boolean {
  return fencedTokens.has(tokenKey(directory, authority));
}

async function inspectLeasePair(directory: string, scopeKey: string): Promise<PairInspection> {
  return inspectExactPair({
    directory,
    stateName: LEASE_STATE_NAME,
    expectedKind: LEASE_KIND,
    expectedScopeKey: scopeKey,
  });
}

function leaseFail(
  request: { latch: RuntimePersistenceLatch },
  disposition: LeaseDisposition,
  reasonCodes: string[],
  inspection?: PairInspection,
  blockLatch = false,
): LeaseResult {
  const codes = sortLeaseCodes([
    ...reasonCodes,
    ...(request.latch.blocked ? ["LATCH_ALREADY_BLOCKED"] : []),
  ]);
  if (blockLatch) {
    request.latch.block(codes);
  }
  return {
    disposition,
    authority: null,
    record: null,
    allowRiskIncrease: false,
    reasonCodes: codes,
    latchState: request.latch.snapshot(),
    coordinationCapability: COORDINATION_CAPABILITY,
    distributedFencingProven: false,
    inspection:
      inspection ??
      ({
        pairStatus: "UNPROVEN",
        primary: { status: "MISSING" },
        backup: { status: "MISSING" },
        exactBytesEqual: false,
        pairAuthorityProven: false,
        lineageStatus: "UNVERIFIED",
        generation: null,
        envelopeSha256: null,
        reasonCodes: sortPhase2BReasonCodes(codes),
        allowRiskIncrease: false,
      } satisfies PairInspection),
  };
}

function mutationFail(
  request: { latch: RuntimePersistenceLatch },
  reasonCodes: string[],
  _blocked: boolean,
): FencedMutationResult<never> {
  return {
    outcome: "NOT_SENT",
    value: null,
    allowRiskIncrease: false,
    reasonCodes: sortLeaseCodes(reasonCodes),
    callbackCount: 0,
    latchState: request.latch.snapshot(),
    coordinationCapability: COORDINATION_CAPABILITY,
    distributedFencingProven: false,
  };
}

function sortLeaseCodes(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map<string, number>(
    PHASE_2C_REASON_CODE_CATALOG.map((code, index) => [code, index]),
  );
  return unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
}
