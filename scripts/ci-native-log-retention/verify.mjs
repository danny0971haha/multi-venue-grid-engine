import process from "node:process";

import { verifyPacket } from "./lib.mjs";

const packetRoot = process.argv[2];
if (!packetRoot) {
  process.stderr.write("usage: node verify.mjs <packet-dir>\n");
  process.exitCode = 1;
} else {
  const result = verifyPacket(packetRoot, {
    expectedPacketId: process.env.CI_NATIVE_LOG_PACKET_ID,
    expectedRunId: process.env.EXPECTED_RUN_ID,
    expectedTestedSha: process.env.EXPECTED_TESTED_SHA,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
