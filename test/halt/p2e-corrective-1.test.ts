import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import type { HaltAuthoritativeSnapshot, HaltOperationResult } from "../../src/halt/index.js";
import {
  DEFAULT_SNAPSHOT_SOURCE_ID,
  HALT_STATE_NAME,
  HaltProcessFence,
  acknowledgeHalt,
  executeHardHalt,
  inspectHaltContinuation,
} from "../../src/halt/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  baselineRiskInput,
  resumeEvidence,
  seedHaltContext,
  snapshot,
  withTempDir,
} from "./helpers.js";

function assertRiskBlocked(result: HaltOperationResult): void {
  assert.equal(result.allowRiskIncrease, false);
  assert.equal(result.systemAllowRiskIncrease, false);
}

function assertAckRejected(result: HaltOperationResult): void {
  assert.notEqual(result.durableStatus, "RUNNING");
  assert.notEqual(result.runtimeDisposition, "RUNNING");
  assert.equal(result.acknowledgementCommitted, false);
  assert.ok(result.reasonCodes.includes("ACK_REJECTED"));
  assertRiskBlocked(result);
}

function callerSafeEvidence(generation: string) {
  return resumeEvidence(generation, {
    snapshotFresh: true,
    snapshotAuthoritative: true,
  });
}

function internalSnapshot(
  generation: string,
  extras: Partial<HaltAuthoritativeSnapshot> = {},
): HaltAuthoritativeSnapshot {
  return snapshot({
    leaseGeneration: generation,
    signedPosition: "0",
    actualGrossNotional: "0",
    ownedRiskIncreasingRemaining: false,
    ...extras,
  });
}

async function haltThenAck(directory: string): Promise<{
  context: Awaited<ReturnType<typeof seedHaltContext>>["context"];
  transport: Awaited<ReturnType<typeof seedHaltContext>>["transport"];
  halted: HaltOperationResult;
}> {
  const seeded = await seedHaltContext(directory, {});
  const halted = await executeHardHalt(seeded.context, {
    haltReasons: ["DAILY_LOSS"],
    lastRiskEvaluationAt: "1000000",
  });
  assert.equal(halted.durableStatus, "HALTED_FLAT");
  assert.equal(seeded.context.processFence.tripped, true);
  return { context: seeded.context, transport: seeded.transport, halted };
}

async function assertRestartRemainsHalted(
  context: Awaited<ReturnType<typeof seedHaltContext>>["context"],
  halted: HaltOperationResult,
): Promise<void> {
  const restarted: typeof context = {
    ...context,
    latch: new RuntimePersistenceLatch(),
    processFence: new HaltProcessFence(),
  };
  const inspected = await inspectHaltContinuation(restarted);
  assert.notEqual(inspected.durableStatus, "RUNNING");
  assert.notEqual(inspected.runtimeDisposition, "RUNNING");
  assertRiskBlocked(inspected);
  if (inspected.record !== null) {
    assert.equal(inspected.haltId, halted.haltId);
    assert.equal(inspected.durableStatus, halted.durableStatus);
  }
}

