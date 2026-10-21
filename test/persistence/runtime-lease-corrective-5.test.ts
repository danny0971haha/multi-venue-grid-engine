import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createLeaseMutationFence } from "../../src/execution/lease-fence.js";
import type { LeaseAuthority, LeaseClock } from "../../src/persistence/runtime-lease.js";
import {
  acquireRuntimeLease,
  assertCurrentLease,
  heartbeatRuntimeLease,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { buildIntent, createHarness, grant, SCOPE_KEY } from "../execution/helpers.js";

const ACQUIRED_AT_MS = 1_000_000n;
// Exactly acquiredAt + LEASE_TTL_MS: PHASE_2C §8 treats nowMs >= expiresAtMs as expired.
const EXACT_EXPIRY_MS = 1_030_000n;
// Inside the original lease window, so the durable record alone would still look current.
const RETURNED_MS = 1_001_000n;

type MutableClock = LeaseClock & { set(nowMs: bigint): void };

function mutableClock(initialMs: bigint): MutableClock {
  let current = initialMs;
  return {
    nowMs() {
      return current;
    },
    set(nowMs: bigint) {
      current = nowMs;
    },
  };
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr5-"));
  try {
    await run(directory);
  } finally {
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

async function acquireA(directory: string, clock: LeaseClock): Promise<LeaseAuthority> {
  const acquired = await acquireRuntimeLease({
    directory,
    scopeKey: SCOPE_KEY,
    ownerId: "ownerA",
    processInstanceId: "procA",
    latch: new RuntimePersistenceLatch(),
    clock,
  });
  assert.equal(acquired.disposition, "ACQUIRED");
  assert.ok(acquired.authority);
  return acquired.authority;
}

// Every file under the lease directory with its bytes, so a failed operation can be shown
// to have written nothing.
async function directoryBytes(directory: string): Promise<Map<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      files.set(path.relative(directory, full), (await readFile(full)).toString("base64"));
    }
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

async function mutate(
  directory: string,
  authority: LeaseAuthority,
  latch: RuntimePersistenceLatch,
  clock: LeaseClock,
) {
  let calls = 0;
  const result = await runLeaseFencedMutation({
    directory,
    scopeKey: SCOPE_KEY,
    authority,
    latch,
    clock,
    mutation: () => {
      calls += 1;
      return "sent";
    },
  });
  return { result, calls };
}

describe("Gate 2/3 re-review RC2: failed heartbeat and token fencing", { concurrency: 1 }, () => {
  test("RC2-01 heartbeat at exact expiry blocks the latch; after the clock returns nothing is sent", async () => {
    await withTempDir(async (directory) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      const authority = await acquireA(directory, clock);
      const latch = new RuntimePersistenceLatch();
      const lease = { directory, scopeKey: SCOPE_KEY, authority, latch, clock };
      const before = await directoryBytes(directory);

      clock.set(EXACT_EXPIRY_MS);
      const heartbeat = await heartbeatRuntimeLease(lease);
      assert.equal(heartbeat.disposition, "BLOCKED");
      assert.equal(heartbeat.authority, null);
      assert.ok(heartbeat.reasonCodes.includes("LEASE_EXPIRED"));
      assert.equal(latch.blocked, true);
      assert.equal(heartbeat.latchState.blocked, true);

      clock.set(RETURNED_MS);
      const sameLatch = await mutate(directory, authority, latch, clock);
      assert.equal(sameLatch.result.outcome, "NOT_SENT");
      assert.equal(sameLatch.calls, 0);
      assert.equal(sameLatch.result.callbackCount, 0);
      assert.ok(sameLatch.result.reasonCodes.includes("MUTATION_NOT_SENT"));

      // A fresh latch does not reopen the token: it was fenced when the heartbeat failed.
      const freshLatch = await mutate(directory, authority, new RuntimePersistenceLatch(), clock);
      assert.equal(freshLatch.result.outcome, "NOT_SENT");
      assert.equal(freshLatch.calls, 0);
      assert.equal(freshLatch.result.callbackCount, 0);
      assert.ok(freshLatch.result.reasonCodes.includes("FENCED_OWNER"));

      const again = await heartbeatRuntimeLease(lease);
      assert.notEqual(again.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(again.authority, null);
      const againFresh = await heartbeatRuntimeLease({
        ...lease,
        latch: new RuntimePersistenceLatch(),
      });
      assert.notEqual(againFresh.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(againFresh.reasonCodes.includes("FENCED_OWNER"));

      const asserted = await assertCurrentLease({ ...lease, latch: new RuntimePersistenceLatch() });
      assert.notEqual(asserted.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(asserted.authority, null);
      assert.ok(asserted.reasonCodes.includes("FENCED_OWNER"));

      assert.deepEqual(await directoryBytes(directory), before);
    });
  });

  test("RC2-02 assert at exact expiry fences the token; after the clock returns nothing is sent", async () => {
    await withTempDir(async (directory) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      const authority = await acquireA(directory, clock);
      const latch = new RuntimePersistenceLatch();
      const lease = { directory, scopeKey: SCOPE_KEY, authority, latch, clock };
      const before = await directoryBytes(directory);

      clock.set(EXACT_EXPIRY_MS);
      const asserted = await assertCurrentLease(lease);
      assert.equal(asserted.disposition, "BLOCKED");
      assert.equal(asserted.authority, null);
      assert.ok(asserted.reasonCodes.includes("LEASE_EXPIRED"));

      clock.set(RETURNED_MS);
      const sameLatch = await mutate(directory, authority, latch, clock);
      assert.equal(sameLatch.result.outcome, "NOT_SENT");
      assert.equal(sameLatch.calls, 0);
      assert.equal(sameLatch.result.callbackCount, 0);
      assert.ok(sameLatch.result.reasonCodes.includes("FENCED_OWNER"));

      const freshLatch = await mutate(directory, authority, new RuntimePersistenceLatch(), clock);
      assert.equal(freshLatch.result.outcome, "NOT_SENT");
      assert.equal(freshLatch.calls, 0);
      assert.equal(freshLatch.result.callbackCount, 0);
      assert.ok(freshLatch.result.reasonCodes.includes("FENCED_OWNER"));

      const heartbeat = await heartbeatRuntimeLease(lease);
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.reasonCodes.includes("FENCED_OWNER"));

      assert.deepEqual(await directoryBytes(directory), before);
    });
  });

  for (const check of ["heartbeat", "assert"] as const) {
    test(`RC2-03 Phase 3 submit after a failed ${check} at exact expiry and clock return: NOT_SENT, no place`, async () => {
      await withTempDir(async (directory) => {
        const clock = mutableClock(ACQUIRED_AT_MS);
        const authority = await acquireA(directory, clock);
        const latch = new RuntimePersistenceLatch();
        const lease = { directory, scopeKey: SCOPE_KEY, authority, latch, clock };
        const h = await createHarness({ fence: createLeaseMutationFence(lease) });

        clock.set(EXACT_EXPIRY_MS);
        const failed =
          check === "heartbeat"
            ? await heartbeatRuntimeLease(lease)
            : await assertCurrentLease(lease);
        assert.equal(failed.disposition, "BLOCKED");
        assert.ok(failed.reasonCodes.includes("LEASE_EXPIRED"));

        clock.set(RETURNED_MS);
        await grant(h.coordinator);
        const submitted = await h.coordinator.submit(
          buildIntent({ leaseGeneration: authority.generation }),
        );
        assert.equal(submitted.record?.status, "NOT_SENT");
        assert.ok(submitted.reasonCodes.includes("FENCE_NOT_SENT"));
        assert.ok(submitted.reasonCodes.includes("MUTATION_NOT_SENT"));
        assert.equal(h.venue.calls.place, 0);
      });
    });
  }

  test("RC2-04 a forged-token release fences the forged token only", async () => {
    await withTempDir(async (directory) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      const authority = await acquireA(directory, clock);
      const forged = { ...authority, ownerId: "ownerX" };
      const forgedLatch = new RuntimePersistenceLatch();

      const released = await releaseRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority: forged,
        latch: forgedLatch,
        clock,
      });
      assert.equal(released.disposition, "BLOCKED");
      assert.ok(released.reasonCodes.includes("FORGED_LEASE_TOKEN"));

      const forgedSend = await mutate(directory, forged, new RuntimePersistenceLatch(), clock);
      assert.equal(forgedSend.result.outcome, "NOT_SENT");
      assert.equal(forgedSend.calls, 0);
      assert.ok(forgedSend.result.reasonCodes.includes("FENCED_OWNER"));

      const genuineSend = await mutate(directory, authority, new RuntimePersistenceLatch(), clock);
      assert.equal(genuineSend.result.outcome, "SENT");
      assert.equal(genuineSend.calls, 1);
    });
  });

  test("RC2-05 control: a heartbeat before expiry commits and the new token still sends", async () => {
    await withTempDir(async (directory) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      const authority = await acquireA(directory, clock);
      const latch = new RuntimePersistenceLatch();

      clock.set(EXACT_EXPIRY_MS - 1n);
      const heartbeat = await heartbeatRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch,
        clock,
      });
      assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.authority);
      assert.equal(latch.blocked, false);

      const sent = await mutate(directory, heartbeat.authority, latch, clock);
      assert.equal(sent.result.outcome, "SENT");
      assert.equal(sent.calls, 1);
      assert.equal(latch.blocked, false);
    });
  });

  test("RC2-06 control: a rejected second-owner acquire does not block its latch", async () => {
    await withTempDir(async (directory) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      await acquireA(directory, clock);
      const latch = new RuntimePersistenceLatch();

      clock.set(RETURNED_MS);
      const contender = await acquireRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerB",
        processInstanceId: "procB",
        latch,
        clock,
      });
      assert.equal(contender.disposition, "BLOCKED");
      assert.equal(contender.authority, null);
      assert.equal(latch.blocked, false);
    });
  });
});
