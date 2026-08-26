import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HaltAuthoritativeSnapshot,
  HaltOwnedOrder,
  HaltRuntimeContext,
} from "../../src/halt/index.js";
import {
  HaltProcessFence,
  createSequentialHaltIdSource,
  createScriptedHaltTransport,
  fixedHaltClock,
  initializeDurableHalt,
} from "../../src/halt/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  acquireRuntimeLease,
  createProcessInstanceId,
  fixedLeaseClock,
  resetLeaseProcessStateForTests,
} from "../../src/persistence/runtime-lease.js";
import type { RiskInput } from "../../src/risk/index.js";

export const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
export const EXPERIMENT_ID = "exp-phase2e";
export const NOW_MS = 1_000_000n;
export const HALT_ISO = "1970-01-01T00:16:40.000Z";
export const RISK_NOW = "1000000";

export function baselineRiskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    signedPosition: overrides.signedPosition ?? "0",
    markOrMidPrice: overrides.markOrMidPrice ?? "100",
    equity: overrides.equity ?? "100",
    startingEquity: overrides.startingEquity ?? "100",
    highWaterEquity: overrides.highWaterEquity ?? "100",
    realizedTradingPnl: overrides.realizedTradingPnl ?? "0",
    fees: overrides.fees === undefined ? "0" : overrides.fees,
    funding: overrides.funding === undefined ? "0" : overrides.funding,
    fundingConvention:
      overrides.fundingConvention === undefined ? "RECEIVED_POSITIVE" : overrides.fundingConvention,
    ownedActiveOrders: overrides.ownedActiveOrders ?? [],
    unknownReservations: overrides.unknownReservations ?? [],
    proposedBatch: overrides.proposedBatch ?? [],
    gridLower: overrides.gridLower ?? "97",
    gridUpper: overrides.gridUpper ?? "103",
    freshness: {
      evaluatedAt: RISK_NOW,
      maxStaleMs: "1000",
      positionObservedAt: RISK_NOW,
      equityObservedAt: RISK_NOW,
      markObservedAt: RISK_NOW,
      pnlObservedAt: RISK_NOW,
      ...(overrides.freshness ?? {}),
    },
    reconciliation: { unresolved: false, ...(overrides.reconciliation ?? {}) },
    lease: { proven: true, expired: false, lost: false, ...(overrides.lease ?? {}) },
    latchBlocked: overrides.latchBlocked ?? false,
    durableInspection: {
      pairAuthorityProven: true,
      ...(overrides.durableInspection ?? {}),
    },
    haltAuthorityClear: false,
    boundedReduction: {
      possible: true,
      ambiguous: false,
      cancelOnly: false,
      snapshotFresh: true,
      ...(overrides.boundedReduction ?? {}),
    },
  };
}

export function dailyLossHaltInput(): RiskInput {
  return baselineRiskInput({
    realizedTradingPnl: "-5",
    fees: "0",
    funding: "0",
  });
}

export function actualNotionalReduceInput(): RiskInput {
  return baselineRiskInput({
    signedPosition: "2",
    markOrMidPrice: "100",
  });
}

export function ownedAndForeignOrders(): HaltOwnedOrder[] {
  return [
    { exchangeOrderId: "owned-risk-1", ownership: "OWNED", riskIncreasing: true },
    { exchangeOrderId: "foreign-1", ownership: "UNOWNED", riskIncreasing: true },
    { exchangeOrderId: "owned-reduce-1", ownership: "OWNED", riskIncreasing: false },
  ];
}

export function snapshot(
  args: Partial<HaltAuthoritativeSnapshot> & { leaseGeneration: string },
): HaltAuthoritativeSnapshot {
  return {
    fresh: args.fresh ?? true,
    authoritative: args.authoritative ?? true,
    leaseGeneration: args.leaseGeneration,
    signedPosition: args.signedPosition ?? "0",
    actualGrossNotional: args.actualGrossNotional ?? "0",
    ownedRiskIncreasingRemaining: args.ownedRiskIncreasingRemaining ?? false,
    observedAt: args.observedAt ?? RISK_NOW,
  };
}

function bindSnapshots(
  snapshots: readonly HaltAuthoritativeSnapshot[] | undefined,
  leaseGeneration: string,
): HaltAuthoritativeSnapshot[] {
  if (snapshots === undefined) {
    return [snapshot({ leaseGeneration })];
  }
  return snapshots.map((item) =>
    item.leaseGeneration === "pending" ? { ...item, leaseGeneration } : { ...item },
  );
}

export async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2e-halt-"));
  try {
    await run(directory);
  } finally {
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function seedHaltContext(
  directory: string,
  script: Parameters<typeof createScriptedHaltTransport>[0],
): Promise<{
  context: HaltRuntimeContext;
  transport: ReturnType<typeof createScriptedHaltTransport>;
}> {
  const latch = new RuntimePersistenceLatch();
  const ownerId = "ownera";
  const processInstanceId = createProcessInstanceId();
  const acquired = await acquireRuntimeLease({
    directory,
    scopeKey: SCOPE_KEY,
    ownerId,
    processInstanceId,
    latch,
    clock: fixedLeaseClock(NOW_MS),
  });
  if (acquired.authority === null) {
    throw new Error(`lease acquire failed: ${acquired.reasonCodes.join(",")}`);
  }
  const leaseGeneration = acquired.authority.generation;
  const transport = createScriptedHaltTransport({
    orders: script.orders ?? ownedAndForeignOrders(),
    snapshots: bindSnapshots(script.snapshots, leaseGeneration),
    ...(script.cancelById === undefined ? {} : { cancelById: script.cancelById }),
    ...(script.defaultCancel === undefined ? {} : { defaultCancel: script.defaultCancel }),
    ...(script.flatten === undefined ? {} : { flatten: script.flatten }),
    ...(script.reduce === undefined ? {} : { reduce: script.reduce }),
  });
  const context: HaltRuntimeContext = {
    directory,
    scopeKey: SCOPE_KEY,
    experimentId: EXPERIMENT_ID,
    latch,
    leaseAuthority: acquired.authority,
    leaseClock: fixedLeaseClock(NOW_MS),
    haltClock: fixedHaltClock(HALT_ISO),
    haltIdSource: createSequentialHaltIdSource("h"),
    transport,
    processFence: new HaltProcessFence(),
  };
  const initialized = await initializeDurableHalt(context, { startingEquityUsd: "100" });
  if (initialized.durableStatus !== "RUNNING" || initialized.durableGeneration !== "1") {
    throw new Error(`halt initialize failed: ${initialized.reasonCodes.join(",")}`);
  }
  return { context, transport };
}

export function resumeEvidence(
  leaseGeneration: string,
  extras?: Partial<{
    snapshotFresh: boolean;
    snapshotAuthoritative: boolean;
  }>,
) {
  return {
    snapshotFresh: extras?.snapshotFresh ?? true,
    snapshotAuthoritative: extras?.snapshotAuthoritative ?? true,
    snapshotLeaseGeneration: leaseGeneration,
  };
}
