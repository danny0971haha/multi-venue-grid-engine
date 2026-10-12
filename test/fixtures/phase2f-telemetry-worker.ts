import type { TelemetryEventInput, TelemetryFaultWindow } from "../../src/telemetry/index.js";
import { openTelemetryLog, setTelemetryFaultHookForTests } from "../../src/telemetry/index.js";

export type Phase2FWorkerCommand = {
  directory: string;
  events: TelemetryEventInput[];
  crash?: { window: TelemetryFaultWindow; readyFilePath: string };
};

export type Phase2FWorkerResult = {
  ok: boolean;
  lineCount: number;
  reasonCodes: string[];
};

async function handleCommand(command: Phase2FWorkerCommand): Promise<Phase2FWorkerResult> {
  if (command.crash !== undefined) {
    setTelemetryFaultHookForTests({ ...command.crash, action: "NOTIFY_AND_WAIT" });
  }
  const opened = await openTelemetryLog(command.directory);
  if (!opened.ok) {
    return { ok: false, lineCount: 0, reasonCodes: opened.reasonCodes };
  }
  for (const event of command.events) {
    const appended = await opened.log.append(event);
    if (!appended.ok) {
      return { ok: false, lineCount: opened.log.lineCount, reasonCodes: appended.reasonCodes };
    }
  }
  return { ok: true, lineCount: opened.log.lineCount, reasonCodes: [] };
}

const argvCommand = process.argv[2];
if (argvCommand === undefined) {
  process.stderr.write("phase2f-telemetry-worker requires a JSON command argument\n");
  process.exit(2);
}

void handleCommand(JSON.parse(argvCommand) as Phase2FWorkerCommand)
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
