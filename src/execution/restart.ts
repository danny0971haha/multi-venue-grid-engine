import type { AnchorEpoch, IntentId } from "../domain/ids.js";
import type {
  ExecutionCoordinator,
  ExecutionReplayResult,
  OpenOrderScan,
  ReconcileResult,
} from "./coordinator.js";
import type { IntentRegistry, IntentStatus } from "./intent-registry.js";
import type { IntentJournal } from "./ports.js";

export type RecoveredIntent = {
  intentId: IntentId;
  from: IntentStatus;
  to: IntentStatus;
};

export type RestartRecoveryResult = {
  ok: boolean;
  reasonCodes: string[];
  items: RecoveredIntent[];
};

export type RestartGateResult = {
  allowRiskIncrease: boolean;
  reasonCodes: string[];
  reconcile: ReconcileResult;
  scan: OpenOrderScan;
  replay: ExecutionReplayResult;
};

// A process that died during a send or cancel leaves PREPARED or CANCEL_PREPARED records
// whose outcome nobody observed. Before any coordinator uses a loaded registry, both become
// explicitly unknown and durable; they stay unresolved until exchange evidence resolves them.
// A failed write means the caller must not continue with this registry.
export async function recoverInterruptedIntents(
  registry: IntentRegistry,
  journal: IntentJournal,
): Promise<RestartRecoveryResult> {
  const items: RecoveredIntent[] = [];
  for (const record of registry.unresolved()) {
    const intentId = record.intent.intentId;
    if (record.status === "PREPARED") {
      registry.markUnknown(intentId, ["RESTART_SEND_OUTCOME_UNKNOWN"]);
      items.push({ intentId, from: "PREPARED", to: "UNKNOWN" });
    } else if (record.status === "CANCEL_PREPARED") {
      registry.markCancelUnverified(intentId, ["RESTART_CANCEL_OUTCOME_UNKNOWN"]);
      items.push({ intentId, from: "CANCEL_PREPARED", to: "CANCEL_UNVERIFIED" });
    }
  }
  if (items.length === 0) {
    return { ok: true, reasonCodes: [], items };
  }
  try {
    await journal.persist(registry.exportState());
  } catch {
    return { ok: false, reasonCodes: ["RESTART_RECOVERY_WRITE_FAILED"], items };
  }
  return { ok: true, reasonCodes: [], items };
}

// The restart gate: reconcile unresolved intents, scan open orders, then replay executions.
// Every step runs even after an earlier one reports a problem, so the result names each
// blocker. Risk increase is allowed only when the coordinator reports no blocker afterwards.
export async function runRestartGate(
  coordinator: ExecutionCoordinator,
  anchorEpoch: AnchorEpoch,
): Promise<RestartGateResult> {
  const reconcile = await coordinator.reconcileUnresolved();
  const scan = await coordinator.scanOpenOrders(anchorEpoch);
  const replay = await coordinator.replayExecutions();
  const reasonCodes = coordinator.riskIncreaseBlockers();
  return { allowRiskIncrease: reasonCodes.length === 0, reasonCodes, reconcile, scan, replay };
}
