import process from "node:process";

import { DEFAULT_COMMAND, finalizePacket, RetentionError } from "./lib.mjs";

try {
  const result = finalizePacket({
    repoRoot: process.cwd(),
    env: process.env,
    intendedCommand: [...DEFAULT_COMMAND],
  });
  if (!result.verification.ok) {
    process.stderr.write(
      `ci-native-log-retention finalize verification failed:\n${result.verification.errors.join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `ci-native-log-retention packet=${result.packetId} integration=${result.verification.integrationStatus} fresh=${result.verification.freshExecutionLog}\n`,
    );
  }
} catch (error) {
  const message =
    error instanceof RetentionError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
