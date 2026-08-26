import type { GridLevelState } from "../domain/enums.js";

export type TransitionEvidence = "ACK" | "OBSERVATION" | "REJECTED" | "UNKNOWN" | "LOCAL";

const MUTATION_EVIDENCE = new Set<TransitionEvidence>([
  "ACK",
  "OBSERVATION",
  "REJECTED",
  "UNKNOWN",
]);

export function isMutationDependentTransition(from: GridLevelState, to: GridLevelState): boolean {
  if (from === to) {
    return false;
  }
  if (from === "IDLE" && to === "ENTRY_SUBMITTING") {
    return false;
  }
  if (from === "ENTRY_SUBMITTING" && to === "IDLE") {
    return false;
  }
  if (from === "POSITION_OPEN" && to === "EXIT_SUBMITTING") {
    return false;
  }
  if (from === "EXIT_SUBMITTING" && to === "POSITION_OPEN") {
    return false;
  }
  if (from === "ENTRY_WORKING" && to === "CANCEL_PENDING") {
    return false;
  }
  if (from === "ENTRY_PARTIAL" && to === "CANCEL_PENDING") {
    return false;
  }
  if (from === "EXIT_WORKING" && to === "CANCEL_PENDING") {
    return false;
  }
  if (from === "EXIT_PARTIAL" && to === "CANCEL_PENDING") {
    return false;
  }
  return true;
}

export function assertTransition(
  from: GridLevelState,
  to: GridLevelState,
  evidence: TransitionEvidence,
): void {
  if (from === to) {
    return;
  }
  if (isMutationDependentTransition(from, to) && !MUTATION_EVIDENCE.has(evidence)) {
    throw new Error(`FORBIDDEN_STATE_TRANSITION:${from}->${to}:${evidence}`);
  }
}

export function isWorkingState(state: GridLevelState): boolean {
  return (
    state === "ENTRY_WORKING" ||
    state === "ENTRY_PARTIAL" ||
    state === "EXIT_WORKING" ||
    state === "EXIT_PARTIAL"
  );
}

export function isRiskIncreasingState(state: GridLevelState): boolean {
  return (
    state === "ENTRY_SUBMITTING" ||
    state === "ENTRY_WORKING" ||
    state === "ENTRY_PARTIAL" ||
    state === "RECONCILING"
  );
}
