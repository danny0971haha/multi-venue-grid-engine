import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  HaltAuthoritativeSnapshot,
  HaltOperationResult,
  HaltRuntimeContext,
  ScriptedHaltTransport,
} from "../../src/halt/index.js";
import {
  HaltProcessFence,
  applyRiskDecision,
  inspectHaltContinuation,
  loadHaltAuthority,
  makeHaltRecord,
  persistHaltTransition,
} from "../../src/halt/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  actualNotionalReduceInput,
  baselineRiskInput,
  dailyLossHaltInput,
  seedHaltContext,
  snapshot,
  withTempDir,
} from "./helpers.js";

// A snapshot that still shows the 200U position the reduction was meant to bring down.
function unreducedSnapshot(): HaltAuthoritativeSnapshot {
  return snapshot({ leaseGeneration: "pending", signedPosition: "2", actualGrossNotional: "200" });
}

function restartedProcess(context: HaltRuntimeContext): HaltRuntimeContext {
  return { ...context, latch: new RuntimePersistenceLatch(), processFence: new HaltProcessFence() };
}

function assertHas(result: HaltOperationResult, code: string): void {
  assert.ok(result.reasonCodes.includes(code), `${code} missing: ${result.reasonCodes}`);
}

async function durableRecord(context: HaltRuntimeContext) {
  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  assert.ok(loaded.ok, "durable halt authority must load");
  return loaded.record;
}

// A reduction that was not proven safe must leave the scope halted, in this process and
// in a fresh one.
async function assertEscalated(
  result: HaltOperationResult,
  context: HaltRuntimeContext,
): Promise<void> {
  assert.notEqual(result.durableStatus, "RUNNING", `${result.reasonCodes}`);
  assert.notEqual(result.runtimeDisposition, "RUNNING");
  assert.notEqual(result.runtimeDisposition, "REDUCING");
  assert.equal(result.allowRiskIncrease, false);
  assert.equal(result.systemAllowRiskIncrease, false);
  assert.ok(result.haltId !== null);
  assert.equal(context.processFence.tripped, true);
  assert.notEqual((await durableRecord(context)).status, "RUNNING");

  const sameProcess = await inspectHaltContinuation(context);
  assert.notEqual(sameProcess.durableStatus, "RUNNING");
  assert.equal(sameProcess.systemAllowRiskIncrease, false);
  assert.equal(sameProcess.allowRiskIncrease, false);

  const freshProcess = await inspectHaltContinuation(restartedProcess(context));
  assert.notEqual(freshProcess.durableStatus, "RUNNING");
  assert.equal(freshProcess.systemAllowRiskIncrease, false);
  assert.equal(freshProcess.allowRiskIncrease, false);
}

function assertOwnedCancelOnly(transport: ScriptedHaltTransport): void {
  assert.ok(transport.calls.cancel.includes("owned-risk-1"), `${transport.calls.cancel}`);
  assert.ok(!transport.calls.cancel.includes("foreign-1"));
  assert.ok(!transport.calls.cancel.includes("owned-reduce-1"));
}

