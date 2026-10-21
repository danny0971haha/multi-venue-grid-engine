import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  HaltAuthoritativeSnapshot,
  HaltOperationResult,
  HaltRuntimeContext,
} from "../../src/halt/index.js";
import {
  HaltProcessFence,
  applyRiskDecision,
  inspectHaltContinuation,
  loadHaltAuthority,
} from "../../src/halt/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import {
  actualNotionalReduceInput,
  baselineRiskInput,
  seedHaltContext,
  snapshot,
  withTempDir,
} from "./helpers.js";

const DOMAIN_INVALID = "SNAPSHOT_FINANCIAL_DOMAIN_INVALID";

// A reduction snapshot with the given position, price and gross notional; everything else
// (freshness, authority, source, lease) is valid evidence.
function reductionEvidence(
  signedPosition: string,
  markOrMidPrice: string,
  actualGrossNotional: string | null,
): HaltAuthoritativeSnapshot {
  // Spread after the helper so a null notional is not defaulted back to "0".
  return {
    ...snapshot({ leaseGeneration: "pending", signedPosition, markOrMidPrice }),
    actualGrossNotional,
  };
}

// The valid flat snapshot the escalated flatten is verified against.
function flatAfterFlatten(): HaltAuthoritativeSnapshot {
  return snapshot({ leaseGeneration: "pending" });
}

function restartedProcess(context: HaltRuntimeContext): HaltRuntimeContext {
  return { ...context, latch: new RuntimePersistenceLatch(), processFence: new HaltProcessFence() };
}

function assertHas(result: HaltOperationResult, code: string, label = ""): void {
  assert.ok(result.reasonCodes.includes(code), `${label} ${code} missing: ${result.reasonCodes}`);
}

async function durableRecord(context: HaltRuntimeContext) {
  const loaded = await loadHaltAuthority({
    directory: context.directory,
    scopeKey: context.scopeKey,
  });
  assert.ok(loaded.ok, "durable halt authority must load");
  return loaded.record;
}

// Runs the RR1 scenario (actual notional 200, reduce ACK) against the given reduction evidence.
async function reduceAgainst(
  directory: string,
  evidence: HaltAuthoritativeSnapshot,
): Promise<{
  context: HaltRuntimeContext;
  result: HaltOperationResult;
  calls: { reduce: number; flatten: number; snapshot: number };
}> {
  const { context, transport } = await seedHaltContext(directory, {
    reduce: "ACK",
    snapshots: [evidence, flatAfterFlatten()],
  });
  const result = await applyRiskDecision(context, actualNotionalReduceInput());
  return { context, result, calls: transport.calls };
}

// Invalid reduction evidence must take the existing unverified path: halt, flatten once, stay
// blocked in this process and after a restart, and never settle the reduction as RUNNING.
async function assertUnverifiedHalt(
  label: string,
  context: HaltRuntimeContext,
  result: HaltOperationResult,
  calls: { reduce: number; flatten: number; snapshot: number },
): Promise<void> {
  assertHas(result, "REDUCE_NOT_VERIFIED", label);
  assertHas(result, "SNAPSHOT_RISK_MISMATCH", label);
  assert.ok(!result.reasonCodes.includes("REDUCE_VERIFIED"), `${label} ${result.reasonCodes}`);
  assert.equal(result.durableStatus, "HALTED_FLAT", `${label} ${result.reasonCodes}`);
  assert.equal(result.runtimeDisposition, "HALTED", label);
  assert.equal(result.allowRiskIncrease, false, label);
  assert.equal(result.systemAllowRiskIncrease, false, label);
  assert.ok(result.haltId !== null, label);
  assert.equal(result.flattenInvoked, true, label);
  assert.equal(calls.reduce, 1, label);
  assert.equal(calls.flatten, 1, label);
  assert.equal(calls.snapshot, 2, label);
  assert.equal(context.processFence.tripped, true, label);

  const record = await durableRecord(context);
  assert.equal(record.status, "HALTED_FLAT", label);

  for (const inspected of [
    await inspectHaltContinuation(context),
    await inspectHaltContinuation(restartedProcess(context)),
  ]) {
    assert.equal(inspected.durableStatus, "HALTED_FLAT", label);
    assert.equal(inspected.allowRiskIncrease, false, label);
    assert.equal(inspected.systemAllowRiskIncrease, false, label);
  }
}