describe("Phase 2E runtime corrective 1 ACK authority and exception boundary", {
  concurrency: 1,
}, () => {
  test("P2E-C1-01 forged caller resumeEvidence cannot authorize RUNNING", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, {
          sourceId: "forged-caller-source",
        });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("CALLER_RESUME_EVIDENCE_IGNORED"));
      assert.ok(result.reasonCodes.includes("SNAPSHOT_SOURCE_UNPROVEN"));
      assert.equal(context.processFence.tripped, true);
      await assertRestartRemainsHalted(context, halted);
    });
  });

  test("P2E-C1-02 safe caller claims plus unsafe internal snapshot remain halted", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, {
          signedPosition: "1",
          actualGrossNotional: "100",
          ownedRiskIncreasingRemaining: true,
        });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("OWNED_RISK_INCREASING_REMAINING"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-03 safe caller risk input plus internally observed over-cap actual notional remains halted", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, {
          signedPosition: "2",
          actualGrossNotional: "200",
          markOrMidPrice: "100",
        });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("CALLER_RISK_INPUT_IGNORED"));
      assert.ok(
        result.reasonCodes.includes("ACTUAL_EXPOSURE_UNSAFE") ||
          result.reasonCodes.includes("ACTIVE_RISK_BREACH"),
      );
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-04 internal snapshot lease-generation mismatch rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot("999", {
          signedPosition: "0",
          actualGrossNotional: "0",
        });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("SNAPSHOT_LEASE_MISMATCH"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-05 stale observedAt rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { observedAt: "0" });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("STALE_SNAPSHOT"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-06 future or malformed observedAt rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { observedAt: "2000000" });
      const future = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(future);
      assert.ok(future.reasonCodes.includes("SNAPSHOT_OBSERVED_AT_FUTURE"));
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { observedAt: "not-a-timestamp" });
      const malformed = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(malformed);
      assert.ok(malformed.reasonCodes.includes("SNAPSHOT_OBSERVED_AT_MALFORMED"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-07 non-authoritative internal snapshot rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { authoritative: false });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("SNAPSHOT_NOT_AUTHORITATIVE"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-08 owned risk-increasing orders remaining reject ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, transport, halted } = await haltThenAck(directory);
      transport.setOpenOrders([
        { exchangeOrderId: "owned-risk-still-open", ownership: "OWNED", riskIncreasing: true },
      ]);
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("OWNED_RISK_INCREASING_REMAINING"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-09 unresolved UNKNOWN reservation rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, { defaultCancel: "UNKNOWN" });
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(halted.durableStatus, "RECONCILIATION_REQUIRED");
      assert.equal(halted.unresolvedPossibleExposureReserved, true);
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("UNRESOLVED_UNKNOWN"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-10 lease changes after snapshot but before ACK persistence", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          context.leaseAuthority = {
            ...context.leaseAuthority,
            generation: "999",
          };
        },
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("LEASE_UNCERTAIN"));
      assert.equal(context.processFence.tripped, true);
      assert.equal(halted.durableStatus, "HALTED_FLAT");
      const inspected = await inspectHaltContinuation(context);
      assert.equal(inspected.durableStatus, "HALTED_FLAT");
    });
  });

  test("P2E-C1-11 final exact-pair uncertainty never clears the process fence", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        afterAckPersistedBeforeFinalInspect: async () => {
          await writeFile(path.join(directory, `${HALT_STATE_NAME}.json`), "corrupt", "utf8");
          await writeFile(path.join(directory, `${HALT_STATE_NAME}.json.bak`), "corrupt", "utf8");
        },
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(result.acknowledgementCommitted, false);
      assert.notEqual(result.runtimeDisposition, "RUNNING");
      assertRiskBlocked(result);
      assert.ok(result.reasonCodes.includes("FINAL_PAIR_UNPROVEN"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-12 listOpenOrders throw returns structured non-running result", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.transport.listOpenOrders = () => {
        throw new Error("listOpenOrders boom");
      };
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.notEqual(result.durableStatus, "RUNNING");
      assert.notEqual(result.runtimeDisposition, "RUNNING");
      assertRiskBlocked(result);
      assert.ok(
        result.reasonCodes.includes("RECONCILIATION_REQUIRED") ||
          result.reasonCodes.includes("LIST_OPEN_ORDERS_UNKNOWN") ||
          result.reasonCodes.includes("HALTING_COMMITTED"),
      );
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C1-13 cancel throw remains reconciliation-required/non-running", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.transport.cancel = async () => {
        throw new Error("cancel boom");
      };
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
      assert.notEqual(result.runtimeDisposition, "RUNNING");
      assertRiskBlocked(result);
      assert.ok(
        result.reasonCodes.includes("CANCEL_UNKNOWN") ||
          result.reasonCodes.includes("RECONCILIATION_REQUIRED"),
      );
      assert.equal(result.unresolvedPossibleExposureReserved, true);
    });
  });

  test("P2E-C1-14 flatten throw remains reconciliation-required/non-running", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.transport.flatten = async () => {
        throw new Error("flatten boom");
      };
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
      assert.notEqual(result.runtimeDisposition, "RUNNING");
      assertRiskBlocked(result);
      assert.ok(
        result.reasonCodes.includes("FLATTEN_UNKNOWN") ||
          result.reasonCodes.includes("RECONCILIATION_REQUIRED"),
      );
      assert.equal(result.unresolvedPossibleExposureReserved, true);
    });
  });

  test("P2E-C1-15 freshSnapshot throw rejects ACK and remains non-running", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () => {
        throw new Error("freshSnapshot boom");
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.equal(context.processFence.tripped, true);
      await assertRestartRemainsHalted(context, halted);
    });
  });

  test("P2E-C1-16 restart after every rejected ACK remains halted", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      const cases: Array<() => Promise<void>> = [
        async () => {
          context.transport.freshSnapshot = async () =>
            internalSnapshot(context.leaseAuthority.generation, { authoritative: false });
        },
        async () => {
          context.transport.freshSnapshot = async () =>
            internalSnapshot(context.leaseAuthority.generation, { observedAt: "0" });
        },
        async () => {
          context.transport.freshSnapshot = async () => internalSnapshot("999");
        },
      ];
      for (const configure of cases) {
        await configure();
        const rejected = await acknowledgeHalt(context, {
          suppliedHaltId: halted.haltId,
          resumeRiskInput: baselineRiskInput(),
          resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
        });
        assertAckRejected(rejected);
        assert.equal(context.processFence.tripped, true);
        await assertRestartRemainsHalted(context, halted);
      }
    });
  });

  test("P2E-C1 successful ACK binds internally sourced snapshot identity", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.acknowledgementCommitted, true);
      assert.ok(result.reasonCodes.includes("CALLER_RESUME_EVIDENCE_IGNORED"));
      assert.ok(result.reasonCodes.includes("CALLER_RISK_INPUT_IGNORED"));
      assert.equal(result.record?.acknowledgement?.snapshotSourceId, DEFAULT_SNAPSHOT_SOURCE_ID);
      assert.equal(
        result.record?.acknowledgement?.snapshotLeaseGeneration,
        context.leaseAuthority.generation,
      );
      assert.equal(result.record?.acknowledgement?.snapshotObservedAt, "1000000");
      assert.equal(context.processFence.tripped, false);
    });
  });
});
