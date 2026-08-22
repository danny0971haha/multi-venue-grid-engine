import { resolveRuntimeMode } from "./runtime-mode.js";

const mode = resolveRuntimeMode();

process.stdout.write(
  `${JSON.stringify({
    phase: 0,
    mode,
    liveExchangeWritesEnabled: false,
  })}\n`,
);
