import { writeSync } from "node:fs";
import type { HaltProcessFence } from "../halt/index.js";
import type { RuntimePersistenceLatch } from "../persistence/runtime-persistence-latch.js";

export const FATAL_EXIT_CODE = 70;

let installed = false;

// Turns any uncaught exception or unhandled rejection into process termination. The halt
// process fence, when the runtime has one, is tripped and the latch is blocked first, so
// neither risk-increase authority nor any fenced write survives the fault, and the process
// then exits with FATAL_EXIT_CODE; nothing logs the fault and keeps trading. Only a reason
// code is written, never the error, since it may carry request data.
export function installFatalProcessGuard(
  latch: RuntimePersistenceLatch,
  processFence?: HaltProcessFence,
): void {
  if (installed) {
    throw new Error("FATAL_GUARD_ALREADY_INSTALLED");
  }
  installed = true;
  process.on("uncaughtException", () => terminate(latch, processFence, "FATAL_UNCAUGHT_EXCEPTION"));
  process.on("unhandledRejection", () =>
    terminate(latch, processFence, "FATAL_UNHANDLED_REJECTION"),
  );
}

function terminate(
  latch: RuntimePersistenceLatch,
  processFence: HaltProcessFence | undefined,
  reasonCode: string,
): never {
  processFence?.trip();
  try {
    latch.block([reasonCode]);
  } catch {
    // The exit below still fences every later write.
  }
  try {
    writeSync(2, `${JSON.stringify({ event: "FATAL_PROCESS_ERROR", reasonCode })}\n`);
  } catch {
    // Reporting is best effort; termination is not.
  }
  process.exit(FATAL_EXIT_CODE);
}