describe("Phase 2E runtime corrective 5 actual-exposure reduction protocol", {
  concurrency: 1,
}, () => {
  test("P2E-C5-01 a verified reduction cancels owned risk, reduces once and proves the result", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, { reduce: "ACK" });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      assert.equal(result.durableStatus, "RUNNING");
      assert.equal(result.runtimeDisposition, "REDUCING");
      assert.equal(result.allowRiskIncrease, false);
      assert.equal(result.systemAllowRiskIncrease, false);
      assert.equal(result.haltId, null);
      assertHas(result, "REDUCE_VERIFIED");
      assert.deepEqual(transport.calls.cancel, ["owned-risk-1"]);
      assert.equal(transport.calls.reduce, 1);
      assert.equal(transport.calls.snapshot, 1);
      assert.equal(transport.calls.flatten, 0);
      assert.equal(result.unresolvedPossibleExposureReserved, false);
      assert.equal(context.processFence.tripped, false);
      const record = await durableRecord(context);
      assert.equal(record.status, "RUNNING");
      assert.equal(record.unresolvedPossibleExposure, false);
      assert.equal(record.snapshotFresh, true);
      // Once the reduction is proven the halt component no longer blocks; new risk still
      // needs a fresh CONTINUE through the execution continuation gate.
      for (const inspected of [
        await inspectHaltContinuation(context),
        await inspectHaltContinuation(restartedProcess(context)),
      ]) {
        assert.equal(inspected.durableStatus, "RUNNING");
        assert.equal(inspected.systemAllowRiskIncrease, true);
      }
    });
  });

  test("P2E-C5-02 a reduction is verified against the 150U cap exactly", async () => {
    const atCap = snapshot({
      leaseGeneration: "pending",
      signedPosition: "1.5",
      actualGrossNotional: "150",
    });
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, { reduce: "ACK", snapshots: [atCap] });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      assert.equal(result.durableStatus, "RUNNING", `${result.reasonCodes}`);
      assertHas(result, "REDUCE_VERIFIED");
    });

    const position = `1.5${"0".repeat(40)}1`;
    const aboveCap = snapshot({
      leaseGeneration: "pending",
      signedPosition: position,
      actualGrossNotional: `150.${"0".repeat(39)}1`,
    });
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        reduce: "ACK",
        snapshots: [aboveCap, snapshot({ leaseGeneration: "pending" })],
      });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      await assertEscalated(result, context);
      assertHas(result, "REDUCE_NOT_VERIFIED");
      assertHas(result, "ACTUAL_EXPOSURE_UNSAFE");
    });
  });

  test("P2E-C5-03 an ACK whose fresh snapshot is stale is not proof and escalates to halt", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        reduce: "ACK",
        snapshots: [snapshot({ leaseGeneration: "pending", observedAt: "998000" })],
      });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      await assertEscalated(result, context);
      assertOwnedCancelOnly(transport);
      assertHas(result, "REDUCE_NOT_VERIFIED");
      assertHas(result, "STALE_SNAPSHOT");
      assert.equal(transport.calls.reduce, 1);
      assert.equal(result.reduceInvoked, true);
      assert.equal(result.flattenInvoked, true);
      assert.equal(transport.calls.flatten, 1);
      assert.equal(result.durableStatus, "HALTED_UNFLAT");
    });
  });

  test("P2E-C5-04 an ACK whose snapshot still shows the breach escalates and flattens", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        reduce: "ACK",
        snapshots: [unreducedSnapshot(), snapshot({ leaseGeneration: "pending" })],
      });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      await assertEscalated(result, context);
      assertOwnedCancelOnly(transport);
      assertHas(result, "REDUCE_NOT_VERIFIED");
      assertHas(result, "ACTUAL_EXPOSURE_UNSAFE");
      assert.equal(transport.calls.flatten, 1);
      assert.equal(transport.calls.snapshot, 2);
      assert.equal(result.durableStatus, "HALTED_FLAT");
    });
  });

  test("P2E-C5-05 an ACK without authoritative fresh evidence is not proof", async () => {
    const variants: Array<[string, Partial<HaltAuthoritativeSnapshot>, string]> = [
      ["not fresh", { fresh: false }, "STALE_SNAPSHOT"],
      ["future", { observedAt: "1000500" }, "SNAPSHOT_OBSERVED_AT_FUTURE"],
      ["not authoritative", { authoritative: false }, "SNAPSHOT_NOT_AUTHORITATIVE"],
      ["foreign source", { sourceId: "other-source" }, "SNAPSHOT_SOURCE_UNPROVEN"],
      ["wrong lease", { leaseGeneration: "999" }, "SNAPSHOT_LEASE_MISMATCH"],
      ["missing notional", { actualGrossNotional: null }, "SNAPSHOT_RISK_MISMATCH"],
      [
        "inconsistent notional",
        { signedPosition: "2", actualGrossNotional: "100" },
        "SNAPSHOT_RISK_MISMATCH",
      ],
      [
        "owned risk remaining",
        { ownedRiskIncreasingRemaining: true },
        "OWNED_RISK_INCREASING_REMAINING",
      ],
    ];
    for (const [label, overrides, code] of variants) {
      await withTempDir(async (directory) => {
        const { context, transport } = await seedHaltContext(directory, {
          reduce: "ACK",
          // Spread after the helper so a null notional is not defaulted back to "0".
          snapshots: [{ ...snapshot({ leaseGeneration: "pending" }), ...overrides }],
        });
        const result = await applyRiskDecision(context, actualNotionalReduceInput());
        await assertEscalated(result, context);
        assertOwnedCancelOnly(transport);
        assert.equal(transport.calls.reduce, 1, label);
        assertHas(result, "REDUCE_NOT_VERIFIED");
        assertHas(result, code);
      });
    }
  });

  test("P2E-C5-06 an unknown reservation in the reduction snapshot keeps exposure reserved", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {
        reduce: "ACK",
        snapshots: [
          snapshot({
            leaseGeneration: "pending",
            unknownReservations: [{ side: "BUY", price: "100", quantity: "1" }],
          }),
        ],
      });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      await assertEscalated(result, context);
      assertHas(result, "REDUCE_NOT_VERIFIED");
      assertHas(result, "UNRESOLVED_UNKNOWN");
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
      assert.equal(result.unresolvedPossibleExposureReserved, true);
      assert.equal((await durableRecord(context)).unresolvedPossibleExposure, true);
    });
  });

  test("P2E-C5-07 an UNKNOWN reduction requires reconciliation and keeps exposure reserved", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, { reduce: "UNKNOWN" });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      await assertEscalated(result, context);
      assertOwnedCancelOnly(transport);
      assertHas(result, "REDUCE_UNKNOWN");
      assert.equal(transport.calls.reduce, 1);
      assert.equal(result.reduceInvoked, true);
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
      assert.equal(result.unresolvedPossibleExposureReserved, true);
      assert.equal((await durableRecord(context)).unresolvedPossibleExposure, true);
    });
  });

  test("P2E-C5-08 a REJECTED or NOT_SENT reduction escalates to halt and flatten", async () => {
    for (const reduce of ["REJECTED", "NOT_SENT"] as const) {
      await withTempDir(async (directory) => {
        const { context, transport } = await seedHaltContext(directory, { reduce });
        const result = await applyRiskDecision(context, actualNotionalReduceInput());
        await assertEscalated(result, context);
        assertOwnedCancelOnly(transport);
        assertHas(result, "REDUCE_FAILED");
        assert.equal(transport.calls.reduce, 1, reduce);
        assert.equal(transport.calls.flatten, 1, reduce);
        assert.equal(result.flattenInvoked, true);
        assert.equal(result.durableStatus, "HALTED_FLAT");
        assert.equal(result.unresolvedPossibleExposureReserved, false);
      });
    }
  });

  test("P2E-C5-09 a thrown, rejected or malformed reduce callback is UNKNOWN", async () => {
    const replacements: Array<[string, () => Promise<{ kind: never }>]> = [
      [
        "sync throw",
        () => {
          throw new Error("reduce transport threw");
        },
      ],
      ["rejected", async () => Promise.reject(new Error("reduce transport rejected"))],
      ["malformed", async () => ({ kind: "PARTIAL" as never })],
    ];
    for (const [label, reduce] of replacements) {
      await withTempDir(async (directory) => {
        const { context, transport } = await seedHaltContext(directory, {});
        const wrapped: HaltRuntimeContext = { ...context, transport: { ...transport, reduce } };
        const result = await applyRiskDecision(wrapped, actualNotionalReduceInput());
        await assertEscalated(result, wrapped);
        assertOwnedCancelOnly(transport);
        assertHas(result, "REDUCE_UNKNOWN");
        assert.equal(result.reduceInvoked, true, label);
        assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED", label);
        assert.equal(result.unresolvedPossibleExposureReserved, true, label);
      });
    }
  });

  test("P2E-C5-10 a failed or ambiguous cancel escalates before any reduction", async () => {
    for (const cancel of ["UNKNOWN", "REJECTED"] as const) {
      await withTempDir(async (directory) => {
        const { context, transport } = await seedHaltContext(directory, {
          cancelById: { "owned-risk-1": cancel },
        });
        const result = await applyRiskDecision(context, actualNotionalReduceInput());
        await assertEscalated(result, context);
        assertOwnedCancelOnly(transport);
        assert.equal(transport.calls.reduce, 0, cancel);
        assert.equal(result.reduceInvoked, false);
        assertHas(result, cancel === "UNKNOWN" ? "CANCEL_UNKNOWN" : "CANCEL_FAILED");
        if (cancel === "UNKNOWN") {
          assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
          assert.equal(result.unresolvedPossibleExposureReserved, true);
        }
      });
    }
  });

  test("P2E-C5-11 an unreadable or ambiguous order book escalates before any reduction", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {});
      const wrapped: HaltRuntimeContext = {
        ...context,
        transport: {
          ...transport,
          listOpenOrders: () => {
            throw new Error("order listing failed");
          },
        },
      };
      const result = await applyRiskDecision(wrapped, actualNotionalReduceInput());
      await assertEscalated(result, wrapped);
      assert.equal(transport.calls.reduce, 0);
      assertHas(result, "LIST_OPEN_ORDERS_UNKNOWN");
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
    });

    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {
        orders: [{ exchangeOrderId: "ambiguous-1", ownership: "AMBIGUOUS", riskIncreasing: true }],
      });
      const result = await applyRiskDecision(context, actualNotionalReduceInput());
      await assertEscalated(result, context);
      assert.equal(transport.calls.reduce, 0);
      assert.deepEqual(transport.calls.cancel, []);
      assertHas(result, "AMBIGUOUS_ORDERS_PRESENT");
      assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED");
    });
  });

  test("P2E-C5-12 a thrown snapshot read after ACK is not proof", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, { reduce: "ACK" });
      const wrapped: HaltRuntimeContext = {
        ...context,
        transport: {
          ...transport,
          freshSnapshot: async () => Promise.reject(new Error("snapshot read failed")),
        },
      };
      const result = await applyRiskDecision(wrapped, actualNotionalReduceInput());
      await assertEscalated(result, wrapped);
      assert.equal(transport.calls.reduce, 1);
      assertHas(result, "REDUCE_NOT_VERIFIED");
    });
  });

  test("P2E-C5-13 new risk is durably blocked before the reduction is sent", async () => {
    await withTempDir(async (directory) => {
      const { context, transport } = await seedHaltContext(directory, {});
      let inFlight: Awaited<ReturnType<typeof durableRecord>> | undefined;
      const wrapped: HaltRuntimeContext = {
        ...context,
        transport: {
          ...transport,
          reduce: async () => {
            inFlight = await durableRecord(context);
            return transport.reduce();
          },
        },
      };
      const result = await applyRiskDecision(wrapped, actualNotionalReduceInput());
      assert.equal(result.durableStatus, "RUNNING", `${result.reasonCodes}`);
      assert.ok(inFlight !== undefined);
      assert.equal(inFlight.status, "RUNNING");
      assert.equal(inFlight.unresolvedPossibleExposure, true);
      assert.equal(inFlight.lastRiskEvaluationAt, "1000000");
    });
  });

  test("P2E-C5-14 a process that dies mid-reduction cannot resume new risk after restart", async () => {
    // The durable state below is what the reduction path commits before it sends the reduce.
    for (const next of ["CONTINUE", "REDUCE", "HALT"] as const) {
      await withTempDir(async (directory) => {
        const { context, transport } = await seedHaltContext(directory, {});
        const loaded = await loadHaltAuthority({
          directory: context.directory,
          scopeKey: context.scopeKey,
        });
        assert.ok(loaded.ok);
        const persisted = await persistHaltTransition({
          directory: context.directory,
          scopeKey: context.scopeKey,
          expectedGeneration: loaded.generation,
          expectedPredecessorEnvelopeSha256: loaded.envelopeSha256,
          payload: makeHaltRecord({
            ...loaded.record,
            unresolvedPossibleExposure: true,
            lastRiskEvaluationAt: "1000000",
          }),
          latch: context.latch,
        });
        assert.equal(persisted.disposition, "REQUESTED_STATE_COMMITTED");

        const restarted = restartedProcess(context);
        const inspected = await inspectHaltContinuation(restarted);
        assert.equal(inspected.systemAllowRiskIncrease, false);
        assertHas(inspected, "UNRESOLVED_UNKNOWN");

        const input =
          next === "CONTINUE"
            ? baselineRiskInput()
            : next === "REDUCE"
              ? actualNotionalReduceInput()
              : dailyLossHaltInput();
        const result = await applyRiskDecision(restarted, input);
        assert.equal(result.allowRiskIncrease, false, next);
        assert.equal(result.systemAllowRiskIncrease, false, next);
        assert.equal(transport.calls.reduce, 0, next);
        if (next !== "CONTINUE") {
          await assertEscalated(result, restarted);
          assert.equal(result.durableStatus, "RECONCILIATION_REQUIRED", next);
          assert.equal(result.unresolvedPossibleExposureReserved, true, next);
        }
        const after = await inspectHaltContinuation(restartedProcess(context));
        assert.equal(after.systemAllowRiskIncrease, false, next);
      });
    }
  });
});
