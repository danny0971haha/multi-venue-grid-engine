import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createLeaseMutationFence } from "../../src/execution/lease-fence.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import type { LeaseClock } from "../../src/persistence/runtime-lease.js";
import {
  MAX_CLOCK_SKEW_MS,
  MAX_FORWARD_JUMP_MS,
  acquireRuntimeLease,
  fixedLeaseClock,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
  setLeasePreCallbackHookForTests,
} from "../../src/persistence/runtime-lease.js";

const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
const NOW_MS = 1_000_000n;

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr3-"));
  try {
    await run(directory);
  } finally {
    setLeasePreCallbackHookForTests(null);
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

// Clock that reads NOW_MS at the first boundary and switches to `finalMs` once the
// pre-callback hook fires, so only the final synchronous boundary sees the moved clock.
function finalReadClock(finalMs: bigint): LeaseClock {
  let current = NOW_MS;
  setLeasePreCallbackHookForTests(() => {
    current = finalMs;
  });
  return {
    nowMs() {
      return current;
    },
  };
}

async function acquireAtNow(directory: string) {
  const acquired = await acquireRuntimeLease({
    directory,
    scopeKey: SCOPE_KEY,
    ownerId: "ownerA",
    processInstanceId: "procA",
    latch: new RuntimePersistenceLatch(),
    clock: fixedLeaseClock(NOW_MS),
  });
  assert.equal(acquired.disposition, "ACQUIRED");
  assert.ok(acquired.authority);
  return acquired.authority;
}

describe("Phase 2C corrective 3: final-boundary clock validation", { concurrency: 1 }, () => {
  test("2C-C3-01 final clock read regressed beyond tolerance: NOT_SENT, callback 0, latch blocked", async () => {
    await withTempDir(async (directory) => {
      const authority = await acquireAtNow(directory);
      const latch = new RuntimePersistenceLatch();
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch,
        clock: finalReadClock(NOW_MS - 2_000n),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(result.outcome, "NOT_SENT");
      assert.equal(result.callbackCount, 0);
      assert.equal(calls, 0);
      assert.equal(result.value, null);
      assert.equal(result.allowRiskIncrease, false);
      assert.ok(result.reasonCodes.includes("CLOCK_REGRESSION"));
      assert.ok(result.reasonCodes.includes("MUTATION_NOT_SENT"));
      assert.equal(latch.blocked, true);
      assert.equal(result.latchState.blocked, true);
    });
  });

  test("2C-C3-02 final clock regression is exact at the tolerance boundary", async () => {
    await withTempDir(async (root) => {
      const atTolerance = path.join(root, "at-tolerance");
      await mkdir(atTolerance, { mode: 0o700 });
      const authorityA = await acquireAtNow(atTolerance);
      const latchA = new RuntimePersistenceLatch();
      const accepted = await runLeaseFencedMutation({
        directory: atTolerance,
        scopeKey: SCOPE_KEY,
        authority: authorityA,
        latch: latchA,
        clock: finalReadClock(NOW_MS - MAX_CLOCK_SKEW_MS),
        mutation: () => "sent",
      });
      assert.equal(accepted.outcome, "SENT");
      assert.equal(accepted.callbackCount, 1);
      assert.equal(latchA.blocked, false);

      resetLeaseProcessStateForTests();
      const beyond = path.join(root, "beyond-tolerance");
      await mkdir(beyond, { mode: 0o700 });
      const authorityB = await acquireAtNow(beyond);
      const latchB = new RuntimePersistenceLatch();
      let calls = 0;
      const rejected = await runLeaseFencedMutation({
        directory: beyond,
        scopeKey: SCOPE_KEY,
        authority: authorityB,
        latch: latchB,
        clock: finalReadClock(NOW_MS - MAX_CLOCK_SKEW_MS - 1n),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(rejected.outcome, "NOT_SENT");
      assert.equal(rejected.callbackCount, 0);
      assert.equal(calls, 0);
      assert.ok(rejected.reasonCodes.includes("CLOCK_REGRESSION"));
      assert.equal(latchB.blocked, true);
    });
  });

  test("2C-C3-03 final clock read jumped forward beyond limit: NOT_SENT and latch blocked", async () => {
    await withTempDir(async (directory) => {
      const authority = await acquireAtNow(directory);
      const latch = new RuntimePersistenceLatch();
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch,
        clock: finalReadClock(NOW_MS + MAX_FORWARD_JUMP_MS + 1n),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(result.outcome, "NOT_SENT");
      assert.equal(result.callbackCount, 0);
      assert.equal(calls, 0);
      assert.ok(result.reasonCodes.includes("CLOCK_FORWARD_JUMP"));
      assert.equal(latch.blocked, true);
    });
  });

  test("2C-C3-04 rejected final boundary fences the token for later mutations", async () => {
    await withTempDir(async (directory) => {
      const authority = await acquireAtNow(directory);
      const rejected = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch: new RuntimePersistenceLatch(),
        clock: finalReadClock(NOW_MS - 2_000n),
        mutation: () => "sent",
      });
      assert.equal(rejected.outcome, "NOT_SENT");
      setLeasePreCallbackHookForTests(null);

      let calls = 0;
      const later = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch: new RuntimePersistenceLatch(),
        clock: fixedLeaseClock(NOW_MS),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(later.outcome, "NOT_SENT");
      assert.equal(later.callbackCount, 0);
      assert.equal(calls, 0);
      assert.ok(later.reasonCodes.includes("FENCED_OWNER"));
    });
  });

  test("2C-C3-05 Phase 3 lease mutation fence: final clock regression is NOT_SENT", async () => {
    await withTempDir(async (directory) => {
      const authority = await acquireAtNow(directory);
      const latch = new RuntimePersistenceLatch();
      const fence = createLeaseMutationFence({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch,
        clock: finalReadClock(NOW_MS - 2_000n),
      });
      let calls = 0;
      const result = await fence.run(async () => {
        calls += 1;
        return "placed";
      });
      assert.equal(result.outcome, "NOT_SENT");
      assert.equal(result.value, null);
      assert.equal(calls, 0);
      assert.ok(result.reasonCodes.includes("CLOCK_REGRESSION"));
      assert.equal(latch.blocked, true);
    });
  });

  test("2C-C3-06 unchanged clock across both boundaries still sends exactly once", async () => {
    await withTempDir(async (directory) => {
      const authority = await acquireAtNow(directory);
      const latch = new RuntimePersistenceLatch();
      let calls = 0;
      const result = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch,
        clock: finalReadClock(NOW_MS),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      });
      assert.equal(result.outcome, "SENT");
      assert.equal(result.callbackCount, 1);
      assert.equal(calls, 1);
      assert.equal(result.value, "sent");
      assert.equal(latch.blocked, false);
    });
  });
});
