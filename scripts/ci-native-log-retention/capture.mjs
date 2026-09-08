import process from "node:process";

import { captureIntegration, parseCommand } from "./lib.mjs";

const result = await captureIntegration({
  repoRoot: process.cwd(),
  env: process.env,
  command: parseCommand(process.argv),
  mirror: true,
});

if (!result.verification.ok) {
  process.stderr.write(
    `ci-native-log-retention capture verification failed:\n${result.verification.errors.join("\n")}\n`,
  );
}

process.exitCode = result.exitCode;