describe("Gate 2 re-review RC1: reduction snapshot financial domain", {
  concurrency: 1,
}, () => {
  test("G2-RC1-1 a negative price with a matching negative notional is not reduction proof", async () => {
    await withTempDir(async (directory) => {
      const { context, result, calls } = await reduceAgainst(
        directory,
        reductionEvidence("2", "-100", "-200"),
      );
      await assertUnverifiedHalt("negative price", context, result, calls);
      assertHas(result, DOMAIN_INVALID);
    });
  });

  test("G2-RC1-2 a zero price with a zero notional is not reduction proof", async () => {
    await withTempDir(async (directory) => {
      const { context, result, calls } = await reduceAgainst(
        directory,
        reductionEvidence("2", "0", "0"),
      );
      await assertUnverifiedHalt("zero price", context, result, calls);
      assertHas(result, DOMAIN_INVALID);
    });
  });

  test("G2-RC1-3 zero and negative price or notional variants all halt and flatten", async () => {
    const variants: Array<[string, string, string, string]> = [
      ["short at a negative price", "-2", "-100", "-200"],
      ["short at a zero price", "-2", "0", "0"],
      ["flat at a zero price", "0", "0", "0"],
      ["flat at a negative price", "0", "-100", "0"],
      ["negative notional at a positive price", "2", "100", "-200"],
      ["negative notional at a negative price", "-1", "-100", "-100"],
    ];
    for (const [label, position, price, notional] of variants) {
      await withTempDir(async (directory) => {
        const { context, result, calls } = await reduceAgainst(
          directory,
          reductionEvidence(position, price, notional),
        );
        await assertUnverifiedHalt(label, context, result, calls);
        assertHas(result, DOMAIN_INVALID, label);
      });
    }
  });

  test("G2-RC1-4 non-canonical values that would prove a within-cap product are rejected", async () => {
    const variants: Array<[string, string, string, string]> = [
      ["non-canonical price", "1.5", "100.0", "150"],
      ["non-canonical notional", "1.5", "100", "150.0"],
      ["non-canonical position", "1.50", "100", "150"],
      ["exponent price", "1.5", "1e2", "150"],
      ["signed price", "1.5", "+100", "150"],
    ];
    for (const [label, position, price, notional] of variants) {
      await withTempDir(async (directory) => {
        const { context, result, calls } = await reduceAgainst(
          directory,
          reductionEvidence(position, price, notional),
        );
        await assertUnverifiedHalt(label, context, result, calls);
        assertHas(result, DOMAIN_INVALID, label);
      });
    }
  });

  test("G2-RC1-5 the domain failure is persisted and a restart cannot resume new risk", async () => {
    await withTempDir(async (directory) => {
      const { context, result, calls } = await reduceAgainst(
        directory,
        reductionEvidence("2", "-100", "-200"),
      );
      await assertUnverifiedHalt("negative price", context, result, calls);
      assert.ok((await durableRecord(context)).haltReasons.includes(DOMAIN_INVALID));

      // A clean CONTINUE input in a fresh process must not lift the hard halt.
      const restarted = restartedProcess(context);
      const resumed = await applyRiskDecision(restarted, baselineRiskInput());
      assert.equal(resumed.durableStatus, "HALTED_FLAT", `${resumed.reasonCodes}`);
      assert.equal(resumed.allowRiskIncrease, false);
      assert.equal(resumed.systemAllowRiskIncrease, false);
      assert.equal(calls.reduce, 1);
      assert.equal((await durableRecord(context)).status, "HALTED_FLAT");
      const after = await inspectHaltContinuation(restartedProcess(context));
      assert.equal(after.systemAllowRiskIncrease, false);
    });
  });

  test("G2-RC1-6 control: a tiny positive price with a consistent notional is still verified", async () => {
    const tiny = `0.${"0".repeat(30)}1`;
    await withTempDir(async (directory) => {
      const { context, result, calls } = await reduceAgainst(
        directory,
        reductionEvidence("1", tiny, tiny),
      );
      assert.equal(result.durableStatus, "RUNNING", `${result.reasonCodes}`);
      assert.equal(result.runtimeDisposition, "REDUCING");
      assertHas(result, "REDUCE_VERIFIED");
      assert.ok(!result.reasonCodes.includes(DOMAIN_INVALID));
      assert.equal(calls.flatten, 0);
      assert.equal(context.processFence.tripped, false);
    });
  });

  test("G2-RC1-7 control: the 150U cap and the missing-notional path are unchanged", async () => {
    await withTempDir(async (directory) => {
      const { result } = await reduceAgainst(directory, reductionEvidence("1.5", "100", "150"));
      assert.equal(result.durableStatus, "RUNNING", `${result.reasonCodes}`);
      assertHas(result, "REDUCE_VERIFIED");
    });

    await withTempDir(async (directory) => {
      const { context, result, calls } = await reduceAgainst(
        directory,
        reductionEvidence("1.6", "100", "160"),
      );
      assert.equal(result.durableStatus, "HALTED_FLAT", `${result.reasonCodes}`);
      assertHas(result, "REDUCE_NOT_VERIFIED");
      assertHas(result, "ACTUAL_EXPOSURE_UNSAFE");
      assert.ok(!result.reasonCodes.includes(DOMAIN_INVALID));
      assert.equal(calls.flatten, 1);
      assert.equal(context.processFence.tripped, true);
    });

    await withTempDir(async (directory) => {
      const { context, result, calls } = await reduceAgainst(
        directory,
        reductionEvidence("1.5", "100", null),
      );
      await assertUnverifiedHalt("missing notional", context, result, calls);
      assert.ok(!result.reasonCodes.includes(DOMAIN_INVALID));
    });
  });
});
