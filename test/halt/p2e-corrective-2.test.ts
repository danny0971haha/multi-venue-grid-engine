import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import type { HaltAuthoritativeSnapshot, HaltOperationResult } from "../../src/halt/index.js";
import {
  DEFAULT_SNAPSHOT_SOURCE_ID,
  HALT_STATE_NAME,
  PHASE_2E_REASON_CODE_CATALOG,
  acknowledgeHalt,
  executeHardHalt,
  inspectHaltContinuation,
} from "../../src/halt/index.js";
import { LEASE_TTL_MS, fixedLeaseClock } from "../../src/persistence/runtime-lease.js";
import {
  HALT_ISO,
  NOW_MS,
  RISK_NOW,
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

function assertNotRuntimeRunning(result: HaltOperationResult): void {
  assert.notEqual(result.runtimeDisposition, "RUNNING");
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
    lastRiskEvaluationAt: RISK_NOW,
  });
  assert.equal(halted.durableStatus, "HALTED_FLAT");
  assert.equal(seeded.context.processFence.tripped, true);
  return { context: seeded.context, transport: seeded.transport, halted };
}

describe("Phase 2E runtime corrective 2 continuation, freshness, ambiguous, race, baselines", {
  concurrency: 1,
}, () => {
  test("P2E-C2-01 RUNNING durable record plus expired lease is FAIL_CLOSED", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.leaseClock = fixedLeaseClock(NOW_MS + LEASE_TTL_MS);
      const inspected = await inspectHaltContinuation(context);
      assert.equal(inspected.runtimeDisposition, "FAIL_CLOSED");
      assertNotRuntimeRunning(inspected);
      assert.ok(inspected.reasonCodes.includes("LEASE_UNCERTAIN"));
    });
  });

  test("P2E-C2-02 RUNNING durable record plus mismatched lease generation is FAIL_CLOSED", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.leaseAuthority = {
        ...context.leaseAuthority,
        generation: "999",
      };
      const inspected = await inspectHaltContinuation(context);
      assert.equal(inspected.runtimeDisposition, "FAIL_CLOSED");
      assertNotRuntimeRunning(inspected);
      assert.ok(inspected.reasonCodes.includes("LEASE_UNCERTAIN"));
    });
  });

  test("P2E-C2-03 RUNNING durable record plus mismatched lease envelope SHA is FAIL_CLOSED", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.leaseAuthority = {
        ...context.leaseAuthority,
        leaseEnvelopeSha256: "00".repeat(32),
      };
      const inspected = await inspectHaltContinuation(context);
      assert.equal(inspected.runtimeDisposition, "FAIL_CLOSED");
      assertNotRuntimeRunning(inspected);
      assert.ok(inspected.reasonCodes.includes("LEASE_UNCERTAIN"));
    });
  });

  test("P2E-C2-04 RUNNING durable record plus blocked latch is risk blocked", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.latch.block(["IO_FAILURE"]);
      const inspected = await inspectHaltContinuation(context);
      assertNotRuntimeRunning(inspected);
      assert.ok(inspected.reasonCodes.includes("LATCH_ALREADY_BLOCKED"));
    });
  });

  test("P2E-C2-05 RUNNING durable record plus tripped process fence is not runtime RUNNING", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.processFence.trip();
      const inspected = await inspectHaltContinuation(context);
      assertNotRuntimeRunning(inspected);
      assert.ok(inspected.reasonCodes.includes("RISK_INCREASE_FENCED"));
    });
  });

  test("P2E-C2-06 proven current RUNNING authority still succeeds", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const inspected = await inspectHaltContinuation(context);
      assert.equal(inspected.durableStatus, "RUNNING");
      assert.equal(inspected.runtimeDisposition, "RUNNING");
      assert.equal(inspected.allowRiskIncrease, true);
      assert.equal(inspected.systemAllowRiskIncrease, true);
      assert.ok(inspected.reasonCodes.includes("DURABLE_HALT_RUNNING"));
    });
  });

  test("P2E-C2-07 snapshot.fresh=false plus current observedAt rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, {
          fresh: false,
          observedAt: RISK_NOW,
        });
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

  test("P2E-C2-08 snapshot.fresh=true plus stale observedAt rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, {
          fresh: true,
          observedAt: "0",
        });
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

  test("P2E-C2-09 future observedAt rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { observedAt: "2000000" });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("SNAPSHOT_OBSERVED_AT_FUTURE"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-10 malformed observedAt rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { observedAt: "not-a-timestamp" });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("SNAPSHOT_OBSERVED_AT_MALFORMED"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-11 valid fresh authoritative snapshot still succeeds", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.runtimeDisposition, "RUNNING");
      assert.equal(result.acknowledgementCommitted, true);
      assert.equal(result.allowRiskIncrease, true);
      assert.equal(context.processFence.tripped, false);
    });
  });

  test("P2E-C2-12/13/14 ambiguous risk-increasing order during hard halt reserves exposure", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        orders: [
          { exchangeOrderId: "owned-risk-1", ownership: "OWNED", riskIncreasing: true },
          { exchangeOrderId: "ambiguous-risk-1", ownership: "AMBIGUOUS", riskIncreasing: true },
          { exchangeOrderId: "foreign-1", ownership: "UNOWNED", riskIncreasing: true },
        ],
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            signedPosition: "0",
            actualGrossNotional: "0",
            ownedRiskIncreasingRemaining: false,
          }),
        ],
      });
      const result = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      assert.equal(result.unresolvedPossibleExposureReserved, true);
      assert.notEqual(result.durableStatus, "HALTED_FLAT");
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
      assertNotRuntimeRunning(result);
      assert.ok(result.reasonCodes.includes("AMBIGUOUS_ORDERS_PRESENT"));
      assert.ok(result.reasonCodes.includes("RECONCILIATION_REQUIRED"));
      assert.equal(transport.calls.cancel.includes("ambiguous-risk-1"), false);
      assert.equal(transport.calls.cancel.includes("foreign-1"), false);
      assert.equal(transport.calls.cancel.includes("owned-risk-1"), true);
    });
  });

  test("P2E-C2-15 ACK rejects an ambiguous risk-increasing order", async () => {
    await withTempDir(async (directory) => {
      const { context, transport, halted } = await haltThenAck(directory);
      transport.setOpenOrders([
        { exchangeOrderId: "ambiguous-risk-ack", ownership: "AMBIGUOUS", riskIncreasing: true },
      ]);
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("AMBIGUOUS_ORDERS_PRESENT"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-16 ambiguous non-risk-increasing order preserves existing halt/ACK semantics", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        orders: [
          { exchangeOrderId: "owned-risk-1", ownership: "OWNED", riskIncreasing: true },
          {
            exchangeOrderId: "ambiguous-reduce-1",
            ownership: "AMBIGUOUS",
            riskIncreasing: false,
          },
        ],
      });
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      assert.equal(halted.durableStatus, "HALTED_FLAT");
      assert.equal(halted.unresolvedPossibleExposureReserved, false);
      assert.ok(halted.reasonCodes.includes("AMBIGUOUS_ORDERS_PRESENT"));
      assert.equal(transport.calls.cancel.includes("ambiguous-reduce-1"), false);
      const acked = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(acked.durableStatus, "RUNNING");
      assert.equal(acked.acknowledgementCommitted, true);
    });
  });

  test("P2E-C2-17 lease changes after the first snapshot reject ACK", async () => {
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
    });
  });

  test("P2E-C2-18 clock past ACK_SNAPSHOT_MAX_STALE_MS before final authority rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      let nowIso = HALT_ISO;
      context.haltClock = {
        nowIso() {
          return nowIso;
        },
      };
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          nowIso = "1970-01-01T00:16:41.001Z";
        },
      };
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

  test("P2E-C2-19 new OWNED risk-increasing order between validations rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, transport, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          transport.setOpenOrders([
            { exchangeOrderId: "late-owned-risk", ownership: "OWNED", riskIncreasing: true },
          ]);
        },
      };
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

  test("P2E-C2-20 new AMBIGUOUS risk-increasing order between validations rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, transport, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          transport.setOpenOrders([
            {
              exchangeOrderId: "late-ambiguous-risk",
              ownership: "AMBIGUOUS",
              riskIncreasing: true,
            },
          ]);
        },
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("AMBIGUOUS_ORDERS_PRESENT"));
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-21 final snapshot becomes unsafe while initial was safe rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          context.transport.freshSnapshot = async () =>
            internalSnapshot(context.leaseAuthority.generation, {
              signedPosition: "2",
              actualGrossNotional: "200",
              markOrMidPrice: "100",
            });
        },
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(
        result.reasonCodes.includes("ACTUAL_EXPOSURE_UNSAFE") ||
          result.reasonCodes.includes("ACTIVE_RISK_BREACH"),
      );
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-22 final snapshot transport throw rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          context.transport.freshSnapshot = async () => {
            throw new Error("final freshSnapshot boom");
          };
        },
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-23 final listOpenOrders throw rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      context.ackTransitionHooks = {
        beforeAckPersistLeaseRecheck: () => {
          context.transport.listOpenOrders = () => {
            throw new Error("final listOpenOrders boom");
          };
        },
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(
        result.reasonCodes.includes("LIST_OPEN_ORDERS_UNKNOWN") ||
          result.reasonCodes.includes("UNRESOLVED_UNKNOWN"),
      );
      assert.equal(context.processFence.tripped, true);
    });
  });

  test("P2E-C2-24 successful ACK lineage records the final snapshot not the initial snapshot", async () => {
    await withTempDir(async (directory) => {
      const { context, halted } = await haltThenAck(directory);
      let snapshotCalls = 0;
      context.transport.freshSnapshot = async () => {
        snapshotCalls += 1;
        return internalSnapshot(context.leaseAuthority.generation, {
          observedAt: snapshotCalls === 1 ? "999000" : RISK_NOW,
          sourceId: DEFAULT_SNAPSHOT_SOURCE_ID,
        });
      };
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.acknowledgementCommitted, true);
      assert.ok(snapshotCalls >= 2);
      assert.equal(result.record?.acknowledgement?.snapshotObservedAt, RISK_NOW);
      assert.notEqual(result.record?.acknowledgement?.snapshotObservedAt, "999000");
      assert.equal(result.record?.acknowledgement?.snapshotSourceId, DEFAULT_SNAPSHOT_SOURCE_ID);
      assert.equal(
        result.record?.acknowledgement?.snapshotLeaseGeneration,
        context.leaseAuthority.generation,
      );
    });
  });

  test("P2E-C2-25 process fence clears only after final exact-pair proof", async () => {
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

  test("P2E-C2-26 missing startingEquityUsd rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {}, { startingEquityUsd: null });
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("DURABLE_RISK_BASELINE_MISSING"));
    });
  });

  test("P2E-C2-27 missing highWaterEquityUsd rejects ACK", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {}, { highWaterEquityUsd: null });
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("DURABLE_RISK_BASELINE_MISSING"));
    });
  });

  test("P2E-C2-28 both explicit durable baselines permit the valid ACK path", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(
        directory,
        {},
        { startingEquityUsd: "100", highWaterEquityUsd: "100" },
      );
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput(),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.acknowledgementCommitted, true);
      assert.equal(result.record?.startingEquityUsd, "100");
      assert.equal(result.record?.highWaterEquityUsd, "100");
    });
  });

  test("P2E-C2-29 missing baselines do not fall back to current snapshot equity", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(
        directory,
        {
          snapshots: [
            snapshot({
              leaseGeneration: "pending",
              equity: "80",
              signedPosition: "0",
              actualGrossNotional: "0",
            }),
          ],
        },
        { startingEquityUsd: null, highWaterEquityUsd: null },
      );
      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: RISK_NOW,
      });
      context.transport.freshSnapshot = async () =>
        internalSnapshot(context.leaseAuthority.generation, { equity: "80" });
      const result = await acknowledgeHalt(context, {
        suppliedHaltId: halted.haltId,
        resumeRiskInput: baselineRiskInput({
          equity: "80",
          startingEquity: "80",
          highWaterEquity: "80",
        }),
        resumeEvidence: callerSafeEvidence(context.leaseAuthority.generation),
      });
      assertAckRejected(result);
      assert.ok(result.reasonCodes.includes("DURABLE_RISK_BASELINE_MISSING"));
      assert.notEqual(result.durableStatus, "RUNNING");
    });
  });

  test("P2E-C2-CATALOG DURABLE_RISK_BASELINE_MISSING is in the Phase 2E catalog", () => {
    assert.ok(PHASE_2E_REASON_CODE_CATALOG.includes("DURABLE_RISK_BASELINE_MISSING"));
  });
});
