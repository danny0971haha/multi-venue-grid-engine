import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bootDryRun } from "../../src/bootstrap/runtimeMode.js";
import type { HaltOperationResult } from "../../src/halt/index.js";
import {
  HaltProcessFence,
  acknowledgeHalt,
  applyRiskDecision,
  executeHardHalt,
  formatHaltResultDiagnostic,
  inspectHaltContinuation,
} from "../../src/halt/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  actualNotionalReduceInput,
  baselineRiskInput,
  dailyLossHaltInput,
  resumeEvidence,
  seedHaltContext,
  snapshot,
  withTempDir,
} from "./helpers.js";

function assertMatrixShape(result: HaltOperationResult): void {
  assert.equal(typeof result.durableStatus, "string");
  assert.equal(typeof result.runtimeDisposition, "string");
  assert.equal(typeof result.allowRiskIncrease, "boolean");
  assert.equal(typeof result.systemAllowRiskIncrease, "boolean");
  assert.equal(typeof result.mutationInvoked, "boolean");
  assert.equal(typeof result.cancelInvoked, "boolean");
  assert.equal(typeof result.flattenInvoked, "boolean");
  assert.equal(typeof result.unresolvedPossibleExposureReserved, "boolean");
  assert.ok(result.haltId === null || typeof result.haltId === "string");
  assert.ok(result.durableGeneration === null || typeof result.durableGeneration === "string");
  assert.ok(
    result.durableEnvelopeSha256 === null || typeof result.durableEnvelopeSha256 === "string",
  );
  assert.ok(result.leaseGeneration === null || typeof result.leaseGeneration === "string");
}

function assertRiskBlocked(result: HaltOperationResult): void {
  assert.equal(result.allowRiskIncrease, false);
  assert.equal(result.systemAllowRiskIncrease, false);
}

function assertNonRunning(result: HaltOperationResult): void {
  assert.notEqual(result.durableStatus, "RUNNING");
  assert.notEqual(result.runtimeDisposition, "RUNNING");
  assertRiskBlocked(result);
}

