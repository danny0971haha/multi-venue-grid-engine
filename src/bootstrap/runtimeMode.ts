export const DEFAULT_RUNTIME_MODE = "DRY_RUN" as const;

export type RuntimeMode = "DRY_RUN" | "LIVE";

export const LIVE_MODE_NOT_IMPLEMENTED = "LIVE_MODE_NOT_IMPLEMENTED";

export const EXPERIMENT_SPEC_VERSION = "0.1.0" as const;

export type DryRunReport = {
  project: "multi-venue-grid-engine";
  runtimeMode: typeof DEFAULT_RUNTIME_MODE;
  liveExchangeWrites: false;
  phase: 0;
  experimentSpecVersion: typeof EXPERIMENT_SPEC_VERSION;
};

export function resolveRuntimeMode(
  configuredMode: string | undefined = process.env.RUNTIME_MODE,
): typeof DEFAULT_RUNTIME_MODE {
  if (configuredMode === undefined || configuredMode === "") {
    return DEFAULT_RUNTIME_MODE;
  }

  if (configuredMode === DEFAULT_RUNTIME_MODE) {
    return DEFAULT_RUNTIME_MODE;
  }

  if (configuredMode === "LIVE") {
    throw new Error(LIVE_MODE_NOT_IMPLEMENTED);
  }

  throw new Error(`UNSUPPORTED_RUNTIME_MODE:${configuredMode}`);
}

export function bootDryRun(
  configuredMode: string | undefined = process.env.RUNTIME_MODE,
): DryRunReport {
  return {
    project: "multi-venue-grid-engine",
    runtimeMode: resolveRuntimeMode(configuredMode),
    liveExchangeWrites: false,
    phase: 0,
    experimentSpecVersion: EXPERIMENT_SPEC_VERSION,
  };
}
