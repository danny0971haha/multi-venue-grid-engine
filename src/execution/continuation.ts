import { inspectHaltContinuation } from "../halt/index.js";
import type { HaltRuntimeContext } from "../halt/index.js";
import { evaluateRisk } from "../risk/risk-engine.js";
import type { RiskAction, RiskDecision } from "../risk/risk-types.js";
import type { ExposureReservation } from "./coordinator.js";
import type { HaltAuthorityPort, HaltAuthorityView } from "./ports.js";

// What the continuation gate decided. allowRiskIncrease is true only for CONTINUE, and then
// grants exactly one risk-increasing submit or batch.
export type ContinuationDecision = {
  action: RiskAction;
  allowRiskIncrease: boolean;
  reasonCodes: string[];
  evaluatedAt: string | null;
  risk: RiskDecision | null;
  haltStatus: string | null;
};

// Everything one gate evaluation observed. riskInputs and haltView are null when their read
// rejected; any other value is checked here, never trusted.
export type ContinuationEvidence = {
  riskInputs: unknown;
  haltView: unknown;
  reservation: ExposureReservation;
  blockers: readonly string[];
};

// Keys the coordinator supplies itself. A source that sets any of them is not a
// RiskAccountInputs, so the evaluation fails closed instead of choosing one of the values.
const COORDINATOR_RISK_KEYS = [
  "ownedActiveOrders",
  "unknownReservations",
  "proposedBatch",
  "haltAuthorityClear",
];

// Decides CONTINUE, REDUCE or HALT from the frozen risk rules, the coordinator's blockers and
// the durable halt authority. Risk increase is allowed only when the risk rules say CONTINUE
// within limits without blocking new seeding, nothing blocks the coordinator and a proven
// RUNNING halt record allows it. Missing, malformed or unknown evidence never continues.
export function decideContinuation(evidence: ContinuationEvidence): ContinuationDecision {
  const gateCodes: string[] = [];
  const input = riskInput(evidence);
  if (input === null) {
    gateCodes.push("RISK_INPUT_UNAVAILABLE");
  }
  const risk = evaluateRisk(input);
  const halt = haltAuthorityView(evidence.haltView);
  if (halt === null) {
    gateCodes.push("HALT_AUTHORITY_UNAVAILABLE");
  }
  const haltAllows = halt?.allowRiskIncrease === true && halt.durableStatus === "RUNNING";
  if (!haltAllows) {
    gateCodes.push("HALT_AUTHORITY_DENIED");
  }
  const action: RiskAction = risk.action === "HALT" || !haltAllows ? "HALT" : risk.action;
  // A flat position outside the grid band is no hard halt, but no new seeding either.
  const allowRiskIncrease =
    action === "CONTINUE" &&
    evidence.blockers.length === 0 &&
    risk.riskMetricsWithinLimits &&
    !risk.reasonCodes.includes("BOUNDARY_SEED_BLOCKED");
  if (allowRiskIncrease) {
    gateCodes.push("CONTINUATION_GRANTED");
  }
  const reasonCodes = new Set([
    ...risk.reasonCodes,
    ...evidence.blockers,
    ...(halt?.reasonCodes ?? []),
    ...gateCodes,
  ]);
  return {
    action,
    allowRiskIncrease,
    reasonCodes: [...reasonCodes].sort(compareStrings),
    evaluatedAt: risk.evaluatedAt,
    risk,
    haltStatus: halt?.durableStatus ?? null,
  };
}

// The gate's result when it could not run at all.
export function unevaluatedContinuation(reasonCodes: string[]): ContinuationDecision {
  return {
    action: "HALT",
    allowRiskIncrease: false,
    reasonCodes: [...reasonCodes].sort(compareStrings),
    evaluatedAt: null,
    risk: null,
    haltStatus: null,
  };
}

// Reads the durable halt authority of a 2E halt runtime context without changing it.
export function createHaltAuthorityPort(context: HaltRuntimeContext): HaltAuthorityPort {
  return { inspect: () => inspectHaltContinuation(context) };
}

// The source's account inputs with this coordinator's own working orders and reservations.
// Any blocker is reported to the risk rules as unresolved reconciliation.
function riskInput(evidence: ContinuationEvidence): Record<string, unknown> | null {
  const source = evidence.riskInputs;
  try {
    if (
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source) ||
      COORDINATOR_RISK_KEYS.some((key) => Object.hasOwn(source, key))
    ) {
      return null;
    }
    const account = source as Record<string, unknown>;
    return {
      ...account,
      ownedActiveOrders: evidence.reservation.ownedActiveOrders,
      unknownReservations: evidence.reservation.unknownReservations,
      proposedBatch: [],
      haltAuthorityClear: false,
      reconciliation: evidence.blockers.length > 0 ? { unresolved: true } : account.reconciliation,
    };
  } catch {
    return null;
  }
}

function haltAuthorityView(value: unknown): HaltAuthorityView | null {
  try {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const view = value as HaltAuthorityView;
    const durableStatus = view.durableStatus;
    const allowRiskIncrease = view.allowRiskIncrease;
    const reasonCodes: unknown = view.reasonCodes;
    if (
      typeof durableStatus !== "string" ||
      typeof allowRiskIncrease !== "boolean" ||
      !Array.isArray(reasonCodes) ||
      !reasonCodes.every((code) => typeof code === "string")
    ) {
      return null;
    }
    return { durableStatus, allowRiskIncrease, reasonCodes: [...reasonCodes] };
  } catch {
    return null;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
