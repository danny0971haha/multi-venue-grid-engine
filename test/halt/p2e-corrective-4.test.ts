import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { acknowledgeHalt, applyRiskDecision, executeHardHalt } from "../../src/halt/index.js";
import {
  baselineRiskInput,
  resumeEvidence,
  seedHaltContext,
  snapshot,
  withTempDir,
} from "./helpers.js";

// The position notional at mark 100 is 100 + 1e-40, which rounding to 40 digits turns into 100.
const POSITION = `1.${"0".repeat(41)}1`;
const EXACT_ACTUAL = `100.${"0".repeat(39)}1`;

async function haltThenAcknowledge(actualGrossNotional: string) {
  let outcome: Awaited<ReturnType<typeof acknowledgeHalt>> | undefined;
  let snapshotReads = 0;
  await withTempDir(async (directory) => {
    // The hard halt reads one flat snapshot. The acknowledgement then reads the position
    // snapshot for its initial and, once that passes, its final resume authority.
    const { context, transport } = await seedHaltContext(directory, {
      snapshots: [
        snapshot({ leaseGeneration: "pending" }),
        snapshot({
          leaseGeneration: "pending",
          signedPosition: POSITION,
          markOrMidPrice: "100",
          actualGrossNotional,
        }),
      ],
    });
    const halted = await executeHardHalt(context, {
      haltReasons: ["DAILY_LOSS"],
      lastRiskEvaluationAt: "1000000",
    });
    assert.equal(halted.durableStatus, "HALTED_FLAT");
    assert.equal(transport.calls.snapshot, 1);
    outcome = await acknowledgeHalt(context, {
      suppliedHaltId: halted.haltId,
      resumeRiskInput: baselineRiskInput(),
      resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
    });
    snapshotReads = transport.calls.snapshot;
  });
  assert.ok(outcome !== undefined);
  return { acked: outcome, snapshotReads };
}

describe("Phase 2E runtime corrective 4 exact risk arithmetic", { concurrency: 1 }, () => {
  test("P2E-C4-01 a proposed notional just above 150 does not keep the runtime RUNNING", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const result = await applyRiskDecision(
        context,
        baselineRiskInput({
          proposedBatch: [
            {
              side: "BUY",
              price: `150.${"0".repeat(38)}1`,
              quantity: "1",
              reduceOnly: false,
              purpose: "GRID_ENTRY",
            },
          ],
        }),
      );
      assert.notEqual(result.runtimeDisposition, "RUNNING");
      assert.equal(result.allowRiskIncrease, false);
      assert.equal(result.systemAllowRiskIncrease, false);
    });
  });

  test("P2E-C4-02 an exact snapshot notional passes the acknowledgement consistency check", async () => {
    const { acked, snapshotReads } = await haltThenAcknowledge(EXACT_ACTUAL);
    assert.ok(!acked.reasonCodes.includes("SNAPSHOT_RISK_MISMATCH"), `${acked.reasonCodes}`);
    assert.equal(snapshotReads, 3);
    assert.equal(acked.durableStatus, "RUNNING");
    assert.equal(acked.runtimeDisposition, "RUNNING");
  });

  test("P2E-C4-03 a rounded snapshot notional is a risk mismatch and stays halted", async () => {
    const { acked, snapshotReads } = await haltThenAcknowledge("100");
    assert.ok(acked.reasonCodes.includes("SNAPSHOT_RISK_MISMATCH"), `${acked.reasonCodes}`);
    assert.equal(snapshotReads, 2);
    assert.equal(acked.durableStatus, "HALTED_FLAT");
    assert.notEqual(acked.runtimeDisposition, "RUNNING");
    assert.equal(acked.allowRiskIncrease, false);
  });
});
