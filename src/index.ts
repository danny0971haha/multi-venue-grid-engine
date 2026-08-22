import { bootDryRun } from "./bootstrap/runtimeMode.js";

try {
  process.stdout.write(`${JSON.stringify(bootDryRun())}\n`);
} catch (error: unknown) {
  const reason = error instanceof Error ? error.message : "UNKNOWN_BOOTSTRAP_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
  process.exitCode = 1;
}
