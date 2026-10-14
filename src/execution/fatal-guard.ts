import { writeSync } from "node:fs";
import type { RuntimePersistenceLatch } from "../persistence/runtime-persistence-latch.js";

export const FATAL_EXIT_CODE = 70;

let installed = false;

// Turns any uncaught exception or unhandled rejection into process termination. The latch is
// blocked first, so no fenced write can start after the fault, and the process then exits
// with FATAL_EXIT_CODE; nothing logs the fault and keeps trading. Only a reason code is
// written, never the error, since it may carry request data.
export function installFatalProcessGuard(latch: RuntimePersistenceLatch): void {
  if (installed) {
    throw new Error("FATAL_GUARD_ALREADY_INSTALLED");
  }
  installed = true;
  process.on("uncaughtException", () => terminate(latch, "FATAL_UNCAUGHT_EXCEPTION"));
  process.on("unhandledRejection", () => terminate(latch, "FATAL_UNHANDLED_REJECTION"));
}

function terminate(latch: RuntimePersistenceLatch, reasonCode: string): never {
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
