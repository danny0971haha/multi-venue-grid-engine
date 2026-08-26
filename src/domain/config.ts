import type { ExperimentConfig } from "./types.js";

export const V01_EXPERIMENT_CONFIG: ExperimentConfig = {
  version: "0.1.0",
  capitalCeilingUsd: "100",
  leverage: "5",
  marginBudgetUsd: "30",
  maxPlannedGrossNotionalUsd: "150",
  gridLevels: 10,
  gridHalfBandFraction: "0.03",
  dailyLossLimitUsd: "5",
  drawdownFromStartLimitUsd: "10",
  boundaryBufferFraction: "0.01",
};

export function frozenExperimentConfig(): ExperimentConfig {
  return { ...V01_EXPERIMENT_CONFIG };
}
