export const DEFAULT_RUNTIME_MODE = "dry-run" as const;

export type RuntimeMode = typeof DEFAULT_RUNTIME_MODE;

export function resolveRuntimeMode(
  configuredMode: string | undefined = process.env.GRID_ENGINE_MODE,
): RuntimeMode {
  if (configuredMode === undefined || configuredMode === "" || configuredMode === "dry-run") {
    return DEFAULT_RUNTIME_MODE;
  }

  throw new Error(
    `Unsupported runtime mode: ${configuredMode}. Phase 0 permits dry-run only; live mode is unavailable.`,
  );
}
