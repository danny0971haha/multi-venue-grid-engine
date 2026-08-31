import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { HaltOperationResult, HaltRuntimeContext } from "../../src/halt/index.js";
import {
  applyRiskDecision,
  inspectHaltContinuation,
  loadHaltAuthority,
  makeHaltRecord,
  persistHaltTransition,
} from "../../src/halt/index.js";
import { LEASE_TTL_MS, fixedLeaseClock } from "../../src/persistence/runtime-lease.js";
import {
  HALT_ISO,
  NOW_MS,
  SCOPE_KEY,
  baselineRiskInput,
  seedHaltContext,
  withTempDir,
} from "./helpers.js";

function assertRiskBlocked(result: HaltOperationResult): void {
  assert.equal(result.allowRiskIncrease, false);
  assert.equal(result.systemAllowRiskIncrease, false);
}

function assertContinueBlocked(result: HaltOperationResult): void {
  assert.notEqual(result.runtimeDisposition, "RUNNING");
  assert.equal(result.runtimeDisposition, "FAIL_CLOSED");
  assertRiskBlocked(result);
}

function assertAlignedWithContinuation(
  continued: HaltOperationResult,
  inspected: HaltOperationResult,
): void {
  assert.equal(continued.runtimeDisposition, inspected.runtimeDisposition);
  assert.equal(continued.allowRiskIncrease, inspected.allowRiskIncrease);
  assert.equal(continued.systemAllowRiskIncrease, inspected.systemAllowRiskIncrease);
}

function freezeInput(input: ReturnType<typeof baselineRiskInput>): string {
  return JSON.stringify(input);
}

async function persistUnresolvedRunning(context: HaltRuntimeContext): Promise<void> {
  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: SCOPE_KEY,
  });
  if (!loaded.ok) {
    throw new Error(`loadHaltAuthority failed: ${loaded.reasonCodes.join(",")}`);
  }
  const persist = await persistHaltTransition({
    directory: context.directory,
    scopeKey: SCOPE_KEY,
    expectedGeneration: loaded.generation,
    expectedPredecessorEnvelopeSha256: loaded.envelopeSha256,
    payload: makeHaltRecord({
      ...loaded.record,
      unresolvedPossibleExposure: true,
      updatedAt: HALT_ISO,
    }),
    latch: context.latch,
  });
  if (persist.disposition !== "REQUESTED_STATE_COMMITTED" || persist.state === null) {
    throw new Error(`persist unresolved running failed: ${persist.reasonCodes.join(",")}`);
  }
}

describe("Phase 2E runtime corrective 3 CONTINUE uses continuation authorization", {
  concurrency: 1,
}, () => {
  test("P2E-C3-01 valid CONTINUE remains RUNNING", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const input = baselineRiskInput();
      const continued = await applyRiskDecision(context, input);
      assert.equal(continued.durableStatus, "RUNNING");
      assert.equal(continued.runtimeDisposition, "RUNNING");
      assert.equal(continued.allowRiskIncrease, true);
      assert.equal(continued.systemAllowRiskIncrease, true);
      assert.ok(continued.reasonCodes.includes("DURABLE_HALT_RUNNING"));
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-02 tripped process fence blocks CONTINUE", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.processFence.trip();
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(continued);
      assert.ok(continued.reasonCodes.includes("RISK_INCREASE_FENCED"));
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-03 blocked latch blocks CONTINUE", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.latch.block(["IO_FAILURE"]);
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(continued);
      assert.ok(continued.reasonCodes.includes("LATCH_ALREADY_BLOCKED"));
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-04 unresolved possible exposure blocks CONTINUE", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      await persistUnresolvedRunning(context);
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(continued);
      assert.ok(continued.reasonCodes.includes("UNRESOLVED_UNKNOWN"));
      assert.equal(continued.record?.unresolvedPossibleExposure, true);
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-05 expired lease blocks CONTINUE", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.leaseClock = fixedLeaseClock(NOW_MS + LEASE_TTL_MS);
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(continued);
      assert.ok(continued.reasonCodes.includes("LEASE_UNCERTAIN"));
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-06 lease generation mismatch blocks CONTINUE", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.leaseAuthority = {
        ...context.leaseAuthority,
        generation: "999",
      };
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(continued);
      assert.ok(continued.reasonCodes.includes("LEASE_UNCERTAIN"));
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-07 lease envelope SHA mismatch blocks CONTINUE", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      context.leaseAuthority = {
        ...context.leaseAuthority,
        leaseEnvelopeSha256: "00".repeat(32),
      };
      const continued = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(continued);
      assert.ok(continued.reasonCodes.includes("LEASE_UNCERTAIN"));
      const inspected = await inspectHaltContinuation(context);
      assertAlignedWithContinuation(continued, inspected);
    });
  });

  test("P2E-C3-08 repeated CONTINUE evaluation is deterministic", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const first = await applyRiskDecision(context, baselineRiskInput());
      const second = await applyRiskDecision(context, baselineRiskInput());
      assert.equal(first.runtimeDisposition, "RUNNING");
      assert.equal(second.runtimeDisposition, first.runtimeDisposition);
      assert.equal(second.allowRiskIncrease, first.allowRiskIncrease);
      assert.equal(second.systemAllowRiskIncrease, first.systemAllowRiskIncrease);
      assert.deepEqual(second.reasonCodes, first.reasonCodes);
      context.processFence.trip();
      const blockedFirst = await applyRiskDecision(context, baselineRiskInput());
      const blockedSecond = await applyRiskDecision(context, baselineRiskInput());
      assertContinueBlocked(blockedFirst);
      assert.equal(blockedSecond.runtimeDisposition, blockedFirst.runtimeDisposition);
      assert.deepEqual(blockedSecond.reasonCodes, blockedFirst.reasonCodes);
    });
  });

  test("P2E-C3-09 caller CONTINUE inputs remain unmodified", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const input = baselineRiskInput();
      const before = freezeInput(input);
      await applyRiskDecision(context, input);
      assert.equal(freezeInput(input), before);
      context.processFence.trip();
      await applyRiskDecision(context, input);
      assert.equal(freezeInput(input), before);
    });
  });
});