describe("Phase 2E P2-H halt/ACK matrix", { concurrency: 1 }, () => {
  test("P2-H01 hard breach creates and persists a unique halt ID", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {});
      const result = await applyRiskDecision(context, dailyLossHaltInput());
      assertMatrixShape(result);
      assert.equal(result.haltId, "h1");
      assert.equal(result.durableStatus, "HALTED_FLAT");
      assert.equal(result.runtimeDisposition, "HALTED");
      assertRiskBlocked(result);
      assert.equal(result.durableGeneration, "3");
      assert.ok(result.durableEnvelopeSha256 !== null);
      assert.equal(result.leaseGeneration, context.leaseAuthority.generation);
      assert.equal(result.cancelInvoked, true);
      assert.equal(result.flattenInvoked, true);
      assert.equal(transport.calls.cancel.includes("owned-risk-1"), true);
      assert.equal(transport.calls.cancel.includes("foreign-1"), false);
      assert.equal(result.unresolvedPossibleExposureReserved, false);
      assert.equal(result.inspection.pairAuthorityProven, true);
      const second = await applyRiskDecision(context, dailyLossHaltInput());
      assert.equal(second.haltId, "h1");
      assertNonRunning(second);
    });
  });

  test("P2-H02 cancel failure remains non-running", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        defaultCancel: "REJECTED",
        flatten: "ACK",
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "1",
            ownedRiskIncreasingRemaining: true,
          }),
        ],
      });
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assertMatrixShape(result);
      assertNonRunning(result);
      assert.ok(result.durableStatus === "HALT_FAILED" || result.durableStatus === "HALTED_UNFLAT");
      assert.equal(result.cancelInvoked, true);
      assert.equal(transport.calls.cancel.includes("foreign-1"), false);
      assert.equal(result.allowRiskIncrease, false);
    });
  });

  test("P2-H03 cancel UNKNOWN remains halted/reconciliation-required", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        defaultCancel: "UNKNOWN",
      });
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assertMatrixShape(result);
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
      assert.equal(result.runtimeDisposition, "RECONCILIATION_REQUIRED");
      assertRiskBlocked(result);
      assert.equal(result.cancelInvoked, true);
      assert.equal(result.flattenInvoked, false);
      assert.equal(result.unresolvedPossibleExposureReserved, true);
      assert.equal(transport.calls.flatten, 0);
    });
  });

  test("P2-H04 flatten failure becomes HALTED_UNFLAT or HALT_FAILED", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        flatten: "REJECTED",
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "1",
            ownedRiskIncreasingRemaining: false,
          }),
        ],
      });
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assertMatrixShape(result);
      assertNonRunning(result);
      assert.ok(result.durableStatus === "HALTED_UNFLAT" || result.durableStatus === "HALT_FAILED");
      assert.equal(result.flattenInvoked, true);
      assert.equal(result.allowRiskIncrease, false);
    });
  });

  test("P2-H05 flatten ACK plus stale snapshot is not HALTED_FLAT", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        flatten: "ACK",
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            fresh: false,
            signedPosition: "0",
            ownedRiskIncreasingRemaining: false,
          }),
        ],
      });
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assertMatrixShape(result);
      assert.notEqual(result.durableStatus, "HALTED_FLAT");
      assertNonRunning(result);
      assert.equal(result.flattenInvoked, true);
      assert.ok(result.reasonCodes.includes("STALE_SNAPSHOT"));
    });
  });

  test("P2-H06 fresh authoritative flat snapshot may persist HALTED_FLAT", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        flatten: "ACK",
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            fresh: true,
            authoritative: true,
            signedPosition: "0",
            ownedRiskIncreasingRemaining: false,
          }),
        ],
      });
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assertMatrixShape(result);
      assert.equal(result.durableStatus, "HALTED_FLAT");
      assert.equal(result.runtimeDisposition, "HALTED");
      assertRiskBlocked(result);
      assert.equal(result.flattenInvoked, true);
      assert.equal(result.acknowledgementCommitted, false);
    });
  });

  test("P2-H07 restart without ACK remains halted", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(halted.durableStatus, "HALTED_FLAT");
      const restarted: typeof context = {
        ...context,
        latch: new RuntimePersistenceLatch(),
        processFence: new HaltProcessFence(),
      };
      const inspected = await inspectHaltContinuation(restarted);
      assertMatrixShape(inspected);
      assert.equal(inspected.haltId, halted.haltId);
      assert.equal(inspected.durableStatus, "HALTED_FLAT");
      assert.equal(inspected.durableGeneration, halted.durableGeneration);
      assert.equal(inspected.durableEnvelopeSha256, halted.durableEnvelopeSha256);
      assertNonRunning(inspected);
      assert.equal(inspected.acknowledgementCommitted, false);
    });
  });

  test("P2-H08 stale previous halt ID is rejected", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const first = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(first.haltId, "h1");
      const acked = await acknowledgeHalt(context, {
        suppliedHaltId: "h1",
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(acked.durableStatus, "RUNNING");
      assert.equal(acked.acknowledgementCommitted, true);
      const second = await executeHardHalt(context, {
        haltReasons: ["START_DRAWDOWN"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(second.haltId, "h2");
      const stale = await acknowledgeHalt(context, {
        suppliedHaltId: "h1",
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assertMatrixShape(stale);
      assert.equal(stale.acknowledgementCommitted, false);
      assert.equal(stale.haltId, "h2");
      assertNonRunning(stale);
      assert.ok(
        stale.reasonCodes.includes("STALE_HALT_ID") ||
          stale.reasonCodes.includes("HALT_ID_MISMATCH"),
      );
    });
  });

  test("P2-H09 random or mismatched halt ID is rejected", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      const random = await acknowledgeHalt(context, {
        suppliedHaltId: "hrandom",
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assertMatrixShape(random);
      assertNonRunning(random);
      assert.equal(random.haltId, halted.haltId);
      assert.equal(random.acknowledgementCommitted, false);
      const malformed = await acknowledgeHalt(context, {
        suppliedHaltId: "halt id",
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assert.ok(malformed.reasonCodes.includes("MALFORMED_HALT_ID"));
      assertNonRunning(malformed);
      const missing = await acknowledgeHalt(context, {
        suppliedHaltId: null,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assert.ok(missing.reasonCodes.includes("NO_ACKNOWLEDGEMENT_SUPPLIED"));
      assertNonRunning(missing);
    });
  });

  test("P2-H10 forged caller state cannot override current durable exact pair", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      const forged = {
        status: "RUNNING",
        haltId: halted.haltId,
        storeGeneration: "99",
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: dailyLossHaltInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
        ignoredCallerState: forged,
      });
      assertMatrixShape(result);
      assert.ok(result.reasonCodes.includes("FORGED_CALLER_STATE_IGNORED"));
      assert.ok(result.reasonCodes.includes("CALLER_RESUME_EVIDENCE_IGNORED"));
      assert.ok(result.reasonCodes.includes("CALLER_RISK_INPUT_IGNORED"));
      assert.notEqual(result.durableGeneration, forged.storeGeneration);
      assert.equal(result.acknowledgementCommitted, true);
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.record?.acknowledgement?.acknowledgedHaltId, halted.haltId);
      assert.equal(
        result.record?.acknowledgement?.predecessorEnvelopeSha256,
        halted.durableEnvelopeSha256,
      );
      assert.equal(result.record?.acknowledgement?.snapshotSourceId, "engine-owned-snapshot");
    });
  });

  test("P2-H11 correct ID plus unsafe fresh state does not authorize RUNNING", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "0",
            actualGrossNotional: "0",
            ownedRiskIncreasingRemaining: false,
          }),
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "2",
            actualGrossNotional: "200",
            ownedRiskIncreasingRemaining: true,
            realizedTradingPnl: "-5",
          }),
        ],
      });
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      const unsafe = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assertMatrixShape(unsafe);
      assert.equal(unsafe.acknowledgementCommitted, false);
      assert.notEqual(unsafe.durableStatus, "RUNNING");
      assertRiskBlocked(unsafe);
      assert.ok(
        unsafe.reasonCodes.includes("ACTIVE_RISK_BREACH") ||
          unsafe.reasonCodes.includes("ACK_REJECTED"),
      );
      const overCap = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput({
          proposedBatch: [
            {
              side: "BUY",
              price: "100",
              quantity: "1.5001",
              reduceOnly: false,
              purpose: "GRID_ENTRY",
            },
          ],
        }),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assertNonRunning(overCap);
      assert.ok(
        overCap.reasonCodes.includes("ACTUAL_EXPOSURE_UNSAFE") ||
          overCap.reasonCodes.includes("ACTIVE_RISK_BREACH") ||
          overCap.reasonCodes.includes("PLANNED_EXPOSURE_UNSAFE"),
      );
    });
  });

  test("P2-H12 correct ID plus every safe gate reaches RUNNING only after exact durable commit", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(halted.durableStatus, "HALTED_FLAT");
      const beforeGeneration = halted.durableGeneration;
      const beforeHash = halted.durableEnvelopeSha256;
      const acked = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assertMatrixShape(acked);
      assert.equal(acked.durableStatus, "RUNNING");
      assert.equal(acked.runtimeDisposition, "RUNNING");
      assert.equal(acked.allowRiskIncrease, true);
      assert.equal(acked.systemAllowRiskIncrease, true);
      assert.equal(acked.haltId, null);
      assert.equal(acked.acknowledgementCommitted, true);
      assert.notEqual(acked.durableGeneration, beforeGeneration);
      assert.notEqual(acked.durableEnvelopeSha256, beforeHash);
      assert.equal(acked.inspection.pairAuthorityProven, true);
      assert.equal(acked.record?.acknowledgement?.acknowledgedHaltId, halted.haltId);
      assert.equal(acked.record?.acknowledgement?.predecessorEnvelopeSha256, beforeHash);
      assert.equal(acked.record?.acknowledgement?.predecessorStoreGeneration, beforeGeneration);
      assert.equal(acked.record?.acknowledgement?.newStoreGeneration, acked.durableGeneration);
      assert.equal(acked.leaseGeneration, context.leaseAuthority.generation);
      assert.equal(acked.mutationInvoked, false);
      assert.equal(acked.unresolvedPossibleExposureReserved, false);
    });
  });

  test("P2-H13 crash during ACK persistence never infers caller-memory clearance", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "0",
            actualGrossNotional: "0",
            ownedRiskIncreasingRemaining: false,
          }),
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "0",
            actualGrossNotional: "0",
            ownedRiskIncreasingRemaining: false,
            observedAt: "0",
          }),
        ],
      });
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      const callerMemoryCleared = true;
      void callerMemoryCleared;
      const failed = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation, { snapshotFresh: false }),
      });
      assert.equal(failed.acknowledgementCommitted, false);
      const restarted: typeof context = {
        ...context,
        latch: new RuntimePersistenceLatch(),
        processFence: new HaltProcessFence(),
      };
      const inspected = await inspectHaltContinuation(restarted);
      assertMatrixShape(inspected);
      assert.equal(inspected.durableStatus, halted.durableStatus);
      assert.equal(inspected.haltId, halted.haltId);
      assert.equal(inspected.durableEnvelopeSha256, halted.durableEnvelopeSha256);
      assertNonRunning(inspected);
      assert.notEqual(callerMemoryCleared && inspected.durableStatus === "RUNNING", true);
    });
  });

  test("P2E-I01 REDUCE remains distinct from a full hard halt", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, { reduce: "ACK" });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      assertMatrixShape(result);
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.runtimeDisposition, "REDUCING");
      assertRiskBlocked(result);
      assert.equal(result.haltId, null);
      assert.equal(result.reduceInvoked, true);
      assert.equal(result.flattenInvoked, false);
      assert.equal(transport.calls.flatten, 0);
    });
  });

  test("P2E-I02 CONTINUE cannot override a current durable halt", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertMatrixShape(continued);
      assertNonRunning(continued);
      assert.ok(continued.reasonCodes.includes("CONTINUE_CANNOT_OVERRIDE_HALT"));
    });
  });

  test("P2E-I03 latch-blocked process cannot ACK", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      context.latch.block(["IO_FAILURE"]);
      const acked = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: resumeEvidence(context.leaseAuthority.generation),
      });
      assertNonRunning(acked);
      assert.equal(acked.acknowledgementCommitted, false);
      assert.ok(
        acked.reasonCodes.includes("LATCH_BLOCKS_ACK") ||
          acked.reasonCodes.includes("LATCH_ALREADY_BLOCKED"),
      );
    });
  });

  test("P2E-I04 diagnostics omit secret-like fixture values", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      const diagnostic = formatHaltResultDiagnostic(result);
      assert.equal(diagnostic.includes("secret"), false);
      assert.equal(diagnostic.includes("api_key"), false);
    });
  });

  test("P2E-I05 dry-run still reports no live exchange write", () => {
    const report = bootDryRun();
    assert.equal(report.liveExchangeWrites, false);
  });
});
