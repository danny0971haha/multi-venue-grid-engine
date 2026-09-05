import assert from "node:assert/strict";
import {
  DEFAULT_SNAPSHOT_SOURCE_ID,
  HaltProcessFence,
  acknowledgeHalt,
  createScriptedHaltTransport,
  createSequentialHaltIdSource,
  fixedHaltClock,
  inspectHaltContinuation,
  loadHaltAuthority,
} from "../../src/halt/index.js";
import type { HaltRuntimeContext } from "../../src/halt/index.js";
import {
  RuntimePersistenceLatch,
  acquireRuntimeLease,
  createProcessInstanceId,
  fixedLeaseClock,
} from "../../src/persistence/index.js";
import { EXPERIMENT_ID, HALT_ISO, NOW_MS, SCOPE_KEY, snapshot } from "../halt/helpers.js";

const directory = process.argv[2];
assert.ok(directory);
const loaded = await loadHaltAuthority({ directory, scopeKey: SCOPE_KEY });
assert.ok(loaded.ok);
const latch = new RuntimePersistenceLatch();
const acquired = await acquireRuntimeLease({
  directory,
  scopeKey: SCOPE_KEY,
  ownerId: "reloadowner",
  processInstanceId: createProcessInstanceId(),
  latch,
  clock: fixedLeaseClock(NOW_MS),
});
assert.ok(acquired.authority);
const context: HaltRuntimeContext = {
  directory,
  scopeKey: SCOPE_KEY,
  experimentId: EXPERIMENT_ID,
  latch,
  leaseAuthority: acquired.authority,
  leaseClock: fixedLeaseClock(NOW_MS),
  haltClock: fixedHaltClock(HALT_ISO),
  haltIdSource: createSequentialHaltIdSource("reload"),
  processFence: new HaltProcessFence(),
  expectedSnapshotSourceId: DEFAULT_SNAPSHOT_SOURCE_ID,
  transport: createScriptedHaltTransport({
    orders: [],
    snapshots: [snapshot({ leaseGeneration: acquired.authority.generation })],
  }),
};
const before = await inspectHaltContinuation(context);
const missing = await acknowledgeHalt(context, { suppliedHaltId: null });
const valid = await acknowledgeHalt(context, { suppliedHaltId: loaded.record.haltId });
console.log(
  JSON.stringify({
    beforeStatus: loaded.record.status,
    beforeHaltId: loaded.record.haltId,
    beforeAcknowledgement: loaded.record.acknowledgement,
    beforeRiskIncrease: before.allowRiskIncrease,
    missingAckCommitted: missing.acknowledgementCommitted,
    validAckCommitted: valid.acknowledgementCommitted,
    afterStatus: valid.durableStatus,
  }),
);
